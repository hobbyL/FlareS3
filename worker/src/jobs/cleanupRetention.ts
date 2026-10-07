import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { logStructured } from '../utils/log'
import { buildJobResult, type JobExecutionResult } from '../services/jobRuns'

export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000
export const AUDIT_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** share_access_logs 保留窗口与 audit_logs 对齐（90 天） */
export const SHARE_ACCESS_LOG_RETENTION_MS = AUDIT_LOG_RETENTION_MS

/** audit_logs 每轮 DELETE 的批量上限，避免首次清理 90 天积压时长事务阻塞 */
export const AUDIT_LOG_DELETE_BATCH_SIZE = 500
/** 单次 cron 运行的轮数上限（500 × 20 = 10000 条），防止超时；剩余下次继续 */
export const AUDIT_LOG_DELETE_MAX_ROUNDS = 20

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

export async function cleanupRetention(env: Env, now = new Date()): Promise<JobExecutionResult> {
  const startedAtMs = now.getTime()
  const nowIso = now.toISOString()
  const sessionThresholdIso = new Date(now.getTime() - SESSION_RETENTION_MS).toISOString()
  const rateLimitThresholdIso = new Date(now.getTime() - RATE_LIMIT_RETENTION_MS).toISOString()
  const auditLogThresholdIso = new Date(now.getTime() - AUDIT_LOG_RETENTION_MS).toISOString()
  const shareAccessLogThresholdIso = new Date(
    now.getTime() - SHARE_ACCESS_LOG_RETENTION_MS
  ).toISOString()

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

  const details = {
    sessions: getChanges(sessionResult),
    rateLimits: getChanges(rateLimitResult),
    auditLogs: auditLogsDeleted,
    shareAccessLogs: shareAccessLogsDeleted,
  }

  const processed =
    details.sessions + details.rateLimits + details.auditLogs + details.shareAccessLogs

  return buildJobResult('cleanupRetention', startedAtMs, {
    status: 'success',
    processed,
    succeeded: processed,
    failed: 0,
    details,
  })
}
