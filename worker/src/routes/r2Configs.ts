import type { Env } from '../config/env'
import { getTotalStorage } from '../config/env'
import { jsonResponse, parseJson, getUser } from './utils'
import { encryptString, validateBase64KeyLength } from '../services/crypto'
import { formatBytes } from '../utils/format'
import {
  LEGACY_R2_CONFIG_ID,
  SYSTEM_DEFAULT_R2_CONFIG_ID_KEY,
  listR2ConfigOptions,
  loadR2ConfigById,
  setDefaultR2ConfigId,
  setLegacyFilesR2ConfigId,
  summarizeS3Error,
  testConnection,
} from '../services/r2'
import { listUploadConfigOptionsForUser } from '../services/uploadConfigPolicy'
import { getReservedConfigSpace } from '../services/uploadReservations'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'

const ACTIVE_COMPLETED_STORAGE_USAGE_WHERE = "upload_status = 'completed' AND deleted_at IS NULL"

type R2ConfigInput = {
  name: string
  endpoint: string
  access_key_id: string
  secret_access_key: string
  bucket_name: string
  quota_bytes: number
}

export async function listOptions(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  const timings: RouteTimingEntry[] = []

  const result = await measureRouteStep(timings, 'configOptions', () =>
    listUploadConfigOptionsForUser(env, user)
  )
  return withRouteTimingHeaders(jsonResponse(result), timings)
}

export async function listConfigs(_request: Request, env: Env): Promise<Response> {
  const { default_config_id, legacy_files_config_id, options } = await listR2ConfigOptions(env)
  const legacyAssignedId = legacy_files_config_id || default_config_id
  const configs: Array<{
    id: string
    name: string
    source: string
    endpoint: string
    bucket_name: string
    access_key_id?: string
    usedSpace: number
    totalSpace: number
    usedSpaceFormatted: string
    totalSpaceFormatted: string
    usagePercent: number
  }> = []

  const legacyUsedSpaceRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(size), 0) AS usedSpace FROM files WHERE ${ACTIVE_COMPLETED_STORAGE_USAGE_WHERE} AND r2_key NOT LIKE 'flares3/%/%'`
  ).first('usedSpace')
  const legacyUsedSpace = Number(legacyUsedSpaceRow || 0)

  for (const option of options) {
    const loaded = await loadR2ConfigById(env, option.id)
    if (!loaded) {
      continue
    }

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
      source: option.source,
      endpoint: loaded.config.endpoint,
      bucket_name: loaded.config.bucketName,
      access_key_id: loaded.config.accessKeyId,
      usedSpace,
      totalSpace,
      usedSpaceFormatted: formatBytes(usedSpace),
      totalSpaceFormatted: formatBytes(totalSpace),
      usagePercent,
    })
  }

  return jsonResponse({
    default_config_id,
    configs,
  })
}

export async function createConfig(request: Request, env: Env): Promise<Response> {
  const masterKey = String(env.R2_MASTER_KEY || '').trim()
  if (!masterKey) {
    return jsonResponse({ error: '缺少 R2_MASTER_KEY' }, 500)
  }
  const keyCheck = validateBase64KeyLength(masterKey, 32)
  if (!keyCheck.valid) {
    if (keyCheck.reason === 'invalid_base64') {
      return jsonResponse({ error: 'R2_MASTER_KEY 无效：不是合法的 base64 字符串' }, 500)
    }
    const suffix =
      keyCheck.reason === 'invalid_length' ? `（当前解码为 ${keyCheck.byteLength} 字节）` : ''
    return jsonResponse({ error: `R2_MASTER_KEY 无效：需要 32 字节 base64${suffix}` }, 500)
  }

  try {
    const body = await parseJson<R2ConfigInput>(request)
    if (
      !body.name ||
      !body.endpoint ||
      !body.access_key_id ||
      !body.secret_access_key ||
      !body.bucket_name ||
      body.quota_bytes === undefined
    ) {
      return jsonResponse({ error: '所有字段都是必填的' }, 400)
    }

    const quotaBytes = Number(body.quota_bytes)
    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
      return jsonResponse({ error: 'quota_bytes 必须为大于 0 的数字' }, 400)
    }

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const accessEnc = await encryptString(body.access_key_id, masterKey)
    const secretEnc = await encryptString(body.secret_access_key, masterKey)

    const result = await env.DB.prepare(
      `INSERT INTO r2_configs (id, name, endpoint, bucket_name, access_key_id_enc, secret_access_key_enc, quota_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        body.name,
        body.endpoint,
        body.bucket_name,
        accessEnc,
        secretEnc,
        quotaBytes,
        now,
        now
      )
      .run()

    if (result.error) {
      return jsonResponse({ error: '创建配置失败' }, 400)
    }

    const defaultId = await env.DB.prepare('SELECT value FROM system_config WHERE key = ?')
      .bind(SYSTEM_DEFAULT_R2_CONFIG_ID_KEY)
      .first('value')

    if (!defaultId) {
      await setDefaultR2ConfigId(env, id)
    }

    return jsonResponse({ success: true, id })
  } catch (error) {
    return jsonResponse({ error: '创建配置失败' }, 500)
  }
}

export async function updateConfig(request: Request, env: Env, id: string): Promise<Response> {
  if (!id) return jsonResponse({ error: '配置 ID 不能为空' }, 400)
  if (id === LEGACY_R2_CONFIG_ID) {
    return jsonResponse({ error: '该配置不可修改' }, 400)
  }
  const masterKey = String(env.R2_MASTER_KEY || '').trim()
  if (!masterKey) {
    return jsonResponse({ error: '缺少 R2_MASTER_KEY' }, 500)
  }
  const keyCheck = validateBase64KeyLength(masterKey, 32)
  if (!keyCheck.valid) {
    if (keyCheck.reason === 'invalid_base64') {
      return jsonResponse({ error: 'R2_MASTER_KEY 无效：不是合法的 base64 字符串' }, 500)
    }
    const suffix =
      keyCheck.reason === 'invalid_length' ? `（当前解码为 ${keyCheck.byteLength} 字节）` : ''
    return jsonResponse({ error: `R2_MASTER_KEY 无效：需要 32 字节 base64${suffix}` }, 500)
  }

  try {
    const existing = await env.DB.prepare(
      'SELECT id, name, endpoint, bucket_name, quota_bytes, access_key_id_enc, secret_access_key_enc FROM r2_configs WHERE id = ? LIMIT 1'
    )
      .bind(id)
      .first<{
        id: string
        name: string
        endpoint: string
        bucket_name: string
        quota_bytes: number
        access_key_id_enc: string
        secret_access_key_enc: string
      }>()

    if (!existing) {
      return jsonResponse({ error: '配置不存在' }, 404)
    }

    const body = await parseJson<Partial<R2ConfigInput>>(request)
    if (!body || Object.keys(body).length === 0) {
      return jsonResponse({ error: '无有效更新字段' }, 400)
    }

    const nextName = body.name ?? String(existing.name)
    const nextEndpoint = body.endpoint ?? String(existing.endpoint)
    const nextBucketName = body.bucket_name ?? String(existing.bucket_name)
    let nextQuotaBytes = Number(existing.quota_bytes)
    if (body.quota_bytes !== undefined) {
      nextQuotaBytes = Number(body.quota_bytes)
    }
    if (!Number.isFinite(nextQuotaBytes) || nextQuotaBytes <= 0) {
      return jsonResponse({ error: 'quota_bytes 必须为大于 0 的数字' }, 400)
    }

    let accessEnc = String(existing.access_key_id_enc)
    let secretEnc = String(existing.secret_access_key_enc)

    if (typeof body.access_key_id === 'string' && body.access_key_id) {
      accessEnc = await encryptString(body.access_key_id, masterKey)
    }

    if (typeof body.secret_access_key === 'string' && body.secret_access_key) {
      secretEnc = await encryptString(body.secret_access_key, masterKey)
    }

    if (!nextName || !nextEndpoint || !nextBucketName || !accessEnc || !secretEnc) {
      return jsonResponse({ error: '所有字段都是必填的' }, 400)
    }

    const now = new Date().toISOString()
    await env.DB.prepare(
      `UPDATE r2_configs
       SET name = ?, endpoint = ?, bucket_name = ?, quota_bytes = ?, access_key_id_enc = ?, secret_access_key_enc = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(nextName, nextEndpoint, nextBucketName, nextQuotaBytes, accessEnc, secretEnc, now, id)
      .run()

    return jsonResponse({ success: true })
  } catch (error) {
    return jsonResponse({ error: '更新配置失败' }, 500)
  }
}

export async function deleteConfig(_request: Request, env: Env, id: string): Promise<Response> {
  if (!id) return jsonResponse({ error: '配置 ID 不能为空' }, 400)
  if (id === LEGACY_R2_CONFIG_ID) {
    return jsonResponse({ error: '该配置不可删除' }, 400)
  }

  try {
    const prefix = `flares3/${id}/%`
    const fileCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM files WHERE r2_key LIKE ?'
    )
      .bind(prefix)
      .first('count')
    const queueCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM delete_queue WHERE r2_key LIKE ?'
    )
      .bind(prefix)
      .first('count')

    if (Number(fileCount || 0) > 0 || Number(queueCount || 0) > 0) {
      return jsonResponse({ error: '该配置仍有关联文件，无法删除' }, 409)
    }

    await env.DB.prepare('DELETE FROM r2_configs WHERE id = ?').bind(id).run()

    const defaultId = await env.DB.prepare('SELECT value FROM system_config WHERE key = ?')
      .bind(SYSTEM_DEFAULT_R2_CONFIG_ID_KEY)
      .first('value')

    if (String(defaultId || '') === id) {
      await env.DB.prepare('DELETE FROM system_config WHERE key = ?')
        .bind(SYSTEM_DEFAULT_R2_CONFIG_ID_KEY)
        .run()
    }

    return jsonResponse({ success: true })
  } catch (error) {
    return jsonResponse({ error: '删除配置失败' }, 500)
  }
}

export async function setDefault(request: Request, env: Env): Promise<Response> {
  try {
    const body = await parseJson<{ id: string }>(request)
    const id = body?.id
    if (!id) {
      return jsonResponse({ error: '缺少 id' }, 400)
    }

    const loaded = await loadR2ConfigById(env, id)
    if (!loaded) {
      return jsonResponse({ error: '配置不存在或不可用' }, 404)
    }

    await setDefaultR2ConfigId(env, id)
    return jsonResponse({ success: true })
  } catch (error) {
    return jsonResponse({ error: '设置默认配置失败' }, 500)
  }
}

export async function setLegacyFiles(request: Request, env: Env): Promise<Response> {
  try {
    const body = await parseJson<{ id?: string | null }>(request)
    const id = body?.id

    if (id === undefined) {
      return jsonResponse({ error: '缺少 id' }, 400)
    }

    if (id === null || String(id).trim() === '') {
      await setLegacyFilesR2ConfigId(env, null)
      return jsonResponse({ success: true })
    }

    const loaded = await loadR2ConfigById(env, id)
    if (!loaded) {
      return jsonResponse({ error: '配置不存在或不可用' }, 404)
    }

    await setLegacyFilesR2ConfigId(env, id)
    return jsonResponse({ success: true })
  } catch (error) {
    return jsonResponse({ error: '设置旧文件配置失败' }, 500)
  }
}

export async function testById(_request: Request, env: Env, id: string): Promise<Response> {
  if (!id) return jsonResponse({ success: false, message: '缺少 id' }, 400)
  try {
    const loaded = await loadR2ConfigById(env, id)
    if (!loaded) {
      return jsonResponse({ success: false, message: '配置不存在或不可用' }, 404)
    }
    await testConnection(loaded.config)
    return jsonResponse({ success: true, message: '连接测试成功' })
  } catch (error) {
    const summary = summarizeS3Error(error)
    const parts = [
      summary.code,
      typeof summary.httpStatusCode === 'number' ? `HTTP ${summary.httpStatusCode}` : null,
      summary.message,
    ].filter(Boolean)

    let message = parts.length ? `连接测试失败（${parts.join(' / ')}）` : '连接测试失败'
    if (summary.httpStatusCode === 403 || summary.code === 'AccessDenied') {
      message += '；请确认 R2 API Token 已启用 Object Read/Write 且已授权该 Bucket'
    }

    return jsonResponse({ success: false, message }, 400)
  }
}
