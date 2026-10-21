import type { D1QueryDb } from '../utils/db'
import { withD1Retry } from '../utils/db'

const DELETE_LEASE_MS = 5 * 60 * 1000
// 给一小时预签名凭据留出签名、上游提交及重试的缓冲。
const UPLOAD_CREDENTIAL_TTL_MS = 65 * 60 * 1000

/** 删除意图不可撤销；lease 过期只允许新的清理执行者接管。 */
export async function claimFileDeletion(
  db: D1QueryDb,
  fileId: string,
  key: string,
  queueId?: string
): Promise<string | null> {
  const now = new Date().toISOString()
  const token = crypto.randomUUID()
  const result = await withD1Retry(db)
    .prepare(
      `UPDATE files SET deletion_started_at = COALESCE(deletion_started_at, ?),
         deletion_token = ?, deletion_lease_until = ?
       WHERE id = ? AND r2_key = ? AND upload_status = 'deleted' AND deleted_at IS NOT NULL
         AND (deletion_lease_until IS NULL OR deletion_lease_until < ? OR deletion_token = ?)
         ${queueId ? 'AND EXISTS (SELECT 1 FROM delete_queue WHERE id = ? AND file_id = files.id AND processed_at IS NULL)' : ''}` +
        ` AND (upload_updated_at IS NULL OR (upload_key IS NULL AND multipart_upload_id IS NULL AND r2_key NOT LIKE 'storage/%/.pending/%') OR upload_updated_at < ?)`
    )
    .bind(
      now,
      token,
      new Date(Date.now() + DELETE_LEASE_MS).toISOString(),
      fileId,
      key,
      now,
      token,
      ...(queueId ? [queueId] : []),
      new Date(Date.now() - UPLOAD_CREDENTIAL_TTL_MS).toISOString()
    )
    .run()
  return Number(result.meta?.changes || 0) > 0 ? token : null
}

export function prepareDeleteClaimedFile(db: D1QueryDb, fileId: string, token: string) {
  return withD1Retry(db)
    .prepare(
      'DELETE FROM files WHERE id = ? AND deletion_token = ? AND deletion_started_at IS NOT NULL'
    )
    .bind(fileId, token)
}

/** 同一 batch 内的附属清理也必须校验领取凭据，防止租约接管后的旧执行者落库。 */
export function prepareClaimedFileCleanup(
  db: D1QueryDb,
  fileId: string,
  token: string,
  now: string
) {
  const guardedDb = withD1Retry(db)
  return [
    guardedDb
      .prepare(
        "UPDATE upload_reservations SET status = ?, updated_at = ? WHERE file_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM files WHERE id = ? AND deletion_token = ?)"
      )
      .bind('released', now, fileId, fileId, token),
    guardedDb
      .prepare(
        'DELETE FROM file_shares WHERE file_id = ? AND EXISTS (SELECT 1 FROM files WHERE id = ? AND deletion_token = ?)'
      )
      .bind(fileId, fileId, token),
    prepareDeleteClaimedFile(db, fileId, token),
  ]
}
