import type { Env } from '../config/env'
import type { AuthUser } from '../middleware/authSession'
import { hashToken } from '../utils/token'
import { withD1Retry } from '../utils/db'

/** PAT 明文前缀：authSession 据此在 opaque 分支前快速识别 PAT，避免无谓的 sessions 查询。 */
export const API_TOKEN_PREFIX = 'fla_'

/** 随机熵：32 字节 → hex 64 字符，拼前缀后形如 `fla_<64hex>`。 */
const API_TOKEN_RANDOM_BYTES = 32

/**
 * last_used_at 节流窗口：距上次记录不足该阈值则跳过写入，
 * 避免每请求都在鉴权热路径写库（写放大）。
 */
const LAST_USED_THROTTLE_MS = 60 * 1000

/** 令牌有效期上限：365 天（创建时 expires_in 以天计，超出截断，<=0 视为永不过期）。 */
export const MAX_API_TOKEN_EXPIRES_IN_DAYS = 365

/** 对外列表项：绝不含明文 / token_hash，status 由 revoked/expires 派生。 */
export type ApiTokenListItem = {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  status: 'active' | 'expired' | 'revoked'
}

/** 创建结果：plaintext 仅此一次返回，调用方须立即呈现且永不回读。 */
export type CreatedApiToken = {
  id: string
  name: string
  token: string
  created_at: string
  expires_at: string | null
}

/** 鉴权命中结果：装载的用户 + 命中的 token id（供 last_used 节流）。 */
export type ApiTokenValidation = {
  user: AuthUser
  tokenId: string
}

/** 是否 PAT 明文（仅看前缀；真正校验在 {@link validateApiToken}）。 */
export function isApiToken(token: string): boolean {
  return typeof token === 'string' && token.startsWith(API_TOKEN_PREFIX)
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 生成一枚 PAT 明文：`fla_` + 32 字节加密随机（hex）。
 * 仅创建时产出一次，库内只存其 {@link hashToken} 结果。
 */
export function generateApiToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(API_TOKEN_RANDOM_BYTES))
  return `${API_TOKEN_PREFIX}${toHex(bytes)}`
}

/** expires_in（天）→ ISO expires_at；<=0 / 非法 → null（永不过期）；上限 365 天。 */
export function resolveExpiresAt(expiresInDays: unknown, now: Date = new Date()): string | null {
  const days = Number(expiresInDays)
  if (!Number.isFinite(days) || days <= 0) return null
  const clamped = Math.min(Math.floor(days), MAX_API_TOKEN_EXPIRES_IN_DAYS)
  return new Date(now.getTime() + clamped * 24 * 60 * 60 * 1000).toISOString()
}

function deriveStatus(
  expiresAt: string | null,
  revokedAt: string | null,
  nowMs: number
): ApiTokenListItem['status'] {
  if (revokedAt) return 'revoked'
  if (expiresAt) {
    const expMs = new Date(String(expiresAt)).getTime()
    if (!Number.isNaN(expMs) && nowMs > expMs) return 'expired'
  }
  return 'active'
}

/**
 * 校验 PAT 明文并装载活跃用户（鉴权热路径）。
 *
 * 口径：按 token_hash 命中 → 未吊销 → 未过期 → 关联用户 status='active'。
 * 命中后节流更新 last_used_at（best-effort，失败不影响鉴权）。
 *
 * @returns 命中返回 { user, tokenId }；任一校验不通过返回 null。
 */
export async function validateApiToken(
  env: Env,
  token: string
): Promise<ApiTokenValidation | null> {
  if (!isApiToken(token)) return null

  const tokenHash = await hashToken(token)
  const row = await withD1Retry(env.DB)
    .prepare(
      `SELECT t.id AS token_id,
              t.last_used_at,
              t.expires_at,
              t.revoked_at,
              u.id AS user_id,
              u.username,
              u.role,
              u.status,
              u.quota_bytes
         FROM api_tokens t
         INNER JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?
        LIMIT 1`
    )
    .bind(tokenHash)
    .first<{
      token_id: string
      last_used_at: string | null
      expires_at: string | null
      revoked_at: string | null
      user_id: string
      username: string
      role: string
      status: string
      quota_bytes: number
    }>()

  if (!row || row.revoked_at) return null
  if (row.expires_at) {
    const expMs = new Date(String(row.expires_at)).getTime()
    if (Number.isNaN(expMs) || Date.now() > expMs) return null
  }
  if (row.status !== 'active') return null

  const user: AuthUser = {
    id: String(row.user_id),
    username: String(row.username),
    role: row.role === 'admin' ? 'admin' : 'user',
    status: 'active',
    quota_bytes: Number(row.quota_bytes),
  }

  await touchLastUsed(env, String(row.token_id), row.last_used_at)

  return { user, tokenId: String(row.token_id) }
}

/**
 * 节流更新 last_used_at：距上次 <60s 则跳过；写入失败被吞（遥测字段，不得使鉴权失败）。
 */
async function touchLastUsed(env: Env, tokenId: string, lastUsedAt: string | null): Promise<void> {
  const now = Date.now()
  if (lastUsedAt) {
    const prevMs = new Date(String(lastUsedAt)).getTime()
    if (!Number.isNaN(prevMs) && now - prevMs < LAST_USED_THROTTLE_MS) return
  }
  try {
    await withD1Retry(env.DB)
      .prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
      .bind(new Date(now).toISOString(), tokenId)
      .run()
  } catch {
    // best-effort：last_used_at 为遥测字段，写入瞬时失败不影响本次鉴权结果
  }
}

/**
 * 列出某用户的全部 PAT 元数据（不含明文 / token_hash），按创建时间倒序。
 */
export async function listApiTokens(env: Env, userId: string): Promise<ApiTokenListItem[]> {
  const rows = await withD1Retry(env.DB)
    .prepare(
      `SELECT id, name, created_at, last_used_at, expires_at, revoked_at
         FROM api_tokens
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 200`
    )
    .bind(userId)
    .all<{
      id: string
      name: string
      created_at: string
      last_used_at: string | null
      expires_at: string | null
      revoked_at: string | null
    }>()

  const nowMs = Date.now()
  return (rows.results || []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
    expires_at: row.expires_at ?? null,
    status: deriveStatus(row.expires_at ?? null, row.revoked_at ?? null, nowMs),
  }))
}
