import type { Env } from '../config/env'
import { DEFAULT_TOTAL_STORAGE } from '../config/env'
import { decryptString } from './crypto'

export const LEGACY_R2_CONFIG_ID = 'legacy'
export const SYSTEM_DEFAULT_R2_CONFIG_ID_KEY = 'r2_default_config_id'
export const SYSTEM_LEGACY_FILES_CONFIG_ID_KEY = 'r2_legacy_files_config_id'

export type R2Config = {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucketName: string
}

export type R2ConfigSource = 'legacy' | 'db'

export type LoadedR2Config = {
  id: string
  source: R2ConfigSource
  config: R2Config
}

export type R2ConfigOption = {
  id: string
  name: string
  source: R2ConfigSource
}

export type R2ConfigSummary = {
  id: string
  name: string
  source: R2ConfigSource
  endpoint: string
  bucketName: string
  quotaBytes: number
  createdAt?: string
  updatedAt?: string
}

async function getSystemConfigValue(db: D1Database, key: string): Promise<string | null> {
  const value = await db
    .prepare('SELECT value FROM system_config WHERE key = ?')
    .bind(key)
    .first('value')
  return value ? String(value) : null
}

async function getSystemConfigValues(db: D1Database, keys: string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map()

  const placeholders = keys.map(() => '?').join(',')
  const rows = await db
    .prepare(`SELECT key, value FROM system_config WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>()

  const values = new Map<string, string>()
  for (const row of rows.results || []) {
    values.set(String(row.key), String(row.value))
  }
  return values
}

async function setSystemConfigValue(db: D1Database, key: string, value: string): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO system_config (key, value, updated_at)
     VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`
    )
    .bind(key, value, now, value, now)
    .run()
}

export async function getDefaultR2ConfigId(env: Env): Promise<string | null> {
  return getSystemConfigValue(env.DB, SYSTEM_DEFAULT_R2_CONFIG_ID_KEY)
}

export async function setDefaultR2ConfigId(env: Env, id: string): Promise<void> {
  await setSystemConfigValue(env.DB, SYSTEM_DEFAULT_R2_CONFIG_ID_KEY, id)
}

export async function getLegacyFilesR2ConfigId(env: Env): Promise<string | null> {
  return getSystemConfigValue(env.DB, SYSTEM_LEGACY_FILES_CONFIG_ID_KEY)
}

export async function setLegacyFilesR2ConfigId(env: Env, id: string | null): Promise<void> {
  if (!id) {
    await env.DB.prepare('DELETE FROM system_config WHERE key = ?')
      .bind(SYSTEM_LEGACY_FILES_CONFIG_ID_KEY)
      .run()
    return
  }
  await setSystemConfigValue(env.DB, SYSTEM_LEGACY_FILES_CONFIG_ID_KEY, id)
}

async function getLegacyDbConfig(db: D1Database, masterKey: string): Promise<R2Config | null> {
  const values = await getSystemConfigValues(db, [
    'r2_endpoint',
    'r2_bucket_name',
    'r2_access_key_id_enc',
    'r2_secret_access_key_enc',
  ])
  const endpoint = values.get('r2_endpoint')
  if (!endpoint) {
    return null
  }
  const bucketName = values.get('r2_bucket_name')
  const accessKeyEnc = values.get('r2_access_key_id_enc')
  const secretKeyEnc = values.get('r2_secret_access_key_enc')
  if (!bucketName || !accessKeyEnc || !secretKeyEnc) {
    return null
  }
  const accessKeyId = await decryptString(String(accessKeyEnc), masterKey)
  const secretAccessKey = await decryptString(String(secretKeyEnc), masterKey)
  return {
    endpoint: String(endpoint),
    accessKeyId,
    secretAccessKey,
    bucketName: String(bucketName),
  }
}

export async function getLegacyR2ConfigSummary(db: D1Database): Promise<R2ConfigSummary | null> {
  const values = await getSystemConfigValues(db, [
    'r2_endpoint',
    'r2_bucket_name',
    'r2_access_key_id_enc',
    'r2_secret_access_key_enc',
  ])
  const endpoint = values.get('r2_endpoint')
  const bucketName = values.get('r2_bucket_name')
  const accessKeyEnc = values.get('r2_access_key_id_enc')
  const secretKeyEnc = values.get('r2_secret_access_key_enc')
  if (!endpoint || !bucketName || !accessKeyEnc || !secretKeyEnc) {
    return null
  }

  return {
    id: LEGACY_R2_CONFIG_ID,
    name: '旧版配置',
    source: 'legacy',
    endpoint,
    bucketName,
    quotaBytes: DEFAULT_TOTAL_STORAGE,
  }
}

async function getDbConfigById(
  db: D1Database,
  masterKey: string,
  id: string
): Promise<R2Config | null> {
  const row = await db
    .prepare(
      'SELECT endpoint, bucket_name, access_key_id_enc, secret_access_key_enc FROM r2_configs WHERE id = ? LIMIT 1'
    )
    .bind(id)
    .first<{
      endpoint: string
      bucket_name: string
      access_key_id_enc: string
      secret_access_key_enc: string
    }>()
  if (!row) {
    return null
  }
  const accessKeyId = await decryptString(String(row.access_key_id_enc), masterKey)
  const secretAccessKey = await decryptString(String(row.secret_access_key_enc), masterKey)
  return {
    endpoint: String(row.endpoint),
    accessKeyId,
    secretAccessKey,
    bucketName: String(row.bucket_name),
  }
}

export async function listDbR2Configs(db: D1Database): Promise<R2ConfigSummary[]> {
  const rows = await db
    .prepare(
      'SELECT id, name, endpoint, bucket_name, quota_bytes, created_at, updated_at FROM r2_configs ORDER BY created_at DESC'
    )
    .all<{
      id: string
      name: string
      endpoint: string
      bucket_name: string
      quota_bytes: number
      created_at: string
      updated_at: string
    }>()
  return (rows.results || []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    source: 'db',
    endpoint: String(row.endpoint),
    bucketName: String(row.bucket_name),
    quotaBytes: Number(row.quota_bytes || DEFAULT_TOTAL_STORAGE),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }))
}

export async function loadR2ConfigById(env: Env, id: string): Promise<LoadedR2Config | null> {
  if (!env.R2_MASTER_KEY) {
    return null
  }

  if (id === LEGACY_R2_CONFIG_ID) {
    const legacy = await getLegacyDbConfig(env.DB, env.R2_MASTER_KEY)
    if (!legacy) return null
    return { id: LEGACY_R2_CONFIG_ID, source: 'legacy', config: legacy }
  }

  const dbConfig = await getDbConfigById(env.DB, env.R2_MASTER_KEY, id)
  if (!dbConfig) {
    return null
  }
  return { id, source: 'db', config: dbConfig }
}

export async function loadR2Config(env: Env): Promise<LoadedR2Config | null> {
  const configuredDefault = await getDefaultR2ConfigId(env)
  if (configuredDefault) {
    const loaded = await loadR2ConfigById(env, configuredDefault)
    if (loaded) return loaded
  }

  if (!env.R2_MASTER_KEY) {
    return null
  }

  const legacyFilesConfigId = await getSystemConfigValue(env.DB, SYSTEM_LEGACY_FILES_CONFIG_ID_KEY)
  if (legacyFilesConfigId) {
    const loaded = await loadR2ConfigById(env, legacyFilesConfigId)
    if (loaded) return loaded
  }

  const legacy = await loadR2ConfigById(env, LEGACY_R2_CONFIG_ID)
  if (legacy) return legacy

  const configs = await listDbR2Configs(env.DB)
  for (const config of configs) {
    const loaded = await loadR2ConfigById(env, config.id)
    if (loaded) return loaded
  }

  return null
}

export async function listR2ConfigSummaries(env: Env): Promise<{
  default_config_id: string | null
  legacy_files_config_id: string | null
  configs: R2ConfigSummary[]
}> {
  const [settings, legacyConfig, dbConfigs] = await Promise.all([
    getSystemConfigValues(env.DB, [
      SYSTEM_DEFAULT_R2_CONFIG_ID_KEY,
      SYSTEM_LEGACY_FILES_CONFIG_ID_KEY,
    ]),
    env.R2_MASTER_KEY ? getLegacyR2ConfigSummary(env.DB) : Promise.resolve(null),
    env.R2_MASTER_KEY ? listDbR2Configs(env.DB) : Promise.resolve([]),
  ])

  const configs = [...(legacyConfig ? [legacyConfig] : []), ...dbConfigs]
  const availableIds = new Set(configs.map((cfg) => cfg.id))

  let defaultId = settings.get(SYSTEM_DEFAULT_R2_CONFIG_ID_KEY) || null
  if (defaultId && !availableIds.has(defaultId)) {
    defaultId = null
  }

  let legacyFilesId = settings.get(SYSTEM_LEGACY_FILES_CONFIG_ID_KEY) || null
  if (legacyFilesId && !availableIds.has(legacyFilesId)) {
    legacyFilesId = null
  }

  if (!defaultId) {
    defaultId = legacyFilesId || configs[0]?.id || null
  }

  return {
    default_config_id: defaultId,
    legacy_files_config_id: legacyFilesId,
    configs,
  }
}

export async function listR2ConfigOptions(env: Env): Promise<{
  default_config_id: string | null
  legacy_files_config_id: string | null
  options: R2ConfigOption[]
}> {
  const result = await listR2ConfigSummaries(env)

  return {
    default_config_id: result.default_config_id,
    legacy_files_config_id: result.legacy_files_config_id,
    options: result.configs.map((cfg) => ({ id: cfg.id, name: cfg.name, source: cfg.source })),
  }
}
