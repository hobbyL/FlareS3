import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { getTotalStorage } from '../config/env'
import { jsonResponse } from './utils'
import { formatBytes } from '../utils/format'
import { listR2ConfigSummaries, loadR2ConfigById } from '../services/r2'
import { listWebDAVConfigs, loadWebDAVConfigById } from '../services/storage/webdav-config'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'

const ACTIVE_COMPLETED_STORAGE_USAGE_WHERE = "upload_status = 'completed' AND deleted_at IS NULL"

function toUsageMap(
  rows: Array<{ config_id?: unknown; used_space?: unknown }>
): Map<string, number> {
  const usage = new Map<string, number>()
  for (const row of rows) {
    const configId = String(row.config_id || '').trim()
    if (!configId) continue
    const usedSpace = Number(row.used_space || 0)
    const normalizedUsedSpace = Number.isFinite(usedSpace) && usedSpace > 0 ? usedSpace : 0
    usage.set(configId, (usage.get(configId) || 0) + normalizedUsedSpace)
  }
  return usage
}

async function listCompletedConfigUsage(db: D1Database): Promise<Map<string, number>> {
  const rows = await withD1Retry(db)
    .prepare(
      `SELECT config_id, COALESCE(SUM(size), 0) AS used_space
         FROM files
        WHERE ${ACTIVE_COMPLETED_STORAGE_USAGE_WHERE}
          AND config_id IS NOT NULL
          AND TRIM(config_id) <> ''
        GROUP BY config_id
       UNION ALL
       SELECT SUBSTR(rest, 1, INSTR(rest, '/') - 1) AS config_id,
              COALESCE(SUM(size), 0) AS used_space
         FROM (
                SELECT SUBSTR(r2_key, 9) AS rest, size
                  FROM files
                 WHERE ${ACTIVE_COMPLETED_STORAGE_USAGE_WHERE}
                   AND (config_id IS NULL OR TRIM(config_id) = '')
                   AND r2_key LIKE 'flares3/%/%'
              )
        WHERE INSTR(rest, '/') > 0
        GROUP BY SUBSTR(rest, 1, INSTR(rest, '/') - 1)`
    )
    .all<{ config_id: string; used_space: number }>()

  return toUsageMap(rows.results || [])
}

async function listReservedConfigUsage(db: D1Database): Promise<Map<string, number>> {
  const rows = await withD1Retry(db)
    .prepare(
      `SELECT r2_config_id AS config_id,
              COALESCE(SUM(reserved_bytes), 0) AS used_space
         FROM upload_reservations
        WHERE status = 'active'
        GROUP BY r2_config_id`
    )
    .all<{ config_id: string; used_space: number }>()

  return toUsageMap(rows.results || [])
}

async function getLegacyUsedSpace(db: D1Database): Promise<number> {
  const legacyUsedSpaceRow = await withD1Retry(db)
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS usedSpace
         FROM files
        WHERE ${ACTIVE_COMPLETED_STORAGE_USAGE_WHERE}
          AND (config_id IS NULL OR TRIM(config_id) = '')
          AND r2_key NOT LIKE 'flares3/%/%'`
    )
    .first('usedSpace')
  const legacyUsedSpace = Number(legacyUsedSpaceRow || 0)
  return Number.isFinite(legacyUsedSpace) && legacyUsedSpace > 0 ? legacyUsedSpace : 0
}

function getMappedUsage(usage: Map<string, number>, configId: string): number {
  return Number(usage.get(configId) || 0)
}

function secretJsonResponse(data: unknown, status = 200): Response {
  return jsonResponse(data, status, { 'Cache-Control': 'no-store' })
}

/**
 * 获取所有存储配置（统一 R2 和 WebDAV/Koofr）
 *
 * @route GET /api/storage/configs
 * @param _request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含所有存储配置的统一列表
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "default_config_id": "uuid",
 *   "legacy_files_config_id": "uuid",
 *   "configs": [
 *     {
 *       "id": "uuid",
 *       "name": "R2 配置",
 *       "type": "r2",
 *       "source": "database",
 *       "endpoint": "https://xxx.r2.cloudflarestorage.com",
 *       "bucket_name": "my-bucket",
 *       "usedSpace": 1048576,
 *       "totalSpace": 10737418240,
 *       "usedSpaceFormatted": "1.00 MB",
 *       "totalSpaceFormatted": "10.00 GB",
 *       "usagePercent": 0.01
 *     },
 *     {
 *       "id": "uuid",
 *       "name": "WebDAV 配置",
 *       "type": "webdav",
 *       "endpoint": "https://webdav.example.com",
 *       "remote_path": "/files",
 *       "usedSpace": 2097152,
 *       "totalSpace": 5368709120,
 *       "usedSpaceFormatted": "2.00 MB",
 *       "totalSpaceFormatted": "5.00 GB",
 *       "usagePercent": 0.04
 *     }
 *   ]
 * }
 */
export async function listAllConfigs(_request: Request, env: Env): Promise<Response> {
  const timings: RouteTimingEntry[] = []
  const [r2Result, webdavConfigs, completedUsage, reservedUsage, legacyUsedSpace] =
    await Promise.all([
      measureRouteStep(timings, 'r2ConfigRows', () => listR2ConfigSummaries(env)),
      measureRouteStep(timings, 'webdavConfigRows', () => listWebDAVConfigs(env.DB)),
      measureRouteStep(timings, 'completedUsageRows', () => listCompletedConfigUsage(env.DB)),
      measureRouteStep(timings, 'reservedUsageRows', () => listReservedConfigUsage(env.DB)),
      measureRouteStep(timings, 'legacyUsageRow', () => getLegacyUsedSpace(env.DB)),
    ])

  const { default_config_id, legacy_files_config_id, configs: r2Configs } = r2Result
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
  for (const config of r2Configs) {
    const totalSpace = config.source === 'legacy' ? getTotalStorage(env) : config.quotaBytes
    let usedSpace =
      getMappedUsage(completedUsage, config.id) + getMappedUsage(reservedUsage, config.id)
    if (legacyAssignedId && legacyUsedSpace > 0 && config.id === legacyAssignedId) {
      usedSpace += legacyUsedSpace
    }

    const usagePercent = totalSpace ? (usedSpace / totalSpace) * 100 : 0
    configs.push({
      id: config.id,
      name: config.name,
      type: 'r2',
      source: config.source,
      endpoint: config.endpoint,
      bucket_name: config.bucketName,
      usedSpace,
      totalSpace,
      usedSpaceFormatted: formatBytes(usedSpace),
      totalSpaceFormatted: formatBytes(totalSpace),
      usagePercent,
    })
  }

  for (const cfg of webdavConfigs) {
    const usedSpace = getMappedUsage(completedUsage, cfg.id) + getMappedUsage(reservedUsage, cfg.id)
    const usagePercent = cfg.quotaBytes ? (usedSpace / cfg.quotaBytes) * 100 : 0
    configs.push({
      id: cfg.id,
      name: cfg.name,
      type: cfg.type,
      endpoint: cfg.endpoint,
      remote_path: cfg.remote_path,
      usedSpace,
      totalSpace: cfg.quotaBytes,
      usedSpaceFormatted: formatBytes(usedSpace),
      totalSpaceFormatted: formatBytes(cfg.quotaBytes),
      usagePercent,
    })
  }

  return withRouteTimingHeaders(
    jsonResponse({
      default_config_id,
      legacy_files_config_id,
      configs,
    }),
    timings
  )
}

/**
 * 获取存储配置的敏感信息（密钥/密码）
 *
 * @route GET /api/storage/configs/:id/secrets
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param id - 配置 ID
 * @returns JSON 响应，包含配置的敏感信息
 *
 * @example
 * // 查询参数
 * // type: 配置类型（r2 | webdav | koofr）
 *
 * // 成功响应（R2）(200)
 * {
 *   "type": "r2",
 *   "endpoint": "https://xxx.r2.cloudflarestorage.com",
 *   "bucket_name": "my-bucket",
 *   "access_key_id": "xxxx",
 *   "secret_access_key": "xxxx"
 * }
 *
 * // 成功响应（WebDAV/Koofr）(200)
 * {
 *   "type": "webdav",
 *   "endpoint": "https://webdav.example.com",
 *   "remote_path": "/files",
 *   "username": "user",
 *   "password": "pass"
 * }
 *
 * // 配置 ID 为空 (400)
 * { "error": "配置 ID 不能为空" }
 *
 * // 配置不存在 (404)
 * { "error": "配置不存在或密钥不可用" }
 *
 * // type 无效 (400)
 * { "error": "type 必须为 r2、webdav 或 koofr" }
 */
export async function getConfigSecrets(request: Request, env: Env, id: string): Promise<Response> {
  if (!id) return secretJsonResponse({ error: '配置 ID 不能为空' }, 400)

  const type = new URL(request.url).searchParams.get('type')
  if (type === 'r2') {
    try {
      const loaded = await loadR2ConfigById(env, id)
      if (!loaded) return secretJsonResponse({ error: '配置不存在或密钥不可用' }, 404)

      return secretJsonResponse({
        type: 'r2',
        endpoint: loaded.config.endpoint,
        bucket_name: loaded.config.bucketName,
        access_key_id: loaded.config.accessKeyId,
        secret_access_key: loaded.config.secretAccessKey,
      })
    } catch {
      return secretJsonResponse({ error: '读取配置密钥失败' }, 500)
    }
  }

  if (type === 'webdav' || type === 'koofr') {
    const loaded = await loadWebDAVConfigById(env, id)
    if (!loaded || loaded.type !== type) {
      return secretJsonResponse({ error: '配置不存在或密钥不可用' }, 404)
    }

    return secretJsonResponse({
      type: loaded.type,
      endpoint: loaded.config.endpoint,
      remote_path: loaded.config.remotePath,
      username: loaded.config.username,
      password: loaded.config.password,
    })
  }

  return secretJsonResponse({ error: 'type 必须为 r2、webdav 或 koofr' }, 400)
}
