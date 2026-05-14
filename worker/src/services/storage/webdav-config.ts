/**
 * WebDAV 配置 CRUD — 管理 webdav_configs 表。
 *
 * 模式与 r2.ts 一致：加密存储 username/password，列表返回不含密钥。
 */

import type { Env } from '../../config/env'
import { DEFAULT_TOTAL_STORAGE } from '../../config/env'
import { encryptString, decryptString } from '../crypto'

// ── 类型 ──

export type WebDAVConfigType = 'webdav' | 'koofr'

export type WebDAVConfigInput = {
  name: string
  type: WebDAVConfigType
  endpoint: string
  mount_id?: string
  remote_path?: string
  username: string
  password: string
  quota_bytes: number
}

export type WebDAVConfigSummary = {
  id: string
  name: string
  type: WebDAVConfigType
  endpoint: string
  mount_id: string | null
  remote_path: string
  username: string
  password: string
  quotaBytes: number
  createdAt: string
  updatedAt: string
}

export type LoadedWebDAVConfig = {
  id: string
  type: WebDAVConfigType
  config: {
    endpoint: string
    username: string
    password: string
    mountId?: string
    remotePath: string
  }
}

// ── 读取 ──

export async function listWebDAVConfigs(db: D1Database, masterKey?: string): Promise<WebDAVConfigSummary[]> {
  const rows = await db
    .prepare(
      'SELECT id, name, type, endpoint, mount_id, remote_path, quota_bytes, username_enc, password_enc, created_at, updated_at FROM webdav_configs ORDER BY created_at DESC'
    )
    .all<{
      id: string
      name: string
      type: string
      endpoint: string
      mount_id: string | null
      remote_path: string | null
      quota_bytes: number
      username_enc: string
      password_enc: string
      created_at: string
      updated_at: string
    }>()

  const results: WebDAVConfigSummary[] = []
  for (const row of rows.results || []) {
    let username = ''
    let password = ''
    if (masterKey && row.username_enc) {
      try {
        username = await decryptString(String(row.username_enc), masterKey)
        password = row.password_enc ? await decryptString(String(row.password_enc), masterKey) : ''
      } catch {
        username = ''
        password = ''
      }
    }
    results.push({
      id: String(row.id),
      name: String(row.name),
      type: (String(row.type) === 'koofr' ? 'koofr' : 'webdav') as WebDAVConfigType,
      endpoint: String(row.endpoint),
      mount_id: row.mount_id ? String(row.mount_id) : null,
      remote_path: row.remote_path || '/',
      username,
      password,
      quotaBytes: Number(row.quota_bytes || DEFAULT_TOTAL_STORAGE),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })
  }
  return results
}

export async function loadWebDAVConfigById(env: Env, id: string): Promise<LoadedWebDAVConfig | null> {
  const masterKey = String(env.R2_MASTER_KEY || '').trim()
  if (!masterKey) return null

  const row = await env.DB
    .prepare(
      'SELECT id, type, endpoint, mount_id, remote_path, username_enc, password_enc FROM webdav_configs WHERE id = ? LIMIT 1'
    )
    .bind(id)
    .first<{
      id: string
      type: string
      endpoint: string
      mount_id: string | null
      remote_path: string | null
      username_enc: string
      password_enc: string
    }>()

  if (!row) return null

  try {
    const username = await decryptString(String(row.username_enc), masterKey)
    const password = await decryptString(String(row.password_enc), masterKey)

    const configType = String(row.type) === 'koofr' ? 'koofr' : 'webdav'

    return {
      id: String(row.id),
      type: configType as WebDAVConfigType,
      config: {
        endpoint: String(row.endpoint),
        username,
        password,
        remotePath: row.remote_path || '/',
        ...(row.mount_id ? { mountId: String(row.mount_id) } : {}),
      },
    }
  } catch {
    return null
  }
}

// ── 创建 ──

export async function createWebDAVConfig(env: Env, body: WebDAVConfigInput): Promise<{ id: string }> {
  const masterKey = String(env.R2_MASTER_KEY || '').trim()
  if (!masterKey) throw new StorageConfigError('缺少 R2_MASTER_KEY')

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const usernameEnc = await encryptString(body.username, masterKey)
  const passwordEnc = await encryptString(body.password, masterKey)
  const remotePath = body.remote_path || '/'

  const result = await env.DB.prepare(
    `INSERT INTO webdav_configs (id, name, type, endpoint, mount_id, remote_path, username_enc, password_enc, quota_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.name,
      body.type,
      body.endpoint,
      body.type === 'koofr' && body.mount_id ? body.mount_id : null,
      remotePath,
      usernameEnc,
      passwordEnc,
      body.quota_bytes,
      now,
      now
    )
    .run()

  if (result.error) {
    throw new StorageConfigError('创建 WebDAV 配置失败')
  }

  return { id }
}

// ── 更新 ──

export async function updateWebDAVConfig(
  env: Env,
  id: string,
  body: Partial<WebDAVConfigInput>
): Promise<void> {
  const masterKey = String(env.R2_MASTER_KEY || '').trim()
  if (!masterKey) throw new StorageConfigError('缺少 R2_MASTER_KEY')

  const existing = await env.DB.prepare(
    'SELECT id, name, type, endpoint, mount_id, remote_path, quota_bytes, username_enc, password_enc FROM webdav_configs WHERE id = ? LIMIT 1'
  )
    .bind(id)
    .first<{
      id: string
      name: string
      type: string
      endpoint: string
      mount_id: string | null
      remote_path: string | null
      quota_bytes: number
      username_enc: string
      password_enc: string
    }>()

  if (!existing) {
    throw new StorageConfigError('配置不存在')
  }

  const nextName = body.name ?? String(existing.name)
  const nextType = body.type ?? String(existing.type)
  const nextEndpoint = body.endpoint ?? String(existing.endpoint)

  let nextQuotaBytes = Number(existing.quota_bytes)
  if (body.quota_bytes !== undefined) {
    nextQuotaBytes = Number(body.quota_bytes)
  }
  if (!Number.isFinite(nextQuotaBytes) || nextQuotaBytes <= 0) {
    throw new StorageConfigError('quota_bytes 必须为大于 0 的数字')
  }

  const nextMountId = nextType === 'koofr'
    ? (body.mount_id !== undefined ? (body.mount_id || null) : (existing.mount_id || null))
    : null

  const nextRemotePath = body.remote_path !== undefined
    ? (body.remote_path || '/')
    : (existing.remote_path || '/')

  let usernameEnc = String(existing.username_enc)
  let passwordEnc = String(existing.password_enc)

  if (typeof body.username === 'string' && body.username) {
    usernameEnc = await encryptString(body.username, masterKey)
  }

  if (typeof body.password === 'string' && body.password) {
    passwordEnc = await encryptString(body.password, masterKey)
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE webdav_configs
     SET name = ?, type = ?, endpoint = ?, mount_id = ?, remote_path = ?, quota_bytes = ?, username_enc = ?, password_enc = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(nextName, nextType, nextEndpoint, nextMountId, nextRemotePath, nextQuotaBytes, usernameEnc, passwordEnc, now, id)
    .run()
}

// ── 删除 ──

export async function deleteWebDAVConfig(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM webdav_configs WHERE id = ?').bind(id).run()
}

// ── 错误类型 ──

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageConfigError'
  }
}
