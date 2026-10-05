import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import {
  getRateLimitConfig,
  PUBLIC_RATE_LIMIT_PREFIX,
  SHARE_SCOPE_PREFIX,
} from '../config/rateLimit'
import { jsonResponse } from '../utils/response'

function shouldUsePersistentRateLimit(request: Request): boolean {
  const url = new URL(request.url)
  return request.method === 'POST' && url.pathname === '/api/auth/login'
}

function shouldUsePublicRateLimit(request: Request): boolean {
  const url = new URL(request.url)
  const pathname = url.pathname
  if (pathname.startsWith('/s/') || pathname.startsWith('/t/') || pathname.startsWith('/f/')) {
    return true
  }
  if (/^\/api\/files\/[^/]+\/download$/.test(pathname)) {
    return true
  }
  return false
}

/**
 * 公开入口的 per-path 限流类别。
 *
 * 归一为定长类别而非完整 pathname：随机 pathname（如爆破 `/s/<随机串>`）
 * 不再为每个请求创建新的 rate_limits 行（防表膨胀），同类别共享一个计数桶，
 * 且该桶始终受全局 per-IP 桶约束。
 */
function categorizePublicPath(pathname: string): 's' | 't' | 'f' | 'dl' | null {
  if (pathname.startsWith('/s/')) return 's'
  if (pathname.startsWith('/t/')) return 't'
  if (pathname.startsWith('/f/')) return 'f'
  if (/^\/api\/files\/[^/]+\/download$/.test(pathname)) return 'dl'
  return null
}

/**
 * 客户端 IP 仅信任 Cloudflare 注入的 CF-Connecting-IP。
 *
 * 不回退 X-Forwarded-For：其首值可被客户端伪造，任何非 CF 前置部署下
 * 会绕过全部 IP 限流与封禁。本项目仅部署于 Cloudflare 边缘；
 * 缺失时返回 'unknown'（该聚合桶自身受限流约束）。
 */
export function getClientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'unknown'
}

async function isBlockedByKey(db: D1Database, key: string): Promise<boolean> {
  const row = await withD1Retry(db)
    .prepare('SELECT blocked_until FROM rate_limits WHERE ip = ?')
    .bind(key)
    .first('blocked_until')
  if (!row) return false
  const blockedUntil = new Date(String(row))
  if (Number.isNaN(blockedUntil.getTime())) return false
  if (Date.now() < blockedUntil.getTime()) return true
  await withD1Retry(db)
    .prepare('UPDATE rate_limits SET blocked_until = NULL, failed_attempts = 0 WHERE ip = ?')
    .bind(key)
    .run()
  return false
}

async function isBlocked(db: D1Database, ip: string): Promise<boolean> {
  return isBlockedByKey(db, ip)
}

/**
 * 滑动窗口计数：窗口内未超限则 +1 并放行，超限则拒绝。
 *
 * 导出供管理端低频敏感操作（如 secrets reveal）复用同一计数机制。
 */
export async function allowScopedRequest(
  db: D1Database,
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<boolean> {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const nowSeconds = Math.floor(nowMs / 1000)
  const result = await withD1Retry(db)
    .prepare(
      `INSERT INTO rate_limits (ip, request_count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET
         request_count = CASE
           WHEN strftime('%s', window_start) IS NULL THEN 1
           WHEN (? - strftime('%s', window_start)) * 1000 > ? THEN 1
           ELSE request_count + 1
         END,
         window_start = CASE
           WHEN strftime('%s', window_start) IS NULL THEN ?
           WHEN (? - strftime('%s', window_start)) * 1000 > ? THEN ?
           ELSE window_start
         END
       WHERE
         strftime('%s', window_start) IS NULL
         OR (? - strftime('%s', window_start)) * 1000 > ?
         OR request_count < ?`
    )
    .bind(
      key,
      nowIso,
      nowSeconds,
      windowMs,
      nowIso,
      nowSeconds,
      windowMs,
      nowIso,
      nowSeconds,
      windowMs,
      maxRequests
    )
    .run()
  const changes = Number((result as any)?.meta?.changes ?? 0)
  return !result.error && Number.isFinite(changes) && changes > 0
}

export async function recordFailedAttempt(env: Env, ip: string): Promise<void> {
  const config = getRateLimitConfig(env)
  const blockedUntil = new Date(Date.now() + config.loginBlockDurationMs).toISOString()
  await withD1Retry(env.DB)
    .prepare(
      `INSERT INTO rate_limits (ip, failed_attempts, blocked_until)
       VALUES (?, 1, NULL)
       ON CONFLICT(ip) DO UPDATE SET
         failed_attempts = COALESCE(failed_attempts, 0) + 1,
         blocked_until = CASE
           WHEN COALESCE(failed_attempts, 0) + 1 >= ? THEN ?
           ELSE blocked_until
         END`
    )
    .bind(ip, config.loginMaxFailedAttempts, blockedUntil)
    .run()
}

/**
 * 用户名维度的登录失败计数 key。
 *
 * 用 SHA-256 摘要前 16 字符避免明文用户名入库；与 IP 维度同阈值，
 * 换 IP 的分布式爆破在同一用户名上仍会触发封禁。
 */
async function buildUsernameScopeKey(username: string): Promise<string> {
  const data = new TextEncoder().encode(username)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `login-user:${hex.slice(0, 16)}`
}

/**
 * 记录用户名维度登录失败（与 IP 维度互补，防换 IP 绕过）。
 */
export async function recordFailedAttemptForUsername(env: Env, username: string): Promise<void> {
  const key = await buildUsernameScopeKey(username)
  const config = getRateLimitConfig(env)
  const blockedUntil = new Date(Date.now() + config.loginBlockDurationMs).toISOString()
  await withD1Retry(env.DB)
    .prepare(
      `INSERT INTO rate_limits (ip, failed_attempts, blocked_until)
       VALUES (?, 1, NULL)
       ON CONFLICT(ip) DO UPDATE SET
         failed_attempts = COALESCE(failed_attempts, 0) + 1,
         blocked_until = CASE
           WHEN COALESCE(failed_attempts, 0) + 1 >= ? THEN ?
           ELSE blocked_until
         END`
    )
    .bind(key, config.loginMaxFailedAttempts, blockedUntil)
    .run()
}

/**
 * 用户名是否处于封禁期（IP 无关，任一 IP 的尝试都拒绝）。
 */
export async function isUsernameBlocked(env: Env, username: string): Promise<boolean> {
  const key = await buildUsernameScopeKey(username)
  return isBlockedByKey(env.DB, key)
}

function buildShareRateLimitKey(shareCode: string, ip: string): string {
  return `${SHARE_SCOPE_PREFIX}${String(shareCode || '').trim()}:${ip}`
}

/**
 * 分享码维度的口令失败计数 key（不含 IP）。
 *
 * 与 share:{code}:{ip} 互补：换 IP 的分布式口令爆破在同一分享码上仍触发封禁。
 */
function buildShareCodeScopeKey(shareCode: string): string {
  return `share-pass:${String(shareCode || '').trim()}`
}

export async function recordSharePasswordFailedAttempt(
  env: Env,
  shareCode: string,
  ip: string
): Promise<void> {
  const key = buildShareRateLimitKey(shareCode, ip)
  const codeKey = buildShareCodeScopeKey(shareCode)
  const config = getRateLimitConfig(env)
  const blockedUntil = new Date(Date.now() + config.shareBlockDurationMs).toISOString()
  const statement = withD1Retry(env.DB).prepare(
    `INSERT INTO rate_limits (ip, failed_attempts, blocked_until)
     VALUES (?, 1, NULL)
     ON CONFLICT(ip) DO UPDATE SET
       failed_attempts = COALESCE(failed_attempts, 0) + 1,
       blocked_until = CASE
         WHEN COALESCE(failed_attempts, 0) + 1 >= ? THEN ?
         ELSE blocked_until
       END`
  )
  // 同时记录 IP 维度与分享码维度，任一达到阈值都封禁
  await withD1Retry(env.DB).batch([
    statement.bind(key, config.shareMaxFailedAttempts, blockedUntil),
    statement.bind(codeKey, config.shareMaxFailedAttempts, blockedUntil),
  ])
}

export async function clearSharePasswordFailedAttempts(
  env: Env,
  shareCode: string,
  ip: string
): Promise<void> {
  const key = buildShareRateLimitKey(shareCode, ip)
  const codeKey = buildShareCodeScopeKey(shareCode)
  // 密码验证成功后同时清除 IP 维度与分享码维度的失败计数
  await withD1Retry(env.DB).batch([
    withD1Retry(env.DB)
      .prepare('UPDATE rate_limits SET failed_attempts = 0, blocked_until = NULL WHERE ip = ?')
      .bind(key),
    withD1Retry(env.DB)
      .prepare('UPDATE rate_limits SET failed_attempts = 0, blocked_until = NULL WHERE ip = ?')
      .bind(codeKey),
  ])
}

export async function isSharePasswordBlocked(
  env: Env,
  shareCode: string,
  ip: string
): Promise<boolean> {
  const key = buildShareRateLimitKey(shareCode, ip)
  const codeKey = buildShareCodeScopeKey(shareCode)
  // 任一维度处于封禁期即拒绝（IP 维度先查，命中可直接短路返回）
  if (await isBlockedByKey(env.DB, key)) return true
  return isBlockedByKey(env.DB, codeKey)
}

export async function rateLimitMiddleware(
  request: Request,
  env: Env
): Promise<Response | undefined> {
  const loginRateLimit = shouldUsePersistentRateLimit(request)
  const publicRateLimit = shouldUsePublicRateLimit(request)
  if (!loginRateLimit && !publicRateLimit) {
    return
  }

  try {
    const config = getRateLimitConfig(env)
    const ip = getClientIp(request)
    if (loginRateLimit) {
      if (await isBlocked(env.DB, ip)) {
        return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429)
      }
      if (!(await allowScopedRequest(env.DB, ip, config.loginMax, config.loginWindowMs))) {
        return jsonResponse({ error: '请求频率超限' }, 429)
      }
    }
    if (publicRateLimit) {
      const url = new URL(request.url)
      const globalKey = `${PUBLIC_RATE_LIMIT_PREFIX}${ip}`
      if (!(await allowScopedRequest(env.DB, globalKey, config.publicMax, config.publicWindowMs))) {
        return jsonResponse({ error: '请求频率超限' }, 429)
      }

      // per-path 计数按入口类别归一，随机 pathname 不再创建新行（防表膨胀）
      const category = categorizePublicPath(url.pathname)
      if (category) {
        const key = `${globalKey}:${category}`
        if (!(await allowScopedRequest(env.DB, key, config.publicMax, config.publicWindowMs))) {
          return jsonResponse({ error: '请求频率超限' }, 429)
        }
      }
    }
  } catch (error) {
    console.error('[rateLimitMiddleware] failed', error)
    return jsonResponse({ error: '服务异常' }, 500)
  }
}
