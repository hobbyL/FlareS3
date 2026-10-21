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
import { StorageError } from '../../services/storage/types'
import { rejectInvalidContentLength } from '../../services/requestBodyPolicy'
import {
  prepareConsumeUploadReservation,
  prepareReleaseUploadReservation,
} from '../../services/uploadReservations'
import { resolveServerUploadConfigForUser } from '../../services/uploadConfigPolicy'
import { generateRandomCode } from '../../utils/random'
import { FILE_SHORT_CODE_LENGTH } from '../../utils/codePolicy'
import { prepareEnqueueFileDeletionIfNeeded } from '../../services/deleteQueue'
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
 * // 同名候选耗尽或远端目标已存在 (409)
 * { "error": "同名文件过多，请修改文件名后重试" }
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
      const candidate = { id, r2Key, shortCode, expiresAt, filename: resolvedFilename }

      const occupied = await withD1Retry(env.DB)
        .prepare('SELECT id FROM files WHERE r2_key = ? LIMIT 1')
        .bind(r2Key)
        .first('id')
      if (occupied) continue

      try {
        await createPendingUploadFileRecord(
          env,
          user.id,
          // 在条件创建成功前只登记本次专用占位 key。即使失败后的 D1 清理失败，
          // 回收站任务也不会持有已有远端目标的 key。
          { ...candidate, r2Key: buildProviderScopedStorageKey(configId, `.pending/${id}`) },
          declaredSize,
          contentTypeStr,
          expiresIn,
          requireLogin,
          configId,
          user.quota_bytes,
          Boolean(customShortCode)
        )
        uploadFile = candidate
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
      if (!uploadFile && !lastError) {
        return jsonResponse({ error: '同名文件过多，请修改文件名后重试' }, 409)
      }
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
      await provider.upload(r2Key, body, contentTypeStr, fileSize, { ifNoneMatch: '*' })
    } catch (error) {
      if (error instanceof StorageError && error.code === 'TargetExists') {
        // 条件 PUT 未创建对象，不能留下稍后会删除已有目标的回收站记录。
        await withD1Retry(env.DB).batch([
          prepareReleaseUploadReservation(env.DB, uploadFile.id),
          withD1Retry(env.DB)
            .prepare("DELETE FROM files WHERE id = ? AND upload_status = 'pending'")
            .bind(uploadFile.id),
        ])
        return jsonResponse({ error: '目标文件已存在，请修改文件名后重试' }, 409)
      }
      await markFileUploadDeleted(env, uploadFile.id)
      const formatted = formatServerError(error)
      return jsonResponse({ error: `上传失败（${formatted.message}）` }, formatted.status)
    }

    try {
      const now = new Date().toISOString()
      const placeholderKey = buildProviderScopedStorageKey(configId, `.pending/${uploadFile.id}`)
      // 仅在条件 PUT 已确认成功后登记实际对象，先补齐并发删除留下的队列快照。
      const [ownedResult] = await withD1Retry(env.DB).batch([
        withD1Retry(env.DB)
          .prepare(
            "UPDATE files SET r2_key = ?, upload_updated_at = ? WHERE id = ? AND r2_key = ? AND upload_status IN ('pending','deleted') AND deletion_token IS NULL"
          )
          .bind(uploadFile.r2Key, now, uploadFile.id, placeholderKey),
        withD1Retry(env.DB)
          .prepare(
            'UPDATE delete_queue SET r2_key = ? WHERE file_id = ? AND processed_at IS NULL AND orphan_multipart = 0 AND EXISTS (SELECT 1 FROM files WHERE id = ? AND r2_key = ?)'
          )
          .bind(uploadFile.r2Key, uploadFile.id, uploadFile.id, uploadFile.r2Key),
      ])
      if (!ownedResult?.meta?.changes) throw new Error('persist_server_upload_object_failed')
      const [updateResult] = await withD1Retry(env.DB).batch([
        withD1Retry(env.DB)
          .prepare(
            "UPDATE files SET upload_status = 'completed', size = ?, r2_key = ?, upload_key = NULL WHERE id = ? AND upload_status = 'pending' AND deleted_at IS NULL"
          )
          .bind(fileSize, uploadFile.r2Key, uploadFile.id),
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
      // 超时可能发生在提交之后；复核成功记录后禁止盲目补偿删除。
      const current = await withD1Retry(env.DB)
        .prepare('SELECT upload_status, r2_key, deleted_at FROM files WHERE id = ? LIMIT 1')
        .bind(uploadFile.id)
        .first<{ upload_status: string; r2_key: string; deleted_at: string | null }>()
      if (
        !(
          current?.upload_status === 'completed' &&
          current.r2_key === uploadFile.r2Key &&
          !current.deleted_at
        )
      ) {
        const now = new Date().toISOString()
        const placeholderKey = buildProviderScopedStorageKey(configId, `.pending/${uploadFile.id}`)
        const [cleanupResult] = await withD1Retry(env.DB).batch([
          withD1Retry(env.DB)
            .prepare(
              "UPDATE files SET r2_key = ?, upload_status = 'deleted', deleted_at = COALESCE(deleted_at, ?), deletion_started_at = COALESCE(deletion_started_at, ?) WHERE id = ? AND r2_key IN (?, ?) AND upload_status IN ('pending','deleted') AND deletion_token IS NULL"
            )
            .bind(uploadFile.r2Key, now, now, uploadFile.id, placeholderKey, uploadFile.r2Key),
          withD1Retry(env.DB)
            .prepare(
              'UPDATE delete_queue SET r2_key = ? WHERE file_id = ? AND processed_at IS NULL AND orphan_multipart = 0 AND EXISTS (SELECT 1 FROM files WHERE id = ? AND r2_key = ?)'
            )
            .bind(uploadFile.r2Key, uploadFile.id, uploadFile.id, uploadFile.r2Key),
          prepareReleaseUploadReservation(env.DB, uploadFile.id, now),
          prepareEnqueueFileDeletionIfNeeded(
            env.DB,
            { id: uploadFile.id, r2_key: uploadFile.r2Key },
            now
          ),
        ])
        console.error(
          '[serverUpload] completion failed; compensation queued',
          { fileId: uploadFile.id, queued: Boolean(cleanupResult?.meta?.changes) },
          error
        )
        throw error
      }
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
