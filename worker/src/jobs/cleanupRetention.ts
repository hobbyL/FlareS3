import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { logStructured } from '../utils/log'
import { buildJobResult, type JobExecutionResult } from '../services/jobRuns'
import { prepareEnqueueFileDeletionIfNeeded } from '../services/deleteQueue'

export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000
export const AUDIT_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** share_access_logs 保留窗口与 audit_logs 对齐（90 天） */
export const SHARE_ACCESS_LOG_RETENTION_MS = AUDIT_LOG_RETENTION_MS
/** 回收站软删除 texts 的保留窗口（30 天），超期物理删除并连带删分享行 */
export const TEXTS_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** 回收站软删除 files 的保留窗口（30 天），与 texts 对齐；超期入队物理删除并连带删分享行 */
export const FILES_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** audit_logs 每轮 DELETE 的批量上限，避免首次清理 90 天积压时长事务阻塞 */
export const AUDIT_LOG_DELETE_BATCH_SIZE = 500
/** 单次 cron 运行的轮数上限（500 × 20 = 10000 条），防止超时；剩余下次继续 */
export const AUDIT_LOG_DELETE_MAX_ROUNDS = 20

/** 回收站 texts 每轮物理删除的批量上限 */
export const TEXTS_TRASH_DELETE_BATCH_SIZE = 100
/** 回收站 texts 单次 cron 清理轮数上限（100 × 20 = 2000 行），防超时；剩余下次继续 */
export const TEXTS_TRASH_DELETE_MAX_ROUNDS = 20

/** 回收站 files 每轮处理（入队 + 连带删分享）的批量上限 */
export const FILES_TRASH_DELETE_BATCH_SIZE = 100
/** 回收站 files 单次 cron 处理轮数上限（100 × 20 = 2000 行），防超时；剩余下次继续 */
export const FILES_TRASH_DELETE_MAX_ROUNDS = 20

function getChanges(result: unknown): number {
  const changes = (result as { meta?: { changes?: number } } | null)?.meta?.changes
  return Number.isFinite(changes) ? Number(changes) : 0
}

/**
 * 按 created_at 分批删除过期行（audit_logs / share_access_logs 共用）。
 *
 * `DELETE ... WHERE id IN (SELECT id ... LIMIT n)` 循环直至删空，
 * 替代一次性全量 DELETE：首次清理大积压时不会形成长事务，
 * 且每批独立提交，中途失败可从下一轮 cron 续跑。
 */
async function deleteExpiredRowsInBatches(
  env: Env,
  table: 'audit_logs' | 'share_access_logs',
  thresholdIso: string,
  cappedEvent: string
): Promise<number> {
  let deleted = 0
  for (let round = 0; round < AUDIT_LOG_DELETE_MAX_ROUNDS; round++) {
    const result = await withD1Retry(env.DB)
      .prepare(
        `DELETE FROM ${table} WHERE id IN (
           SELECT id FROM ${table} WHERE created_at < ? LIMIT ${AUDIT_LOG_DELETE_BATCH_SIZE}
         )`
      )
      .bind(thresholdIso)
      .run()

    const changes = getChanges(result)
    deleted += changes
    if (changes === 0) {
      return deleted
    }
  }

  logStructured('warn', cappedEvent, {
    table,
    deleted,
    batchSize: AUDIT_LOG_DELETE_BATCH_SIZE,
    rounds: AUDIT_LOG_DELETE_MAX_ROUNDS,
    message: `${table} 过期行数超过单轮清理上限，剩余行将在下次 cron 继续`,
  })
  return deleted
}

/**
 * 分批物理删除超期回收站 texts（连带 text_shares / text_one_time_shares）。
 *
 * 每轮 SELECT 一批 id 后按 IN 批量删除（与 audit 的单表 DELETE ... IN 分轮
 * 同语义）；轮数达上限时发 capped 事件，剩余行下次 cron 继续。
 */
async function deleteExpiredTrashTextsInBatches(
  env: Env,
  thresholdIso: string,
  nowIso: string
): Promise<number> {
  let deleted = 0
  for (let round = 0; round < TEXTS_TRASH_DELETE_MAX_ROUNDS; round++) {
    const { results } = await withD1Retry(env.DB)
      .prepare(
        `SELECT id FROM texts
     WHERE deleted_at IS NOT NULL AND deleted_at < ?
     ORDER BY id ASC
     LIMIT ${TEXTS_TRASH_DELETE_BATCH_SIZE}`
      )
      .bind(thresholdIso)
      .all<{ id: string }>()

    const ids = (results || []).map((row) => String(row.id))
    if (!ids.length) {
      return deleted
    }

    const placeholders = ids.map(() => '?').join(',')
    await withD1Retry(env.DB).batch([
      withD1Retry(env.DB)
        .prepare(`DELETE FROM text_shares WHERE text_id IN (${placeholders})`)
        .bind(...ids),
      withD1Retry(env.DB)
        .prepare(`DELETE FROM text_one_time_shares WHERE text_id IN (${placeholders})`)
        .bind(...ids),
      withD1Retry(env.DB)
        .prepare(`DELETE FROM texts WHERE id IN (${placeholders})`)
        .bind(...ids),
    ])
    deleted += ids.length

    if (ids.length < TEXTS_TRASH_DELETE_BATCH_SIZE) {
      return deleted
    }
  }

  logStructured('warn', 'job.cleanupRetention.textsTrashCapped', {
    deleted,
    batchSize: TEXTS_TRASH_DELETE_BATCH_SIZE,
    rounds: TEXTS_TRASH_DELETE_MAX_ROUNDS,
    message: '回收站 texts 过期行数超过单轮清理上限，剩余行将在下次 cron 继续',
    now: nowIso,
  })
  return deleted
}

/**
 * 分批处理超期回收站 files：对象删除入队 delete_queue + 连带删 file_shares。
 *
 * 与 texts 不同，这里**不直接 DELETE files 行**：cleanupDeleteQueue 通过
 * `LEFT JOIN files f ON f.id = dq.file_id` 读取 `f.config_id` 解析 provider，
 * 若此处先删 files 行，入队记录将 JOIN 不到 config_id 导致对象无法删除。
 * 因此 retention 分支每行只做两件事（放在同一 batch，幂等）：
 *   1. prepareEnqueueFileDeletionIfNeeded —— 幂等入队（NOT EXISTS 守卫）；
 *      files 行与对象的最终物理删除交给既有 cleanupDeleteQueue 管线完成；
 *   2. DELETE file_shares —— 保留期到即让分享立即失效（cleanupDeleteQueue
 *      消费入队时也会连带删，二者幂等）。
 *
 * 不翻转 upload_status：回收站行本就是 'deleted'（软删除时已置），再写一次是
 * 无意义的 no-op；且 restoreFile 的恢复守卫是「对象是否仍存在」（checkObjectExists
 * 缺失即 409），而非 deleted_at 时长，故对象被 cleanupDeleteQueue 删除后该行
 * 自然不可恢复，无需在此翻转状态。
 *
 * 进度保证：SELECT 以 `NOT EXISTS(未处理入队)` 排除已入队行，本轮入队后下一轮
 * 不再命中，循环自终止；达轮数上限发 capped 事件，剩余行下次 cron 继续。
 */
async function deleteExpiredTrashFilesInBatches(
  env: Env,
  thresholdIso: string,
  nowIso: string
): Promise<number> {
  let processed = 0
  for (let round = 0; round < FILES_TRASH_DELETE_MAX_ROUNDS; round++) {
    const { results } = await withD1Retry(env.DB)
      .prepare(
        `SELECT id, r2_key FROM files
     WHERE deleted_at IS NOT NULL AND deleted_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM delete_queue dq WHERE dq.file_id = files.id AND dq.processed_at IS NULL
       )
     ORDER BY id ASC
     LIMIT ${FILES_TRASH_DELETE_BATCH_SIZE}`
      )
      .bind(thresholdIso)
      .all<{ id: string; r2_key: string }>()

    const rows = (results || []).filter((row) => row && row.id)
    if (!rows.length) {
      return processed
    }

    const ids = rows.map((row) => String(row.id))
    const placeholders = ids.map(() => '?').join(',')
    const statements: D1PreparedStatement[] = rows.map((row) =>
      prepareEnqueueFileDeletionIfNeeded(
        env.DB,
        { id: String(row.id), r2_key: String(row.r2_key) },
        nowIso
      )
    )
    statements.push(
      withD1Retry(env.DB)
        .prepare(`DELETE FROM file_shares WHERE file_id IN (${placeholders})`)
        .bind(...ids)
    )
    await withD1Retry(env.DB).batch(statements)
    processed += ids.length

    if (ids.length < FILES_TRASH_DELETE_BATCH_SIZE) {
      return processed
    }
  }

  logStructured('warn', 'job.cleanupRetention.filesTrashCapped', {
    processed,
    batchSize: FILES_TRASH_DELETE_BATCH_SIZE,
    rounds: FILES_TRASH_DELETE_MAX_ROUNDS,
    message: '回收站 files 过期行数超过单轮处理上限，剩余行将在下次 cron 继续',
    now: nowIso,
  })
  return processed
}

export async function cleanupRetention(env: Env, now = new Date()): Promise<JobExecutionResult> {
  const startedAtMs = now.getTime()
  const nowIso = now.toISOString()
  const sessionThresholdIso = new Date(now.getTime() - SESSION_RETENTION_MS).toISOString()
  const rateLimitThresholdIso = new Date(now.getTime() - RATE_LIMIT_RETENTION_MS).toISOString()
  const auditLogThresholdIso = new Date(now.getTime() - AUDIT_LOG_RETENTION_MS).toISOString()
  const shareAccessLogThresholdIso = new Date(
    now.getTime() - SHARE_ACCESS_LOG_RETENTION_MS
  ).toISOString()
  const textsTrashThresholdIso = new Date(now.getTime() - TEXTS_TRASH_RETENTION_MS).toISOString()
  const filesTrashThresholdIso = new Date(now.getTime() - FILES_TRASH_RETENTION_MS).toISOString()

  const sessionResult = await withD1Retry(env.DB)
    .prepare(
      `DELETE FROM sessions
     WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
        OR expires_at < ?`
    )
    .bind(sessionThresholdIso, nowIso)
    .run()

  const rateLimitResult = await withD1Retry(env.DB)
    .prepare(
      `DELETE FROM rate_limits
     WHERE window_start < ?
       AND (blocked_until IS NULL OR blocked_until < ?)`
    )
    .bind(rateLimitThresholdIso, nowIso)
    .run()

  const auditLogsDeleted = await deleteExpiredRowsInBatches(
    env,
    'audit_logs',
    auditLogThresholdIso,
    'job.cleanupRetention.auditLogsCapped'
  )
  const shareAccessLogsDeleted = await deleteExpiredRowsInBatches(
    env,
    'share_access_logs',
    shareAccessLogThresholdIso,
    'job.cleanupRetention.shareAccessLogsCapped'
  )
  const textsTrashDeleted = await deleteExpiredTrashTextsInBatches(
    env,
    textsTrashThresholdIso,
    nowIso
  )
  const filesTrashDeleted = await deleteExpiredTrashFilesInBatches(
    env,
    filesTrashThresholdIso,
    nowIso
  )

  const details = {
    sessions: getChanges(sessionResult),
    rateLimits: getChanges(rateLimitResult),
    auditLogs: auditLogsDeleted,
    shareAccessLogs: shareAccessLogsDeleted,
    textsTrash: textsTrashDeleted,
    filesTrash: filesTrashDeleted,
  }

  const processed =
    details.sessions +
    details.rateLimits +
    details.auditLogs +
    details.shareAccessLogs +
    details.textsTrash +
    details.filesTrash

  return buildJobResult('cleanupRetention', startedAtMs, {
    status: 'success',
    processed,
    succeeded: processed,
    failed: 0,
    details,
  })
}
