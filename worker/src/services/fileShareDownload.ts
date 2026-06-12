import type { Env } from '../config/env'
import {
  extractR2ConfigIdFromKey,
  generateDownloadUrl,
  resolveR2ConfigForKey,
  sanitizeContentDispositionFilename,
} from './r2'
import { createProvider } from './storage/factory'
import { MAX_UPSTREAM_ERROR_TEXT_BYTES, readBoundedResponseText } from './upstreamResponsePolicy'
import { calcPresignedDownloadUrlTtlSeconds } from './presignedUrlTtl'

export type SharedDownloadResult =
  | { ok: true; response: Response }
  | { ok: false; error: { status: number; message: string } }

export async function buildSanitizedSharedDownloadResponse(
  upstream: Response,
  filename: string
): Promise<SharedDownloadResult> {
  if (!upstream.ok) {
    const text = await readBoundedResponseText(
      upstream,
      MAX_UPSTREAM_ERROR_TEXT_BYTES,
      '共享文件下载错误响应',
      { truncate: true }
    ).catch(() => '')
    return {
      ok: false,
      error: { status: upstream.status || 502, message: text || '文件下载失败，请稍后重试' },
    }
  }

  const headers = new Headers()
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')

  const contentType = upstream.headers.get('Content-Type')
  if (contentType) headers.set('Content-Type', contentType)

  const safeFilename = sanitizeContentDispositionFilename(filename)
  headers.set('Content-Disposition', `attachment; filename="${safeFilename}"`)

  const contentLength = upstream.headers.get('Content-Length')
  if (contentLength && /^\d+$/.test(contentLength)) headers.set('Content-Length', contentLength)

  return {
    ok: true,
    response: new Response(upstream.body, {
      status: upstream.status,
      headers,
    }),
  }
}

export async function buildSharedDownloadResponse(
  env: Env,
  file: { r2_key: string; filename: string; expires_at: string; config_id?: string | null }
): Promise<SharedDownloadResult> {
  const explicitProviderConfigId = String(file.config_id || '').trim()
  if (explicitProviderConfigId && !extractR2ConfigIdFromKey(file.r2_key)) {
    const provider = await createProvider(env, explicitProviderConfigId)
    if (!provider) {
      return { ok: false, error: { status: 503, message: '存储配置未找到' } }
    }

    try {
      const result = await provider.download(file.r2_key, file.filename, 3600)
      if (result.kind === 'redirect') {
        const upstream = await fetch(result.url)
        return buildSanitizedSharedDownloadResponse(upstream, file.filename)
      }
      return { ok: true, response: result.response }
    } catch {
      return { ok: false, error: { status: 502, message: '文件下载失败，请稍后重试' } }
    }
  }

  const loaded = await resolveR2ConfigForKey(env, file.r2_key)
  if (!loaded) {
    return { ok: false, error: { status: 503, message: 'R2 未配置' } }
  }

  const expiresAt = new Date(file.expires_at)
  const expiresAtMs = expiresAt.getTime()
  if (Number.isNaN(expiresAtMs)) {
    return { ok: false, error: { status: 500, message: '文件过期时间无效' } }
  }

  const ttl = calcPresignedDownloadUrlTtlSeconds(expiresAt)
  const url = await generateDownloadUrl(loaded.config, file.r2_key, file.filename, ttl)

  let upstream: Response
  try {
    upstream = await fetch(url)
  } catch {
    return { ok: false, error: { status: 502, message: '文件下载失败，请稍后重试' } }
  }

  return buildSanitizedSharedDownloadResponse(upstream, file.filename)
}
