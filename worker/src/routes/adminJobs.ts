import type { Env } from '../config/env'
import { cleanupExpired } from '../jobs/cleanupExpired'
import { cleanupDeleteQueue } from '../jobs/cleanupDeleteQueue'
import { cleanupRetention } from '../jobs/cleanupRetention'
import {
  buildJobResult,
  finishJobRun,
  startJobRun,
  type JobExecutionResult,
} from '../services/jobRuns'
import { logAudit } from '../services/audit'
import { getClientIp } from '../middleware/rateLimit'
import { logStructured, serializeError } from '../utils/log'
import { getUser, jsonResponse } from './utils'

/**
 * 可手动触发的定时任务白名单。
 *
 * 仅映射三个既有 cleanup job（与 scheduled.ts 同一入口），未在表内的名称
 * 一律拒绝，避免 `:name` 路径参数演化为任意代码执行入口。
 */
const JOB_HANDLERS: Record<string, (env: Env) => Promise<JobExecutionResult>> = {
  cleanupExpired: (env) => cleanupExpired(env),
  cleanupDeleteQueue: (env) => cleanupDeleteQueue(env),
  cleanupRetention: (env) => cleanupRetention(env),
}

/** 允许手动触发的任务名列表（供路由与测试复用） */
export const ADMIN_JOB_NAMES = Object.keys(JOB_HANDLERS)

/**
 * 手动触发单个定时清理任务并同步返回本轮执行结果。
 *
 * 与 cron 执行同构：复用 startJobRun / finishJobRun 留痕 job_runs，并在
 * summary 注明 `trigger: 'manual'` 以区分来源；执行成功或失败都会登记
 * `ADMIN_JOB_RUN` 审计日志。job 本身按既有批处理设计自然截断，若超过本轮
 * 上限会在下轮 cron 继续，响应如实返回本轮处理量。
 *
 * @route POST /api/admin/jobs/:name/run
 * @param request - HTTP 请求对象（需要管理员权限）
 * @param env - Cloudflare Workers 环境变量
 * @param jobName - 任务名，必须是 cleanupExpired / cleanupDeleteQueue / cleanupRetention 之一
 * @returns JSON 响应，包含本次 job 执行的状态与处理量摘要
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "job_name": "cleanupRetention",
 *   "status": "success",
 *   "duration_ms": 42,
 *   "processed": 12,
 *   "succeeded": 12,
 *   "failed": 0,
 *   "details": { "textsTrash": 2, "filesTrash": 10, "trigger": "manual" }
 * }
 *
 * // 未知任务名 (400)
 * { "error": "未知的任务名称" }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 *
 * // 任务执行失败 (500)
 * {
 *   "job_name": "cleanupRetention",
 *   "status": "failed",
 *   "duration_ms": 8,
 *   "processed": 0,
 *   "succeeded": 0,
 *   "failed": 1,
 *   "details": { "trigger": "manual" },
 *   "error": "..."
 * }
 */
export async function runAdminJob(request: Request, env: Env, jobName: string): Promise<Response> {
  const handler = JOB_HANDLERS[jobName]
  if (!handler) {
    return jsonResponse({ error: '未知的任务名称' }, 400)
  }

  const actor = getUser(request)
  const ip = getClientIp(request)
  const userAgent = request.headers.get('User-Agent') || undefined

  const startedAt = new Date().toISOString()
  const runId = await startJobRun(env.DB, jobName, startedAt)

  let result: JobExecutionResult
  try {
    const raw = await handler(env)
    result = { ...raw, details: { ...raw.details, trigger: 'manual' } }
  } catch (error) {
    result = buildJobResult(jobName, Date.parse(startedAt), {
      status: 'failed',
      processed: 0,
      succeeded: 0,
      failed: 1,
      details: { trigger: 'manual' },
      errorMessage: serializeError(error) ?? 'unknown_error',
    })
  }

  await finishJobRun(env.DB, runId, result)

  try {
    await logAudit(env.DB, {
      actorUserId: actor?.id,
      action: 'ADMIN_JOB_RUN',
      targetType: 'job',
      targetId: jobName,
      ip,
      userAgent,
      metadata: { runId, status: result.status, durationMs: result.durationMs },
    })
  } catch (error) {
    // 审计写入失败不应吞掉已完成的 job 结果，仅记录结构化告警
    logStructured('warn', 'admin.jobRun.auditFailed', {
      jobName,
      error: serializeError(error),
    })
  }

  const payload = {
    job_name: result.jobName,
    status: result.status,
    duration_ms: result.durationMs,
    processed: result.processed,
    succeeded: result.succeeded,
    failed: result.failed,
    details: result.details,
    ...(result.errorMessage ? { error: result.errorMessage } : {}),
  }

  return jsonResponse(payload, result.status === 'failed' ? 500 : 200)
}
