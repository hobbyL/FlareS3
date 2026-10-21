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
import { createProvider } from '../services/storage/factory'
import { StorageError } from '../services/storage/types'
import { claimFileDeletion, prepareClaimedFileCleanup } from '../services/fileDeletion'

const BATCH_SIZE = 100

async function deleteR2ObjectIfPresent(config: Parameters<typeof deleteObject>[0], key: string) {
  try {
    await deleteObject(config, key)
  } catch (error) {
    const summary = summarizeS3Error(error)
    if (summary.httpStatusCode !== 404 && summary.code !== 'NoSuchKey') throw error
  }
}

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
  await withD1Retry(env.DB)
    .prepare(
      'DELETE FROM delete_queue WHERE id IN (SELECT id FROM delete_queue WHERE processed_at IS NOT NULL AND processed_at < ? LIMIT 500)'
    )
    .bind(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .run()
  const { results } = await withD1Retry(env.DB)
    .prepare(
      `SELECT dq.id, dq.file_id, dq.r2_key, COALESCE(dq.config_id, f.config_id) AS config_id,
        COALESCE(dq.multipart_upload_id, f.multipart_upload_id) AS multipart_upload_id,
        COALESCE(dq.upload_key, f.upload_key) AS upload_key, dq.attempts, dq.orphan_multipart,
        (SELECT COUNT(*) FROM delete_queue WHERE processed_at IS NULL) AS pending_count,
        (SELECT MIN(created_at) FROM delete_queue WHERE processed_at IS NULL) AS oldest_pending_at
       FROM delete_queue dq
       LEFT JOIN files f ON f.id = dq.file_id
      WHERE dq.processed_at IS NULL
        AND (dq.next_attempt_at IS NULL OR dq.next_attempt_at <= ?)
      ORDER BY dq.created_at ASC
      LIMIT ?`
    )
    .bind(new Date().toISOString(), BATCH_SIZE)
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
      if (Number(row.orphan_multipart) === 1) {
        const loaded = await resolveR2ConfigForKey(env, r2Key)
        if (!loaded) throw new Error('r2_config_unavailable')
        try {
          await abortMultipartUpload(loaded.config, r2Key, String(row.multipart_upload_id))
        } catch (error) {
          const summary = summarizeS3Error(error)
          if (summary.httpStatusCode !== 404 && summary.code !== 'NoSuchUpload') throw error
        }
        await withD1Retry(env.DB)
          .prepare('UPDATE delete_queue SET processed_at = ? WHERE id = ?')
          .bind(now, queueId)
          .run()
        succeeded += 1
        continue
      }
      const deletionToken = await claimFileDeletion(env.DB, fileId, r2Key, queueId)
      if (!deletionToken) {
        // 直删已完成的队列历史；仍存在的行由恢复或租约持有者负责。
        const closed = await withD1Retry(env.DB)
          .prepare(
            'UPDATE delete_queue SET processed_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM files WHERE id = ?)'
          )
          .bind(now, queueId, fileId)
          .run()
        succeeded += Number(closed.meta?.changes || 0)
        if (!closed.meta?.changes)
          await withD1Retry(env.DB)
            .prepare(
              'UPDATE delete_queue SET next_attempt_at = ? WHERE id = ? AND processed_at IS NULL'
            )
            .bind(new Date(Date.now() + 5 * 60 * 1000).toISOString(), queueId)
            .run()
        continue
      }
      if (explicitProviderConfigId) {
        const uploadKey = String(row.upload_key || '').trim()
        if (uploadKey && uploadKey !== r2Key) {
          await deleteProviderObject(env, explicitProviderConfigId, uploadKey)
        }
        await deleteProviderObject(env, explicitProviderConfigId, r2Key)
        await withD1Retry(env.DB).batch([
          ...prepareClaimedFileCleanup(env.DB, fileId, deletionToken, now),
          withD1Retry(env.DB)
            .prepare(
              'UPDATE delete_queue SET processed_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM files WHERE id = ?)'
            )
            .bind(now, queueId, fileId),
        ])
        succeeded += 1
        continue
      }
      const loaded = await resolveR2ConfigForKey(env, r2Key)
      if (!loaded) {
        throw new Error('r2_config_unavailable')
      }
      const multipartUploadId = String((row as any).multipart_upload_id || '').trim()
      const uploadKey = String(row.upload_key || '').trim()
      if (uploadKey && uploadKey !== r2Key) await deleteR2ObjectIfPresent(loaded.config, uploadKey)
      if (multipartUploadId) {
        try {
          await abortMultipartUpload(loaded.config, r2Key, multipartUploadId)
        } catch (error) {
          const summary = summarizeS3Error(error)
          if (summary.httpStatusCode !== 404 && summary.code !== 'NoSuchUpload') {
            throw error
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
      // abort 与最终对象清理都执行：complete/abort 竞争可能已生成最终对象。
      if (multipartUploadId) await deleteR2ObjectIfPresent(loaded.config, r2Key)
      await withD1Retry(env.DB).batch([
        ...prepareClaimedFileCleanup(env.DB, fileId, deletionToken, now),
        withD1Retry(env.DB)
          .prepare(
            'UPDATE delete_queue SET processed_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM files WHERE id = ?)'
          )
          .bind(now, queueId, fileId),
      ])
      succeeded += 1
    } catch (error) {
      failed += 1
      logError('cleanupDeleteQueue.item_failed', error, { fileId, queueId })
      await withD1Retry(env.DB)
        .prepare(
          'UPDATE delete_queue SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND processed_at IS NULL'
        )
        .bind(
          new Date(
            Date.now() +
              Math.min(
                24 * 60 * 60 * 1000,
                60 * 60 * 1000 * 2 ** Math.min(Number(row.attempts || 0), 5)
              )
          ).toISOString(),
          queueId
        )
        .run()
        .catch((retryError) =>
          logError('cleanupDeleteQueue.retry_schedule_failed', retryError, { queueId })
        )
      continue
    }
  }

  return buildJobResult('cleanupDeleteQueue', startedAtMs, {
    status: failed > 0 ? (succeeded > 0 ? 'partial' : 'failed') : 'success',
    processed: results.length,
    succeeded,
    failed,
    details: {
      dequeuedFiles: succeeded,
      pendingAtStart: Number(results[0]?.pending_count || 0),
      oldestPendingAt: results[0]?.oldest_pending_at || null,
    },
  })
}
