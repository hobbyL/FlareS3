import type { Env } from '../config/env'
import { hashToken } from '../utils/token'

const COOKIE_NAME = 'flares3_session'

export type AuthUser = {
  id: string
  username: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled' | 'deleted'
  quota_bytes: number
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
  const tokenHash = await hashToken(token)
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
    return
  }
  const expiresAt = new Date(String(session.expires_at))
  if (Number.isNaN(expiresAt.getTime()) || Date.now() > expiresAt.getTime()) {
    return
  }
  if (session.status !== 'active') {
    return
  }
  const req = request as Request & { user?: AuthUser; sessionId?: string }
  req.user = {
    id: String(session.user_id),
    username: String(session.username),
    role: session.role as 'admin' | 'user',
    status: session.status as 'active' | 'disabled' | 'deleted',
    quota_bytes: Number(session.quota_bytes),
  }
  req.sessionId = String(session.session_id)
}
