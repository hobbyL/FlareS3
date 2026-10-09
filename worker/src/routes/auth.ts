import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { jsonResponse, parseJson, requestBodyPolicyErrorResponse, getUser } from './utils'
import bcrypt from 'bcryptjs'
import { hashPassword, verifyPassword } from '../services/password'
import {
  recordFailedAttempt,
  recordFailedAttemptForUsername,
  isUsernameBlocked,
  getClientIp,
} from '../middleware/rateLimit'
import { logAudit, prepareAuditLogInsert } from '../services/audit'
import {
  getSessionCookieName,
  invalidateAuthToken,
  invalidateSignedSession,
  invalidateUserAuthTokens,
  type AuthUser,
} from '../middleware/authSession'
import { createSignedAuthToken, getAuthTokenSecret } from '../services/authToken'
import { hashToken } from '../utils/token'
import { logError } from '../utils/log'
import { isSecureRequest } from '../utils/requestSecurity'

const SESSION_TTL_SECONDS = 8 * 60 * 60

/**
 * 用户不存在路径的哈希均衡常量：拉平与密码错误路径的计时差，
 * 防止通过响应时间枚举有效用户名。
 *
 * 预计算的 bcrypt 哈希（'flares3-timing-equalizer'，rounds=10），不在模块
 * 顶层调用 hashSync——部署校验沙箱无 WebCrypto/Node crypto，顶层随机盐
 * 生成会抛错导致 deploy 失败（错误码 10021）。不含真实凭证。
 */
const DUMMY_BCRYPT_HASH = '$2a$10$/SAInTJYIAju0v/IVp43r.Al/pxmKs8WO2/qr/5GeLu6rYlzV9Vrm'

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
    logError('auth.login.failed', error)
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
 * 修改当前用户密码
 *
 * 改密成功后会删除该用户的全部会话（含当前会话），
 * 客户端需要在收到成功响应后主动跳转登录页重新认证。
 *
 * @route POST /api/auth/change-password
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 请求体
 * {
 *   "current_password": "old-password-123",
 *   "new_password": "new-password-456"
 * }
 *
 * // 成功响应 (200)
 * { "ok": true }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // 缺少字段 (400)
 * { "error": "请填写当前密码和新密码" }
 *
 * // 新密码过短 (400)
 * { "error": "新密码至少 8 位" }
 *
 * // 新密码与当前密码相同 (400)
 * { "error": "新密码不能与当前密码相同" }
 *
 * // 当前密码不正确 (400)
 * { "error": "当前密码不正确" }
 *
 * // 请求体超过大小限制 (413)
 * { "error": "JSON 请求体大小超过限制" }
 *
 * // 服务器错误 (500)
 * { "error": "修改密码失败" }
 */
export async function changePassword(request: Request, env: Env): Promise<Response> {
  try {
    const user = getUser(request)
    if (!user) {
      return jsonResponse({ error: '未授权' }, 401)
    }

    const body = await parseJson<{ current_password: string; new_password: string }>(request)
    const currentPassword = String(body.current_password || '')
    const newPassword = String(body.new_password || '')
    if (!currentPassword || !newPassword) {
      return jsonResponse({ error: '请填写当前密码和新密码' }, 400)
    }
    if (newPassword.length < 8) {
      return jsonResponse({ error: '新密码至少 8 位' }, 400)
    }
    if (newPassword === currentPassword) {
      return jsonResponse({ error: '新密码不能与当前密码相同' }, 400)
    }

    const row = await withD1Retry(env.DB)
      .prepare('SELECT id, password_hash FROM users WHERE id = ? LIMIT 1')
      .bind(user.id)
      .first<{ id: string; password_hash: string }>()
    // 已认证用户的输入错误返回 400（与登录失败的 401 区分）；
    // 用户行缺失按当前密码不正确处理，不额外泄露账号状态。
    if (!row || !verifyPassword(currentPassword, String(row.password_hash || ''))) {
      return jsonResponse({ error: '当前密码不正确' }, 400)
    }

    const now = new Date().toISOString()
    // 单 batch 原子提交：密码哈希更新、全部会话删除与审计写入必须一起生效，
    // 避免出现密码已改但旧会话仍存活的中间状态（对齐 d1-write-consistency）。
    await withD1Retry(env.DB).batch([
      withD1Retry(env.DB)
        .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .bind(hashPassword(newPassword), now, user.id),
      withD1Retry(env.DB).prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
      prepareAuditLogInsert(
        env.DB,
        {
          actorUserId: user.id,
          action: 'USER_CHANGE_PASSWORD',
          targetType: 'user',
          targetId: user.id,
          ip: getClientIp(request),
          userAgent: request.headers.get('User-Agent') || undefined,
          metadata: { sessionsRevoked: true },
        },
        now
      ),
    ])
    // 立即失效本 isolate 的会话缓存，消除 15s 缓存窗口内旧 token 仍可通过认证的残余
    invalidateUserAuthTokens(user.id, Date.parse(now) || Date.now())

    return jsonResponse({ ok: true })
  } catch (error) {
    const bodyError = requestBodyPolicyErrorResponse(error)
    if (bodyError) return bodyError
    logError('auth.changePassword.failed', error)
    return jsonResponse({ error: '修改密码失败' }, 500)
  }
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

// ── 会话管理 ──

/** 活跃会话列表 / 撤销分批的批量上限（会话 TTL 8h，正常账号远低于此） */
const SESSIONS_LIST_LIMIT = 50
/** revoke-others 单次请求的清理轮数上限（50 × 10 = 500 个会话），防超时 */
const SESSIONS_REVOKE_MAX_ROUNDS = 10

/** authSessionMiddleware 已把 sessionId 挂到认证请求上（当前会话识别） */
function getSessionId(request: Request): string | undefined {
  return (request as Request & { sessionId?: string }).sessionId
}

/**
 * 获取本人活跃会话列表
 *
 * @route GET /api/auth/sessions
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含活跃会话列表（不含 token_hash）
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "sessions": [
 *     {
 *       "id": "uuid",
 *       "ip": "203.0.113.10",
 *       "user_agent": "Mozilla/5.0 ...",
 *       "created_at": "2026-10-09T00:00:00.000Z",
 *       "expires_at": "2026-10-09T08:00:00.000Z",
 *       "is_current": 1
 *     }
 *   ]
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 */
export async function listSessions(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const currentSessionId = getSessionId(request)
  const nowIso = new Date().toISOString()
  const rows = await withD1Retry(env.DB)
    .prepare(
      `SELECT id, ip, user_agent, created_at, expires_at
     FROM sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC
     LIMIT ?`
    )
    .bind(user.id, nowIso, SESSIONS_LIST_LIMIT)
    .all<{
      id: string
      ip: string | null
      user_agent: string | null
      created_at: string
      expires_at: string
    }>()

  const sessions = (rows.results || []).map((row) => ({
    id: String(row.id),
    ip: row.ip === null ? null : String(row.ip),
    user_agent: row.user_agent === null ? null : String(row.user_agent),
    created_at: row.created_at,
    expires_at: row.expires_at,
    is_current: String(row.id) === currentSessionId ? 1 : 0,
  }))

  return jsonResponse({ sessions })
}

/**
 * 撤销指定会话（下线该设备）
 *
 * 仅允许撤销本人会话（user_id 条件防越权）；撤销当前会话等价登出。
 *
 * @route DELETE /api/auth/sessions/:id
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param sessionId - 会话 ID
 * @returns JSON 响应
 *
 * @example
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 会话不存在 / 非本人 / 已撤销 (404，同文案不泄露区分)
 * { "error": "会话不存在" }
 */
export async function revokeSession(
  request: Request,
  env: Env,
  sessionId: string
): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  if (!sessionId) return jsonResponse({ error: 'id 不能为空' }, 400)

  const existing = await withD1Retry(env.DB)
    .prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL LIMIT 1')
    .bind(sessionId, user.id)
    .first()

  if (!existing) {
    return jsonResponse({ error: '会话不存在' }, 404)
  }

  // 状态切换与审计同 batch（d1-write-consistency）
  const nowIso = new Date().toISOString()
  await withD1Retry(env.DB).batch([
    withD1Retry(env.DB)
      .prepare(
        'UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
      )
      .bind(nowIso, sessionId, user.id),
    prepareAuditLogInsert(
      env.DB,
      {
        actorUserId: user.id,
        action: 'SESSION_REVOKE',
        targetType: 'session',
        targetId: sessionId,
        ip: getClientIp(request),
        userAgent: request.headers.get('User-Agent') || undefined,
      },
      nowIso
    ),
  ])

  // isolate 失效在落库之后（DB 是事实源；见 invalidateSignedSession JSDoc）
  invalidateSignedSession(sessionId, Date.parse(nowIso) || Date.now())

  return jsonResponse({ success: true })
}

/**
 * 撤销除当前会话外的全部本人会话（下线其他设备）
 *
 * 分批（50/轮，至多 10 轮）SELECT + UPDATE，批间可重入；当前会话永不被撤。
 *
 * @route POST /api/auth/sessions/revoke-others
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含撤销数量
 *
 * @example
 * // 成功响应 (200)
 * { "success": true, "revoked": 3 }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 */
export async function revokeOtherSessions(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const currentSessionId = getSessionId(request)
  if (!currentSessionId) {
    return jsonResponse({ error: '缺少当前会话' }, 400)
  }

  const nowIso = new Date().toISOString()
  const revokedIds: string[] = []
  for (let round = 0; round < SESSIONS_REVOKE_MAX_ROUNDS; round++) {
    const rows = await withD1Retry(env.DB)
      .prepare(
        `SELECT id FROM sessions
     WHERE user_id = ? AND revoked_at IS NULL AND id != ?
     ORDER BY created_at DESC
     LIMIT ?`
      )
      .bind(user.id, currentSessionId, SESSIONS_LIST_LIMIT)
      .all<{ id: string }>()
    const ids = (rows.results || []).map((row) => String(row.id))
    if (!ids.length) break

    // 每轮状态切换与该轮审计同 batch（d1-write-consistency）；
    // 多轮时每轮各带审计，metadata 记录该轮数量，部分失败可重入续跑
    const placeholders = ids.map(() => '?').join(',')
    await withD1Retry(env.DB).batch([
      withD1Retry(env.DB)
        .prepare(
          `UPDATE sessions SET revoked_at = ?
        WHERE user_id = ? AND id IN (${placeholders}) AND revoked_at IS NULL`
        )
        .bind(nowIso, user.id, ...ids),
      prepareAuditLogInsert(
        env.DB,
        {
          actorUserId: user.id,
          action: 'SESSION_REVOKE_OTHERS',
          targetType: 'session',
          targetId: '',
          ip: getClientIp(request),
          userAgent: request.headers.get('User-Agent') || undefined,
          metadata: { revoked: ids.length },
        },
        nowIso
      ),
    ])
    revokedIds.push(...ids)

    if (ids.length < SESSIONS_LIST_LIMIT) break
  }

  if (revokedIds.length) {
    // isolate 失效在落库之后；逐会话失效（不能用 userId 级——会误伤当前会话）
    const invalidatedAtMs = Date.parse(nowIso) || Date.now()
    for (const id of revokedIds) {
      invalidateSignedSession(id, invalidatedAtMs)
    }
  }

  return jsonResponse({ success: true, revoked: revokedIds.length })
}
