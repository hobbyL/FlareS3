import type { Env } from '../config/env'
import { invalidJsonBodyResponse, jsonResponse, redirect, getUser, parseJson } from './utils'
import { createProvider } from '../services/storage/factory'
import { StorageError, type StorageProvider } from '../services/storage/types'
import { logAudit } from '../services/audit'
import { getClientIp } from '../middleware/rateLimit'
import { limitedPreviewResponse } from '../services/previewResponsePolicy'
import { rejectInvalidContentLength } from '../services/requestBodyPolicy'
import { normalizeStorageFilename, normalizeStoragePath } from '../services/storage/pathPolicy'
import { fetchWithUpstreamTimeout } from '../services/upstreamFetch'
import { logWarn } from '../utils/log'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'

function normalizePrefix(value: string | null): string {
  const result = normalizeStoragePath(value, { allowEmpty: true, allowTrailingSlash: true })
  if (!result.ok) {
    throw new Error(result.message)
  }
  return result.key
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

function normalizeMountKey(
  value: unknown,
  options: { allowTrailingSlash?: boolean } = {}
): { key: string } | { response: Response } {
  const result = normalizeStoragePath(value, {
    allowTrailingSlash: Boolean(options.allowTrailingSlash),
  })
  if (!result.ok) {
    return { response: jsonResponse({ error: result.message }, 400) }
  }
  return { key: result.key }
}

function normalizeMountDirectory(value: unknown): { key: string } | { response: Response } {
  const result = normalizeStoragePath(value, {
    allowTrailingSlash: true,
    forceTrailingSlash: true,
  })
  if (!result.ok) {
    return { response: jsonResponse({ error: result.message }, 400) }
  }
  return { key: result.key }
}

function buildUploadKey(path: string, filename: string): string {
  if (!path) return filename
  const normalizedPath = path.endsWith('/') ? path : `${path}/`
  return `${normalizedPath}${filename}`
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

  // 媒体类型走 redirect：R2 presigned URL 支持 Range，video/audio 控件
  // 依赖 Range 拖动进度（与 services/filePreview.ts resolvePreviewMode 口径一致）
  if (['mp4', 'm4v', 'webm', 'ogg', 'ogv', 'mov', 'mkv'].includes(extension)) {
    const videoMime: Record<string, string> = {
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      webm: 'video/webm',
      ogg: 'video/ogg',
      ogv: 'video/ogg',
      mov: 'video/quicktime',
      mkv: 'video/x-matroska',
    }
    return { kind: 'redirect', responseContentType: videoMime[extension] }
  }

  if (['mp3', 'm4a', 'wav', 'flac', 'aac', 'opus'].includes(extension)) {
    const audioMime: Record<string, string> = {
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
      flac: 'audio/flac',
      aac: 'audio/aac',
      opus: 'audio/ogg',
    }
    return { kind: 'redirect', responseContentType: audioMime[extension] }
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

/**
 * 上游错误对外只回通用文案；原始消息（含 endpoint/内部细节）进服务端日志。
 */
function formatUpstreamFetchError(error: unknown): string {
  console.error('[mount] upstream fetch failed', error)
  return '上游存储服务暂时不可用'
}

async function ensureMountedObjectExists(
  provider: StorageProvider,
  key: string
): Promise<Response | null> {
  try {
    const exists = await provider.checkExists(key)
    if (exists) return null
    return jsonResponse({ error: '对象不存在' }, 404)
  } catch (error) {
    const formatted = formatStorageError(error)
    return jsonResponse({ error: `检查对象失败（${formatted.message}）` }, formatted.status)
  }
}

/**
 * 列出挂载对象
 *
 * @route GET /api/mount/objects
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含对象列表和分页信息
 *
 * @example
 * // 查询参数
 * // config_id: 存储配置 ID（必需）
 * // prefix: 路径前缀（可选）
 * // continuation_token: 分页标记（可选）
 * // limit: 每页数量（默认 100，最大 500）
 *
 * // 成功响应 (200)
 * {
 *   "config_id": "default",
 *   "prefix": "uploads/",
 *   "delimiter": "/",
 *   "limit": 100,
 *   "continuation_token": null,
 *   "next_continuation_token": "token123",
 *   "is_truncated": true,
 *   "key_count": 100,
 *   "folders": ["uploads/images/", "uploads/videos/"],
 *   "objects": [
 *     {
 *       "key": "uploads/file.txt",
 *       "size": 1024,
 *       "last_modified": "2026-09-14T00:00:00.000Z"
 *     }
 *   ]
 * }
 *
 * // 缺少配置 ID (400)
 * { "error": "缺少 config_id" }
 *
 * // 配置不存在 (404)
 * { "error": "配置不存在或不可用" }
 */
export async function listMountedObjects(request: Request, env: Env): Promise<Response> {
  const timings: RouteTimingEntry[] = []
  const url = new URL(request.url)
  const configId = String(url.searchParams.get('config_id') || '').trim()
  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  let prefix = ''
  try {
    prefix = normalizePrefix(url.searchParams.get('prefix'))
  } catch (error) {
    const message = error instanceof Error ? error.message : '路径无效'
    return jsonResponse({ error: message }, 400)
  }
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

/**
 * 下载挂载对象
 *
 * @route GET /api/mount/download
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns 重定向到下载 URL 或文件内容
 *
 * @example
 * // 查询参数
 * // config_id: 存储配置 ID（必需）
 * // key: 对象键名（必需）
 *
 * // 成功响应 (302)
 * // 重定向到预签名下载 URL
 *
 * // 缺少参数 (400)
 * { "error": "缺少 config_id" }
 * { "error": "缺少 key" }
 *
 * // 配置不存在 (404)
 * { "error": "配置不存在或不可用" }
 */
export async function downloadMountedObject(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const configId = String(url.searchParams.get('config_id') || '').trim()
  const rawKey = String(url.searchParams.get('key') || '')

  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  if (!rawKey) {
    return jsonResponse({ error: '缺少 key' }, 400)
  }

  const keyResult = normalizeMountKey(rawKey)
  if ('response' in keyResult) return keyResult.response
  const key = keyResult.key

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

/**
 * 预览挂载对象
 *
 * @route GET /api/mount/preview
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns 文件预览内容或重定向
 *
 * @example
 * // 查询参数
 * // config_id: 存储配置 ID（必需）
 * // key: 对象键名（必需）
 *
 * // 文本文件响应 (200)
 * // Content-Type: text/plain
 * // Body: 文件内容（限制 1MB）
 *
 * // 图片文件响应 (302)
 * // 重定向到预签名 URL
 *
 * // 缺少参数 (400)
 * { "error": "缺少 config_id" }
 * { "error": "缺少 key" }
 *
 * // 不支持预览 (415)
 * { "error": "不支持预览该文件类型" }
 */
export async function previewMountedObject(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const configId = String(url.searchParams.get('config_id') || '').trim()
  const rawKey = String(url.searchParams.get('key') || '')

  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  if (!rawKey) {
    return jsonResponse({ error: '缺少 key' }, 400)
  }

  const keyResult = normalizeMountKey(rawKey)
  if ('response' in keyResult) return keyResult.response
  const key = keyResult.key

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

    return limitedPreviewResponse(result.response, mode.responseContentType)
  } catch (error) {
    return jsonResponse({ error: `生成预览链接失败：${formatUpstreamFetchError(error)}` }, 502)
  }
}

/**
 * 删除挂载对象
 *
 * @route DELETE /api/mount/object
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含删除统计
 *
 * @example
 * // 查询参数
 * // config_id: 存储配置 ID（必需）
 * // key: 对象键名（必需，可以是文件或目录）
 *
 * // 删除文件成功 (200)
 * {
 *   "success": true,
 *   "deleted_count": 1
 * }
 *
 * // 删除目录成功 (200)
 * {
 *   "success": true,
 *   "deleted_count": 15
 * }
 *
 * // 缺少参数 (400)
 * { "error": "缺少 config_id" }
 * { "error": "缺少 key" }
 *
 * // 对象不存在 (404)
 * { "error": "对象不存在" }
 */
export async function deleteMountedObject(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const method = request.method.toUpperCase()
  if (method !== 'DELETE') {
    return jsonResponse({ error: '方法不允许' }, 405)
  }

  const url = new URL(request.url)
  const configId = String(url.searchParams.get('config_id') || '').trim()
  const rawKey = String(url.searchParams.get('key') || '').trim()

  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  if (!rawKey) {
    return jsonResponse({ error: '缺少 key' }, 400)
  }

  const keyResult = normalizeMountKey(rawKey, { allowTrailingSlash: true })
  if ('response' in keyResult) return keyResult.response
  const key = keyResult.key

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
    if (
      error instanceof StorageError &&
      (error.httpStatusCode === 404 || error.code === 'NoSuchKey')
    ) {
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
const MAX_MOUNT_MULTIPART_REQUEST_BYTES = MAX_MOUNT_UPLOAD_BYTES + 1024 * 1024

/**
 * 上传文件到挂载目录
 *
 * @route POST /api/mount/upload
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含上传结果
 *
 * @example
 * // 请求格式 1: multipart/form-data
 * // FormData 字段:
 * // - config_id: 存储配置 ID（必需）
 * // - path: 目标路径（必需）
 * // - file: 文件对象（必需）
 *
 * // 请求格式 2: application/octet-stream
 * // 查询参数:
 * // - config_id: 存储配置 ID（必需）
 * // - path: 目标路径（必需）
 * // - filename: 文件名（必需）
 * // Body: 文件二进制数据
 *
 * // 成功响应 (200)
 * {
 *   "success": true,
 *   "key": "uploads/file.txt",
 *   "size": 1024
 * }
 *
 * // 缺少参数 (400)
 * { "error": "缺少 config_id" }
 * { "error": "缺少 path" }
 * { "error": "缺少文件" }
 *
 * // 文件过大 (413)
 * { "error": "上传文件超出限制（100MB）" }
 */
export async function uploadMountedObject(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const contentType = String(request.headers.get('Content-Type') || '')
  const contentLengthResponse = rejectInvalidContentLength(
    request,
    contentType.includes('multipart/form-data')
      ? MAX_MOUNT_MULTIPART_REQUEST_BYTES
      : MAX_MOUNT_UPLOAD_BYTES,
    '上传文件'
  )
  if (contentLengthResponse) return contentLengthResponse

  let configId = ''
  let path = ''
  let file: File | null = null
  let octetFilename = ''

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
    const filenameResult = normalizeStorageFilename(filename)
    if (!filenameResult.ok) {
      return jsonResponse({ error: filenameResult.message }, 400)
    }
    octetFilename = filenameResult.key
    const body = await request.arrayBuffer()
    file = new File([body], octetFilename, {
      type: contentType || 'application/octet-stream',
    })
  }

  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  if (!file) {
    return jsonResponse({ error: '缺少文件' }, 400)
  }

  const filenameResult = normalizeStorageFilename(file.name)
  if (!filenameResult.ok) {
    return jsonResponse({ error: filenameResult.message }, 400)
  }
  const pathResult = normalizeStoragePath(path, { allowEmpty: true, allowTrailingSlash: true })
  if (!pathResult.ok) {
    return jsonResponse({ error: pathResult.message }, 400)
  }

  const fileSize = file.size
  if (fileSize > MAX_MOUNT_UPLOAD_BYTES) {
    return jsonResponse(
      { error: `文件大小超过限制（最大 ${MAX_MOUNT_UPLOAD_BYTES / 1024 / 1024}MB）` },
      413
    )
  }

  // 构造 key: path + filename
  const key = buildUploadKey(pathResult.key, filenameResult.key)

  const provider = await createProvider(env, configId)
  if (!provider) {
    return jsonResponse({ error: '配置不存在或不可用' }, 404)
  }

  try {
    const body = await file.arrayBuffer()
    const result = await provider.upload(
      key,
      body,
      file.type || 'application/octet-stream',
      fileSize
    )

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

/**
 * 创建挂载目录
 *
 * @route POST /api/mount/folder
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 请求体
 * {
 *   "config_id": "default",
 *   "key": "uploads/images/"
 * }
 *
 * // 成功响应 (200)
 * {
 *   "success": true,
 *   "key": "uploads/images/"
 * }
 *
 * // 缺少参数 (400)
 * { "error": "缺少 config_id" }
 * { "error": "缺少 key" }
 *
 * // 配置不存在 (404)
 * { "error": "配置不存在或不可用" }
 */
export async function createMountedFolder(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  let configId = ''
  let key = ''

  try {
    const body = await parseJson<{ config_id?: string; key?: string }>(request)
    configId = String(body.config_id || '').trim()
    key = String(body.key || '').trim()
  } catch (error) {
    return invalidJsonBodyResponse(error, '请求格式错误')
  }

  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  if (!key) {
    return jsonResponse({ error: '缺少 key' }, 400)
  }

  const keyResult = normalizeMountDirectory(key)
  if ('response' in keyResult) return keyResult.response
  key = keyResult.key

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

// ── 移动 / 重命名 ──

/**
 * 判断 provider 异常是否表示源对象不存在。
 */
function isMoveSourceMissingError(error: unknown): boolean {
  return (
    error instanceof StorageError && (error.httpStatusCode === 404 || error.code === 'NotFound')
  )
}

/**
 * 判断 provider 异常是否表示目标已存在（WebDAV MOVE Overwrite:F 的 412/409）。
 */
function isMoveTargetConflictError(error: unknown): boolean {
  return (
    error instanceof StorageError && (error.httpStatusCode === 409 || error.code === 'Conflict')
  )
}

/**
 * 判断 provider 异常是否表示对象超过 R2 CopyObject 上限。
 */
function isMoveEntityTooLargeError(error: unknown): boolean {
  return (
    error instanceof StorageError &&
    (error.httpStatusCode === 413 || error.code === 'EntityTooLarge')
  )
}

/**
 * 移动 / 重命名挂载对象（同一挂载点内）
 *
 * 重命名 = 目标目录为对象当前目录 + 新文件名；移动 = 新目录（可同时改名）。
 * 仅支持文件对象：key 带尾斜杠（目录）会被路径校验直接拒绝。
 *
 * @route POST /api/mount/move
 * @param request - HTTP 请求对象（需要 admin 认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含移动后的对象 key
 *
 * @example
 * // 请求体
 * {
 *   "config_id": "default",
 *   "key": "docs/report.pdf",
 *   "to_dir": "archive",
 *   "new_name": "report-2026.pdf"
 * }
 *
 * // 重命名（同目录）请求体
 * {
 *   "config_id": "default",
 *   "key": "docs/report.pdf",
 *   "to_dir": "docs",
 *   "new_name": "report-final.pdf"
 * }
 *
 * // 成功响应 (200)
 * {
 *   "ok": true,
 *   "key": "archive/report-2026.pdf"
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // 缺少参数 / 路径非法（穿越、绝对路径、空段、尾斜杠 key、非法文件名）(400)
 * { "error": "路径不能包含 . 或 .." }
 * { "error": "路径不能以 / 结尾" }
 * { "error": "文件名不能包含路径分隔符" }
 * { "error": "目标与源相同" }
 *
 * // 目标已存在 (409)
 * { "error": "目标文件已存在" }
 *
 * // 源对象不存在 (404)
 * { "error": "对象不存在" }
 *
 * // 配置不存在 (404)
 * { "error": "配置不存在或不可用" }
 *
 * // 对象超过 R2 复制上限 (413)
 * { "error": "文件过大，超过 R2 复制上限（5GiB），请删除后重新上传到目标名称" }
 *
 * // 上游存储失败 (502)
 * { "error": "移动对象失败（存储操作失败）" }
 */
export async function moveMountedObject(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  let configId = ''
  let rawKey = ''
  let rawToDir: string | undefined
  let rawNewName = ''

  try {
    const body = await parseJson<{
      config_id?: string
      key?: string
      to_dir?: string
      new_name?: string
    }>(request)
    configId = String(body.config_id || '').trim()
    rawKey = String(body.key || '').trim()
    rawToDir = body.to_dir
    rawNewName = String(body.new_name || '').trim()
  } catch (error) {
    return invalidJsonBodyResponse(error, '请求格式错误')
  }

  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }
  if (!rawKey) {
    return jsonResponse({ error: '缺少 key' }, 400)
  }
  if (!rawNewName) {
    return jsonResponse({ error: '缺少 new_name' }, 400)
  }

  // 源 key：文件对象（不允许尾斜杠，目录/前缀操作不在第一版范围）
  const keyResult = normalizeMountKey(rawKey)
  if ('response' in keyResult) return keyResult.response
  const sourceKey = keyResult.key

  // 目标目录：可空（挂载点根）、可带尾斜杠
  const toDirResult = normalizeStoragePath(rawToDir, {
    allowEmpty: true,
    allowTrailingSlash: true,
  })
  if (!toDirResult.ok) {
    return jsonResponse({ error: toDirResult.message }, 400)
  }
  const targetDir = toDirResult.key.replace(/\/+$/, '')

  const nameResult = normalizeStorageFilename(rawNewName)
  if (!nameResult.ok) {
    return jsonResponse({ error: nameResult.message }, 400)
  }

  const destKey = targetDir ? `${targetDir}/${nameResult.key}` : nameResult.key
  if (sourceKey === destKey) {
    return jsonResponse({ error: '目标与源相同' }, 400)
  }

  const provider = await createProvider(env, configId)
  if (!provider) {
    return jsonResponse({ error: '配置不存在或不可用' }, 404)
  }

  // 目标占用检查（对齐 delete 的 404 对称语义，冲突用 409）
  try {
    const destExists = await provider.checkExists(destKey)
    if (destExists) {
      return jsonResponse({ error: '目标文件已存在' }, 409)
    }
  } catch (error) {
    const formatted = formatStorageError(error)
    return jsonResponse({ error: `检查目标失败（${formatted.message}）` }, formatted.status)
  }

  try {
    await provider.move(sourceKey, destKey)
  } catch (error) {
    if (isMoveSourceMissingError(error)) {
      return jsonResponse({ error: '对象不存在' }, 404)
    }
    if (isMoveTargetConflictError(error)) {
      return jsonResponse({ error: '目标文件已存在' }, 409)
    }
    if (isMoveEntityTooLargeError(error)) {
      return jsonResponse(
        { error: '文件过大，超过 R2 复制上限（5GiB），请删除后重新上传到目标名称' },
        413
      )
    }
    const formatted = formatStorageError(error)
    return jsonResponse({ error: `移动对象失败（${formatted.message}）` }, formatted.status)
  }

  await logAudit(env.DB, {
    actorUserId: user.id,
    action: 'MOUNT_OBJECT_MOVE',
    targetType: 'mount_object',
    targetId: destKey,
    ip: getClientIp(request),
    userAgent: request.headers.get('User-Agent') || undefined,
    metadata: {
      configId,
      fromKey: sourceKey,
      toKey: destKey,
    },
  })

  return jsonResponse({ ok: true, key: destKey })
}

// ── 跨存储复制 ──

// 跨存储复制中转上限与 mount 上传同口径：download 全量读入 ArrayBuffer → upload
// 全量写出，与上传路径的 Worker 内存边界完全同构，不引入第二套上限常量
const MAX_CROSS_CONFIG_COPY_BYTES = MAX_MOUNT_UPLOAD_BYTES

/**
 * 读取对象 body 用于服务端中转。
 *
 * redirect 形态（R2 预签名）：Worker 出网 GET 拉回 body；
 * proxy 形态（WebDAV/Koofr）：直接取响应 body。
 */
async function readObjectBody(provider: StorageProvider, key: string): Promise<ArrayBuffer> {
  const result = await provider.download(key, 'download', 3600)
  if (result.kind === 'proxy') {
    return result.response.arrayBuffer()
  }
  const response = await fetchWithUpstreamTimeout(result.url, { method: 'GET' })
  if (!response.ok) {
    throw new StorageError(
      `读取源对象失败（HTTP ${response.status}）`,
      undefined,
      response.status === 404 ? 404 : 502
    )
  }
  return response.arrayBuffer()
}

/**
 * 写出对象 body（中转语义要求 Worker 完成上传，不得把 redirect URL 丢给前端）。
 *
 * redirect 形态（R2 预签名 PUT）：Worker 出网 PUT；consumed 形态：已完成。
 */
async function writeObjectBody(
  provider: StorageProvider,
  key: string,
  body: ArrayBuffer,
  contentType: string,
  size: number
): Promise<void> {
  const result = await provider.upload(key, body, contentType, size)
  if (result.kind === 'consumed') return
  const response = await fetchWithUpstreamTimeout(result.url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
  })
  if (!response.ok) {
    throw new StorageError(`写入目标对象失败（HTTP ${response.status}）`, undefined, 502)
  }
}

/**
 * 逐级确保目标 key 的父目录存在（镜像 server.ts 中转上传的目录创建容错：
 * 已存在或创建失败均 continue，由后续 upload 报真实错误）。
 */
async function ensureParentFolders(provider: StorageProvider, key: string): Promise<void> {
  const lastSlash = key.lastIndexOf('/')
  if (lastSlash <= 0) return
  const dirParts = key.slice(0, lastSlash).split('/').filter(Boolean)
  let current = ''
  for (const part of dirParts) {
    current += `/${part}`
    try {
      await provider.createFolder(`${current}/`)
    } catch {
      // directory already exists or creation failed, continue
    }
  }
}

/**
 * 跨存储配置复制对象（R2↔WebDAV↔Koofr）
 *
 * 服务端中转：download 拉回 body → dest.upload 写出；勾选 delete_source
 * 时复制成功后删除源对象（=迁移语义；删除失败不回滚目标，仅 warn）。
 * 上限与 mount 上传同口径（100MB）——超大文件跨后端迁移不在本任务范围。
 *
 * @route POST /api/mount/cross-config-copy（仅管理员）
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应 `{ ok, key, source_deleted }`
 *
 * @example
 * // 请求体
 * {
 *   "source_config_id": "webdav-1",
 *   "source_key": "docs/a.txt",
 *   "dest_config_id": "koofr-1",
 *   "dest_dir": "backup",          // 可选，空 = 目标挂载点根
 *   "delete_source_after_copy": false // 可选，默认 false
 * }
 *
 * // 成功响应 (200)
 * { "ok": true, "key": "backup/a.txt", "source_deleted": false }
 *
 * // 参数错误 (400)
 * { "error": "缺少 source_config_id" }
 * { "error": "源与目标配置相同" }
 *
 * // 超过中转上限 (413)
 * { "error": "文件过大，跨存储复制上限为 100MB" }
 *
 * // 目标已存在 (409)
 * { "error": "目标文件已存在" }
 *
 * // 配置不存在 (404)
 * { "error": "配置不存在或不可用" }
 */
export async function crossConfigCopyObject(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  let sourceConfigId = ''
  let rawSourceKey = ''
  let destConfigId = ''
  let rawDestDir: string | undefined
  let deleteSourceAfterCopy = false

  try {
    const body = await parseJson<{
      source_config_id?: string
      source_key?: string
      dest_config_id?: string
      dest_dir?: string
      delete_source_after_copy?: boolean
    }>(request)
    sourceConfigId = String(body.source_config_id || '').trim()
    rawSourceKey = String(body.source_key || '').trim()
    destConfigId = String(body.dest_config_id || '').trim()
    rawDestDir = body.dest_dir
    deleteSourceAfterCopy = Boolean(body.delete_source_after_copy)
  } catch (error) {
    return invalidJsonBodyResponse(error, '请求格式错误')
  }

  if (!sourceConfigId) {
    return jsonResponse({ error: '缺少 source_config_id' }, 400)
  }
  if (!rawSourceKey) {
    return jsonResponse({ error: '缺少 source_key' }, 400)
  }
  if (!destConfigId) {
    return jsonResponse({ error: '缺少 dest_config_id' }, 400)
  }
  if (sourceConfigId === destConfigId) {
    return jsonResponse({ error: '源与目标配置相同' }, 400)
  }

  // 源 key：文件对象（禁止尾斜杠/穿越/绝对路径，与 moveMountedObject 同守卫）
  const keyResult = normalizeMountKey(rawSourceKey)
  if ('response' in keyResult) return keyResult.response
  const sourceKey = keyResult.key

  // 目标目录：可空（挂载点根）、可带尾斜杠
  const destDirResult = normalizeStoragePath(rawDestDir, {
    allowEmpty: true,
    allowTrailingSlash: true,
  })
  if (!destDirResult.ok) {
    return jsonResponse({ error: destDirResult.message }, 400)
  }
  const destDir = destDirResult.key.replace(/\/+$/, '')
  const basename = sourceKey.slice(sourceKey.lastIndexOf('/') + 1)
  const destKey = destDir ? `${destDir}/${basename}` : basename

  const sourceProvider = await createProvider(env, sourceConfigId)
  if (!sourceProvider) {
    return jsonResponse({ error: '源配置不存在或不可用' }, 404)
  }
  const destProvider = await createProvider(env, destConfigId)
  if (!destProvider) {
    return jsonResponse({ error: '目标配置不存在或不可用' }, 404)
  }

  // 大小守卫前置（半写防护）：超限直接 413，不触碰 download/upload
  let sourceSize: number | null = null
  try {
    sourceSize = await sourceProvider.getSize(sourceKey)
  } catch (error) {
    const formatted = formatStorageError(error)
    if (formatted.status === 404) {
      return jsonResponse({ error: '对象不存在' }, 404)
    }
    return jsonResponse({ error: `检查源对象失败（${formatted.message}）` }, formatted.status)
  }
  if (typeof sourceSize === 'number' && sourceSize > MAX_CROSS_CONFIG_COPY_BYTES) {
    return jsonResponse(
      { error: `文件过大，跨存储复制上限为 ${MAX_CROSS_CONFIG_COPY_BYTES / 1024 / 1024}MB` },
      413
    )
  }

  // 目标占用检查（默认不覆盖；与 moveMountedObject 的 409 语义一致）
  try {
    const destExists = await destProvider.checkExists(destKey)
    if (destExists) {
      return jsonResponse({ error: '目标文件已存在' }, 409)
    }
  } catch (error) {
    const formatted = formatStorageError(error)
    return jsonResponse({ error: `检查目标失败（${formatted.message}）` }, formatted.status)
  }

  // 中转：拉回 → 写出；写出失败 best-effort 清理目标，不留半写
  let body: ArrayBuffer
  try {
    body = await readObjectBody(sourceProvider, sourceKey)
  } catch (error) {
    const formatted = formatStorageError(error)
    if (formatted.status === 404) {
      return jsonResponse({ error: '对象不存在' }, 404)
    }
    return jsonResponse({ error: `复制失败（${formatted.message}）` }, formatted.status)
  }

  const contentType = 'application/octet-stream'

  try {
    await ensureParentFolders(destProvider, destKey)
    await writeObjectBody(
      destProvider,
      destKey,
      body,
      contentType,
      body.byteLength || sourceSize || 0
    )
  } catch (error) {
    // best-effort 清理可能的目标半写；清理失败仅 warn（下次复制会先 409 拦截）
    await Promise.allSettled([destProvider.delete(destKey)])
    const formatted = formatStorageError(error)
    return jsonResponse({ error: `复制失败（${formatted.message}）` }, formatted.status)
  }

  // 可选删源（=迁移）：失败不回滚目标，仅 warn；幂等重试同一复制即可收敛
  let sourceDeleted = false
  if (deleteSourceAfterCopy) {
    try {
      await sourceProvider.delete(sourceKey)
      sourceDeleted = true
    } catch (error) {
      logWarn('mount.crossConfigCopyDeleteSourceFailed', {
        sourceConfigId,
        sourceKey,
        destConfigId,
        destKey,
        error: String(error instanceof Error ? error.message : error),
      })
    }
  }

  await logAudit(env.DB, {
    actorUserId: user.id,
    action: 'MOUNT_CROSS_CONFIG_COPY',
    targetType: 'mount_object',
    targetId: destKey,
    ip: getClientIp(request),
    userAgent: request.headers.get('User-Agent') || undefined,
    metadata: {
      sourceConfigId,
      sourceKey,
      destConfigId,
      destKey,
      size: body.byteLength || sourceSize || 0,
      sourceDeleted,
    },
  })

  return jsonResponse({ ok: true, key: destKey, source_deleted: sourceDeleted })
}
