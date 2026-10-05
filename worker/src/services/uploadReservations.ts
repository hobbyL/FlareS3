import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { getTotalStorage } from '../config/env'
import { uploadConfigCapacityExceededError, userQuotaExceededError } from './uploadErrors'

type ReserveUploadCapacityInput = {
  fileId: string
  userId: string
  userQuotaBytes: number
  r2ConfigId: string
  declaredSize: number
}

export const ORPHAN_UPLOAD_RESERVATION_GRACE_MS = 15 * 60 * 1000

function toNonNegativeNumber(value: unknown): number {
  const normalized = Number(value)
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0
}

export async function getCompletedUserUsedSpace(db: D1Database, userId: string): Promise<number> {
  const now = new Date().toISOString()
  const result = await withD1Retry(db)
    .prepare(
      "SELECT COALESCE(SUM(size), 0) AS completedUsed FROM files WHERE owner_id = ? AND upload_status = 'completed' AND deleted_at IS NULL AND expires_at > ?"
    )
    .bind(userId, now)
    .first('completedUsed')
  return toNonNegativeNumber(result)
}

export async function getReservedUserSpace(db: D1Database, userId: string): Promise<number> {
  const result = await withD1Retry(db)
    .prepare(
      "SELECT COALESCE(SUM(reserved_bytes), 0) AS reservedUsed FROM upload_reservations WHERE user_id = ? AND status = 'active'"
    )
    .bind(userId)
    .first('reservedUsed')
  return toNonNegativeNumber(result)
}

export async function getTotalUserUsedSpace(db: D1Database, userId: string): Promise<number> {
  const [completedUsed, reservedUsed] = await Promise.all([
    getCompletedUserUsedSpace(db, userId),
    getReservedUserSpace(db, userId),
  ])
  return completedUsed + reservedUsed
}

export async function getCompletedConfigUsedSpace(
  db: D1Database,
  configId: string
): Promise<number> {
  const prefix = `flares3/${configId}/%`
  const result = await withD1Retry(db)
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS completedUsed
         FROM files
        WHERE upload_status = 'completed'
          AND deleted_at IS NULL
          AND (
            config_id = ?
            OR ((config_id IS NULL OR TRIM(config_id) = '') AND r2_key LIKE ?)
          )`
    )
    .bind(configId, prefix)
    .first('completedUsed')
  return toNonNegativeNumber(result)
}

export async function getReservedConfigSpace(db: D1Database, configId: string): Promise<number> {
  const result = await withD1Retry(db)
    .prepare(
      "SELECT COALESCE(SUM(reserved_bytes), 0) AS reservedUsed FROM upload_reservations WHERE r2_config_id = ? AND status = 'active'"
    )
    .bind(configId)
    .first('reservedUsed')
  return toNonNegativeNumber(result)
}

export async function getTotalConfigUsedSpace(db: D1Database, configId: string): Promise<number> {
  const [completedUsed, reservedUsed] = await Promise.all([
    getCompletedConfigUsedSpace(db, configId),
    getReservedConfigSpace(db, configId),
  ])
  return completedUsed + reservedUsed
}

export async function cleanupOrphanUploadReservations(
  db: D1Database,
  nowDate: Date = new Date()
): Promise<number> {
  const now = nowDate.toISOString()
  const cutoff = new Date(nowDate.getTime() - ORPHAN_UPLOAD_RESERVATION_GRACE_MS).toISOString()
  const result = await withD1Retry(db)
    .prepare(
      `UPDATE upload_reservations
          SET status = 'released', updated_at = ?
        WHERE status = 'active'
          AND created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM files WHERE files.id = upload_reservations.file_id
          )`
    )
    .bind(now, cutoff)
    .run()
  return toNonNegativeNumber(result.meta?.changes)
}

export async function getUploadConfigQuotaBytes(env: Env, configId: string): Promise<number> {
  const r2Quota = await withD1Retry(env.DB)
    .prepare('SELECT quota_bytes FROM r2_configs WHERE id = ? LIMIT 1')
    .bind(configId)
    .first('quota_bytes')
  const r2QuotaBytes = Number(r2Quota)
  if (Number.isFinite(r2QuotaBytes) && r2QuotaBytes > 0) {
    return r2QuotaBytes
  }

  const webdavQuota = await withD1Retry(env.DB)
    .prepare('SELECT quota_bytes FROM webdav_configs WHERE id = ? LIMIT 1')
    .bind(configId)
    .first('quota_bytes')
  const webdavQuotaBytes = Number(webdavQuota)
  if (Number.isFinite(webdavQuotaBytes) && webdavQuotaBytes > 0) {
    return webdavQuotaBytes
  }

  return getTotalStorage(env)
}

export async function reserveUploadCapacity(
  env: Env,
  input: ReserveUploadCapacityInput
): Promise<void> {
  const { fileId, userId, userQuotaBytes, r2ConfigId, declaredSize } = input
  const now = new Date().toISOString()
  const quotaBytes = await getUploadConfigQuotaBytes(env, r2ConfigId)
  const result = await withD1Retry(env.DB)
    .prepare(
      `INSERT INTO upload_reservations
       (file_id, user_id, r2_config_id, reserved_bytes, status, created_at, updated_at)
       SELECT ?, ?, ?, ?, 'active', ?, ?
       WHERE (
         COALESCE(
           (
             SELECT SUM(size) FROM files
             WHERE owner_id = ? AND upload_status = 'completed' AND deleted_at IS NULL AND expires_at > ?
           ),
           0
         ) +
         COALESCE(
           (
             SELECT SUM(reserved_bytes) FROM upload_reservations
             WHERE user_id = ? AND status = 'active'
           ),
           0
         ) + ? <= ?
       )
       AND (
         COALESCE(
           (
             SELECT SUM(size) FROM files
             WHERE upload_status = 'completed'
               AND deleted_at IS NULL
               AND (
                 config_id = ?
                 OR ((config_id IS NULL OR TRIM(config_id) = '') AND r2_key LIKE ?)
               )
           ),
           0
         ) +
         COALESCE(
           (
             SELECT SUM(reserved_bytes) FROM upload_reservations
             WHERE r2_config_id = ? AND status = 'active'
           ),
           0
         ) + ? <= ?
       )`
    )
    .bind(
      fileId,
      userId,
      r2ConfigId,
      declaredSize,
      now,
      now,
      userId,
      now,
      userId,
      declaredSize,
      userQuotaBytes,
      r2ConfigId,
      `flares3/${r2ConfigId}/%`,
      r2ConfigId,
      declaredSize,
      quotaBytes
    )
    .run()

  if (result.meta?.changes) {
    return
  }

  const [usedUserSpace, usedConfigSpace] = await Promise.all([
    getTotalUserUsedSpace(env.DB, userId),
    getTotalConfigUsedSpace(env.DB, r2ConfigId),
  ])
  if (usedUserSpace + declaredSize > userQuotaBytes) {
    throw userQuotaExceededError(declaredSize, userQuotaBytes, usedUserSpace)
  }
  if (usedConfigSpace + declaredSize > quotaBytes) {
    throw uploadConfigCapacityExceededError()
  }
  throw new Error('reserve_upload_capacity_failed')
}

async function transitionUploadReservation(
  db: D1Database,
  fileId: string,
  nextStatus: 'consumed' | 'released',
  updatedAt: string = new Date().toISOString()
): Promise<void> {
  await prepareUploadReservationTransition(db, fileId, nextStatus, updatedAt).run()
}

export function prepareUploadReservationTransition(
  db: D1Database,
  fileId: string,
  nextStatus: 'consumed' | 'released',
  updatedAt: string = new Date().toISOString()
): D1PreparedStatement {
  return withD1Retry(db)
    .prepare(
      "UPDATE upload_reservations SET status = ?, updated_at = ? WHERE file_id = ? AND status = 'active'"
    )
    .bind(nextStatus, updatedAt, fileId)
}

export function prepareConsumeUploadReservation(
  db: D1Database,
  fileId: string,
  updatedAt: string = new Date().toISOString()
): D1PreparedStatement {
  return prepareUploadReservationTransition(db, fileId, 'consumed', updatedAt)
}

export function prepareReleaseUploadReservation(
  db: D1Database,
  fileId: string,
  updatedAt: string = new Date().toISOString()
): D1PreparedStatement {
  return prepareUploadReservationTransition(db, fileId, 'released', updatedAt)
}

export async function consumeUploadReservation(db: D1Database, fileId: string): Promise<void> {
  await transitionUploadReservation(db, fileId, 'consumed')
}

export async function releaseUploadReservation(db: D1Database, fileId: string): Promise<void> {
  await transitionUploadReservation(db, fileId, 'released')
}
