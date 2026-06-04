import type { Env } from '../config/env'
import {
  isLikelySignedAuthToken,
  verifySignedAuthToken,
  type VerifiedAuthToken,
} from '../services/authToken'
import { hashToken } from '../utils/token'

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

function invalidateSignedSession(sessionId: string, invalidatedAtMs: number = Date.now()): void {
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
  const session = await env.DB.prepare(
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
  if (!session || session.revoked_at) {
    return null
  }
  const expiresAt = new Date(String(session.expires_at))
  const expiresAtMs = expiresAt.getTime()
  if (Number.isNaN(expiresAtMs) || Date.now() > expiresAtMs) {
    return null
  }
  if (session.status !== 'active') {
    return null
  }
  return {
    user: {
      id: String(session.user_id),
      username: String(session.username),
      role: session.role as 'admin' | 'user',
      status: session.status as 'active' | 'disabled' | 'deleted',
      quota_bytes: Number(session.quota_bytes),
    },
    sessionId: String(session.session_id),
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
    const req = request as Request & { user?: AuthUser; sessionId?: string }
    req.user = signedSession.user
    req.sessionId = signedSession.sessionId
    return
  }

  if (isLikelySignedAuthToken(token)) {
    return
  }

  const tokenHash = await hashToken(token)
  const session = await loadSession(env, tokenHash)
  if (!session) {
    return
  }
  const req = request as Request & { user?: AuthUser; sessionId?: string }
  req.user = session.user
  req.sessionId = session.sessionId
}
