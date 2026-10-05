import { withD1Retry } from '../../utils/db'
import type { Env } from '../../config/env'
import { getMaxFileSize } from '../../config/env'
import { jsonResponse, parseJson, getUser, calcPresignedDownloadUrlTtlSeconds } from '../utils'
import { generateDownloadUrl, generateUploadUrl, resolveR2ConfigForKey } from '../../services/r2'
import { logAudit } from '../../services/audit'
import { getClientIp } from '../../middleware/rateLimit'
import { resolveUploadConfigForUser } from '../../services/uploadConfigPolicy'
import { normalizeDeclaredFileSize } from '../../services/uploadValidation'
import {
  confirmUploadNotPendingError,
  fileTooLargeError,
  invalidUploadRequestError,
  mapUnexpectedUploadError,
  uploadConfigNotFoundError,
  uploadConfigUnavailableError,
  uploadErrorResponse,
  uploadFileExpiredError,
  uploadFileNotFoundError,
} from '../../services/uploadErrors'
import { prepareConsumeUploadReservation } from '../../services/uploadReservations'
import {
  SHORT_CODE_MAX_ATTEMPTS,
  normalizeExpiresIn,
  isExpired,
  calcDownloadTtlSeconds,
  createUploadConfigPolicyErrorResponse,
  markFileUploadDeleted,
  verifyUploadedObjectSizeOrReject,
  allocateUploadFileIdentity,
  createPendingUploadFileRecord,
} from './helpers'

/**
 * 获取预签名上传 URL（小文件上传）
 *
 * @route POST /api/upload/presign
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含预签名上传 URL
 *
 * @example
 * // 请求体
 * {
 *   "filename": "example.jpg",
 *   "content_type": "image/jpeg",
 *   "size": 1024000,
 *   "expires_in": 86400,
 *   "require_login": false,
 *   "config_id": "default",
 *   "dir": "uploads"
 * }
 *
 * // 成功响应 (200)
 * {
 *   "file_id": "uuid",
 *   "upload_url": "https://...",
 *   "r2_config_id": "default"
 * }
 */
export async function presignUpload(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  try {
    const body = await parseJson<{
      filename: string
      content_type?: string
      size: number
      expires_in: number
      require_login?: boolean
      config_id?: string
      dir?: string
    }>(request)

    const declaredSize = normalizeDeclaredFileSize(body.size)
    if (!body.filename || declaredSize === null) {
      return uploadErrorResponse(invalidUploadRequestError())
    }
    const expiresIn = normalizeExpiresIn(body.expires_in)
    const dir = body.dir

    const maxSize = getMaxFileSize(env)
    if (declaredSize > maxSize) {
      return uploadErrorResponse(fileTooLargeError(declaredSize, maxSize))
    }

    let loaded
    try {
      loaded = await resolveUploadConfigForUser(env, user, body.config_id)
    } catch (error) {
      const response = createUploadConfigPolicyErrorResponse(error)
      if (response) return response
      throw error
    }

    if (!loaded) {
      if (body.config_id) return uploadErrorResponse(uploadConfigNotFoundError())
      return uploadErrorResponse(uploadConfigUnavailableError())
    }

    const contentType = body.content_type || 'application/octet-stream'
    const requireLogin = body.require_login !== false
    let file: {
      id: string
      r2Key: string
      shortCode: string
      expiresAt: Date
      filename: string
    } | null = null
    let lastCreateError: unknown = null
    for (let attempt = 0; attempt < SHORT_CODE_MAX_ATTEMPTS; attempt += 1) {
      file = await allocateUploadFileIdentity(env, body.filename, expiresIn, loaded.id, dir)
      try {
        await createPendingUploadFileRecord(
          env,
          user.id,
          file,
          declaredSize,
          contentType,
          expiresIn,
          requireLogin,
          loaded.id,
          user.quota_bytes
        )
        lastCreateError = null
        break
      } catch (error) {
        lastCreateError = error
        if (error instanceof Error && error.message === 'create_file_record_conflict') {
          continue
        }
        throw error
      }
    }
    if (!file || lastCreateError) {
      throw lastCreateError || new Error('create_file_record_failed')
    }

    let uploadUrl = ''
    try {
      uploadUrl = await generateUploadUrl(loaded.config, file.r2Key, contentType, 3600)
    } catch (error) {
      await markFileUploadDeleted(env, file.id)
      throw error
    }

    await logAudit(env.DB, {
      actorUserId: user.id,
      action: 'UPLOAD_PRESIGN',
      targetType: 'file',
      targetId: file.id,
      ip: getClientIp(request),
      userAgent: request.headers.get('User-Agent') || undefined,
    })

    return jsonResponse({
      file_id: file.id,
      filename: file.filename,
      upload_url: uploadUrl,
      download_url: `/api/files/${file.id}/download`,
      short_url: `/s/${file.shortCode}`,
      expires_at: file.expiresAt.toISOString(),
      r2_config_id: loaded.id,
    })
  } catch (error) {
    return uploadErrorResponse(
      mapUnexpectedUploadError(error, {
        code: 'UPLOAD_PRESIGN_FAILED',
        message: '生成上传 URL 失败',
      })
    )
  }
}

/**
 * 确认小文件上传完成
 *
 * @route POST /api/upload/confirm
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含文件信息和下载链接
 *
 * @example
 * // 请求体
 * {
 *   "file_id": "uuid"
 * }
 *
 * // 成功响应 (200)
 * {
 *   "file_id": "uuid",
 *   "filename": "example.jpg",
 *   "download_url": "https://...",
 *   "short_url": "/s/abc123",
 *   "expires_at": "2026-09-15T00:00:00.000Z",
 *   "r2_config_id": "default"
 * }
 *
 * // 文件已过期 (410)
 * { "error": { "code": "UPLOAD_FILE_EXPIRED", "message": "文件已过期" } }
 *
 * // 文件不在待确认状态（已删除/已确认/分片中）(409)
 * { "error": { "code": "UPLOAD_CONFIRM_NOT_PENDING", "message": "文件不在待确认状态，无法完成确认" } }
 */
export async function confirmUpload(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  try {
    const body = await parseJson<{ file_id: string }>(request)

    const file = await withD1Retry(env.DB)
      .prepare(
        'SELECT id, owner_id, filename, r2_key, expires_at, short_code, require_login, size, upload_status, deleted_at FROM files WHERE id = ? LIMIT 1'
      )
      .bind(body.file_id)
      .first()

    if (!file || file.owner_id !== user.id) {
      return uploadErrorResponse(uploadFileNotFoundError())
    }

    if (isExpired(file.expires_at)) {
      return uploadErrorResponse(uploadFileExpiredError())
    }

    if (file.deleted_at || file.upload_status !== 'pending') {
      return uploadErrorResponse(confirmUploadNotPendingError())
    }

    const r2Key = String(file.r2_key)
    const loaded = await resolveR2ConfigForKey(env, r2Key)
    if (!loaded) return uploadErrorResponse(uploadConfigUnavailableError())

    const sizeValidation = await verifyUploadedObjectSizeOrReject(
      env,
      {
        id: String(file.id),
        size: Number(file.size),
        r2_key: r2Key,
      },
      loaded,
      {
        actorUserId: user.id,
        ip: getClientIp(request),
        userAgent: request.headers.get('User-Agent') || undefined,
        stage: 'confirm_upload',
      }
    )
    if ('response' in sizeValidation) {
      return sizeValidation.response
    }

    const now = new Date().toISOString()
    const [updateResult] = await withD1Retry(env.DB).batch([
      withD1Retry(env.DB)
        .prepare(
          "UPDATE files SET size = ?, upload_status = 'completed' WHERE id = ? AND upload_status = 'pending' AND deleted_at IS NULL"
        )
        .bind(sizeValidation.actualSize, body.file_id),
      prepareConsumeUploadReservation(env.DB, body.file_id, now),
    ])

    // 与 serverUpload 对齐：状态守卫命中 0 行说明确认期间记录被并发删除/变更，
    // 不得再置 completed
    if (!updateResult?.meta?.changes) {
      return uploadErrorResponse(confirmUploadNotPendingError())
    }

    let downloadUrl = `/api/files/${body.file_id}/download`
    const allowDirect = Number(file.require_login) === 0
    if (allowDirect) {
      try {
        if (!isExpired(file.expires_at)) {
          const ttl = calcDownloadTtlSeconds(file.expires_at)
          downloadUrl = await generateDownloadUrl(loaded.config, r2Key, String(file.filename), ttl)
        }
      } catch (error) {
        downloadUrl = `/api/files/${body.file_id}/download`
      }
    }

    return jsonResponse({
      success: true,
      filename: String(file.filename),
      download_url: downloadUrl,
      short_url: `/s/${file.short_code}`,
      r2_config_id: loaded.id,
    })
  } catch (error) {
    return uploadErrorResponse(
      mapUnexpectedUploadError(error, {
        code: 'UPLOAD_CONFIRM_FAILED',
        message: '确认上传失败',
      })
    )
  }
}
