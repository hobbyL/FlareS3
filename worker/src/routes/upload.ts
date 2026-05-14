import type { Env } from '../config/env'
import { getMaxFileSize } from '../config/env'
import { jsonResponse, parseJson, getUser, calcPresignedDownloadUrlTtlSeconds } from './utils'
import {
  abortMultipartUpload,
  buildR2Key,
  completeMultipartUpload,
  deleteObject,
  generateDownloadUrl,
  generateMultipartUploadUrl,
  generateUploadUrl,
  getObjectSize,
  initiateMultipartUpload,
  listParts,
  loadR2ConfigById,
  resolveR2ConfigForKey,
  sanitizeFilename,
  summarizeS3Error,
} from '../services/r2'
import { logAudit, prepareAuditLogInsert } from '../services/audit'
import { getClientIp } from '../middleware/rateLimit'
import { generateRandomCode } from '../utils/random'
import {
  isUploadConfigPolicyError,
  resolveUploadConfigForUser,
} from '../services/uploadConfigPolicy'
import { normalizeDeclaredFileSize, validateUploadedObjectSize } from '../services/uploadValidation'
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
  uploadConfigForbiddenError,
  uploadConfigNotFoundError,
  uploadConfigUnavailableError,
  uploadErrorResponse,
  uploadFileExpiredError,
  uploadFileNotFoundError,
  uploadObjectMissingError,
  uploadObjectSizeInvalidError,
  uploadObjectSizeMismatchError,
} from '../services/uploadErrors'
import { prepareEnqueueFileDeletionIfNeeded } from '../services/deleteQueue'
import { createProvider } from '../services/storage/factory'
import {
  prepareConsumeUploadReservation,
  prepareReleaseUploadReservation,
  releaseUploadReservation,
  reserveUploadCapacity,
} from '../services/uploadReservations'

const ALLOWED_EXPIRES = new Set([-30, 0, 1, 3, 7, 30])
const PART_SIZE = 20 * 1024 * 1024
const NEVER_EXPIRES_AT_ISO = '9999-12-31T23:59:59.999Z'

function normalizeExpiresIn(value: unknown): number {
  const expiresIn = Number(value)
  if (!Number.isFinite(expiresIn)) return 7
  return ALLOWED_EXPIRES.has(expiresIn) ? expiresIn : 7
}

function calcExpiresAt(expiresIn: number): Date {
  const now = new Date()
  if (expiresIn === -30) {
    return new Date(now.getTime() + 30 * 1000)
  }
  if (expiresIn === 0) {
    return new Date(NEVER_EXPIRES_AT_ISO)
  }
  return new Date(now.getTime() + expiresIn * 24 * 60 * 60 * 1000)
}

function isNeverExpires(expiresAt: unknown): boolean {
  const value = String(expiresAt || '').trim()
  if (!value) return false
  return value === NEVER_EXPIRES_AT_ISO
}

function isExpired(expiresAt: unknown): boolean {
  if (isNeverExpires(expiresAt)) return false
  const expiresAtMs = new Date(String(expiresAt)).getTime()
  if (Number.isNaN(expiresAtMs)) return true
  return Date.now() > expiresAtMs
}

function calcDownloadTtlSeconds(expiresAt: unknown): number {
  if (isNeverExpires(expiresAt)) {
    return 24 * 60 * 60
  }
  const parsed = new Date(String(expiresAt))
  const parsedMs = parsed.getTime()
  if (Number.isNaN(parsedMs)) {
    return 24 * 60 * 60
  }
  return calcPresignedDownloadUrlTtlSeconds(parsed)
}

const SHORT_CODE_MAX_ATTEMPTS = 10
const FILENAME_RENAME_MAX_ATTEMPTS = 100

function createUploadConfigPolicyErrorResponse(error: unknown): Response | null {
  if (!isUploadConfigPolicyError(error)) {
    return null
  }
  return uploadErrorResponse(uploadConfigForbiddenError(error.message))
}

function sanitizeUploadFilename(filename: string): string {
  return sanitizeFilename(filename)
}

function splitFilename(filename: string): { stem: string; ext: string } {
  const safe = String(filename || 'file')
  const dotIndex = safe.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === safe.length - 1) {
    return { stem: safe, ext: '' }
  }
  return {
    stem: safe.slice(0, dotIndex),
    ext: safe.slice(dotIndex),
  }
}

function buildRenamedFilename(filename: string, suffix: number): string {
  if (suffix <= 0) return filename
  const { stem, ext } = splitFilename(filename)
  return `${stem}(${suffix})${ext}`
}

function formatD1ErrorMessage(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

async function markFileUploadDeleted(env: Env, fileId: string): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE files SET upload_status = 'deleted', deleted_at = ?, multipart_upload_id = NULL WHERE id = ?"
    ).bind(now, fileId),
    prepareReleaseUploadReservation(env.DB, fileId, now),
  ])
}

async function deleteUploadedObjectIfPresent(
  loaded: NonNullable<Awaited<ReturnType<typeof resolveR2ConfigForKey>>>,
  r2Key: string
): Promise<void> {
  try {
    await deleteObject(loaded.config, r2Key)
  } catch (error) {
    const summary = summarizeS3Error(error)
    if (summary.httpStatusCode === 404 || summary.code === 'NoSuchKey') {
      return
    }
    throw error
  }
}

async function verifyUploadedObjectSizeOrReject(
  env: Env,
  file: { id: string; size: number; r2_key: string },
  loaded: NonNullable<Awaited<ReturnType<typeof resolveR2ConfigForKey>>>,
  auditContext?: {
    actorUserId?: string
    ip?: string
    userAgent?: string
    stage: 'confirm_upload' | 'complete_multipart'
  }
): Promise<{ actualSize: number } | { response: Response }> {
  const actualSize = await getObjectSize(loaded.config, String(file.r2_key))
  if (actualSize === null) {
    return {
      response: uploadErrorResponse(uploadObjectMissingError()),
    }
  }

  const expectedSize = Number(file.size)
  const validation = validateUploadedObjectSize(expectedSize, actualSize)
  if (validation.ok) {
    return { actualSize }
  }

  await deleteUploadedObjectIfPresent(loaded, String(file.r2_key))
  await markFileUploadDeleted(env, String(file.id))

  if (validation.reason === 'SIZE_MISMATCH' && auditContext) {
    await Promise.allSettled([
      logAudit(env.DB, {
        actorUserId: auditContext.actorUserId,
        action: 'UPLOAD_SIZE_MISMATCH',
        targetType: 'file',
        targetId: String(file.id),
        ip: auditContext.ip,
        userAgent: auditContext.userAgent,
        metadata: {
          stage: auditContext.stage,
          expected_size: expectedSize,
          actual_size: actualSize,
        },
      }),
    ])
  }

  if (validation.reason === 'INVALID_ACTUAL_SIZE') {
    return {
      response: uploadErrorResponse(uploadObjectSizeInvalidError()),
    }
  }

  return {
    response: uploadErrorResponse(uploadObjectSizeMismatchError()),
  }
}

function isUniqueConstraintError(errorMessage: string, field: 'r2_key' | 'short_code'): boolean {
  const normalized = String(errorMessage || '').toLowerCase()
  if (!normalized.includes('unique constraint failed')) return false
  return normalized.includes(`files.${field}`) || normalized.includes(field)
}

function sanitizeDir(dir: string): string {
  const trimmed = String(dir || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  if (!trimmed || trimmed === '.' || trimmed === '/') return ''
  let clean = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  clean = clean.endsWith('/') ? clean.slice(0, -1) : clean
  if (!clean || clean === '.' || clean === '..') return ''
  const segments = clean.split('/')
  if (segments.some((s) => s === '..' || s === '.')) return ''
  return clean
}

async function allocateUploadFileIdentity(
  env: Env,
  filename: string,
  expiresIn: number,
  r2ConfigId: string,
  dir?: string
): Promise<{ id: string; r2Key: string; shortCode: string; expiresAt: Date; filename: string }> {
  const baseFilename = sanitizeUploadFilename(filename)
  const expiresAt = calcExpiresAt(expiresIn)
  const cleanDir = sanitizeDir(dir || '')

  for (let suffix = 0; suffix < FILENAME_RENAME_MAX_ATTEMPTS; suffix += 1) {
    const resolvedFilename = buildRenamedFilename(baseFilename, suffix)
    const r2Key = cleanDir
      ? buildR2Key(r2ConfigId, `${cleanDir}/${resolvedFilename}`)
      : buildR2Key(r2ConfigId, resolvedFilename)

    const occupied = await env.DB.prepare('SELECT id FROM files WHERE r2_key = ? LIMIT 1')
      .bind(r2Key)
      .first('id')
    if (occupied) {
      continue
    }

    for (let i = 0; i < SHORT_CODE_MAX_ATTEMPTS; i += 1) {
      const id = crypto.randomUUID()
      const shortCode = generateRandomCode(6)
      return { id, r2Key, shortCode, expiresAt, filename: resolvedFilename }
    }
  }

  throw new Error('filename_conflict_unresolved')
}

async function createPendingUploadFileRecord(
  env: Env,
  userId: string,
  file: { id: string; r2Key: string; shortCode: string; expiresAt: Date; filename: string },
  size: number,
  contentType: string,
  expiresIn: number,
  requireLogin: boolean,
  r2ConfigId: string,
  userQuotaBytes: number
): Promise<void> {
  await reserveUploadCapacity(env, {
    fileId: file.id,
    userId,
    userQuotaBytes,
    r2ConfigId,
    declaredSize: size,
  })

  const now = new Date().toISOString()
  const result = await env.DB
    .prepare(
      `INSERT INTO files (id, owner_id, filename, r2_key, size, content_type, expires_in, created_at, expires_at, upload_status, short_code, require_login, config_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .bind(
      file.id,
      userId,
      file.filename,
      file.r2Key,
      size,
      contentType,
      expiresIn,
      now,
      file.expiresAt.toISOString(),
      file.shortCode,
      requireLogin ? 1 : 0,
      r2ConfigId || null
    )
    .run()

  if (!result.error) {
    return
  }

  await releaseUploadReservation(env.DB, file.id)
  const errorMessage = formatD1ErrorMessage(result.error)
  if (isUniqueConstraintError(errorMessage, 'r2_key') || isUniqueConstraintError(errorMessage, 'short_code')) {
    throw new Error('create_file_record_conflict')
  }
  throw new Error(errorMessage || 'create_file_record_failed')
}

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
    let file: { id: string; r2Key: string; shortCode: string; expiresAt: Date; filename: string } | null =
      null
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
      env.DB.prepare('UPDATE files SET size = ?, upload_status = ? WHERE id = ?')
        .bind(sizeValidation.actualSize, 'completed', body.file_id),
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
    let file: { id: string; r2Key: string; shortCode: string; expiresAt: Date; filename: string } | null =
      null
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
      total_parts: Math.ceil(declaredSize / PART_SIZE),
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
      'SELECT id, owner_id, r2_key, expires_at, upload_status, multipart_upload_id FROM files WHERE id = ?'
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

    const partNumber = Number(body.part_number)
    if (!Number.isFinite(partNumber) || partNumber <= 0) {
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

    const requestParts = Array.isArray(body.parts) ? body.parts : []
    const parts: Array<{ PartNumber?: number; ETag?: string }> =
      requestParts.length > 0
        ? requestParts
            .map((part) => {
              const partNumber = Number(part.part_number)
              const rawEtag = typeof part.etag === 'string' ? part.etag.trim() : ''
              if (!Number.isFinite(partNumber) || partNumber <= 0 || !rawEtag) {
                return null
              }
              const etag = rawEtag.startsWith('"') ? rawEtag : `"${rawEtag}"`
              return { PartNumber: partNumber, ETag: etag }
            })
            .filter((part): part is { PartNumber: number; ETag: string } => Boolean(part))
        : await listParts(loaded.config, String(file.r2_key), storedUploadId)

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

const MAX_SERVER_UPLOAD_BYTES = 100 * 1024 * 1024

function formatServerError(error: unknown): { status: number; message: string } {
  if (error instanceof Error) {
    const msg = error.message
    const m = msg.match(/HTTP\s+(\d+)/)
    if (m) return { status: Number(m[1]), message: msg }
    if (msg.includes('Network connection lost') || msg.includes('fetch failed')) {
      return { status: 502, message: '存储服务连接中断，请稍后重试' }
    }
    return { status: 500, message: msg }
  }
  return { status: 500, message: String(error || '未知错误') }
}

export async function serverUpload(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  try {
    const contentType = String(request.headers.get('Content-Type') || '')
    if (!contentType.includes('multipart/form-data')) {
      return jsonResponse({ error: '请求格式错误，需要 multipart/form-data' }, 400)
    }

    const formData = await request.formData()
    const configId = String(formData.get('config_id') || '').trim()
    const filename = String(formData.get('filename') || '').trim()
    const expiresInRaw = Number(formData.get('expires_in') || 7)
    const requireLogin = formData.get('require_login') !== 'false'
    const rawFile = formData.get('file')
    const dirRaw = String(formData.get('dir') || '').trim()
    const dir = sanitizeDir(dirRaw)

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
      return jsonResponse({ error: `文件大小超过限制（最大 ${MAX_SERVER_UPLOAD_BYTES / 1024 / 1024}MB）` }, 413)
    }

    // R2 配置使用预签名上传，不接受服务端中转
    const r2Loaded = await loadR2ConfigById(env, configId)
    if (r2Loaded) {
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

    let uploadFile: { id: string; r2Key: string; shortCode: string; expiresAt: Date; filename: string } | null = null
    let lastError: unknown = null
    for (let attempt = 0; attempt < SHORT_CODE_MAX_ATTEMPTS; attempt += 1) {
      const baseFilename = sanitizeUploadFilename(filename)
      const resolvedFilename = buildRenamedFilename(baseFilename, attempt)
      const expiresAt = calcExpiresAt(expiresIn)
      // WebDAV/Koofr: key = dir/filename，remotePath 在 provider 层拼接
      const r2Key = dir ? `${dir}/${resolvedFilename}` : resolvedFilename
      const id = crypto.randomUUID()
      const shortCode = generateRandomCode(6)
      uploadFile = { id, r2Key, shortCode, expiresAt, filename: resolvedFilename }

      const occupied = await env.DB.prepare('SELECT id FROM files WHERE r2_key = ? LIMIT 1')
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
          user.quota_bytes
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
      // 确保上传目录递归存在（如 wfs/{configId}/）
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
            // 目录已存在或创建失败，继续
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

    const now = new Date().toISOString()
    const updateResult = await env.DB.prepare(
      "UPDATE files SET upload_status = 'completed', size = ? WHERE id = ? AND upload_status = 'pending'"
    )
      .bind(fileSize, uploadFile.id)
      .run()

    if (!updateResult.error) {
      try {
        await env.DB.batch([
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
              metadata: { configId, key: uploadFile.r2Key, size: fileSize },
            },
            now
          ),
        ])
      } catch {
        // reservation/audit failure non-fatal
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
