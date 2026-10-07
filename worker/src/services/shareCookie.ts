import type { Env } from '../config/env'
import { getAuthTokenSecret } from './authToken'

const encoder = new TextEncoder()

/** cookie 免密凭证的单次有效期上限（秒）：即使分享长期有效也只签 24h */
export const SHARE_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60

/**
 * 构造 folder 分享密码 cookie 名：`fs_<code>`。
 * 配合 `Path=/f/<code>` 限定作用域，不同分享的凭证互不可见。
 */
export function buildShareCookieName(code: string): string {
  return `fs_${code}`
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function hmacSign(input: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(input) as unknown as BufferSource
  )
  return bytesToBase64Url(new Uint8Array(signature))
}

/**
 * 常量时间字符串比较：长度不同直接失败（长度本身不敏感——
 * 签名是固定长度的 base64url），相同长度则逐字符 XOR 累加后一次判定。
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * 为分享 code 签发密码免重输凭证。
 *
 * 值格式 `${expirySeconds}.${hmac}`，HMAC 输入 `${code}:${expiry}`，
 * 密钥复用 `AUTH_TOKEN_SECRET`（不引入新 secret）。有效期取
 * min(分享过期剩余时间, 24h)；secret 未配置时返回 null（调用方退化为
 * 每次访问都要求输入密码，不阻断分享本身）。
 */
export async function signShareCookie(
  env: Env,
  code: string,
  shareExpiresAtMs?: number | null
): Promise<string | null> {
  const secret = getAuthTokenSecret(env)
  const normalizedCode = String(code || '').trim()
  if (!secret || !normalizedCode) {
    return null
  }

  const nowMs = Date.now()
  let maxAgeSeconds = SHARE_COOKIE_MAX_AGE_SECONDS
  if (typeof shareExpiresAtMs === 'number' && Number.isFinite(shareExpiresAtMs)) {
    const remainingSeconds = Math.floor((shareExpiresAtMs - nowMs) / 1000)
    maxAgeSeconds = Math.min(maxAgeSeconds, Math.max(1, remainingSeconds))
  }

  const expirySeconds = Math.floor(nowMs / 1000) + maxAgeSeconds
  const hmac = await hmacSign(`${normalizedCode}:${expirySeconds}`, secret)
  return `${expirySeconds}.${hmac}`
}

/**
 * 验证 cookie 凭证：解析 `${expiry}.${hmac}`，检查未过期后重算签名做
 * 常量时间比较。任何格式/过期/篡改失败一律返回 false（不区分原因，
 * 避免向探测方泄露校验细节）。
 */
export async function verifyShareCookie(
  env: Env,
  code: string,
  value: string | null | undefined
): Promise<boolean> {
  const secret = getAuthTokenSecret(env)
  const normalizedCode = String(code || '').trim()
  const token = String(value || '').trim()
  if (!secret || !normalizedCode || !token) {
    return false
  }

  const dotIndex = token.indexOf('.')
  if (dotIndex <= 0 || dotIndex === token.length - 1) {
    return false
  }

  const expiryPart = token.slice(0, dotIndex)
  const signaturePart = token.slice(dotIndex + 1)
  if (!/^\d+$/.test(expiryPart)) {
    return false
  }

  const expirySeconds = Number(expiryPart)
  if (!Number.isFinite(expirySeconds) || expirySeconds <= Math.floor(Date.now() / 1000)) {
    return false
  }

  const expected = await hmacSign(`${normalizedCode}:${expiryPart}`, secret)
  return constantTimeEquals(expected, signaturePart)
}
