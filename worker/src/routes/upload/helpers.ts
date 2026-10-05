import { withD1Retry } from '../../utils/db'
import type { Env } from '../../config/env'
import { getMaxFileSize } from '../../config/env'
import { jsonResponse, parseJson, getUser, calcPresignedDownloadUrlTtlSeconds } from '../utils'
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
} from '../../services/r2'
import { logAudit, prepareAuditLogInsert } from '../../services/audit'
import { getClientIp } from '../../middleware/rateLimit'
import { generateRandomCode } from '../../utils/random'
import { FILE_SHORT_CODE_LENGTH } from '../../utils/codePolicy'
import {
  isUploadConfigPolicyError,
  resolveUploadConfigForUser,
} from '../../services/uploadConfigPolicy'
import {
  normalizeDeclaredFileSize,
  validateUploadedObjectSize,
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
  uploadConfigForbiddenError,
  uploadConfigNotFoundError,
  uploadConfigUnavailableError,
  uploadErrorResponse,
  uploadFileExpiredError,
  uploadFileNotFoundError,
  uploadObjectMissingError,
  uploadObjectSizeInvalidError,
  uploadObjectSizeMismatchError,
} from '../../services/uploadErrors'
import { prepareEnqueueFileDeletionIfNeeded } from '../../services/deleteQueue'
import { createProvider } from '../../services/storage/factory'
import {
  prepareConsumeUploadReservation,
  prepareReleaseUploadReservation,
  releaseUploadReservation,
  reserveUploadCapacity,
} from '../../services/uploadReservations'

export const ALLOWED_EXPIRES = new Set([-30, 0, 1, 3, 7, 30])
export const PART_SIZE = 20 * 1024 * 1024
export const NEVER_EXPIRES_AT_ISO = '9999-12-31T23:59:59.999Z'

export function normalizeExpiresIn(value: unknown): number {
  const expiresIn = Number(value)
  if (!Number.isFinite(expiresIn)) return 7
  return ALLOWED_EXPIRES.has(expiresIn) ? expiresIn : 7
}

export function calcExpiresAt(expiresIn: number): Date {
  const now = new Date()
  if (expiresIn === -30) {
    return new Date(now.getTime() + 30 * 1000)
  }
  if (expiresIn === 0) {
    return new Date(NEVER_EXPIRES_AT_ISO)
  }
  return new Date(now.getTime() + expiresIn * 24 * 60 * 60 * 1000)
}

export function isNeverExpires(expiresAt: unknown): boolean {
  const value = String(expiresAt || '').trim()
  if (!value) return false
  return value === NEVER_EXPIRES_AT_ISO
}

export function isExpired(expiresAt: unknown): boolean {
  if (isNeverExpires(expiresAt)) return false
  const expiresAtMs = new Date(String(expiresAt)).getTime()
  if (Number.isNaN(expiresAtMs)) return true
  return Date.now() > expiresAtMs
}

export function calcDownloadTtlSeconds(expiresAt: unknown): number {
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

export const SHORT_CODE_MAX_ATTEMPTS = 10
export const FILENAME_RENAME_MAX_ATTEMPTS = 100

export function createUploadConfigPolicyErrorResponse(error: unknown): Response | null {
  if (!isUploadConfigPolicyError(error)) {
    return null
  }
  return uploadErrorResponse(uploadConfigForbiddenError(error.message))
}

export function sanitizeUploadFilename(filename: string): string {
  return sanitizeFilename(filename)
}

export function splitFilename(filename: string): { stem: string; ext: string } {
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

export function buildRenamedFilename(filename: string, suffix: number): string {
  if (suffix <= 0) return filename
  const { stem, ext } = splitFilename(filename)
  return `${stem}(${suffix})${ext}`
}

export function formatD1ErrorMessage(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export async function markFileUploadDeleted(env: Env, fileId: string): Promise<void> {
  const now = new Date().toISOString()
  await withD1Retry(env.DB).batch([
    withD1Retry(env.DB)
      .prepare(
        "UPDATE files SET upload_status = 'deleted', deleted_at = ?, multipart_upload_id = NULL WHERE id = ?"
      )
      .bind(now, fileId),
    prepareReleaseUploadReservation(env.DB, fileId, now),
  ])
}

export async function deleteUploadedObjectIfPresent(
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

export async function verifyUploadedObjectSizeOrReject(
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

export function isUniqueConstraintError(
  errorMessage: string,
  field: 'r2_key' | 'short_code'
): boolean {
  const normalized = String(errorMessage || '').toLowerCase()
  if (!normalized.includes('unique constraint failed')) return false
  return normalized.includes(`files.${field}`) || normalized.includes(field)
}

export function sanitizeDir(dir: string): string {
  const trimmed = String(dir || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
  if (!trimmed || trimmed === '.' || trimmed === '/') return ''
  let clean = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  clean = clean.endsWith('/') ? clean.slice(0, -1) : clean
  if (!clean || clean === '.' || clean === '..') return ''
  const segments = clean.split('/')
  if (segments.some((s) => s === '..' || s === '.')) return ''
  return clean
}

export function buildProviderScopedStorageKey(configId: string, relativePath: string): string {
  const safeConfigId = String(configId || 'unknown')
    .trim()
    .replace(/[\\/]+/g, '_')
  const normalizedPath = String(relativePath || 'file')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
  const segments = normalizedPath
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
  const safePath = segments.length ? segments.join('/') : 'file'
  return `storage/${safeConfigId || 'unknown'}/${safePath}`
}

export async function allocateUploadFileIdentity(
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

    const occupied = await withD1Retry(env.DB)
      .prepare('SELECT id FROM files WHERE r2_key = ? LIMIT 1')
      .bind(r2Key)
      .first('id')
    if (occupied) {
      continue
    }

    for (let i = 0; i < SHORT_CODE_MAX_ATTEMPTS; i += 1) {
      const id = crypto.randomUUID()
      const shortCode = generateRandomCode(FILE_SHORT_CODE_LENGTH)
      return { id, r2Key, shortCode, expiresAt, filename: resolvedFilename }
    }
  }

  throw new Error('filename_conflict_unresolved')
}

export async function createPendingUploadFileRecord(
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
  const result = await withD1Retry(env.DB)
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
  if (
    isUniqueConstraintError(errorMessage, 'r2_key') ||
    isUniqueConstraintError(errorMessage, 'short_code')
  ) {
    throw new Error('create_file_record_conflict')
  }
  throw new Error(errorMessage || 'create_file_record_failed')
}
