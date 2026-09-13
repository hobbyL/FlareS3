import type { Env } from '../../config/env'
import { getMaxFileSize } from '../../config/env'
import { jsonResponse, parseJson, getUser } from '../utils'
import {
  abortMultipartUpload,
  completeMultipartUpload,
  deleteObject,
  generateDownloadUrl,
  generateMultipartUploadUrl,
  initiateMultipartUpload,
  listParts,
  resolveR2ConfigForKey,
  summarizeS3Error,
} from '../../services/r2'
import { prepareAuditLogInsert } from '../../services/audit'
import { getClientIp } from '../../middleware/rateLimit'
import { resolveUploadConfigForUser } from '../../services/uploadConfigPolicy'
import {
  MAX_S3_MULTIPART_PARTS,
  calculateMultipartTotalParts,
  normalizeDeclaredFileSize,
  normalizeMultipartPartNumber,
} from '../../services/uploadValidation'
import {
  createUploadError,
  fileTooLargeError,
  invalidUploadRequestError,
  mapUnexpectedUploadError,
  multipartFileIdRequiredError,
  multipartNotInitializedError,
  multipartPartNumberInvalidError,
  multipartUploadIdMismatchError,
  multipartUploadIdMissingError,
  uploadConfigNotFoundError,
  uploadConfigUnavailableError,
  uploadErrorResponse,
  uploadFileExpiredError,
  uploadFileNotFoundError,
} from '../../services/uploadErrors'
import { prepareEnqueueFileDeletionIfNeeded } from '../../services/deleteQueue'
import {
  prepareConsumeUploadReservation,
  prepareReleaseUploadReservation,
} from '../../services/uploadReservations'
import {
  PART_SIZE,
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

function invalidMultipartPartCountError(declaredSize: number) {
  return invalidUploadRequestError({
    reason: 'MULTIPART_PART_COUNT_EXCEEDED',
    declaredSize,
    partSize: PART_SIZE,
    maxParts: MAX_S3_MULTIPART_PARTS,
  })
}

function normalizeCompleteMultipartParts(
  parts: Array<{ PartNumber?: unknown; ETag?: unknown }>,
  totalParts: number
): Array<{ PartNumber: number; ETag: string }> | null {
  const normalized: Array<{ PartNumber: number; ETag: string }> = []
  const seenPartNumbers = new Set<number>()

  for (const part of parts) {
    const partNumber = normalizeMultipartPartNumber(part.PartNumber, totalParts)
    const rawEtag = typeof part.ETag === 'string' ? part.ETag.trim() : ''
    if (!partNumber || !rawEtag || seenPartNumbers.has(partNumber)) {
      return null
    }
    seenPartNumbers.add(partNumber)
    normalized.push({
      PartNumber: partNumber,
      ETag: rawEtag.startsWith('"') ? rawEtag : `"${rawEtag}"`,
    })
  }

  return normalized.length > 0 ? normalized : null
}

/**
 * 初始化分片上传（大文件上传）
 *
 * @route POST /api/upload/multipart/init
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含上传 ID 和分片信息
 *
 * @example
 * // 请求体
 * {
 *   "filename": "large-file.zip",
 *   "content_type": "application/zip",
 *   "size": 500000000,
 *   "expires_in": 86400,
 *   "require_login": false,
 *   "config_id": "default",
 *   "dir": "uploads"
 * }
 *
 * // 成功响应 (200)
 * {
 *   "file_id": "uuid",
 *   "filename": "large-file.zip",
 *   "upload_id": "multipart-upload-id",
 *   "part_size": 10485760,
 *   "total_parts": 48,
 *   "r2_config_id": "default"
 * }
 */
export async function initMultipart(request: Request, env: Env): Promise<Response> {
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
    const totalParts = calculateMultipartTotalParts(declaredSize, PART_SIZE)
    if (totalParts === null || totalParts > MAX_S3_MULTIPART_PARTS) {
      return uploadErrorResponse(invalidMultipartPartCountError(declaredSize))
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

    let uploadId = ''
    try {
      uploadId = await initiateMultipartUpload(loaded.config, file.r2Key, contentType)
    } catch (error) {
      await markFileUploadDeleted(env, file.id)
      throw error
    }

    await env.DB.prepare('UPDATE files SET upload_status = ?, multipart_upload_id = ? WHERE id = ?')
      .bind('uploading', uploadId, file.id)
      .run()

    return jsonResponse({
      file_id: file.id,
      filename: file.filename,
      upload_id: uploadId,
      part_size: PART_SIZE,
      total_parts: totalParts,
      r2_config_id: loaded.id,
    })
  } catch (error) {
    return uploadErrorResponse(
      mapUnexpectedUploadError(error, {
        code: 'UPLOAD_MULTIPART_INIT_FAILED',
        message: '初始化分片上传失败',
      })
    )
  }
}

/**
 * 获取分片上传的预签名 URL
 *
 * @route POST /api/upload/multipart/presign
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含指定分片的预签名上传 URL
 *
 * @example
 * // 请求体
 * {
 *   "file_id": "uuid",
 *   "upload_id": "multipart-upload-id",
 *   "part_number": 1
 * }
 *
 * // 成功响应 (200)
 * {
 *   "upload_url": "https://...",
 *   "part_number": 1
 * }
 */
export async function presignMultipart(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  try {
    const body = await parseJson<{
      file_id: string
      upload_id: string
      part_number: number
    }>(request)

    const file = await env.DB.prepare(
      'SELECT id, owner_id, r2_key, expires_at, upload_status, multipart_upload_id, size FROM files WHERE id = ?'
    )
      .bind(body.file_id)
      .first()

    if (!file || file.owner_id !== user.id) {
      return uploadErrorResponse(uploadFileNotFoundError())
    }

    if (isExpired(file.expires_at)) {
      return uploadErrorResponse(uploadFileExpiredError())
    }

    if (file.upload_status !== 'uploading') {
      return uploadErrorResponse(multipartNotInitializedError())
    }

    const storedUploadId = String(file.multipart_upload_id || '').trim()
    if (!storedUploadId) {
      return uploadErrorResponse(multipartUploadIdMissingError())
    }
    if (storedUploadId !== String(body.upload_id || '').trim()) {
      return uploadErrorResponse(multipartUploadIdMismatchError())
    }

    const totalParts = calculateMultipartTotalParts(Number(file.size), PART_SIZE)
    if (totalParts === null || totalParts > MAX_S3_MULTIPART_PARTS) {
      return uploadErrorResponse(invalidMultipartPartCountError(Number(file.size)))
    }

    const partNumber = normalizeMultipartPartNumber(body.part_number, totalParts)
    if (!partNumber) {
      return uploadErrorResponse(multipartPartNumberInvalidError())
    }

    const loaded = await resolveR2ConfigForKey(env, String(file.r2_key))
    if (!loaded) return uploadErrorResponse(uploadConfigUnavailableError())

    const uploadUrl = await generateMultipartUploadUrl(
      loaded.config,
      String(file.r2_key),
      storedUploadId,
      partNumber,
      3600
    )

    return jsonResponse({
      upload_url: uploadUrl,
      part_number: partNumber,
    })
  } catch (error) {
    return uploadErrorResponse(
      mapUnexpectedUploadError(error, {
        code: 'UPLOAD_MULTIPART_PRESIGN_FAILED',
        message: '生成分片上传 URL 失败',
      })
    )
  }
}

/**
 * 获取已上传的分片列表（用于断点续传）
 *
 * @route GET /api/upload/multipart/parts
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含已上传的分片列表
 *
 * @example
 * // 请求参数
 * // GET /api/upload/multipart/parts?file_id=uuid&upload_id=multipart-upload-id
 *
 * // 成功响应 (200)
 * {
 *   "file_id": "uuid",
 *   "upload_id": "multipart-upload-id",
 *   "parts": [
 *     { "PartNumber": 1, "ETag": "\"abc123...\"" },
 *     { "PartNumber": 2, "ETag": "\"def456...\"" }
 *   ]
 * }
 */
export async function getMultipartParts(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  try {
    const url = new URL(request.url)
    const fileId = url.searchParams.get('file_id')
    const uploadId = url.searchParams.get('upload_id')

    if (!fileId || !uploadId) {
      return uploadErrorResponse(
        createUploadError({
          status: 400,
          code: 'INVALID_REQUEST',
          message: 'file_id 和 upload_id 参数必需',
        })
      )
    }

    const file = await env.DB.prepare(
      'SELECT id, owner_id, r2_key, expires_at, upload_status, multipart_upload_id, size FROM files WHERE id = ?'
    )
      .bind(fileId)
      .first()

    if (!file || file.owner_id !== user.id) {
      return uploadErrorResponse(uploadFileNotFoundError())
    }

    if (isExpired(file.expires_at)) {
      return uploadErrorResponse(uploadFileExpiredError())
    }

    if (file.upload_status !== 'uploading') {
      return uploadErrorResponse(multipartNotInitializedError())
    }

    const storedUploadId = String(file.multipart_upload_id || '').trim()
    if (!storedUploadId) {
      return uploadErrorResponse(multipartUploadIdMissingError())
    }
    if (storedUploadId !== uploadId.trim()) {
      return uploadErrorResponse(multipartUploadIdMismatchError())
    }

    const loaded = await resolveR2ConfigForKey(env, String(file.r2_key))
    if (!loaded) return uploadErrorResponse(uploadConfigUnavailableError())

    const parts = await listParts(loaded.config, String(file.r2_key), storedUploadId)

    return jsonResponse({
      file_id: fileId,
      upload_id: uploadId,
      parts: parts || [],
    })
  } catch (error) {
    return uploadErrorResponse(
      mapUnexpectedUploadError(error, {
        code: 'GET_MULTIPART_PARTS_FAILED',
        message: '获取已上传分片失败',
      })
    )
  }
}

/**
 * 完成分片上传
 *
 * @route POST /api/upload/multipart/complete
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含文件信息和下载链接
 *
 * @example
 * // 请求体
 * {
 *   "file_id": "uuid",
 *   "upload_id": "multipart-upload-id",
 *   "parts": [
 *     { "part_number": 1, "etag": "\"abc123...\"" },
 *     { "part_number": 2, "etag": "\"def456...\"" }
 *   ]
 * }
 *
 * // 成功响应 (200)
 * {
 *   "file_id": "uuid",
 *   "filename": "large-file.zip",
 *   "download_url": "https://...",
 *   "short_url": "/s/abc123",
 *   "expires_at": "2026-09-15T00:00:00.000Z",
 *   "r2_config_id": "default"
 * }
 */
export async function completeMultipart(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  try {
    const body = await parseJson<{
      file_id: string
      upload_id: string
      parts?: Array<{ part_number: number; etag: string }>
    }>(request)

    const file = await env.DB.prepare(
      'SELECT id, owner_id, filename, r2_key, expires_at, short_code, require_login, upload_status, multipart_upload_id, size FROM files WHERE id = ?'
    )
      .bind(body.file_id)
      .first()

    if (!file || file.owner_id !== user.id) {
      return uploadErrorResponse(uploadFileNotFoundError())
    }

    const expiresAt = new Date(String(file.expires_at))
    const expiresAtMs = expiresAt.getTime()
    if (Number.isNaN(expiresAtMs)) {
      return uploadErrorResponse(
        createUploadError({
          status: 500,
          code: 'UPLOAD_FILE_EXPIRATION_INVALID',
          message: '文件过期时间无效',
        })
      )
    }
    if (Date.now() > expiresAtMs) {
      return uploadErrorResponse(uploadFileExpiredError())
    }

    if (file.upload_status !== 'uploading') {
      return uploadErrorResponse(multipartNotInitializedError())
    }

    const storedUploadId = String(file.multipart_upload_id || '').trim()
    if (!storedUploadId) {
      return uploadErrorResponse(multipartUploadIdMissingError())
    }
    if (storedUploadId !== String(body.upload_id || '').trim()) {
      return uploadErrorResponse(multipartUploadIdMismatchError())
    }

    const loaded = await resolveR2ConfigForKey(env, String(file.r2_key))
    if (!loaded) return uploadErrorResponse(uploadConfigUnavailableError())

    const totalParts = calculateMultipartTotalParts(Number(file.size), PART_SIZE)
    if (totalParts === null || totalParts > MAX_S3_MULTIPART_PARTS) {
      return uploadErrorResponse(invalidMultipartPartCountError(Number(file.size)))
    }

    const requestParts = Array.isArray(body.parts) ? body.parts : []
    const rawParts =
      requestParts.length > 0
        ? requestParts.map((part) => ({
            PartNumber: part.part_number,
            ETag: part.etag,
          }))
        : await listParts(loaded.config, String(file.r2_key), storedUploadId)
    const parts = normalizeCompleteMultipartParts(rawParts, totalParts)
    if (!parts) {
      return uploadErrorResponse(multipartPartNumberInvalidError())
    }

    await completeMultipartUpload(loaded.config, String(file.r2_key), storedUploadId, parts)

    const sizeValidation = await verifyUploadedObjectSizeOrReject(
      env,
      {
        id: String(file.id),
        size: Number(file.size),
        r2_key: String(file.r2_key),
      },
      loaded,
      {
        actorUserId: user.id,
        ip: getClientIp(request),
        userAgent: request.headers.get('User-Agent') || undefined,
        stage: 'complete_multipart',
      }
    )
    if ('response' in sizeValidation) {
      return sizeValidation.response
    }

    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE files SET size = ?, upload_status = ?, multipart_upload_id = NULL WHERE id = ?'
      ).bind(sizeValidation.actualSize, 'completed', file.id),
      prepareConsumeUploadReservation(env.DB, String(file.id), now),
    ])

    let downloadUrl = `/api/files/${file.id}/download`
    const allowDirect = Number(file.require_login) === 0
    if (allowDirect) {
      try {
        if (!isExpired(file.expires_at)) {
          const ttl = calcDownloadTtlSeconds(file.expires_at)
          downloadUrl = await generateDownloadUrl(
            loaded.config,
            String(file.r2_key),
            String(file.filename),
            ttl
          )
        }
      } catch (error) {
        downloadUrl = `/api/files/${file.id}/download`
      }
    }

    return jsonResponse({
      file_id: file.id,
      filename: String(file.filename),
      download_url: downloadUrl,
      short_url: `/s/${file.short_code}`,
      expires_at: String(file.expires_at),
      r2_config_id: loaded.id,
    })
  } catch (error) {
    return uploadErrorResponse(
      mapUnexpectedUploadError(error, {
        code: 'UPLOAD_MULTIPART_COMPLETE_FAILED',
        message: '完成分片上传失败',
      })
    )
  }
}

/**
 * 取消分片上传
 *
 * @route POST /api/upload/multipart/abort
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含取消结果
 *
 * @example
 * // 请求体
 * {
 *   "file_id": "uuid"
 * }
 *
 * // 成功响应 (200)
 * {
 *   "success": true,
 *   "queued": false
 * }
 */
export async function abortMultipart(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  try {
    const body = await parseJson<{ file_id: string }>(request)
    const fileId = String(body?.file_id || '').trim()
    if (!fileId) {
      return uploadErrorResponse(multipartFileIdRequiredError())
    }

    const file = await env.DB.prepare(
      'SELECT id, owner_id, r2_key, upload_status, multipart_upload_id FROM files WHERE id = ? LIMIT 1'
    )
      .bind(fileId)
      .first()

    if (!file || file.owner_id !== user.id) {
      return uploadErrorResponse(uploadFileNotFoundError())
    }

    if (file.upload_status !== 'uploading') {
      return uploadErrorResponse(
        createUploadError({
          status: 400,
          code: 'UPLOAD_MULTIPART_NOT_ACTIVE',
          message: '文件不在分片上传中',
        })
      )
    }

    const r2Key = String(file.r2_key)
    const multipartUploadId = String(file.multipart_upload_id || '').trim()
    if (!multipartUploadId) {
      return uploadErrorResponse(multipartUploadIdMissingError())
    }

    const loaded = await resolveR2ConfigForKey(env, r2Key)
    if (!loaded) return uploadErrorResponse(uploadConfigUnavailableError())

    let queued = false
    try {
      await abortMultipartUpload(loaded.config, r2Key, multipartUploadId)
    } catch (error) {
      const summary = summarizeS3Error(error)
      if (summary.httpStatusCode === 404 || summary.code === 'NoSuchUpload') {
        try {
          await deleteObject(loaded.config, r2Key)
        } catch (deleteError) {
          const deleteSummary = summarizeS3Error(deleteError)
          if (deleteSummary.httpStatusCode !== 404 && deleteSummary.code !== 'NoSuchKey') {
            throw deleteError
          }
        }
      } else {
        queued = true
      }
    }

    const now = new Date().toISOString()
    const statements: D1PreparedStatement[] = queued
      ? [
          env.DB.prepare(
            "UPDATE files SET upload_status = 'deleted', deleted_at = ? WHERE id = ?"
          ).bind(now, fileId),
          prepareEnqueueFileDeletionIfNeeded(env.DB, { id: fileId, r2_key: r2Key }, now),
          prepareReleaseUploadReservation(env.DB, fileId, now),
        ]
      : [
          env.DB.prepare(
            "UPDATE files SET upload_status = 'deleted', deleted_at = ?, multipart_upload_id = NULL WHERE id = ?"
          ).bind(now, fileId),
          prepareReleaseUploadReservation(env.DB, fileId, now),
        ]

    statements.push(
      prepareAuditLogInsert(
        env.DB,
        {
          actorUserId: user.id,
          action: 'UPLOAD_ABORT',
          targetType: 'file',
          targetId: fileId,
          ip: getClientIp(request),
          userAgent: request.headers.get('User-Agent') || undefined,
          metadata: { queued },
        },
        now
      )
    )
    await env.DB.batch(statements)

    return jsonResponse({ success: true, queued })
  } catch (error) {
    return uploadErrorResponse(
      mapUnexpectedUploadError(error, {
        code: 'UPLOAD_MULTIPART_ABORT_FAILED',
        message: '取消分片上传失败',
      })
    )
  }
}
