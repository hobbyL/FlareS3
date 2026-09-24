import type { Env } from './config/env'
import { cleanupExpired } from './jobs/cleanupExpired'
import { cleanupDeleteQueue } from './jobs/cleanupDeleteQueue'
import { cleanupRetention } from './jobs/cleanupRetention'
import {
  buildJobResult,
  finishJobRun,
  startJobRun,
  type JobExecutionResult,
} from './services/jobRuns'
import { logStructured, serializeError } from './utils/log'

export async function handleScheduled(env: Env): Promise<void> {
  const failures: JobExecutionResult[] = []
  const jobs = [
    ['cleanupExpired', () => cleanupExpired(env)],
    ['cleanupDeleteQueue', () => cleanupDeleteQueue(env)],
    ['cleanupRetention', () => cleanupRetention(env)],
  ] as const

  async function executeTrackedJob(
    jobName: string,
    handler: () => Promise<JobExecutionResult>
  ): Promise<JobExecutionResult> {
    const startedAt = new Date().toISOString()
    const runId = await startJobRun(env.DB, jobName, startedAt)

    try {
      const result = await handler()
      await finishJobRun(env.DB, runId, result)
      return result
    } catch (error) {
      const failedResult = buildJobResult(jobName, Date.parse(startedAt), {
        status: 'failed',
        processed: 0,
        succeeded: 0,
        failed: 1,
        details: {},
        errorMessage: serializeError(error) ?? 'unknown_error',
      })
      await finishJobRun(env.DB, runId, failedResult)
      return failedResult
    }
  }

  const results: Array<readonly [string, JobExecutionResult]> = []
  for (const [jobName, handler] of jobs) {
    const result = await executeTrackedJob(jobName, handler)
    if (result.status === 'failed') {
      failures.push(result)
    }
    results.push([jobName, result] as const)
  }

  logStructured('info', 'scheduled.cleanup.completed', {
    ...Object.fromEntries(results),
  })

  if (failures.length > 0) {
    const errorMessage = failures
      .map((item) => item.errorMessage || `${item.jobName} failed`)
      .join('; ')
    logStructured('error', 'scheduled.cleanup.failed', {
      error: errorMessage,
    })
    throw new Error(errorMessage)
  }
}
