import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { logStructured } from '../utils/log'
import { buildJobResult, type JobExecutionResult } from '../services/jobRuns'

export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000
export const AUDIT_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** share_access_logs 保留窗口与 audit_logs 对齐（90 天） */
export const SHARE_ACCESS_LOG_RETENTION_MS = AUDIT_LOG_RETENTION_MS
/** 回收站软删除 texts 的保留窗口（30 天），超期物理删除并连带删分享行 */
export const TEXTS_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** audit_logs 每轮 DELETE 的批量上限，避免首次清理 90 天积压时长事务阻塞 */
export const AUDIT_LOG_DELETE_BATCH_SIZE = 500
/** 单次 cron 运行的轮数上限（500 × 20 = 10000 条），防止超时；剩余下次继续 */
export const AUDIT_LOG_DELETE_MAX_ROUNDS = 20

/** 回收站 texts 每轮物理删除的批量上限 */
export const TEXTS_TRASH_DELETE_BATCH_SIZE = 100
/** 回收站 texts 单次 cron 清理轮数上限（100 × 20 = 2000 行），防超时；剩余下次继续 */
export const TEXTS_TRASH_DELETE_MAX_ROUNDS = 20

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

  const details = {
    sessions: getChanges(sessionResult),
    rateLimits: getChanges(rateLimitResult),
    auditLogs: auditLogsDeleted,
    shareAccessLogs: shareAccessLogsDeleted,
    textsTrash: textsTrashDeleted,
  }

  const processed =
    details.sessions +
    details.rateLimits +
    details.auditLogs +
    details.shareAccessLogs +
    details.textsTrash

  return buildJobResult('cleanupRetention', startedAtMs, {
    status: 'success',
    processed,
    succeeded: processed,
    failed: 0,
    details,
  })
}
