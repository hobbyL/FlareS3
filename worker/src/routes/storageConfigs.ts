import type { Env } from '../config/env'
import { getTotalStorage } from '../config/env'
import { jsonResponse, getUser } from './utils'
import { formatBytes } from '../utils/format'
import { listR2ConfigOptions, loadR2ConfigById } from '../services/r2'
import { listWebDAVConfigs } from '../services/storage/webdav-config'
import { getReservedConfigSpace } from '../services/uploadReservations'

const ACTIVE_COMPLETED_STORAGE_USAGE_WHERE = "upload_status = 'completed' AND deleted_at IS NULL"

export async function listAllConfigs(_request: Request, env: Env): Promise<Response> {
  const { default_config_id, legacy_files_config_id, options: r2Options } = await listR2ConfigOptions(env)
  const legacyAssignedId = legacy_files_config_id || default_config_id

  type UnifiedConfig = {
    id: string
    name: string
    type: 'r2' | 'webdav' | 'koofr'
    source?: string
    endpoint: string
    bucket_name?: string
    access_key_id?: string
    secret_access_key?: string
    username?: string
    password?: string
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
  const legacyUsedSpaceRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(size), 0) AS usedSpace FROM files WHERE ${ACTIVE_COMPLETED_STORAGE_USAGE_WHERE} AND r2_key NOT LIKE 'flares3/%/%'`
  ).first('usedSpace')
  const legacyUsedSpace = Number(legacyUsedSpaceRow || 0)

  for (const option of r2Options) {
    const loaded = await loadR2ConfigById(env, option.id)
    if (!loaded) continue

    let totalSpace = getTotalStorage(env)
    if (option.source === 'db') {
      const quota = await env.DB.prepare('SELECT quota_bytes FROM r2_configs WHERE id = ? LIMIT 1')
        .bind(option.id)
        .first('quota_bytes')
      const quotaBytes = Number(quota)
      if (Number.isFinite(quotaBytes) && quotaBytes > 0) {
        totalSpace = quotaBytes
      }
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
      endpoint: loaded.config.endpoint,
      bucket_name: loaded.config.bucketName,
      access_key_id: loaded.config.accessKeyId,
      secret_access_key: loaded.config.secretAccessKey,
      usedSpace,
      totalSpace,
      usedSpaceFormatted: formatBytes(usedSpace),
      totalSpaceFormatted: formatBytes(totalSpace),
      usagePercent,
    })
  }

  // WebDAV / Koofr 配置
  const masterKey = String(env.R2_MASTER_KEY || '').trim()
  const webdavConfigs = await listWebDAVConfigs(env.DB, masterKey)
  for (const cfg of webdavConfigs) {
    const usagePercent = cfg.quotaBytes ? 0 : 0
    configs.push({
      id: cfg.id,
      name: cfg.name,
      type: cfg.type,
      endpoint: cfg.endpoint,
      username: cfg.username,
      password: cfg.password,
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
