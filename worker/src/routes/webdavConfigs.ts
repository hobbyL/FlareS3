/**
 * WebDAV/Koofr 配置 CRUD 路由。
 *
 * 模式与 r2Configs.ts 保持一致。
 */

import type { Env } from '../config/env'
import { jsonResponse, parseJson, getUser } from './utils'
import { encryptString, validateBase64KeyLength } from '../services/crypto'
import { formatBytes } from '../utils/format'
import {
  listWebDAVConfigs,
  loadWebDAVConfigById,
  createWebDAVConfig,
  updateWebDAVConfig,
  deleteWebDAVConfig,
  StorageConfigError,
  type WebDAVConfigInput,
  type WebDAVConfigType,
} from '../services/storage/webdav-config'
import { WebDAVProvider } from '../services/storage/webdav-provider'
import { KoofrProvider } from '../services/storage/koofr-provider'
import { StorageError } from '../services/storage/types'

const VALID_TYPES: WebDAVConfigType[] = ['webdav', 'koofr']

type WebDAVConfigInputBody = {
  name: string
  type: WebDAVConfigType
  endpoint: string
  mount_id?: string
  remote_path?: string
  username: string
  password: string
  quota_bytes: number
}

export async function listConfigs(_request: Request, env: Env): Promise<Response> {
  const masterKey = String(env.R2_MASTER_KEY || '').trim()
  const configs = await listWebDAVConfigs(env.DB, masterKey)

  const result = configs.map((cfg) => ({
    id: cfg.id,
    name: cfg.name,
    type: cfg.type,
    endpoint: cfg.endpoint,
    remote_path: cfg.remote_path,
    username: cfg.username,
    password: cfg.password,
    quotaBytes: cfg.quotaBytes,
    quotaBytesFormatted: formatBytes(cfg.quotaBytes),
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt,
  }))

  return jsonResponse({ configs: result })
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
    const body = await parseJson<WebDAVConfigInputBody>(request)

    if (!body.name || !body.endpoint || !body.username || !body.password) {
      return jsonResponse({ error: '名称、endpoint、用户名和密码为必填项' }, 400)
    }

    if (!VALID_TYPES.includes(body.type)) {
      return jsonResponse({ error: 'type 必须为 webdav 或 koofr' }, 400)
    }

    // mount_id 自动检测，无需校验

    const quotaBytes = Number(body.quota_bytes)
    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
      return jsonResponse({ error: 'quota_bytes 必须为大于 0 的数字' }, 400)
    }

    const { id } = await createWebDAVConfig(env, {
      name: body.name,
      type: body.type,
      endpoint: body.endpoint,
      mount_id: body.mount_id,
      remote_path: body.remote_path,
      username: body.username,
      password: body.password,
      quota_bytes: quotaBytes,
    })

    return jsonResponse({ success: true, id })
  } catch (error) {
    if (error instanceof StorageConfigError) {
      return jsonResponse({ error: error.message }, 400)
    }
    return jsonResponse({ error: '创建配置失败' }, 500)
  }
}

export async function updateConfig(request: Request, env: Env, id: string): Promise<Response> {
  if (!id) return jsonResponse({ error: '配置 ID 不能为空' }, 400)

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
    const body = await parseJson<Partial<WebDAVConfigInputBody>>(request)
    if (!body || Object.keys(body).length === 0) {
      return jsonResponse({ error: '无有效更新字段' }, 400)
    }

    if (body.type && !VALID_TYPES.includes(body.type)) {
      return jsonResponse({ error: 'type 必须为 webdav 或 koofr' }, 400)
    }

    if (body.type === 'koofr' && !body.mount_id) {
      // mount_id 自动检测，无需强制
    }

    if (body.quota_bytes !== undefined) {
      const quotaBytes = Number(body.quota_bytes)
      if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
        return jsonResponse({ error: 'quota_bytes 必须为大于 0 的数字' }, 400)
      }
    }

    await updateWebDAVConfig(env, id, body)
    return jsonResponse({ success: true })
  } catch (error) {
    if (error instanceof StorageConfigError) {
      if (error.message === '配置不存在') {
        return jsonResponse({ error: error.message }, 404)
      }
      return jsonResponse({ error: error.message }, 400)
    }
    return jsonResponse({ error: '更新配置失败' }, 500)
  }
}

export async function deleteConfig(_request: Request, env: Env, id: string): Promise<Response> {
  if (!id) return jsonResponse({ error: '配置 ID 不能为空' }, 400)

  try {
    const loaded = await loadWebDAVConfigById(env, id)
    if (!loaded) {
      return jsonResponse({ error: '配置不存在' }, 404)
    }

    await deleteWebDAVConfig(env.DB, id)
    return jsonResponse({ success: true })
  } catch (error) {
    return jsonResponse({ error: '删除配置失败' }, 500)
  }
}

export async function testById(_request: Request, env: Env, id: string): Promise<Response> {
  if (!id) return jsonResponse({ success: false, message: '缺少 id' }, 400)

  try {
    const loaded = await loadWebDAVConfigById(env, id)
    if (!loaded) {
      return jsonResponse({ success: false, message: '配置不存在或不可用' }, 404)
    }

    let provider
    if (loaded.type === 'koofr') {
      provider = new KoofrProvider({
        endpoint: loaded.config.endpoint,
        username: loaded.config.username,
        password: loaded.config.password,
        mountId: loaded.config.mountId,
        remotePath: loaded.config.remotePath,
      })
    } else {
      provider = new WebDAVProvider({
        endpoint: loaded.config.endpoint,
        username: loaded.config.username,
        password: loaded.config.password,
        remotePath: loaded.config.remotePath,
      })
    }

    await provider.testConnection()
    return jsonResponse({ success: true, message: '连接测试成功' })
  } catch (error) {
    let message = '连接测试失败'
    if (error instanceof StorageError) {
      const parts = [
        error.code,
        typeof error.httpStatusCode === 'number' ? `HTTP ${error.httpStatusCode}` : null,
        error.message,
      ].filter(Boolean)
      message = parts.length ? `连接测试失败（${parts.join(' / ')}）` : message
    } else if (error instanceof Error) {
      message = `连接测试失败（${error.message}）`
    }

    return jsonResponse({ success: false, message }, 400)
  }
}
