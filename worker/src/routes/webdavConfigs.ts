/**
 * WebDAV/Koofr 配置 CRUD 路由。
 *
 * 模式与 r2Configs.ts 保持一致。
 */

import type { Env } from '../config/env'
import { jsonResponse, parseJson, getUser, requestBodyPolicyErrorResponse } from './utils'
import { encryptString, validateBase64KeyLength } from '../services/crypto'
import { validateExternalEndpoint } from '../services/endpointPolicy'
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

function validateStorageEndpoint(type: WebDAVConfigType, endpoint: unknown): string | Response {
  const endpointCheck = validateExternalEndpoint(endpoint)
  if (!endpointCheck.ok) {
    return jsonResponse({ error: endpointCheck.message }, 400)
  }
  if (type === 'koofr') {
    const host = new URL(endpointCheck.url).hostname.toLowerCase()
    if (host !== 'app.koofr.net') {
      return jsonResponse({ error: 'Koofr endpoint 只允许 app.koofr.net' }, 400)
    }
  }
  return endpointCheck.url
}

/**
 * 获取所有 WebDAV/Koofr 配置
 *
 * @route GET /api/webdav/configs
 * @param _request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含所有 WebDAV/Koofr 配置列表
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "configs": [
 *     {
 *       "id": "uuid",
 *       "name": "WebDAV 配置",
 *       "type": "webdav",
 *       "endpoint": "https://webdav.example.com",
 *       "remote_path": "/files",
 *       "quotaBytes": 10737418240,
 *       "quotaBytesFormatted": "10.00 GB",
 *       "createdAt": "2026-09-14T00:00:00.000Z",
 *       "updatedAt": "2026-09-14T00:00:00.000Z"
 *     }
 *   ]
 * }
 */
export async function listConfigs(_request: Request, env: Env): Promise<Response> {
  const configs = await listWebDAVConfigs(env.DB)

  const result = configs.map((cfg) => ({
    id: cfg.id,
    name: cfg.name,
    type: cfg.type,
    endpoint: cfg.endpoint,
    remote_path: cfg.remote_path,
    quotaBytes: cfg.quotaBytes,
    quotaBytesFormatted: formatBytes(cfg.quotaBytes),
    createdAt: cfg.createdAt,
    updatedAt: cfg.updatedAt,
  }))

  return jsonResponse({ configs: result })
}

/**
 * 创建 WebDAV/Koofr 配置
 *
 * @route POST /api/webdav/configs
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含创建的配置 ID
 *
 * @example
 * // 请求体（WebDAV）
 * {
 *   "name": "WebDAV 配置",
 *   "type": "webdav",
 *   "endpoint": "https://webdav.example.com",
 *   "remote_path": "/files",
 *   "username": "user",
 *   "password": "pass",
 *   "quota_bytes": 10737418240
 * }
 *
 * // 请求体（Koofr）
 * {
 *   "name": "Koofr 配置",
 *   "type": "koofr",
 *   "endpoint": "https://app.koofr.net",
 *   "mount_id": "mount123",
 *   "remote_path": "/files",
 *   "username": "user",
 *   "password": "pass",
 *   "quota_bytes": 10737418240
 * }
 *
 * // 成功响应 (200)
 * {
 *   "success": true,
 *   "id": "uuid"
 * }
 *
 * // 字段缺失 (400)
 * { "error": "名称、endpoint、用户名和密码为必填项" }
 *
 * // 类型无效 (400)
 * { "error": "type 必须为 webdav 或 koofr" }
 *
 * // 配额无效 (400)
 * { "error": "quota_bytes 必须为大于 0 的数字" }
 */
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
    const endpoint = validateStorageEndpoint(body.type, body.endpoint)
    if (endpoint instanceof Response) return endpoint

    // mount_id 自动检测，无需校验

    const quotaBytes = Number(body.quota_bytes)
    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
      return jsonResponse({ error: 'quota_bytes 必须为大于 0 的数字' }, 400)
    }

    const { id } = await createWebDAVConfig(env, {
      name: body.name,
      type: body.type,
      endpoint,
      mount_id: body.mount_id,
      remote_path: body.remote_path,
      username: body.username,
      password: body.password,
      quota_bytes: quotaBytes,
    })

    return jsonResponse({ success: true, id })
  } catch (error) {
    const bodyError = requestBodyPolicyErrorResponse(error)
    if (bodyError) return bodyError
    if (error instanceof StorageConfigError) {
      return jsonResponse({ error: error.message }, 400)
    }
    return jsonResponse({ error: '创建配置失败' }, 500)
  }
}

/**
 * 更新 WebDAV/Koofr 配置
 *
 * @route PATCH /api/webdav/configs/:id
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param id - 配置 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 请求体（所有字段均为可选）
 * {
 *   "name": "更新后的名称",
 *   "type": "webdav",
 *   "endpoint": "https://webdav.example.com",
 *   "remote_path": "/new-path",
 *   "username": "newuser",
 *   "password": "newpass",
 *   "quota_bytes": 21474836480
 * }
 *
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 配置不存在 (404)
 * { "error": "配置不存在" }
 *
 * // 无更新字段 (400)
 * { "error": "无有效更新字段" }
 *
 * // 类型无效 (400)
 * { "error": "type 必须为 webdav 或 koofr" }
 */
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

    if (body.endpoint || body.type) {
      const existing = await loadWebDAVConfigById(env, id)
      const nextType = body.type || existing?.type || 'webdav'
      const nextEndpoint = body.endpoint || existing?.config.endpoint || ''
      const endpoint = validateStorageEndpoint(nextType, nextEndpoint)
      if (endpoint instanceof Response) return endpoint
      body.endpoint = endpoint
    }

    await updateWebDAVConfig(env, id, body)
    return jsonResponse({ success: true })
  } catch (error) {
    const bodyError = requestBodyPolicyErrorResponse(error)
    if (bodyError) return bodyError
    if (error instanceof StorageConfigError) {
      if (error.message === '配置不存在') {
        return jsonResponse({ error: error.message }, 404)
      }
      return jsonResponse({ error: error.message }, 400)
    }
    return jsonResponse({ error: '更新配置失败' }, 500)
  }
}

/**
 * 删除 WebDAV/Koofr 配置
 *
 * @route DELETE /api/webdav/configs/:id
 * @param _request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param id - 配置 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 配置 ID 为空 (400)
 * { "error": "配置 ID 不能为空" }
 *
 * // 配置不存在 (404)
 * { "error": "配置不存在" }
 *
 * // 配置有关联文件 (409)
 * { "error": "该配置仍有关联文件或上传预约，无法删除" }
 */
export async function deleteConfig(_request: Request, env: Env, id: string): Promise<Response> {
  if (!id) return jsonResponse({ error: '配置 ID 不能为空' }, 400)

  try {
    const loaded = await loadWebDAVConfigById(env, id)
    if (!loaded) {
      return jsonResponse({ error: '配置不存在' }, 404)
    }

    const fileCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM files WHERE config_id = ?'
    )
      .bind(id)
      .first('count')
    const reservationCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM upload_reservations WHERE r2_config_id = ? AND status = 'active'"
    )
      .bind(id)
      .first('count')
    const queueCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM delete_queue dq
         INNER JOIN files f ON f.id = dq.file_id
        WHERE f.config_id = ? AND dq.processed_at IS NULL`
    )
      .bind(id)
      .first('count')

    if (
      Number(fileCount || 0) > 0 ||
      Number(reservationCount || 0) > 0 ||
      Number(queueCount || 0) > 0
    ) {
      return jsonResponse({ error: '该配置仍有关联文件或上传预约，无法删除' }, 409)
    }

    await deleteWebDAVConfig(env.DB, id)
    return jsonResponse({ success: true })
  } catch (error) {
    return jsonResponse({ error: '删除配置失败' }, 500)
  }
}

/**
 * 测试 WebDAV/Koofr 配置连接
 *
 * @route POST /api/webdav/configs/:id/test
 * @param _request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param id - 配置 ID
 * @returns JSON 响应，包含测试结果
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "success": true,
 *   "message": "连接测试成功"
 * }
 *
 * // 缺少 id (400)
 * {
 *   "success": false,
 *   "message": "缺少 id"
 * }
 *
 * // 配置不存在 (404)
 * {
 *   "success": false,
 *   "message": "配置不存在或不可用"
 * }
 *
 * // 连接失败 (400)
 * {
 *   "success": false,
 *   "message": "连接测试失败（UNAUTHORIZED / HTTP 401 / Authentication failed）"
 * }
 */
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
