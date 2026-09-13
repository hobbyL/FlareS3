import type { Env } from '../config/env'
import { jsonResponse, parseJson, getUser, requestBodyPolicyErrorResponse } from './utils'
import { encryptString, validateBase64KeyLength } from '../services/crypto'
import { createS3Client, summarizeS3Error, testConnection, type R2Config } from '../services/r2'
import { logAudit } from '../services/audit'
import { getClientIp } from '../middleware/rateLimit'
import { validateExternalEndpoint } from '../services/endpointPolicy'

/**
 * 获取 R2 配置状态
 *
 * @route GET /api/setup/status
 * @param _request - HTTP 请求对象
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含配置状态
 *
 * @example
 * // 已配置响应 (200)
 * {
 *   "configured": true,
 *   "config_source": "db",
 *   "config": {
 *     "endpoint": "https://xxx.r2.cloudflarestorage.com",
 *     "bucket_name": "my-bucket"
 *   }
 * }
 *
 * // 未配置响应 (200)
 * {
 *   "configured": false
 * }
 */
export async function status(_request: Request, env: Env): Promise<Response> {
  const endpoint = await env.DB.prepare('SELECT value FROM system_config WHERE key = ?')
    .bind('r2_endpoint')
    .first('value')
  const bucketName = await env.DB.prepare('SELECT value FROM system_config WHERE key = ?')
    .bind('r2_bucket_name')
    .first('value')
  if (!endpoint || !bucketName) {
    return jsonResponse({ configured: false })
  }
  return jsonResponse({
    configured: true,
    config_source: 'db',
    config: {
      endpoint,
      bucket_name: bucketName,
    },
  })
}

/**
 * 保存 R2 配置
 *
 * @route POST /api/setup/config
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 请求体
 * {
 *   "endpoint": "https://xxx.r2.cloudflarestorage.com",
 *   "access_key_id": "xxxx",
 *   "secret_access_key": "xxxx",
 *   "bucket_name": "my-bucket"
 * }
 *
 * // 成功响应 (200)
 * {
 *   "success": true
 * }
 *
 * // 缺少字段 (400)
 * { "error": "所有字段都是必填的" }
 *
 * // 缺少 R2_MASTER_KEY (500)
 * { "error": "缺少 R2_MASTER_KEY" }
 *
 * // R2_MASTER_KEY 无效 (500)
 * { "error": "R2_MASTER_KEY 无效：不是合法的 base64 字符串" }
 * { "error": "R2_MASTER_KEY 无效：需要 32 字节 base64（当前解码为 16 字节）" }
 */
export async function saveConfig(request: Request, env: Env): Promise<Response> {
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
    const body = await parseJson<{
      endpoint: string
      access_key_id: string
      secret_access_key: string
      bucket_name: string
    }>(request)
    if (!body.endpoint || !body.access_key_id || !body.secret_access_key || !body.bucket_name) {
      return jsonResponse({ error: '所有字段都是必填的' }, 400)
    }
    const endpointCheck = validateExternalEndpoint(body.endpoint)
    if (!endpointCheck.ok) {
      return jsonResponse({ error: endpointCheck.message }, 400)
    }
    const now = new Date().toISOString()
    const accessEnc = await encryptString(body.access_key_id, masterKey)
    const secretEnc = await encryptString(body.secret_access_key, masterKey)
    const statements = [
      ['r2_endpoint', endpointCheck.url],
      ['r2_bucket_name', body.bucket_name],
      ['r2_access_key_id_enc', accessEnc],
      ['r2_secret_access_key_enc', secretEnc],
    ]
    for (const [key, value] of statements) {
      await env.DB.prepare(
        `INSERT INTO system_config (key, value, updated_at)
         VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`
      )
        .bind(key, value, now, value, now)
        .run()
    }
    const actor = getUser(request)
    await logAudit(env.DB, {
      actorUserId: actor?.id,
      action: 'R2_CONFIG_UPDATE',
      targetType: 'system_config',
      targetId: 'r2_config',
      ip: getClientIp(request),
      userAgent: request.headers.get('User-Agent') || undefined,
    })

    return jsonResponse({ success: true })
  } catch (error) {
    const bodyError = requestBodyPolicyErrorResponse(error)
    if (bodyError) return bodyError
    return jsonResponse({ error: '保存配置失败' }, 500)
  }
}

/**
 * 测试 R2 连接配置
 *
 * @route POST /api/setup/test
 * @param request - HTTP 请求对象
 * @returns JSON 响应，包含测试结果
 *
 * @example
 * // 请求体
 * {
 *   "endpoint": "https://xxx.r2.cloudflarestorage.com",
 *   "access_key_id": "xxxx",
 *   "secret_access_key": "xxxx",
 *   "bucket_name": "my-bucket"
 * }
 *
 * // 成功响应 (200)
 * {
 *   "success": true,
 *   "message": "连接测试成功"
 * }
 *
 * // 失败响应 (400)
 * {
 *   "success": false,
 *   "message": "连接测试失败（AccessDenied / HTTP 403 / Access Denied）；请确认 R2 API Token 已启用 Object Read/Write 且已授权该 Bucket"
 * }
 *
 * // 缺少字段 (400)
 * { "error": "所有字段都是必填的" }
 */
export async function testConfig(request: Request): Promise<Response> {
  try {
    const body = await parseJson<{
      endpoint: string
      access_key_id: string
      secret_access_key: string
      bucket_name: string
    }>(request)
    if (!body.endpoint || !body.access_key_id || !body.secret_access_key || !body.bucket_name) {
      return jsonResponse({ error: '所有字段都是必填的' }, 400)
    }
    const endpointCheck = validateExternalEndpoint(body.endpoint)
    if (!endpointCheck.ok) {
      return jsonResponse({ success: false, message: endpointCheck.message }, 400)
    }
    const config: R2Config = {
      endpoint: endpointCheck.url,
      accessKeyId: body.access_key_id,
      secretAccessKey: body.secret_access_key,
      bucketName: body.bucket_name,
    }
    createS3Client(config)
    await testConnection(config)
    return jsonResponse({ success: true, message: '连接测试成功' })
  } catch (error) {
    const bodyError = requestBodyPolicyErrorResponse(error)
    if (bodyError) return bodyError
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
