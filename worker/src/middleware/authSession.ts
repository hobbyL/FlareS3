import type { Env } from '../config/env'
import {
  isLikelySignedAuthToken,
  verifySignedAuthToken,
  type VerifiedAuthToken,
} from '../services/authToken'
import { isApiToken, validateApiToken } from '../services/apiTokens'
import { hashToken } from '../utils/token'
import { withD1Retry } from '../utils/db'

const COOKIE_NAME = 'flares3_session'
const SESSION_CACHE_TTL_MS = 5 * 1000
const MAX_SESSION_CACHE_ENTRIES = 500
const MAX_INVALIDATION_ENTRIES = 1000

export type AuthUser = {
  id: string
  username: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled' | 'deleted'
  quota_bytes: number
}

/**
 * 鉴权来源标记：会话（cookie/JWT/opaque session）为 'session'，个人访问令牌为 'pat'。
 * 敏感端点（改密 / 会话管理 / token 自管理）据此拒绝 PAT，防止令牌自我扩权 / 自传播。
 */
export type AuthKind = 'session' | 'pat'

type AuthedRequestState = Request & {
  user?: AuthUser
  sessionId?: string
  authKind?: AuthKind
}

type SessionLookupResult = {
  sessionId: string
  user: AuthUser
  expiresAtMs: number
}

type SessionCacheEntry = SessionLookupResult & {
  cachedAtMs: number
}

const sessionCache = new Map<string, SessionCacheEntry>()
const sessionLookupPromises = new Map<string, Promise<SessionLookupResult | null>>()
const invalidatedSignedSessions = new Map<string, number>()
const invalidatedUserTokens = new Map<string, number>()

/**
 * 失效表的条目寿命：超过该时长的失效时间戳已无判定价值——
 * 会话缓存 TTL 只有 5s，落库的 revoked_at 才是跨 isolate 的事实源，
 * 本 map 只是「同一 isolate 内立即生效」的加速层。
 */
const INVALIDATION_RETENTION_MS = 10 * 60 * 1000

/**
 * 淘汰与「最旧」有关的两类条目，而不是盲删最早插入的一条：
 *
 * 1. 已过期条目（时间戳早于保留窗口）先清掉，它们已不参与任何判定；
 * 2. 仍存活但超出容量时，淘汰时间戳最小的一条——该条对「issuedAtMs <= 失效时间戳」
 *    的拦截范围最小，删它造成的失效窗口最短。
 *
 * 先前的 FIFO（删 map 中最早插入的 key）在「反复失效同一 sessionId」这类场景下
 * 会误删刚更新的条目、留下更早的时间戳，使已撤销请求恢复通过。
 */
function setBoundedInvalidation(map: Map<string, number>, key: string, value: number): void {
  const cutoff = value - INVALIDATION_RETENTION_MS
  if (map.size >= MAX_INVALIDATION_ENTRIES && !map.has(key)) {
    for (const [entryKey, entryValue] of map) {
      if (entryValue < cutoff) {
        map.delete(entryKey)
      }
    }
    while (map.size >= MAX_INVALIDATION_ENTRIES) {
      let oldestKey: string | null = null
      let oldestValue = Infinity
      for (const [entryKey, entryValue] of map) {
        if (entryValue < oldestValue) {
          oldestValue = entryValue
          oldestKey = entryKey
        }
      }
      if (oldestKey === null) break
      map.delete(oldestKey)
    }
  }
  map.set(key, value)
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('Cookie') || ''
  const cookies: Record<string, string> = {}
  header.split(';').forEach((part) => {
    const [name, ...rest] = part.trim().split('=')
    if (!name) return
    cookies[name] = rest.join('=')
  })
  return cookies
}

export function getSessionCookieName(): string {
  return COOKIE_NAME
}

export function invalidateSessionCache(tokenHash: string): void {
  sessionCache.delete(tokenHash)
  sessionLookupPromises.delete(tokenHash)
}

export function invalidateUserAuthTokens(
  userId: string,
  invalidatedAtMs: number = Date.now()
): void {
  setBoundedInvalidation(invalidatedUserTokens, userId, invalidatedAtMs)
  for (const [tokenHash, cached] of sessionCache) {
    if (cached.user.id === userId) {
      sessionCache.delete(tokenHash)
      sessionLookupPromises.delete(tokenHash)
    }
  }
}

/**
 * 按 sessionId 做 isolate 级失效（加速层）。
 *
 * 三层失效语义：本 map（本 isolate 即时）→ sessions.revoked_at（跨 isolate
 * 事实源）→ 会话缓存 TTL 5s（收敛窗口）。判定条件是签名 token 的
 * issuedAtMs <= 失效时间戳，因此必须在 batch 落库 revoked_at 之后调用。
 */
export function invalidateSignedSession(
  sessionId: string,
  invalidatedAtMs: number = Date.now()
): void {
  setBoundedInvalidation(invalidatedSignedSessions, sessionId, invalidatedAtMs)
}

function isSignedSessionLocallyInvalidated(session: VerifiedAuthToken): boolean {
  const sessionInvalidatedAt = invalidatedSignedSessions.get(session.sessionId)
  if (sessionInvalidatedAt && session.issuedAtMs <= sessionInvalidatedAt) {
    return true
  }

  const userInvalidatedAt = invalidatedUserTokens.get(session.user.id)
  if (userInvalidatedAt && session.issuedAtMs <= userInvalidatedAt) {
    return true
  }

  return false
}

export async function invalidateAuthToken(env: Env, token: string): Promise<string> {
  const signedSession = await verifySignedAuthToken(env, token)
  if (signedSession) {
    invalidateSignedSession(signedSession.sessionId)
  }

  const tokenHash = await hashToken(token)
  invalidateSessionCache(tokenHash)
  return tokenHash
}

function getCachedSession(tokenHash: string): SessionLookupResult | null {
  const cached = sessionCache.get(tokenHash)
  if (!cached) {
    return null
  }
  const now = Date.now()
  if (now >= cached.expiresAtMs || now - cached.cachedAtMs > SESSION_CACHE_TTL_MS) {
    sessionCache.delete(tokenHash)
    return null
  }
  return cached
}

function cacheSession(tokenHash: string, session: SessionLookupResult): void {
  if (sessionCache.size >= MAX_SESSION_CACHE_ENTRIES) {
    const oldestKey = sessionCache.keys().next().value
    if (oldestKey) {
      sessionCache.delete(oldestKey)
    }
  }
  sessionCache.set(tokenHash, {
    ...session,
    cachedAtMs: Date.now(),
  })
}

async function querySession(env: Env, tokenHash: string): Promise<SessionLookupResult | null> {
  const result = await withD1Retry(env.DB)
    .prepare(
      `SELECT s.id AS session_id,
              s.expires_at,
              s.revoked_at,
              u.id AS user_id,
              u.username,
              u.role,
              u.status,
              u.quota_bytes
         FROM sessions s
         INNER JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?
        LIMIT 1`
    )
    .bind(tokenHash)
    .first<{
      session_id: string
      expires_at: string
      revoked_at: string | null
      user_id: string
      username: string
      role: string
      status: string
      quota_bytes: number
    }>()

  if (!result || result.revoked_at) {
    return null
  }
  const expiresAt = new Date(String(result.expires_at))
  const expiresAtMs = expiresAt.getTime()
  if (Number.isNaN(expiresAtMs) || Date.now() > expiresAtMs) {
    return null
  }
  if (result.status !== 'active') {
    return null
  }
  return {
    user: {
      id: String(result.user_id),
      username: String(result.username),
      role: result.role as 'admin' | 'user',
      status: result.status as 'active' | 'disabled' | 'deleted',
      quota_bytes: Number(result.quota_bytes),
    },
    sessionId: String(result.session_id),
    expiresAtMs,
  }
}

async function loadSession(env: Env, tokenHash: string): Promise<SessionLookupResult | null> {
  const cached = getCachedSession(tokenHash)
  if (cached) {
    return cached
  }

  const pending = sessionLookupPromises.get(tokenHash)
  if (pending) {
    return pending
  }

  // 结果是纯 `sessions` 行读取，与 invalidatedUserTokens 无关，因此缓存写入只受
  // 容量约束：先前按 `invalidatedUserTokens.get(userId)` 跳过缓存的做法，在
  // 「用户从未有过用户级失效」与「失效表满载淘汰条目」两种情况下都会永久停写缓存
  // （前者的整型时间戳恒为真值、后者的失效时间戳落入未来），使每次请求都多打一次 D1。
  // 失效后的正确性由失效时间戳本身保证：中间件先查 `isSignedSessionLocallyInvalidated`
  // （毫秒级），随后仍有 `sessions.revoked_at` 兜底，缓存只影响收敛速度。
  const promise = querySession(env, tokenHash)
    .then((session) => {
      if (session) {
        cacheSession(tokenHash, session)
      }
      return session
    })
    .finally(() => {
      if (sessionLookupPromises.get(tokenHash) === promise) {
        sessionLookupPromises.delete(tokenHash)
      }
    })
  sessionLookupPromises.set(tokenHash, promise)
  return promise
}

export async function authSessionMiddleware(
  request: Request,
  env: Env
): Promise<Response | undefined> {
  const cookies = parseCookies(request)
  const header = request.headers.get('Authorization')
  let token = cookies[COOKIE_NAME]
  if (!token && header && header.startsWith('Bearer ')) {
    token = header.replace('Bearer ', '').trim()
  }
  if (!token) {
    return
  }

  const signedSession = await verifySignedAuthToken(env, token)
  if (signedSession) {
    if (isSignedSessionLocallyInvalidated(signedSession)) {
      return
    }
    const tokenHash = await hashToken(token)
    const session = await loadSession(env, tokenHash)
    if (
      !session ||
      session.sessionId !== signedSession.sessionId ||
      session.user.id !== signedSession.user.id
    ) {
      return
    }
    const req = request as AuthedRequestState
    req.user = session.user
    req.sessionId = session.sessionId
    req.authKind = 'session'
    return
  }

  if (isLikelySignedAuthToken(token)) {
    return
  }

  // PAT 分支：fla_ 前缀 opaque 令牌走 api_tokens 校验，置于 sessions 查询之前，
  // 避免 PAT 多打一次无谓的 sessions 表查询。命中仅装载 user + authKind='pat'，
  // 有意不设 sessionId（PAT 不属于任何会话；会话管理端点据 authKind 拒绝）。
  if (isApiToken(token)) {
    const validation = await validateApiToken(env, token)
    if (!validation) {
      return
    }
    const req = request as AuthedRequestState
    req.user = validation.user
    req.authKind = 'pat'
    return
  }

  const tokenHash = await hashToken(token)
  const session = await loadSession(env, tokenHash)
  if (!session) {
    return
  }
  const req = request as AuthedRequestState
  req.user = session.user
  req.sessionId = session.sessionId
  req.authKind = 'session'
}
