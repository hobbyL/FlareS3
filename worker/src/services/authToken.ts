import type { Env } from '../config/env'
import type { AuthUser } from '../middleware/authSession'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type SignedAuthTokenHeader = {
  alg: 'HS256'
  typ: 'JWT'
}

type SignedAuthTokenPayload = {
  sid: string
  sub: string
  username: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled' | 'deleted'
  quota_bytes: number
  iat: number
  iat_ms: number
  exp: number
}

export type VerifiedAuthToken = {
  sessionId: string
  user: AuthUser
  issuedAtMs: number
  expiresAtSeconds: number
}

export function getAuthTokenSecret(env: Env): string {
  return String(env.AUTH_TOKEN_SECRET || env.R2_MASTER_KEY || '').trim()
}

export function isLikelySignedAuthToken(token: string): boolean {
  return token.split('.').length === 3
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function jsonToBase64Url(value: unknown): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)))
}

function parseBase64UrlJson<T>(value: string): T {
  return JSON.parse(decoder.decode(base64UrlToBytes(value))) as T
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

async function sign(input: string, secret: string): Promise<string> {
  const key = await importSigningKey(secret)
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(input) as unknown as BufferSource
  )
  return bytesToBase64Url(new Uint8Array(signature))
}

async function verifySignature(
  input: string,
  signaturePart: string,
  secret: string
): Promise<boolean> {
  try {
    const key = await importSigningKey(secret)
    return crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(signaturePart) as unknown as BufferSource,
      encoder.encode(input) as unknown as BufferSource
    )
  } catch {
    return false
  }
}

export async function createSignedAuthToken(
  env: Env,
  {
    sessionId,
    user,
    issuedAtMs,
    expiresAtSeconds,
  }: {
    sessionId: string
    user: AuthUser
    issuedAtMs: number
    expiresAtSeconds: number
  }
): Promise<string | null> {
  const secret = getAuthTokenSecret(env)
  if (!secret) {
    return null
  }

  const header: SignedAuthTokenHeader = { alg: 'HS256', typ: 'JWT' }
  const payload: SignedAuthTokenPayload = {
    sid: sessionId,
    sub: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    quota_bytes: user.quota_bytes,
    iat: Math.floor(issuedAtMs / 1000),
    iat_ms: issuedAtMs,
    exp: expiresAtSeconds,
  }
  const signingInput = `${jsonToBase64Url(header)}.${jsonToBase64Url(payload)}`
  const signature = await sign(signingInput, secret)
  return `${signingInput}.${signature}`
}

export async function verifySignedAuthToken(
  env: Env,
  token: string
): Promise<VerifiedAuthToken | null> {
  if (!isLikelySignedAuthToken(token)) {
    return null
  }

  const secret = getAuthTokenSecret(env)
  if (!secret) {
    return null
  }

  const [headerPart, payloadPart, signaturePart] = token.split('.')
  if (!headerPart || !payloadPart || !signaturePart) {
    return null
  }

  const signingInput = `${headerPart}.${payloadPart}`
  if (!(await verifySignature(signingInput, signaturePart, secret))) {
    return null
  }

  try {
    const header = parseBase64UrlJson<SignedAuthTokenHeader>(headerPart)
    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      return null
    }

    const payload = parseBase64UrlJson<SignedAuthTokenPayload>(payloadPart)
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (!payload.sid || !payload.sub || !payload.username) {
      return null
    }
    if (payload.role !== 'admin' && payload.role !== 'user') {
      return null
    }
    if (payload.status !== 'active') {
      return null
    }
    if (!Number.isFinite(payload.quota_bytes) || payload.quota_bytes <= 0) {
      return null
    }
    if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) {
      return null
    }

    const issuedAtMs = Number.isFinite(payload.iat_ms) ? payload.iat_ms : payload.iat * 1000
    if (!Number.isFinite(issuedAtMs) || issuedAtMs <= 0) {
      return null
    }

    return {
      sessionId: String(payload.sid),
      user: {
        id: String(payload.sub),
        username: String(payload.username),
        role: payload.role,
        status: payload.status,
        quota_bytes: Number(payload.quota_bytes),
      },
      issuedAtMs,
      expiresAtSeconds: payload.exp,
    }
  } catch {
    return null
  }
}
