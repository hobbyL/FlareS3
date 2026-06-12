import type { Env } from '../../config/env'
import { getMaxFileSize } from '../../config/env'
import { jsonResponse, parseJson, getUser, calcPresignedDownloadUrlTtlSeconds } from '../utils'
import { generateDownloadUrl, generateUploadUrl, resolveR2ConfigForKey } from '../../services/r2'
import { logAudit } from '../../services/audit'
import { getClientIp } from '../../middleware/rateLimit'
import { resolveUploadConfigForUser } from '../../services/uploadConfigPolicy'
import { normalizeDeclaredFileSize } from '../../services/uploadValidation'
import {
  fileTooLargeError,
  invalidUploadRequestError,
  mapUnexpectedUploadError,
  uploadConfigNotFoundError,
  uploadConfigUnavailableError,
  uploadErrorResponse,
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

export async function confirmUpload(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  try {
    const body = await parseJson<{ file_id: string }>(request)

    const file = await env.DB.prepare(
      'SELECT id, owner_id, filename, r2_key, expires_at, short_code, require_login, size FROM files WHERE id = ? LIMIT 1'
    )
      .bind(body.file_id)
      .first()

    if (!file || file.owner_id !== user.id) {
      return uploadErrorResponse(uploadFileNotFoundError())
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
    await env.DB.batch([
      env.DB.prepare('UPDATE files SET size = ?, upload_status = ? WHERE id = ?').bind(
        sizeValidation.actualSize,
        'completed',
        body.file_id
      ),
      prepareConsumeUploadReservation(env.DB, body.file_id, now),
    ])

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
