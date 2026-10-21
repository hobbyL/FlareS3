import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { logError } from '../utils/log'
import { resolveR2ConfigForKey, deleteObject } from '../services/r2'
import { buildJobResult, type JobExecutionResult } from '../services/jobRuns'
import { cleanupOrphanUploadReservations } from '../services/uploadReservations'
import { prepareEnqueueFileDeletionIfNeeded } from '../services/deleteQueue'

const BATCH_SIZE = 100
export const UPLOAD_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000

export async function cleanupExpired(
  env: Env,
  nowDate: Date = new Date()
): Promise<JobExecutionResult> {
  const startedAtMs = Date.now()
  const now = nowDate.toISOString()
  const cutoff = new Date(nowDate.getTime() - UPLOAD_IDLE_TIMEOUT_MS).toISOString()
  const orphanReservationsReleased = await cleanupOrphanUploadReservations(env.DB, nowDate)
  const { results } = await withD1Retry(env.DB)
    .prepare(
      `SELECT id, r2_key, upload_status, multipart_upload_id, config_id, upload_key, expires_at FROM files
     WHERE (deleted_at IS NULL OR EXISTS (SELECT 1 FROM users WHERE users.id = files.owner_id AND users.status = 'deleted')) AND (
       (expires_at < ? AND upload_status IN ('pending','uploading','completed'))
       OR (upload_status IN ('pending','uploading') AND COALESCE(upload_updated_at, created_at) < ?)
       OR (upload_status = 'completed' AND upload_key IS NOT NULL AND COALESCE(upload_updated_at, created_at) < ?)
       OR EXISTS (SELECT 1 FROM users WHERE users.id = files.owner_id AND users.status = 'deleted')
     ) AND (upload_status <> 'deleted' OR NOT EXISTS (
       SELECT 1 FROM delete_queue WHERE file_id = files.id AND processed_at IS NULL AND orphan_multipart = 0
     )) ORDER BY created_at ASC
     LIMIT ?`
    )
    .bind(now, cutoff, cutoff, BATCH_SIZE)
    .all()
  if (!results.length) {
    return buildJobResult('cleanupExpired', startedAtMs, {
      status: 'success',
      processed: orphanReservationsReleased,
      succeeded: orphanReservationsReleased,
      failed: 0,
      details: { deletedFiles: 0, missingConfigs: 0, orphanReservationsReleased },
    })
  }

  let succeeded = 0
  let failed = 0
  let deletedFiles = 0
  let missingConfigs = 0

  for (const row of results) {
    try {
      const r2Key = String(row.r2_key)
      if (
        row.upload_status === 'completed' &&
        row.upload_key &&
        String(row.expires_at || '') > now
      ) {
        const loaded = await resolveR2ConfigForKey(env, r2Key)
        if (!loaded) {
          failed += 1
          missingConfigs += 1
          continue
        }
        await deleteObject(loaded.config, String(row.upload_key))
        await withD1Retry(env.DB)
          .prepare(
            "UPDATE files SET upload_key = NULL WHERE id = ? AND upload_status = 'completed' AND upload_key = ?"
          )
          .bind(row.id, row.upload_key)
          .run()
        succeeded += 1
        continue
      }
      const [deleted] = await withD1Retry(env.DB).batch([
        withD1Retry(env.DB)
          .prepare(
            `UPDATE files SET upload_status = 'deleted', deleted_at = ?, deletion_started_at = COALESCE(deletion_started_at, ?)
             WHERE id = ? AND r2_key = ? AND (deleted_at IS NULL OR EXISTS (SELECT 1 FROM users WHERE users.id = files.owner_id AND users.status = 'deleted')) AND (
               expires_at < ? OR (upload_status IN ('pending','uploading') AND COALESCE(upload_updated_at, created_at) < ?)
               OR EXISTS (SELECT 1 FROM users WHERE users.id = files.owner_id AND users.status = 'deleted'))`
          )
          .bind(now, now, row.id, r2Key, now, cutoff),
        prepareEnqueueFileDeletionIfNeeded(env.DB, { id: String(row.id), r2_key: r2Key }, now),
        withD1Retry(env.DB)
          .prepare(
            "UPDATE upload_reservations SET status = ?, updated_at = ? WHERE file_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM files WHERE id = ? AND upload_status = 'deleted')"
          )
          .bind('released', now, row.id, row.id),
      ])
      succeeded += Number(deleted.meta?.changes || 0)
      deletedFiles += Number(deleted.meta?.changes || 0)
    } catch (error) {
      failed += 1
      logError('cleanupExpired.item_failed', error, { fileId: String(row.id) })
    }
  }

  return buildJobResult('cleanupExpired', startedAtMs, {
    status: failed > 0 ? (succeeded > 0 ? 'partial' : 'failed') : 'success',
    processed: results.length + orphanReservationsReleased,
    succeeded: succeeded + orphanReservationsReleased,
    failed,
    details: {
      deletedFiles,
      missingConfigs,
      orphanReservationsReleased,
    },
  })
}
