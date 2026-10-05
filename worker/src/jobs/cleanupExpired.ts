import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { logError } from '../utils/log'
import {
  extractR2ConfigIdFromKey,
  resolveR2ConfigForKey,
  deleteObject,
  abortMultipartUpload,
  summarizeS3Error,
} from '../services/r2'
import { buildJobResult, type JobExecutionResult } from '../services/jobRuns'
import {
  cleanupOrphanUploadReservations,
  prepareReleaseUploadReservation,
} from '../services/uploadReservations'
import { createProvider } from '../services/storage/factory'
import { StorageError } from '../services/storage/types'

const BATCH_SIZE = 100

function extractProviderConfigIdFromKey(key: string): string | null {
  const parts = String(key || '')
    .split('/')
    .filter(Boolean)
  if (parts.length >= 3 && parts[0] === 'storage') {
    return parts[1] || null
  }
  return null
}

function getExplicitProviderConfigId(row: {
  r2_key?: unknown
  config_id?: unknown
}): string | null {
  const r2Key = String(row.r2_key || '')
  if (extractR2ConfigIdFromKey(r2Key)) return null

  const configId = String(row.config_id || '').trim()
  if (configId) return configId

  return extractProviderConfigIdFromKey(r2Key)
}

async function deleteProviderObject(env: Env, configId: string, key: string): Promise<void> {
  const provider = await createProvider(env, configId)
  if (!provider) {
    throw new Error('storage_config_unavailable')
  }

  try {
    await provider.delete(key)
  } catch (error) {
    if (
      error instanceof StorageError &&
      (error.httpStatusCode === 404 || error.code === 'NoSuchKey')
    ) {
      return
    }
    throw error
  }
}

export async function cleanupExpired(
  env: Env,
  nowDate: Date = new Date()
): Promise<JobExecutionResult> {
  const startedAtMs = Date.now()
  const now = nowDate.toISOString()
  const orphanReservationsReleased = await cleanupOrphanUploadReservations(env.DB, nowDate)
  const { results } = await withD1Retry(env.DB)
    .prepare(
      `SELECT id, r2_key, upload_status, multipart_upload_id, config_id FROM files
     WHERE expires_at < ? AND upload_status IN ('pending','uploading','completed') AND deleted_at IS NULL
     LIMIT ?`
    )
    .bind(now, BATCH_SIZE)
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
      const explicitProviderConfigId = getExplicitProviderConfigId(row)
      if (explicitProviderConfigId) {
        await deleteProviderObject(env, explicitProviderConfigId, r2Key)
        await withD1Retry(env.DB).batch([
          withD1Retry(env.DB)
            .prepare(
              `UPDATE files SET upload_status = 'deleted', deleted_at = ?, multipart_upload_id = NULL WHERE id = ?`
            )
            .bind(now, row.id),
          prepareReleaseUploadReservation(env.DB, String(row.id), now),
        ])
        succeeded += 1
        deletedFiles += 1
        continue
      }

      const loaded = await resolveR2ConfigForKey(env, r2Key)
      if (!loaded) {
        failed += 1
        missingConfigs += 1
        continue
      }
      const multipartUploadId = String((row as any).multipart_upload_id || '').trim()
      if (multipartUploadId) {
        try {
          await abortMultipartUpload(loaded.config, r2Key, multipartUploadId)
        } catch (error) {
          const summary = summarizeS3Error(error)
          if (summary.httpStatusCode !== 404 && summary.code !== 'NoSuchUpload') {
            throw error
          }
          await deleteObject(loaded.config, r2Key)
        }
      } else {
        await deleteObject(loaded.config, r2Key)
      }
      await withD1Retry(env.DB).batch([
        withD1Retry(env.DB)
          .prepare(
            `UPDATE files SET upload_status = 'deleted', deleted_at = ?, multipart_upload_id = NULL WHERE id = ?`
          )
          .bind(now, row.id),
        prepareReleaseUploadReservation(env.DB, String(row.id), now),
      ])
      succeeded += 1
      deletedFiles += 1
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
