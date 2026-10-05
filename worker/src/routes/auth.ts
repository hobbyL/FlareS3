import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { jsonResponse, parseJson, requestBodyPolicyErrorResponse } from './utils'
import bcrypt from 'bcryptjs'
import { verifyPassword } from '../services/password'
import {
  recordFailedAttempt,
  recordFailedAttemptForUsername,
  isUsernameBlocked,
  getClientIp,
} from '../middleware/rateLimit'
import { logAudit } from '../services/audit'
import { getSessionCookieName, invalidateAuthToken, type AuthUser } from '../middleware/authSession'
import { createSignedAuthToken, getAuthTokenSecret } from '../services/authToken'
import { hashToken } from '../utils/token'

const SESSION_TTL_SECONDS = 8 * 60 * 60

/**
 * 用户不存在路径的哈希均衡常量：拉平与密码错误路径的计时差，
 * 防止通过响应时间枚举有效用户名。硬编码 bcrypt 哈希，不含真实凭证。
 */
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('flares3-timing-equalizer', 10)

function isSecureRequest(request: Request): boolean {
  const url = new URL(request.url)
  if (url.protocol === 'https:') return true
  const forwardedProto = request.headers.get('X-Forwarded-Proto')
  if (forwardedProto && forwardedProto.split(',')[0].trim() === 'https') return true
  return false
}

function buildSessionCookie(request: Request, token: string, maxAge: number): string {
  const secure = isSecureRequest(request) ? '; Secure' : ''
  return `${getSessionCookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

/**
 * 用户登录
 *
 * @route POST /api/auth/login
 * @param request - HTTP 请求对象
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含用户信息和会话 Cookie
 *
 * @example
 * // 请求体
 * {
 *   "username": "admin",
 *   "password": "password123"
 * }
 *
 * // 成功响应 (200)
 * {
 *   "success": true,
 *   "user": {
 *     "id": "uuid",
 *     "username": "admin",
 *     "role": "admin",
 *     "status": "active"
 *   }
 * }
 *
 * // 失败响应 (401)
 * {
 *   "error": "用户名或密码错误",
 *   "code": "AUTH_INVALID_CREDENTIALS"
 * }
 */
export async function login(request: Request, env: Env): Promise<Response> {
  try {
    const ip = getClientIp(request)
    const userAgent = request.headers.get('User-Agent') || undefined
    const body = await parseJson<{ username: string; password: string }>(request)
    if (!body.username || !body.password) {
      return jsonResponse({ error: '用户名或密码不能为空' }, 400)
    }
    if (!getAuthTokenSecret(env)) {
      return jsonResponse({ error: '缺少 AUTH_TOKEN_SECRET' }, 500)
    }

    const authFailedResponse = jsonResponse(
      { error: '用户名或密码错误', code: 'AUTH_INVALID_CREDENTIALS' },
      401
    )

    const trackLoginFailure = async (targetId?: string, reason?: string) => {
      await Promise.allSettled([
        recordFailedAttempt(env, ip),
        recordFailedAttemptForUsername(env, body.username),
        logAudit(env.DB, {
          action: 'LOGIN_FAILED',
          targetType: 'user',
          targetId,
          ip,
          userAgent,
          metadata: reason ? { reason } : undefined,
        }),
      ])
    }

    const usernameBlockedResponse = jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429)

    // 账号维度封禁前置检查：换 IP 的分布式爆破在同一用户名上也会被拒绝，
    // 先于用户查询与 bcrypt 比较执行，避免封禁期内仍消耗哈希成本。
    if (await isUsernameBlocked(env, body.username)) {
      await trackLoginFailure(undefined, 'USERNAME_BLOCKED')
      return usernameBlockedResponse
    }

    const user = await withD1Retry(env.DB)
      .prepare(
        'SELECT id, username, password_hash, role, status, quota_bytes FROM users WHERE username = ? LIMIT 1'
      )
      .bind(body.username)
      .first<{
        id: string
        username: string
        password_hash: string
        role: string
        status: string
        quota_bytes: number
      }>()

    if (!user) {
      // 用户不存在时执行等价成本的哈希校验，拉平与密码错误路径的计时差，
      // 防止通过响应时间枚举有效用户名；DUMMY_HASH 为硬编码常量，不含真实凭证。
      bcrypt.compareSync(body.password, DUMMY_BCRYPT_HASH)
      await trackLoginFailure(undefined, 'USER_NOT_FOUND')
      return authFailedResponse
    }

    if (String(user.status) !== 'active') {
      await trackLoginFailure(String(user.id), `USER_${String(user.status).toUpperCase()}`)
      return authFailedResponse
    }

    if (!verifyPassword(body.password, String(user.password_hash))) {
      await trackLoginFailure(String(user.id), 'PASSWORD_INCORRECT')
      return authFailedResponse
    }
    const sessionId = crypto.randomUUID()
    const now = new Date()
    const issuedAtMs = now.getTime()
    const expiresAtSeconds = Math.floor(issuedAtMs / 1000) + SESSION_TTL_SECONDS
    const expiresAt = new Date(expiresAtSeconds * 1000).toISOString()
    const authUser: AuthUser = {
      id: String(user.id),
      username: String(user.username),
      role: String(user.role) === 'admin' ? 'admin' : 'user',
      status: 'active',
      quota_bytes: Number(user.quota_bytes),
    }
    const sessionToken = await createSignedAuthToken(env, {
      sessionId,
      user: authUser,
      issuedAtMs,
      expiresAtSeconds,
    })
    if (!sessionToken) {
      return jsonResponse({ error: '缺少 AUTH_TOKEN_SECRET' }, 500)
    }
    const tokenHash = await hashToken(sessionToken)
    await withD1Retry(env.DB)
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        sessionId,
        user.id,
        tokenHash,
        expiresAt,
        getClientIp(request),
        request.headers.get('User-Agent') || null,
        now.toISOString()
      )
      .run()
    await withD1Retry(env.DB)
      .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(now.toISOString(), user.id)
      .run()
    await Promise.allSettled([
      logAudit(env.DB, {
        actorUserId: String(user.id),
        action: 'LOGIN_SUCCESS',
        targetType: 'user',
        targetId: String(user.id),
        ip,
        userAgent,
      }),
    ])
    return jsonResponse(
      {
        success: true,
        user: { id: user.id, username: user.username, role: user.role, status: user.status },
      },
      200,
      { 'Set-Cookie': buildSessionCookie(request, sessionToken, SESSION_TTL_SECONDS) }
    )
  } catch (error) {
    const bodyError = requestBodyPolicyErrorResponse(error)
    if (bodyError) return bodyError
    console.error('[auth.login] failed', error)
    return jsonResponse({ error: '登录失败' }, 500)
  }
}

/**
 * 用户登出
 *
 * @route POST /api/auth/logout
 * @param request - HTTP 请求对象
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，并清除会话 Cookie
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "success": true
 * }
 */
export async function logout(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '').trim()
  const cookieHeader = request.headers.get('Cookie') || ''
  const cookieToken = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${getSessionCookieName()}=`))
  const sessionToken = token || (cookieToken ? cookieToken.split('=')[1] : '')
  if (sessionToken) {
    const tokenHash = await invalidateAuthToken(env, sessionToken)
    await withD1Retry(env.DB)
      .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?')
      .bind(new Date().toISOString(), tokenHash)
      .run()
  }
  return jsonResponse({ success: true }, 200, {
    'Set-Cookie': buildSessionCookie(request, '', 0),
  })
}

/**
 * 获取当前用户认证状态
 *
 * @route GET /api/auth/status
 * @param request - HTTP 请求对象（需要认证）
 * @returns JSON 响应，包含认证状态和用户信息
 *
 * @example
 * // 已认证响应 (200)
 * {
 *   "authenticated": true,
 *   "user": {
 *     "id": "uuid",
 *     "username": "admin",
 *     "role": "admin",
 *     "status": "active"
 *   }
 * }
 *
 * // 未认证响应 (401)
 * {
 *   "authenticated": false
 * }
 */
export async function status(request: Request): Promise<Response> {
  const req = request as Request & {
    user?: { id: string; username: string; role: string; status: string }
  }
  if (!req.user) {
    return jsonResponse({ authenticated: false }, 401)
  }
  return jsonResponse({
    authenticated: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      status: req.user.status,
    },
  })
}
