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
const SESSION_CACHE_TTL_MS = 15 * 1000
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

function setBoundedInvalidation(map: Map<string, number>, key: string, value: number): void {
  if (map.size >= MAX_INVALIDATION_ENTRIES && !map.has(key)) {
    const oldestKey = map.keys().next().value
    if (oldestKey) {
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
}

/**
 * 按 sessionId 做 isolate 级失效（加速层）。
 *
 * 三层失效语义：本 map（本 isolate 即时）→ sessions.revoked_at（跨 isolate
 * 事实源）→ 会话缓存 TTL 15s（收敛窗口）。判定条件是签名 token 的
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

  const promise = querySession(env, tokenHash)
    .then((session) => {
      if (session) {
        cacheSession(tokenHash, session)
      }
      return session
    })
    .finally(() => {
      sessionLookupPromises.delete(tokenHash)
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
