import type { Env } from '../config/env'
import { getTotalStorage } from '../config/env'
import { jsonResponse } from './utils'
import { formatBytes } from '../utils/format'
import { listDbR2Configs, listR2ConfigOptions, loadR2ConfigById } from '../services/r2'
import { listWebDAVConfigs } from '../services/storage/webdav-config'
import { getReservedConfigSpace } from '../services/uploadReservations'

const ACTIVE_COMPLETED_STORAGE_USAGE_WHERE = "upload_status = 'completed' AND deleted_at IS NULL"

export async function listAllConfigs(_request: Request, env: Env): Promise<Response> {
  const {
    default_config_id,
    legacy_files_config_id,
    options: r2Options,
  } = await listR2ConfigOptions(env)
  const legacyAssignedId = legacy_files_config_id || default_config_id

  type UnifiedConfig = {
    id: string
    name: string
    type: 'r2' | 'webdav' | 'koofr'
    source?: string
    endpoint: string
    bucket_name?: string
    remote_path?: string
    mount_id?: string | null
    usedSpace: number
    totalSpace: number
    usedSpaceFormatted: string
    totalSpaceFormatted: string
    usagePercent: number
  }

  const configs: UnifiedConfig[] = []

  // R2 配置
  const dbR2Configs = await listDbR2Configs(env.DB)
  const dbR2ConfigById = new Map(dbR2Configs.map((cfg) => [cfg.id, cfg]))
  const legacyUsedSpaceRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(size), 0) AS usedSpace FROM files WHERE ${ACTIVE_COMPLETED_STORAGE_USAGE_WHERE} AND r2_key NOT LIKE 'flares3/%/%'`
  ).first('usedSpace')
  const legacyUsedSpace = Number(legacyUsedSpaceRow || 0)

  for (const option of r2Options) {
    let totalSpace = getTotalStorage(env)
    let endpoint = ''
    let bucketName = ''

    if (option.source === 'db') {
      const summary = dbR2ConfigById.get(option.id)
      if (!summary) continue
      endpoint = summary.endpoint
      bucketName = summary.bucketName
      totalSpace = summary.quotaBytes
    } else {
      const loaded = await loadR2ConfigById(env, option.id)
      if (!loaded) continue
      endpoint = loaded.config.endpoint
      bucketName = loaded.config.bucketName
    }

    const prefix = `flares3/${option.id}/%`
    const usedSpaceRow = await env.DB.prepare(
      `SELECT COALESCE(SUM(size), 0) AS usedSpace FROM files WHERE ${ACTIVE_COMPLETED_STORAGE_USAGE_WHERE} AND r2_key LIKE ?`
    )
      .bind(prefix)
      .first('usedSpace')
    let usedSpace = Number(usedSpaceRow || 0)
    usedSpace += await getReservedConfigSpace(env.DB, option.id)
    if (legacyAssignedId && legacyUsedSpace > 0 && option.id === legacyAssignedId) {
      usedSpace += legacyUsedSpace
    }

    const usagePercent = totalSpace ? (usedSpace / totalSpace) * 100 : 0
    configs.push({
      id: option.id,
      name: option.name,
      type: 'r2',
      source: option.source,
      endpoint,
      bucket_name: bucketName,
      usedSpace,
      totalSpace,
      usedSpaceFormatted: formatBytes(usedSpace),
      totalSpaceFormatted: formatBytes(totalSpace),
      usagePercent,
    })
  }

  // WebDAV / Koofr 配置
  const webdavConfigs = await listWebDAVConfigs(env.DB)
  for (const cfg of webdavConfigs) {
    const usagePercent = cfg.quotaBytes ? 0 : 0
    configs.push({
      id: cfg.id,
      name: cfg.name,
      type: cfg.type,
      endpoint: cfg.endpoint,
      remote_path: cfg.remote_path,
      usedSpace: 0,
      totalSpace: cfg.quotaBytes,
      usedSpaceFormatted: formatBytes(0),
      totalSpaceFormatted: formatBytes(cfg.quotaBytes),
      usagePercent,
    })
  }

  return jsonResponse({
    default_config_id,
    configs,
  })
}
