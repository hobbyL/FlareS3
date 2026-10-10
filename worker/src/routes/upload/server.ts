import { withD1Retry } from '../../utils/db'
import type { Env } from '../../config/env'
import { jsonResponse, getUser } from '../utils'
import { prepareAuditLogInsert } from '../../services/audit'
import { getClientIp } from '../../middleware/rateLimit'
import { normalizeDeclaredFileSize } from '../../services/uploadValidation'
import {
  invalidUploadRequestError,
  customShortCodeConflictError,
  customShortCodeInvalidError,
  mapUnexpectedUploadError,
  uploadConfigNotFoundError,
  uploadErrorResponse,
} from '../../services/uploadErrors'
import { createProvider } from '../../services/storage/factory'
import { rejectInvalidContentLength } from '../../services/requestBodyPolicy'
import { prepareConsumeUploadReservation } from '../../services/uploadReservations'
import { resolveServerUploadConfigForUser } from '../../services/uploadConfigPolicy'
import { generateRandomCode } from '../../utils/random'
import { FILE_SHORT_CODE_LENGTH } from '../../utils/codePolicy'
import {
  SHORT_CODE_MAX_ATTEMPTS,
  normalizeExpiresIn,
  calcExpiresAt,
  sanitizeUploadFilename,
  buildRenamedFilename,
  sanitizeDir,
  markFileUploadDeleted,
  createPendingUploadFileRecord,
  createUploadConfigPolicyErrorResponse,
  buildProviderScopedStorageKey,
  normalizeCustomShortCode,
  isShortCodeTaken,
} from './helpers'

const MAX_SERVER_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_SERVER_UPLOAD_REQUEST_BYTES = MAX_SERVER_UPLOAD_BYTES + 1024 * 1024

/**
 * 上游/内部错误对外只回通用文案 + HTTP 状态；原始消息进服务端日志，
 * 避免向客户端泄露 WebDAV/Koofr endpoint 与内部路径细节。
 */
function formatServerError(error: unknown): { status: number; message: string } {
  if (error instanceof Error) {
    console.error('[serverUpload] upstream failed', error)
    const m = error.message.match(/HTTP\s+(\d+)/)
    if (m) return { status: Number(m[1]), message: '存储服务返回错误' }
    if (
      error.message.includes('Network connection lost') ||
      error.message.includes('fetch failed')
    ) {
      return { status: 502, message: '存储服务连接中断，请稍后重试' }
    }
    return { status: 500, message: '上传失败，请稍后重试' }
  }
  console.error('[serverUpload] upstream failed', error)
  return { status: 500, message: '上传失败，请稍后重试' }
}

/**
 * 服务端代理上传（非 R2 配置，文件经 Worker 中转写入 WebDAV / Koofr 等上游）
 *
 * @route POST /api/upload/server
 * @param request - HTTP 请求对象（需要认证；Content-Type 必须为 multipart/form-data）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含文件信息和下载链接
 *
 * @example
 * // 请求体（multipart/form-data 字段）
 * config_id=default
 * filename=example.jpg
 * expires_in=7
 * require_login=false
 * dir=uploads
 * file=<二进制文件内容>
 *
 * // 成功响应 (200)
 * {
 *   "file_id": "uuid",
 *   "filename": "example.jpg",
 *   "download_url": "/api/files/uuid/download",
 *   "short_url": "/s/abc123",
 *   "expires_at": "2026-10-13T00:00:00.000Z",
 *   "r2_config_id": "default"
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // 请求格式错误 (400)
 * { "error": "请求格式错误，需要 multipart/form-data" }
 *
 * // 请求体解析失败 (400)
 * { "error": { "code": "UPLOAD_INVALID_REQUEST", "message": "无效的请求" } }
 *
 * // Content-Length 无效 (400)
 * { "error": "上传文件 Content-Length 无效" }
 *
 * // 缺少必填字段 (400)
 * { "error": "缺少 config_id" }
 *
 * // 缺少文件名 (400)
 * { "error": "缺少 filename" }
 *
 * // 缺少文件 (400)
 * { "error": "缺少文件" }
 *
 * // 无权使用指定上传配置 (403)
 * { "error": { "code": "UPLOAD_CONFIG_FORBIDDEN", "message": "无权使用指定上传配置" } }
 *
 * // 上传配置不存在或不可用 (404)
 * { "error": { "code": "UPLOAD_CONFIG_NOT_FOUND", "message": "配置不存在或不可用" } }
 *
 * // R2 配置不支持服务端上传 (400)
 * { "error": "R2 配置请使用预签名上传" }
 *
 * // 缺少 Content-Length (411)
 * { "error": "上传文件缺少 Content-Length" }
 *
 * // 请求体超过单请求上限 (413)
 * { "error": "上传文件大小超过限制" }
 *
 * // 文件大小超过限制（单请求 100MB 上限）(413)
 * { "error": "文件大小超过限制（最大 100MB）" }
 *
 * // 上游存储连接中断 (502)
 * { "error": "上传失败（存储服务连接中断，请稍后重试）" }
 *
 * // 上游存储返回错误（透传上游状态码）(502)
 * { "error": "上传失败（存储服务返回错误）" }
 *
 * // 上游/内部错误 (500)
 * { "error": { "code": "UPLOAD_SERVER_FAILED", "message": "服务端上传失败" } }
 */
export async function serverUpload(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  try {
    const contentType = String(request.headers.get('Content-Type') || '')
    if (!contentType.includes('multipart/form-data')) {
      return jsonResponse({ error: '请求格式错误，需要 multipart/form-data' }, 400)
    }

    const contentLengthResponse = rejectInvalidContentLength(
      request,
      MAX_SERVER_UPLOAD_REQUEST_BYTES,
      '上传文件'
    )
    if (contentLengthResponse) return contentLengthResponse

    const formData = await request.formData()
    const configId = String(formData.get('config_id') || '').trim()
    const filename = String(formData.get('filename') || '').trim()
    const expiresInRaw = Number(formData.get('expires_in') || 7)
    const requireLogin = formData.get('require_login') !== 'false'
    const rawFile = formData.get('file')
    const dirRaw = String(formData.get('dir') || '').trim()
    const dir = sanitizeDir(dirRaw)

    const customCode = normalizeCustomShortCode(formData.get('custom_short_code'))
    if (customCode.kind === 'invalid') {
      return uploadErrorResponse(customShortCodeInvalidError(customCode.message))
    }
    const customShortCode = customCode.kind === 'ok' ? customCode.code : undefined

    if (!configId) {
      return jsonResponse({ error: '缺少 config_id' }, 400)
    }
    if (!filename) {
      return jsonResponse({ error: '缺少 filename' }, 400)
    }
    if (!rawFile || !(rawFile instanceof File)) {
      return jsonResponse({ error: '缺少文件' }, 400)
    }

    const file = rawFile as File
    const fileSize = file.size
    if (fileSize > MAX_SERVER_UPLOAD_BYTES) {
      return jsonResponse(
        { error: `文件大小超过限制（最大 ${MAX_SERVER_UPLOAD_BYTES / 1024 / 1024}MB）` },
        413
      )
    }

    let resolvedConfig
    try {
      resolvedConfig = await resolveServerUploadConfigForUser(env, user, configId)
    } catch (error) {
      const response = createUploadConfigPolicyErrorResponse(error)
      if (response) return response
      throw error
    }

    if (!resolvedConfig) {
      return uploadErrorResponse(uploadConfigNotFoundError())
    }

    if (resolvedConfig.type === 'r2') {
      return jsonResponse({ error: 'R2 配置请使用预签名上传' }, 400)
    }

    const provider = await createProvider(env, configId)
    if (!provider) {
      return uploadErrorResponse(uploadConfigNotFoundError())
    }

    const expiresIn = normalizeExpiresIn(expiresInRaw)
    const contentTypeStr = file.type || 'application/octet-stream'
    const declaredSize = normalizeDeclaredFileSize(fileSize)
    if (declaredSize === null) {
      return uploadErrorResponse(invalidUploadRequestError())
    }

    // 自定义短码：落库前跨三表预检占用（竞态由 createFileRecord 的 409 兜底）
    if (customShortCode && (await isShortCodeTaken(env, customShortCode))) {
      return uploadErrorResponse(customShortCodeConflictError())
    }

    let uploadFile: {
      id: string
      r2Key: string
      shortCode: string
      expiresAt: Date
      filename: string
    } | null = null
    let lastError: unknown = null
    for (let attempt = 0; attempt < SHORT_CODE_MAX_ATTEMPTS; attempt += 1) {
      const baseFilename = sanitizeUploadFilename(filename)
      const resolvedFilename = buildRenamedFilename(baseFilename, attempt)
      const expiresAt = calcExpiresAt(expiresIn)
      const relativeKey = dir ? `${dir}/${resolvedFilename}` : resolvedFilename
      const r2Key = buildProviderScopedStorageKey(configId, relativeKey)
      const id = crypto.randomUUID()
      const shortCode = customShortCode || generateRandomCode(FILE_SHORT_CODE_LENGTH)
      uploadFile = { id, r2Key, shortCode, expiresAt, filename: resolvedFilename }

      const occupied = await withD1Retry(env.DB)
        .prepare('SELECT id FROM files WHERE r2_key = ? LIMIT 1')
        .bind(r2Key)
        .first('id')
      if (occupied) continue

      try {
        await createPendingUploadFileRecord(
          env,
          user.id,
          uploadFile,
          declaredSize,
          contentTypeStr,
          expiresIn,
          requireLogin,
          configId,
          user.quota_bytes,
          Boolean(customShortCode)
        )
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (error instanceof Error && error.message === 'create_file_record_conflict') {
          continue
        }
        throw error
      }
    }
    if (!uploadFile || lastError) {
      throw lastError || new Error('create_file_record_failed')
    }

    try {
      const r2Key = uploadFile.r2Key
      const lastSlash = r2Key.lastIndexOf('/')
      if (lastSlash > 0) {
        const dirParts = r2Key.slice(0, lastSlash).split('/').filter(Boolean)
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

      const body = await file.arrayBuffer()
      await provider.upload(r2Key, body, contentTypeStr, fileSize)
    } catch (error) {
      await markFileUploadDeleted(env, uploadFile.id)
      const formatted = formatServerError(error)
      return jsonResponse({ error: `上传失败（${formatted.message}）` }, formatted.status)
    }

    try {
      const now = new Date().toISOString()
      const [updateResult] = await withD1Retry(env.DB).batch([
        withD1Retry(env.DB)
          .prepare(
            "UPDATE files SET upload_status = 'completed', size = ? WHERE id = ? AND upload_status = 'pending'"
          )
          .bind(fileSize, uploadFile.id),
        prepareConsumeUploadReservation(env.DB, uploadFile.id, now),
        prepareAuditLogInsert(
          env.DB,
          {
            actorUserId: user.id,
            action: 'UPLOAD_SERVER',
            targetType: 'file',
            targetId: uploadFile.id,
            ip: getClientIp(request),
            userAgent: request.headers.get('User-Agent') || undefined,
            metadata: {
              configId,
              key: uploadFile.r2Key,
              size: fileSize,
              ...(customShortCode ? { custom_short_code: true } : {}),
            },
          },
          now
        ),
      ])

      if (!updateResult?.meta?.changes) {
        throw new Error('complete_server_upload_file_record_failed')
      }
    } catch (error) {
      await Promise.allSettled([
        provider.delete(uploadFile.r2Key),
        markFileUploadDeleted(env, uploadFile.id),
      ])
      throw error
    }

    const downloadUrl = `/api/files/${uploadFile.id}/download`

    return jsonResponse({
      file_id: uploadFile.id,
      filename: uploadFile.filename,
      download_url: downloadUrl,
      short_url: `/s/${uploadFile.shortCode}`,
      expires_at: uploadFile.expiresAt.toISOString(),
      r2_config_id: configId,
    })
  } catch (error) {
    return uploadErrorResponse(
      mapUnexpectedUploadError(error, {
        code: 'UPLOAD_SERVER_FAILED',
        message: '服务端上传失败',
      })
    )
  }
}
