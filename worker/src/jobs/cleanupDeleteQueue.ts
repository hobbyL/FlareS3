import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import {
  extractR2ConfigIdFromKey,
  resolveR2ConfigForKey,
  deleteObject,
  abortMultipartUpload,
  summarizeS3Error,
} from '../services/r2'
import { buildJobResult, type JobExecutionResult } from '../services/jobRuns'
import { prepareReleaseUploadReservation } from '../services/uploadReservations'
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

export async function cleanupDeleteQueue(env: Env): Promise<JobExecutionResult> {
  const startedAtMs = Date.now()
  const { results } = await withD1Retry(env.DB)
    .prepare(
      `SELECT dq.id, dq.file_id, dq.r2_key, f.config_id, f.multipart_upload_id
       FROM delete_queue dq
       LEFT JOIN files f ON f.id = dq.file_id
      WHERE dq.processed_at IS NULL
      ORDER BY dq.created_at ASC
      LIMIT ?`
    )
    .bind(BATCH_SIZE)
    .all()
  if (!results.length) {
    return buildJobResult('cleanupDeleteQueue', startedAtMs, {
      status: 'success',
      processed: 0,
      succeeded: 0,
      failed: 0,
      details: { dequeuedFiles: 0 },
    })
  }

  const now = new Date().toISOString()
  let succeeded = 0
  let failed = 0
  for (const row of results) {
    const queueId = String(row.id)
    const fileId = String(row.file_id)
    const r2Key = String(row.r2_key)
    const explicitProviderConfigId = getExplicitProviderConfigId(row)

    try {
      if (explicitProviderConfigId) {
        await deleteProviderObject(env, explicitProviderConfigId, r2Key)
        await withD1Retry(env.DB).batch([
          prepareReleaseUploadReservation(env.DB, fileId, now),
          withD1Retry(env.DB).prepare('DELETE FROM file_shares WHERE file_id = ?').bind(fileId),
          withD1Retry(env.DB).prepare('DELETE FROM files WHERE id = ?').bind(fileId),
          withD1Retry(env.DB)
            .prepare('UPDATE delete_queue SET processed_at = ? WHERE id = ?')
            .bind(now, queueId),
        ])
        succeeded += 1
        continue
      }

      const loaded = await resolveR2ConfigForKey(env, r2Key)
      if (!loaded) {
        throw new Error('r2_config_unavailable')
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

          try {
            await deleteObject(loaded.config, r2Key)
          } catch (deleteError) {
            const deleteSummary = summarizeS3Error(deleteError)
            if (deleteSummary.httpStatusCode !== 404 && deleteSummary.code !== 'NoSuchKey') {
              throw deleteError
            }
          }
        }
      } else {
        try {
          await deleteObject(loaded.config, r2Key)
        } catch (error) {
          const summary = summarizeS3Error(error)
          if (summary.httpStatusCode !== 404 && summary.code !== 'NoSuchKey') {
            throw error
          }
        }
      }
    } catch (error) {
      failed += 1
      console.error('cleanupDeleteQueue delete failed', error)
      continue
    }

    await withD1Retry(env.DB).batch([
      prepareReleaseUploadReservation(env.DB, fileId, now),
      withD1Retry(env.DB).prepare('DELETE FROM file_shares WHERE file_id = ?').bind(fileId),
      withD1Retry(env.DB).prepare('DELETE FROM files WHERE id = ?').bind(fileId),
      withD1Retry(env.DB)
        .prepare('UPDATE delete_queue SET processed_at = ? WHERE id = ?')
        .bind(now, queueId),
    ])
    succeeded += 1
  }

  return buildJobResult('cleanupDeleteQueue', startedAtMs, {
    status: failed > 0 ? (succeeded > 0 ? 'partial' : 'failed') : 'success',
    processed: results.length,
    succeeded,
    failed,
    details: {
      dequeuedFiles: succeeded,
    },
  })
}
