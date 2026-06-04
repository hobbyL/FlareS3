import type { Env } from '../config/env'
import { SYSTEM_DEFAULT_R2_CONFIG_ID_KEY } from './r2'
import { formatBytes } from '../utils/format'

export type AdminOverviewRisk = {
  code: string
  severity: 'warning' | 'error'
  message: string
  jobName?: string
}

type AdminOverviewMetrics = {
  totalUsers: number
  activeUsers: number
  disabledUsers: number
  totalFiles: number
  usedSpace: number
  usedSpaceFormatted: string
  expiringThisWeek: number
  pendingDeleteQueue: number
  totalTexts: number
  textsUpdated7d: number
  textsUpdated8To30d: number
  textsStaleOver30d: number
  activeShares: number
  expiredShares: number
  exhaustedShares: number
  consumedShares: number
}

async function getTextOverviewMetrics(
  env: Env,
  {
    sevenDaysAgo,
    thirtyDaysAgo,
  }: {
    sevenDaysAgo: string
    thirtyDaysAgo: string
  }
): Promise<
  Pick<
    AdminOverviewMetrics,
    'totalTexts' | 'textsUpdated7d' | 'textsUpdated8To30d' | 'textsStaleOver30d'
  >
> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS totalTexts,
            COALESCE(SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END), 0) AS textsUpdated7d,
            COALESCE(SUM(CASE WHEN updated_at < ? AND updated_at >= ? THEN 1 ELSE 0 END), 0) AS textsUpdated8To30d,
            COALESCE(SUM(CASE WHEN updated_at < ? THEN 1 ELSE 0 END), 0) AS textsStaleOver30d
       FROM texts
      WHERE deleted_at IS NULL`
  )
    .bind(sevenDaysAgo, sevenDaysAgo, thirtyDaysAgo, thirtyDaysAgo)
    .first<{
      totalTexts: number
      textsUpdated7d: number
      textsUpdated8To30d: number
      textsStaleOver30d: number
    }>()

  return {
    totalTexts: Number(row?.totalTexts || 0),
    textsUpdated7d: Number(row?.textsUpdated7d || 0),
    textsUpdated8To30d: Number(row?.textsUpdated8To30d || 0),
    textsStaleOver30d: Number(row?.textsStaleOver30d || 0),
  }
}

async function getStandardShareOverviewMetrics(
  env: Env,
  nowIso: string
): Promise<{
  activeShares: number
  expiredShares: number
  exhaustedShares: number
}> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN expires_at IS NULL OR expires_at > ? THEN CASE WHEN max_views > 0 AND views >= max_views THEN 0 ELSE 1 END ELSE 0 END), 0) AS activeShares,
            COALESCE(SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END), 0) AS expiredShares,
            COALESCE(SUM(CASE WHEN (expires_at IS NULL OR expires_at > ?) AND max_views > 0 AND views >= max_views THEN 1 ELSE 0 END), 0) AS exhaustedShares
       FROM (
              SELECT s.expires_at, s.max_views, s.views
                FROM file_shares s
                INNER JOIN files f ON f.id = s.file_id
               WHERE f.deleted_at IS NULL
              UNION ALL
              SELECT s.expires_at, s.max_views, s.views
                FROM text_shares s
                INNER JOIN texts t ON t.id = s.text_id
               WHERE t.deleted_at IS NULL
            ) shares`
  )
    .bind(nowIso, nowIso, nowIso)
    .first<{
      activeShares: number
      expiredShares: number
      exhaustedShares: number
    }>()

  return {
    activeShares: Number(row?.activeShares || 0),
    expiredShares: Number(row?.expiredShares || 0),
    exhaustedShares: Number(row?.exhaustedShares || 0),
  }
}

async function getOneTimeShareOverviewMetrics(
  env: Env,
  nowIso: string
): Promise<{
  activeShares: number
  expiredShares: number
  consumedShares: number
}> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN consumed_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END), 0) AS activeShares,
            COALESCE(SUM(CASE WHEN consumed_at IS NULL AND expires_at <= ? THEN 1 ELSE 0 END), 0) AS expiredShares,
            COALESCE(SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS consumedShares
       FROM text_one_time_shares s
       INNER JOIN texts t ON t.id = s.text_id
      WHERE t.deleted_at IS NULL`
  )
    .bind(nowIso, nowIso)
    .first<{
      activeShares: number
      expiredShares: number
      consumedShares: number
    }>()

  return {
    activeShares: Number(row?.activeShares || 0),
    expiredShares: Number(row?.expiredShares || 0),
    consumedShares: Number(row?.consumedShares || 0),
  }
}

export async function getAdminOverviewData(env: Env): Promise<{
  metrics: AdminOverviewMetrics
  setup: {
    configCount: number
    defaultConfigId: string | null
    hasUploadConfig: boolean
  }
  risks: AdminOverviewRisk[]
}> {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const nextWeek = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString()
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [
    totalUsersRow,
    activeUsersRow,
    disabledUsersRow,
    filesRow,
    expiringThisWeekRow,
    textMetrics,
    standardShareMetrics,
    oneTimeShareMetrics,
    pendingDeleteQueueRow,
    configCountRow,
    defaultConfigIdValue,
    latestFailedJob,
  ] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS total FROM users').first<{ total: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'active'").first<{
      total: number
    }>(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM users WHERE status = 'disabled'").first<{
      total: number
    }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS totalFiles, COALESCE(SUM(size), 0) AS usedSpace FROM files WHERE upload_status = 'completed' AND deleted_at IS NULL`
    ).first<{ totalFiles: number; usedSpace: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count FROM files WHERE upload_status IN ('pending','uploading','completed') AND deleted_at IS NULL AND expires_at < ?`
    )
      .bind(nextWeek)
      .first<{ count: number }>(),
    getTextOverviewMetrics(env, { sevenDaysAgo, thirtyDaysAgo }),
    getStandardShareOverviewMetrics(env, nowIso),
    getOneTimeShareOverviewMetrics(env, nowIso),
    env.DB.prepare('SELECT COUNT(*) AS count FROM delete_queue WHERE processed_at IS NULL').first<{
      count: number
    }>(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM r2_configs').first<{ count: number }>(),
    env.DB.prepare('SELECT value FROM system_config WHERE key = ?')
      .bind(SYSTEM_DEFAULT_R2_CONFIG_ID_KEY)
      .first('value'),
    env.DB.prepare(
      `SELECT job_name, status, finished_at, error_message FROM job_runs WHERE status IN ('failed','partial') ORDER BY created_at DESC LIMIT 1`
    ).first<{
      job_name: string
      status: 'failed' | 'partial'
      finished_at: string | null
      error_message: string | null
    }>(),
  ])

  const totalUsers = Number(totalUsersRow?.total || 0)
  const activeUsers = Number(activeUsersRow?.total || 0)
  const disabledUsers = Number(disabledUsersRow?.total || 0)
  const totalFiles = Number(filesRow?.totalFiles || 0)
  const usedSpace = Number(filesRow?.usedSpace || 0)
  const expiringThisWeek = Number(expiringThisWeekRow?.count || 0)
  const pendingDeleteQueue = Number(pendingDeleteQueueRow?.count || 0)
  const configCount = Number(configCountRow?.count || 0)
  const defaultConfigId = defaultConfigIdValue ? String(defaultConfigIdValue) : null
  const hasUploadConfig = configCount > 0

  const risks: AdminOverviewRisk[] = []

  if (!defaultConfigId && hasUploadConfig) {
    risks.push({
      code: 'missing_default_upload_config',
      severity: 'warning',
      message: '当前存在上传配置，但未设置默认上传配置',
    })
  }

  if (latestFailedJob) {
    risks.push({
      code: 'scheduled_job_failed',
      severity: 'error',
      message: `最近任务失败：${String(latestFailedJob.job_name)}`,
      jobName: String(latestFailedJob.job_name),
    })
  }

  return {
    metrics: {
      totalUsers,
      activeUsers,
      disabledUsers,
      totalFiles,
      usedSpace,
      usedSpaceFormatted: formatBytes(usedSpace),
      expiringThisWeek,
      pendingDeleteQueue,
      totalTexts: textMetrics.totalTexts,
      textsUpdated7d: textMetrics.textsUpdated7d,
      textsUpdated8To30d: textMetrics.textsUpdated8To30d,
      textsStaleOver30d: textMetrics.textsStaleOver30d,
      activeShares: standardShareMetrics.activeShares + oneTimeShareMetrics.activeShares,
      expiredShares: standardShareMetrics.expiredShares + oneTimeShareMetrics.expiredShares,
      exhaustedShares: standardShareMetrics.exhaustedShares,
      consumedShares: oneTimeShareMetrics.consumedShares,
    },
    setup: {
      configCount,
      defaultConfigId,
      hasUploadConfig,
    },
    risks,
  }
}
