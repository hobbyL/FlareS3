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
import { fetchWithUpstreamTimeout } from './upstreamFetch'

export type SharedDownloadResult =
  | { ok: true; response: Response }
  | { ok: false; error: { status: number; message: string } }

/** 图片内联上限：声明体积超限则回退下载按钮，不读上游（图片不可截断） */
export const IMAGE_INLINE_MAX_BYTES = 5 * 1024 * 1024
/** 文本内联上限：超限按字节截断读取（PRD 建议阈值 256KB） */
export const MAX_INLINE_TEXT_BYTES = 256 * 1024

export type SharedPreviewBytesResult =
  | { ok: true; bytes: ArrayBuffer; contentType: string }
  | { ok: false; error: { status: number; message: string } }

export type SharedPreviewTextResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: { status: number; message: string } }

/**
 * 将二进制分块编码为 base64。
 *
 * `btoa(String.fromCharCode(...bytes))` 对大 buffer 会因展开参数过多栈溢出，
 * 故按固定 chunk 遍历累加后再 btoa。供图片内联拼 data: URI 使用。
 */
export function encodeBase64Chunked(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    const chunk = view.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

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
        // 上游拉取经统一超时封装（GET 只读，超时按配置轻量重试）
        const upstream = await fetchWithUpstreamTimeout(result.url, { method: 'GET' })
        return buildSanitizedSharedDownloadResponse(upstream, file.filename)
      }
      return { ok: true, response: result.response }
    } catch (error) {
      // 上游错误详情仅进服务端日志，响应体保持固定文案（见 storage-security spec）
      console.error('[fileShareDownload] provider download failed', error)
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
    // 预签名 URL 拉取经统一超时封装（GET 只读，超时按配置轻量重试）
    upstream = await fetchWithUpstreamTimeout(url, { method: 'GET' })
  } catch (error) {
    // 预签名 URL 拉取失败同样只落服务端日志，响应体保持固定文案
    console.error('[fileShareDownload] r2 presigned download failed', error)
    return { ok: false, error: { status: 502, message: '文件下载失败，请稍后重试' } }
  }

  return buildSanitizedSharedDownloadResponse(upstream, file.filename)
}

/**
 * 读取共享文件字节用于内联图片预览。
 *
 * 复用 `buildSharedDownloadResponse` 的同一字节源（恰好一次上游拉取），再经
 * `maxBytes` 闸门后 `arrayBuffer()`。调用方须先用声明 size 预筛，本函数的
 * Content-Length / 实际字节闸门为二次兜底（防止声明与实际不符时缓冲超大 body）。
 */
export async function buildSharedPreviewBytes(
  env: Env,
  file: { r2_key: string; filename: string; expires_at: string; config_id?: string | null },
  maxBytes: number
): Promise<SharedPreviewBytesResult> {
  const download = await buildSharedDownloadResponse(env, file)
  if (!download.ok) {
    return { ok: false, error: download.error }
  }

  const contentType = download.response.headers.get('Content-Type') || 'application/octet-stream'
  const declaredLength = Number(download.response.headers.get('Content-Length') || '')
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await download.response.body?.cancel().catch(() => undefined)
    return { ok: false, error: { status: 413, message: '文件过大，无法在线预览' } }
  }

  const bytes = await download.response.arrayBuffer()
  if (bytes.byteLength > maxBytes) {
    return { ok: false, error: { status: 413, message: '文件过大，无法在线预览' } }
  }
  return { ok: true, bytes, contentType }
}

/**
 * 读取共享文件文本用于内联预览（超限按字节截断）。
 *
 * 复用 `buildSharedDownloadResponse` 同一字节源，经 `readBoundedResponseText`
 * 的 `{ truncate: true }` 读入 `≤ maxBytes` 字节；`truncated` 依 Content-Length
 * 推断（缺省则不声明截断）。
 */
export async function buildSharedPreviewText(
  env: Env,
  file: { r2_key: string; filename: string; expires_at: string; config_id?: string | null },
  maxBytes: number
): Promise<SharedPreviewTextResult> {
  const download = await buildSharedDownloadResponse(env, file)
  if (!download.ok) {
    return { ok: false, error: download.error }
  }

  const declaredLength = Number(download.response.headers.get('Content-Length') || '')
  const truncated = Number.isFinite(declaredLength) && declaredLength > maxBytes
  try {
    const text = await readBoundedResponseText(download.response, maxBytes, '共享文件预览内容', {
      truncate: true,
    })
    return { ok: true, text, truncated }
  } catch (error) {
    // 上游错误详情仅进服务端日志，响应体保持固定文案（见 storage-security spec）
    console.error('[fileShareDownload] preview text read failed', error)
    return { ok: false, error: { status: 502, message: '文件下载失败，请稍后重试' } }
  }
}
