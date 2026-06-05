import type { Env } from '../config/env'
import { getTotalStorage } from '../config/env'
import { jsonResponse } from './utils'
import { decryptString, validateBase64KeyLength } from '../services/crypto'
import { formatBytes } from '../utils/format'
import { listR2ConfigSummaries, loadR2ConfigById } from '../services/r2'
import { listWebDAVConfigs, loadWebDAVConfigById } from '../services/storage/webdav-config'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'

const ACTIVE_COMPLETED_STORAGE_USAGE_WHERE = "upload_status = 'completed' AND deleted_at IS NULL"
const MASKED_CREDENTIAL_VALUE = '******'

function toUsageMap(
  rows: Array<{ config_id?: unknown; used_space?: unknown }>
): Map<string, number> {
  const usage = new Map<string, number>()
  for (const row of rows) {
    const configId = String(row.config_id || '').trim()
    if (!configId) continue
    const usedSpace = Number(row.used_space || 0)
    usage.set(configId, Number.isFinite(usedSpace) && usedSpace > 0 ? usedSpace : 0)
  }
  return usage
}

async function listCompletedR2Usage(db: D1Database): Promise<Map<string, number>> {
  const rows = await db
    .prepare(
      `SELECT SUBSTR(rest, 1, INSTR(rest, '/') - 1) AS config_id,
              COALESCE(SUM(size), 0) AS used_space
         FROM (
                SELECT SUBSTR(r2_key, 9) AS rest, size
                  FROM files
                 WHERE ${ACTIVE_COMPLETED_STORAGE_USAGE_WHERE}
                   AND r2_key LIKE 'flares3/%/%'
              )
        WHERE INSTR(rest, '/') > 0
        GROUP BY SUBSTR(rest, 1, INSTR(rest, '/') - 1)`
    )
    .all<{ config_id: string; used_space: number }>()

  return toUsageMap(rows.results || [])
}

async function listReservedConfigUsage(db: D1Database): Promise<Map<string, number>> {
  const rows = await db
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
  const legacyUsedSpaceRow = await db
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS usedSpace FROM files WHERE ${ACTIVE_COMPLETED_STORAGE_USAGE_WHERE} AND r2_key NOT LIKE 'flares3/%/%'`
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

async function loadR2CredentialDisplay(
  env: Env,
  id: string,
  masterKey: string
): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    'SELECT access_key_id_enc FROM r2_configs WHERE id = ? LIMIT 1'
  )
    .bind(id)
    .first<{ access_key_id_enc: string }>()

  if (row?.access_key_id_enc) {
    return {
      type: 'r2',
      access_key_id: await decryptString(String(row.access_key_id_enc), masterKey),
      secret_access_key: MASKED_CREDENTIAL_VALUE,
      secret_access_key_masked: true,
    }
  }

  const loaded = await loadR2ConfigById(env, id)
  if (!loaded) return null

  return {
    type: 'r2',
    access_key_id: loaded.config.accessKeyId,
    secret_access_key: MASKED_CREDENTIAL_VALUE,
    secret_access_key_masked: true,
  }
}

async function loadWebDAVCredentialDisplay(
  env: Env,
  id: string,
  masterKey: string,
  requestedType: string
): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    'SELECT type, username_enc FROM webdav_configs WHERE id = ? LIMIT 1'
  )
    .bind(id)
    .first<{ type: string; username_enc: string }>()

  if (!row) return null

  const configType = String(row.type) === 'koofr' ? 'koofr' : 'webdav'
  if (requestedType && configType !== requestedType) return null

  return {
    type: configType,
    username: await decryptString(String(row.username_enc), masterKey),
    password: MASKED_CREDENTIAL_VALUE,
    password_masked: true,
  }
}

export async function listAllConfigs(_request: Request, env: Env): Promise<Response> {
  const timings: RouteTimingEntry[] = []
  const [r2Result, webdavConfigs, completedUsage, reservedUsage, legacyUsedSpace] =
    await Promise.all([
      measureRouteStep(timings, 'r2ConfigRows', () => listR2ConfigSummaries(env)),
      measureRouteStep(timings, 'webdavConfigRows', () => listWebDAVConfigs(env.DB)),
      measureRouteStep(timings, 'completedUsageRows', () => listCompletedR2Usage(env.DB)),
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

  return withRouteTimingHeaders(
    jsonResponse({
      default_config_id,
      legacy_files_config_id,
      configs,
    }),
    timings
  )
}

export async function getConfigSecrets(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  if (!id) return secretJsonResponse({ error: '配置 ID 不能为空' }, 400)

  const masterKey = String(env.R2_MASTER_KEY || '').trim()
  if (!masterKey) {
    return secretJsonResponse({ error: '缺少 R2_MASTER_KEY' }, 500)
  }

  const keyCheck = validateBase64KeyLength(masterKey, 32)
  if (!keyCheck.valid) {
    if (keyCheck.reason === 'invalid_base64') {
      return secretJsonResponse({ error: 'R2_MASTER_KEY 无效：不是合法的 base64 字符串' }, 500)
    }
    const suffix =
      keyCheck.reason === 'invalid_length' ? `（当前解码为 ${keyCheck.byteLength} 字节）` : ''
    return secretJsonResponse({ error: `R2_MASTER_KEY 无效：需要 32 字节 base64${suffix}` }, 500)
  }

  const url = new URL(request.url)
  const requestedType = String(url.searchParams.get('type') || '').trim()
  if (requestedType && !['r2', 'webdav', 'koofr'].includes(requestedType)) {
    return secretJsonResponse({ error: 'type 必须为 r2、webdav 或 koofr' }, 400)
  }
  const displayOnly =
    url.searchParams.get('mode') === 'display' ||
    ['0', 'false'].includes(String(url.searchParams.get('reveal') || '').toLowerCase())

  try {
    if (displayOnly) {
      if (!requestedType || requestedType === 'r2') {
        const r2Display = await loadR2CredentialDisplay(env, id, masterKey)
        if (r2Display) return secretJsonResponse(r2Display)
      }

      if (!requestedType || requestedType === 'webdav' || requestedType === 'koofr') {
        const webdavDisplay = await loadWebDAVCredentialDisplay(
          env,
          id,
          masterKey,
          requestedType
        )
        if (webdavDisplay) return secretJsonResponse(webdavDisplay)
      }

      return secretJsonResponse({ error: '配置不存在或不可用' }, 404)
    }

    if (!requestedType || requestedType === 'r2') {
      const r2Config = await loadR2ConfigById(env, id)
      if (r2Config) {
        return secretJsonResponse({
          type: 'r2',
          access_key_id: r2Config.config.accessKeyId,
          secret_access_key: r2Config.config.secretAccessKey,
        })
      }
    }

    if (!requestedType || requestedType === 'webdav' || requestedType === 'koofr') {
      const webdavConfig = await loadWebDAVConfigById(env, id)
      if (webdavConfig && (!requestedType || webdavConfig.type === requestedType)) {
        return secretJsonResponse({
          type: webdavConfig.type,
          username: webdavConfig.config.username,
          password: webdavConfig.config.password,
        })
      }
    }

    return secretJsonResponse({ error: '配置不存在或不可用' }, 404)
  } catch {
    return secretJsonResponse({ error: '读取配置密钥失败' }, 500)
  }
}
