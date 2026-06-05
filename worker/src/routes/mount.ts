import type { Env } from '../config/env'
import { jsonResponse, redirect, getUser } from './utils'
import { createProvider } from '../services/storage/factory'
import { StorageError, type StorageProvider } from '../services/storage/types'
import { logAudit } from '../services/audit'
import { getClientIp } from '../middleware/rateLimit'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'

function normalizePrefix(value: string | null): string {
  const prefix = String(value ?? '').trim()
  return prefix
}

function normalizeToken(value: string | null): string | null {
  const token = String(value ?? '').trim()
  return token ? token : null
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.floor(num)))
}

function getBasename(key: string): string {
  const normalized = String(key ?? '')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

function getFilenameExtension(filename: string): string {
  const name = String(filename || '').trim()
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) return ''
  return name.slice(index + 1).toLowerCase()
}

type PreviewMode =
  | { kind: 'redirect'; responseContentType: string }
  | { kind: 'proxy'; responseContentType: string }

function resolvePreviewModeByExtension(extension: string): PreviewMode | null {
  if (extension === 'pdf') {
    return { kind: 'redirect', responseContentType: 'application/pdf' }
  }

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension)) {
    const map: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
    }
    return { kind: 'redirect', responseContentType: map[extension] || 'image/*' }
  }

  if (extension === 'md' || extension === 'markdown') {
    return { kind: 'proxy', responseContentType: 'text/markdown; charset=utf-8' }
  }

  if (['txt', 'log', 'csv', 'json', 'yml', 'yaml', 'ini', 'conf'].includes(extension)) {
    return { kind: 'proxy', responseContentType: 'text/plain; charset=utf-8' }
  }

  return null
}

function formatStorageError(error: unknown): { status: number; message: string } {
  if (error instanceof StorageError) {
    const parts = [
      error.code,
      typeof error.httpStatusCode === 'number' ? `HTTP ${error.httpStatusCode}` : null,
      error.message,
    ].filter(Boolean)
    if (!parts.length) return { status: 502, message: '存储操作失败' }
    return { status: error.httpStatusCode || 502, message: `存储操作失败（${parts.join(' / ')}）` }
  }
  return { status: 502, message: '存储操作失败' }
}

function formatUpstreamFetchError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '')
  const message = raw.replace(/\s+/g, ' ').trim()
  if (!message) return 'upstream_fetch_failed'
  return message.slice(0, 200)
}

async function ensureMountedObjectExists(provider: StorageProvider, key: string): Promise<Response | null> {
  try {
    const exists = await provider.checkExists(key)
    if (exists) return null
    return jsonResponse({ error: '对象不存在' }, 404)
  } catch (error) {
    const formatted = formatStorageError(error)
    return jsonResponse({ error: `检查对象失败（${formatted.message}）` }, formatted.status)
  }
}

export async function listMountedObjects(request: Request, env: Env): Promise<Response> {
  const timings: RouteTimingEntry[] = []
  const url = new URL(request.url)
  const configId = String(url.searchParams.get('config_id') || '').trim()
  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  const prefix = normalizePrefix(url.searchParams.get('prefix'))
  const continuationToken = normalizeToken(url.searchParams.get('continuation_token'))
  const limit = clampNumber(url.searchParams.get('limit'), 1, 500, 100)

  const provider = await measureRouteStep(timings, 'providerLoad', () =>
    createProvider(env, configId)
  )
  if (!provider) {
    return withRouteTimingHeaders(jsonResponse({ error: '配置不存在或不可用' }, 404), timings)
  }

  try {
    const result = await measureRouteStep(timings, 'providerList', () =>
      provider.list({
        prefix,
        delimiter: '/',
        continuationToken: continuationToken || undefined,
        maxKeys: limit,
      })
    )

    return withRouteTimingHeaders(
      jsonResponse({
        config_id: configId,
        prefix,
        delimiter: '/',
        limit,
        continuation_token: continuationToken,
        next_continuation_token: result.next_continuation_token || null,
        is_truncated: result.is_truncated,
        key_count: result.key_count,
        folders: result.common_prefixes,
        objects: result.contents,
      }),
      timings
    )
  } catch (error) {
    const formatted = formatStorageError(error)
    return withRouteTimingHeaders(
      jsonResponse({ error: `读取对象列表失败（${formatted.message}）` }, formatted.status),
      timings
    )
  }
}

export async function downloadMountedObject(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const configId = String(url.searchParams.get('config_id') || '').trim()
  const key = String(url.searchParams.get('key') || '')

  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  if (!key) {
    return jsonResponse({ error: '缺少 key' }, 400)
  }

  const provider = await createProvider(env, configId)
  if (!provider) {
    return jsonResponse({ error: '配置不存在或不可用' }, 404)
  }

  const missingResponse = await ensureMountedObjectExists(provider, key)
  if (missingResponse) return missingResponse

  const filename = getBasename(key) || 'file'

  try {
    const result = await provider.download(key, filename, 3600)
    if (result.kind === 'redirect') {
      return redirect(result.url, 302)
    }
    return result.response
  } catch (error) {
    const message = formatUpstreamFetchError(error)
    return jsonResponse({ error: `生成下载链接失败：${message}` }, 502)
  }
}

export async function previewMountedObject(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const configId = String(url.searchParams.get('config_id') || '').trim()
  const key = String(url.searchParams.get('key') || '')

  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  if (!key) {
    return jsonResponse({ error: '缺少 key' }, 400)
  }

  const provider = await createProvider(env, configId)
  if (!provider) {
    return jsonResponse({ error: '配置不存在或不可用' }, 404)
  }

  const missingResponse = await ensureMountedObjectExists(provider, key)
  if (missingResponse) return missingResponse

  const filename = getBasename(key) || 'file'
  const extension = getFilenameExtension(filename)
  const mode = resolvePreviewModeByExtension(extension)
  if (!mode) {
    return jsonResponse({ error: '不支持预览该文件类型' }, 415)
  }

  try {
    const result = await provider.preview(
      key,
      filename,
      600,
      mode.kind === 'redirect' ? mode.responseContentType : undefined
    )

    if (result.kind === 'redirect') {
      return redirect(result.url, 302)
    }

    return result.response
  } catch (error) {
    return jsonResponse({ error: `生成预览链接失败：${formatUpstreamFetchError(error)}` }, 502)
  }
}

export async function deleteMountedObject(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const method = request.method.toUpperCase()
  if (method !== 'DELETE') {
    return jsonResponse({ error: '方法不允许' }, 405)
  }

  const url = new URL(request.url)
  const configId = String(url.searchParams.get('config_id') || '').trim()
  const key = String(url.searchParams.get('key') || '').trim()

  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  if (!key) {
    return jsonResponse({ error: '缺少 key' }, 400)
  }

  const provider = await createProvider(env, configId)
  if (!provider) {
    return jsonResponse({ error: '配置不存在或不可用' }, 404)
  }

  const isFolder = key.endsWith('/')
  let deletedCount = 0

  try {
    if (isFolder) {
      const result = await provider.deleteByPrefix(key)
      deletedCount = Number(result.deleted_count || 0)
      if (deletedCount <= 0) {
        return jsonResponse({ error: '目录不存在或已为空' }, 404)
      }
    } else {
      const missingResponse = await ensureMountedObjectExists(provider, key)
      if (missingResponse) return missingResponse

      await provider.delete(key)
      deletedCount = 1
    }
  } catch (error) {
    if (error instanceof StorageError && (error.httpStatusCode === 404 || error.code === 'NoSuchKey')) {
      return jsonResponse({ error: '对象不存在' }, 404)
    }

    const formatted = formatStorageError(error)
    const errorPrefix = isFolder ? '删除目录失败' : '删除对象失败'
    return jsonResponse({ error: `${errorPrefix}（${formatted.message}）` }, formatted.status)
  }

  await logAudit(env.DB, {
    actorUserId: user.id,
    action: 'MOUNT_OBJECT_DELETE',
    targetType: 'mount_object',
    targetId: key,
    ip: getClientIp(request),
    userAgent: request.headers.get('User-Agent') || undefined,
    metadata: {
      configId,
      key,
      recursive: isFolder,
      deletedCount,
    },
  })

  return jsonResponse({
    success: true,
    recursive: isFolder,
    deleted_count: deletedCount,
  })
}

// ── 上传文件 ──

const MAX_MOUNT_UPLOAD_BYTES = 100 * 1024 * 1024 // 100MB

export async function uploadMountedObject(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const contentType = String(request.headers.get('Content-Type') || '')

  let configId = ''
  let path = ''
  let file: File | null = null

  // 支持 multipart/form-data 和 application/octet-stream
  if (contentType.includes('multipart/form-data')) {
    try {
      const formData = await request.formData()
      configId = String(formData.get('config_id') || '').trim()
      path = String(formData.get('path') || '').trim()
      const rawFile = formData.get('file')
      if (rawFile instanceof File) {
        file = rawFile
      }
    } catch {
      return jsonResponse({ error: '请求格式错误' }, 400)
    }
  } else {
    // application/octet-stream 或其他二进制流
    const url = new URL(request.url)
    configId = String(url.searchParams.get('config_id') || '').trim()
    path = String(url.searchParams.get('path') || '').trim()
    const filename = String(url.searchParams.get('filename') || '').trim()
    if (!filename) {
      return jsonResponse({ error: '缺少 filename' }, 400)
    }
    const body = await request.arrayBuffer()
    file = new File([body], filename, {
      type: contentType || 'application/octet-stream',
    })
  }

  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  if (!file) {
    return jsonResponse({ error: '缺少文件' }, 400)
  }

  const fileSize = file.size
  if (fileSize > MAX_MOUNT_UPLOAD_BYTES) {
    return jsonResponse({ error: `文件大小超过限制（最大 ${MAX_MOUNT_UPLOAD_BYTES / 1024 / 1024}MB）` }, 413)
  }

  // 构造 key: path + filename
  const normalizedPath = path && !path.endsWith('/') ? `${path}/` : path
  const key = `${normalizedPath}${file.name}`

  const provider = await createProvider(env, configId)
  if (!provider) {
    return jsonResponse({ error: '配置不存在或不可用' }, 404)
  }

  try {
    const body = await file.arrayBuffer()
    const result = await provider.upload(key, body, file.type || 'application/octet-stream', fileSize)

    await logAudit(env.DB, {
      actorUserId: user.id,
      action: 'MOUNT_OBJECT_UPLOAD',
      targetType: 'mount_object',
      targetId: key,
      ip: getClientIp(request),
      userAgent: request.headers.get('User-Agent') || undefined,
      metadata: {
        configId,
        key,
        size: fileSize,
        contentType: file.type,
      },
    })

    if (result.kind === 'redirect') {
      return jsonResponse({ success: true, upload_url: result.url, key })
    }

    return jsonResponse({ success: true, key })
  } catch (error) {
    const formatted = formatStorageError(error)
    return jsonResponse({ error: `上传失败（${formatted.message}）` }, formatted.status)
  }
}

// ── 创建目录 ──

export async function createMountedFolder(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  let configId = ''
  let key = ''

  try {
    const body = await request.json() as { config_id?: string; key?: string }
    configId = String(body.config_id || '').trim()
    key = String(body.key || '').trim()
  } catch {
    return jsonResponse({ error: '请求格式错误' }, 400)
  }

  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  if (!key) {
    return jsonResponse({ error: '缺少 key' }, 400)
  }

  const provider = await createProvider(env, configId)
  if (!provider) {
    return jsonResponse({ error: '配置不存在或不可用' }, 404)
  }

  try {
    await provider.createFolder(key)

    await logAudit(env.DB, {
      actorUserId: user.id,
      action: 'MOUNT_FOLDER_CREATE',
      targetType: 'mount_object',
      targetId: key,
      ip: getClientIp(request),
      userAgent: request.headers.get('User-Agent') || undefined,
      metadata: {
        configId,
        key,
      },
    })

    return jsonResponse({ success: true, key })
  } catch (error) {
    const formatted = formatStorageError(error)
    return jsonResponse({ error: `创建目录失败（${formatted.message}）` }, formatted.status)
  }
}
