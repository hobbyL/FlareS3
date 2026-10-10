import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import {
  jsonResponse,
  parseJson,
  requestBodyPolicyErrorResponse,
  getUser,
  patForbiddenResponse,
} from './utils'
import { prepareAuditLogInsert } from '../services/audit'
import { getClientIp } from '../middleware/rateLimit'
import { generateApiToken, listApiTokens, resolveExpiresAt } from '../services/apiTokens'
import { hashToken } from '../utils/token'
import { logError } from '../utils/log'

/** 令牌名称长度上限：超出截断并拒绝（防超长 name 膨胀 / UI 破版）。 */
const MAX_TOKEN_NAME_LENGTH = 100

/**
 * 列出当前用户的 API Token（元数据，绝不含明文 / token_hash）。
 *
 * 以 PAT 访问时返回 403：令牌自管理需会话登录，杜绝 PAT 自我枚举 / 自传播。
 *
 * @route GET /api/tokens
 * @param request - HTTP 请求对象（需要会话登录）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含令牌元数据列表（含派生 status：active/expired/revoked）
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "tokens": [
 *     {
 *       "id": "uuid",
 *       "name": "CI 部署",
 *       "created_at": "2026-10-01T00:00:00.000Z",
 *       "last_used_at": "2026-10-05T08:00:00.000Z",
 *       "expires_at": "2027-10-01T00:00:00.000Z",
 *       "status": "active"
 *     }
 *   ]
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // PAT 访问被拒 (403)
 * { "error": "此操作需会话登录，不支持 API Token" }
 */
export async function listTokens(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  const patBlocked = patForbiddenResponse(request)
  if (patBlocked) return patBlocked

  const tokens = await listApiTokens(env, user.id)
  return jsonResponse({ tokens })
}

/**
 * 创建一枚 API Token：明文仅在本响应出现一次，库内只存 SHA-256 token_hash。
 *
 * 以 PAT 访问时返回 403（令牌自管理需会话登录）。插入与审计 TOKEN_CREATE 同 batch。
 *
 * @route POST /api/tokens
 * @param request - HTTP 请求对象（需要会话登录）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含一次性明文 token 与元数据
 *
 * @example
 * // 请求体
 * { "name": "CI 部署", "expires_in": 90 }  // expires_in 以天计，省略 / <=0 表示永不过期
 *
 * // 成功响应 (201)
 * {
 *   "id": "uuid",
 *   "name": "CI 部署",
 *   "token": "fla_<一次性明文，永不回读>",
 *   "created_at": "2026-10-10T00:00:00.000Z",
 *   "expires_at": "2027-01-08T00:00:00.000Z"
 * }
 *
 * // 名称为空 (400)
 * { "error": "请填写令牌名称" }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // PAT 访问被拒 (403)
 * { "error": "此操作需会话登录，不支持 API Token" }
 */
export async function createToken(request: Request, env: Env): Promise<Response> {
  try {
    const user = getUser(request)
    if (!user) return jsonResponse({ error: '未授权' }, 401)
    const patBlocked = patForbiddenResponse(request)
    if (patBlocked) return patBlocked

    const body = await parseJson<{ name?: string; expires_in?: number }>(request)
    const name = String(body.name ?? '').trim()
    if (!name) return jsonResponse({ error: '请填写令牌名称' }, 400)
    if (name.length > MAX_TOKEN_NAME_LENGTH) {
      return jsonResponse({ error: `令牌名称不能超过 ${MAX_TOKEN_NAME_LENGTH} 字` }, 400)
    }

    const now = new Date()
    const nowIso = now.toISOString()
    const id = crypto.randomUUID()
    const token = generateApiToken()
    const tokenHash = await hashToken(token)
    const expiresAt = resolveExpiresAt(body.expires_in, now)

    // 插入与审计同 batch：令牌登记与 TOKEN_CREATE 审计必须一起生效（d1-write-consistency）
    await withD1Retry(env.DB).batch([
      withD1Retry(env.DB)
        .prepare(
          `INSERT INTO api_tokens (id, user_id, name, token_hash, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(id, user.id, name, tokenHash, nowIso, expiresAt),
      prepareAuditLogInsert(
        env.DB,
        {
          actorUserId: user.id,
          action: 'TOKEN_CREATE',
          targetType: 'api_token',
          targetId: id,
          ip: getClientIp(request),
          userAgent: request.headers.get('User-Agent') || undefined,
          metadata: { name, expiresAt },
        },
        nowIso
      ),
    ])

    return jsonResponse({ id, name, token, created_at: nowIso, expires_at: expiresAt }, 201)
  } catch (error) {
    const bodyError = requestBodyPolicyErrorResponse(error)
    if (bodyError) return bodyError
    logError('tokens.create.failed', error)
    return jsonResponse({ error: '创建令牌失败' }, 500)
  }
}

/**
 * 吊销当前用户的一枚 API Token（置 revoked_at，仅限本人）。
 *
 * 以 PAT 访问时返回 403（令牌自管理需会话登录）。吊销后该 token 立即失效。
 * 更新与审计 TOKEN_REVOKE 同 batch；不存在 / 非本人 / 已吊销统一 404（不泄露区分）。
 *
 * @route DELETE /api/tokens/:id
 * @param request - HTTP 请求对象（需要会话登录）
 * @param env - Cloudflare Workers 环境变量
 * @param tokenId - 令牌 ID
 * @returns JSON 响应
 *
 * @example
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // PAT 访问被拒 (403)
 * { "error": "此操作需会话登录，不支持 API Token" }
 *
 * // 令牌不存在 / 非本人 / 已吊销 (404，同文案不泄露区分)
 * { "error": "令牌不存在" }
 */
export async function revokeToken(request: Request, env: Env, tokenId: string): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  const patBlocked = patForbiddenResponse(request)
  if (patBlocked) return patBlocked
  if (!tokenId) return jsonResponse({ error: 'id 不能为空' }, 400)

  const existing = await withD1Retry(env.DB)
    .prepare(
      'SELECT id FROM api_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL LIMIT 1'
    )
    .bind(tokenId, user.id)
    .first()

  if (!existing) {
    return jsonResponse({ error: '令牌不存在' }, 404)
  }

  // 状态切换与审计同 batch（d1-write-consistency）
  const nowIso = new Date().toISOString()
  await withD1Retry(env.DB).batch([
    withD1Retry(env.DB)
      .prepare(
        'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
      )
      .bind(nowIso, tokenId, user.id),
    prepareAuditLogInsert(
      env.DB,
      {
        actorUserId: user.id,
        action: 'TOKEN_REVOKE',
        targetType: 'api_token',
        targetId: tokenId,
        ip: getClientIp(request),
        userAgent: request.headers.get('User-Agent') || undefined,
      },
      nowIso
    ),
  ])

  return jsonResponse({ success: true })
}
