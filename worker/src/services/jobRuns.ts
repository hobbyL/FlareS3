export type JobRunStatus = 'running' | 'success' | 'partial' | 'failed'

export type JobExecutionResult = {
  jobName: string
  status: Exclude<JobRunStatus, 'running'>
  processed: number
  succeeded: number
  failed: number
  startedAt: string
  finishedAt: string
  durationMs: number
  details: Record<string, unknown>
  errorMessage?: string
}

type JobRunListItem = {
  id: string
  jobName: string
  status: JobRunStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number
  summary: Record<string, unknown>
  errorMessage: string | null
  createdAt: string
}

function toIsoString(timestampMs: number): string {
  return new Date(timestampMs).toISOString()
}

function safeStringifySummary(summary: unknown): string {
  try {
    return JSON.stringify(summary ?? {})
  } catch {
    return '{}'
  }
}

function safeParseSummary(summaryJson: unknown): Record<string, unknown> {
  if (!summaryJson) {
    return {}
  }

  try {
    const parsed = JSON.parse(String(summaryJson))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function buildJobResult(
  jobName: string,
  startedAtMs: number,
  options: {
    status: Exclude<JobRunStatus, 'running'>
    processed: number
    succeeded: number
    failed: number
    details?: Record<string, unknown>
    errorMessage?: string
  }
): JobExecutionResult {
  const finishedAtMs = Date.now()
  return {
    jobName,
    status: options.status,
    processed: options.processed,
    succeeded: options.succeeded,
    failed: options.failed,
    startedAt: toIsoString(startedAtMs),
    finishedAt: toIsoString(finishedAtMs),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    details: options.details ?? {},
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
  }
}

export async function startJobRun(
  db: D1Database,
  jobName: string,
  startedAt: string = new Date().toISOString()
): Promise<string> {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  await db
    .prepare(
      `INSERT INTO job_runs (id, job_name, status, started_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, jobName, 'running', startedAt, createdAt)
    .run()

  return id
}

export async function finishJobRun(
  db: D1Database,
  id: string,
  result: JobExecutionResult
): Promise<void> {
  await db
    .prepare(
      `UPDATE job_runs
       SET status = ?, finished_at = ?, duration_ms = ?, summary_json = ?, error_message = ?
       WHERE id = ?`
    )
    .bind(
      result.status,
      result.finishedAt,
      result.durationMs,
      safeStringifySummary(result.details),
      result.errorMessage ?? null,
      id
    )
    .run()
}

export async function listJobRuns(
  db: D1Database,
  options: { page?: number; limit?: number } = {}
): Promise<{ total: number; items: JobRunListItem[] }> {
  const page = Math.max(1, Number(options.page || 1))
  const limit = Math.min(100, Math.max(1, Number(options.limit || 20)))
  const offset = (page - 1) * limit

  const total = Number(
    (await db.prepare('SELECT COUNT(*) AS total FROM job_runs').first<{ total: number }>())
      ?.total || 0
  )

  const rows = await db
    .prepare(
      `SELECT id, job_name, status, started_at, finished_at, duration_ms, summary_json, error_message, created_at
       FROM job_runs
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<{
      id: string
      job_name: string
      status: JobRunStatus
      started_at: string
      finished_at: string | null
      duration_ms: number | null
      summary_json: string | null
      error_message: string | null
      created_at: string
    }>()

  return {
    total,
    items: (rows.results || []).map((row) => ({
      id: String(row.id),
      jobName: String(row.job_name),
      status: row.status,
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      durationMs: Number(row.duration_ms || 0),
      summary: safeParseSummary(row.summary_json),
      errorMessage: row.error_message ? String(row.error_message) : null,
      createdAt: String(row.created_at),
    })),
  }
}
