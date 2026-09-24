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

export function getClientIp(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP')
  if (cfIp) return cfIp
  const forwarded = request.headers.get('X-Forwarded-For')
  if (forwarded) return forwarded.split(',')[0].trim()
  return 'unknown'
}

async function isBlocked(db: D1Database, ip: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT blocked_until FROM rate_limits WHERE ip = ?')
    .bind(ip)
    .first('blocked_until')
  if (!row) return false
  const blockedUntil = new Date(String(row))
  if (Number.isNaN(blockedUntil.getTime())) return false
  if (Date.now() < blockedUntil.getTime()) return true
  await db
    .prepare('UPDATE rate_limits SET blocked_until = NULL, failed_attempts = 0 WHERE ip = ?')
    .bind(ip)
    .run()
  return false
}

async function allowScopedRequest(
  db: D1Database,
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<boolean> {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const nowSeconds = Math.floor(nowMs / 1000)
  const result = await db
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
  await env.DB.prepare(
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

function buildShareRateLimitKey(shareCode: string, ip: string): string {
  return `${SHARE_SCOPE_PREFIX}${String(shareCode || '').trim()}:${ip}`
}

export async function recordSharePasswordFailedAttempt(
  env: Env,
  shareCode: string,
  ip: string
): Promise<void> {
  const key = buildShareRateLimitKey(shareCode, ip)
  const config = getRateLimitConfig(env)
  const blockedUntil = new Date(Date.now() + config.shareBlockDurationMs).toISOString()
  await env.DB.prepare(
    `INSERT INTO rate_limits (ip, failed_attempts, blocked_until)
       VALUES (?, 1, NULL)
       ON CONFLICT(ip) DO UPDATE SET
         failed_attempts = COALESCE(failed_attempts, 0) + 1,
         blocked_until = CASE
           WHEN COALESCE(failed_attempts, 0) + 1 >= ? THEN ?
           ELSE blocked_until
         END`
  )
    .bind(key, config.shareMaxFailedAttempts, blockedUntil)
    .run()
}

export async function clearSharePasswordFailedAttempts(
  env: Env,
  shareCode: string,
  ip: string
): Promise<void> {
  const key = buildShareRateLimitKey(shareCode, ip)
  await env.DB.prepare(
    'UPDATE rate_limits SET failed_attempts = 0, blocked_until = NULL WHERE ip = ?'
  )
    .bind(key)
    .run()
}

export async function isSharePasswordBlocked(
  env: Env,
  shareCode: string,
  ip: string
): Promise<boolean> {
  const key = buildShareRateLimitKey(shareCode, ip)
  const row = await env.DB.prepare('SELECT blocked_until FROM rate_limits WHERE ip = ?')
    .bind(key)
    .first('blocked_until')
  if (!row) return false

  const blockedUntil = new Date(String(row))
  if (Number.isNaN(blockedUntil.getTime())) {
    await env.DB.prepare(
      'UPDATE rate_limits SET blocked_until = NULL, failed_attempts = 0 WHERE ip = ?'
    )
      .bind(key)
      .run()
    return false
  }

  if (Date.now() < blockedUntil.getTime()) {
    return true
  }

  await env.DB.prepare(
    'UPDATE rate_limits SET blocked_until = NULL, failed_attempts = 0 WHERE ip = ?'
  )
    .bind(key)
    .run()
  return false
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

      const key = `${globalKey}:${url.pathname}`
      if (!(await allowScopedRequest(env.DB, key, config.publicMax, config.publicWindowMs))) {
        return jsonResponse({ error: '请求频率超限' }, 429)
      }
    }
  } catch (error) {
    console.error('[rateLimitMiddleware] failed', error)
    return jsonResponse({ error: '服务异常' }, 500)
  }
}
