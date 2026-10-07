import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import type { AuthUser } from '../middleware/authSession'
import { getUser, invalidJsonBodyResponse, jsonResponse, parseJson } from './utils'
import { hashPassword } from '../services/password'
import { createProvider } from '../services/storage/factory'
import { normalizeStoragePath } from '../services/storage/pathPolicy'
import { logAudit } from '../services/audit'
import { getClientIp } from '../middleware/rateLimit'
import {
  findFolderShareByCode,
  findFolderShareByScope,
  generateUniqueFolderShareCode,
  type FolderShareRow,
} from '../services/folderShares'

function toShareResponse(share: FolderShareRow): Record<string, unknown> {
  const { password_hash: _passwordHash, ...rest } = share
  return {
    ...rest,
    has_password: Boolean(share.password_hash),
    share_url: `/f/${share.share_code}`,
  }
}

function requireFolderShareOwnership(user: AuthUser, share: FolderShareRow): Response | null {
  if (user.role !== 'admin' && share.owner_id !== user.id) {
    return jsonResponse({ error: '无权限' }, 403)
  }
  return null
}

/** 规范化 folder 分享的 prefix：允许根目录（空值），统一尾斜杠形态（docs/） */
function normalizeSharePrefix(value: unknown): { prefix: string } | { response: Response } {
  const result = normalizeStoragePath(value, {
    allowEmpty: true,
    allowTrailingSlash: true,
    forceTrailingSlash: true,
  })
  if (!result.ok) {
    return { response: jsonResponse({ error: result.message }, 400) }
  }
  return { prefix: result.key }
}

/**
 * 创建文件夹分享
 *
 * @route POST /api/mount/folder-share
 * @param request - HTTP 请求对象（需要认证，owner/admin）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含创建后的分享信息
 *
 * @example
 * // 请求体
 * {
 *   "config_id": "r2-main",
 *   "prefix": "docs/",
 *   "password": "secret123",
 *   "expires_at": "2026-10-21T00:00:00.000Z",
 *   "max_views": 100
 * }
 *
 * // 成功响应 (200)
 * {
 *   "share": {
 *     "id": "uuid",
 *     "config_id": "r2-main",
 *     "prefix": "docs/",
 *     "owner_id": "uuid",
 *     "share_code": "abc123",
 *     "share_url": "/f/abc123",
 *     "has_password": true,
 *     "expires_in": 604800,
 *     "expires_at": "2026-10-21T00:00:00.000Z",
 *     "max_views": 100,
 *     "views": 0,
 *     "created_at": "2026-10-14T00:00:00.000Z",
 *     "updated_at": "2026-10-14T00:00:00.000Z"
 *   }
 * }
 *
 * // 缺少 config_id (400)
 * { "error": "缺少 config_id" }
 *
 * // prefix 无效 (400)
 * { "error": "路径不能包含 . 或 .." }
 *
 * // 存储配置不存在 (404)
 * { "error": "配置不存在或不可用" }
 *
 * // 同 scope 已存在分享 (409)
 * { "error": "该目录已存在分享" }
 *
 * // max_views / expires_at 无效 (400)
 * { "error": "max_views 无效" | "expires_at 无效" | "expires_at 需要晚于当前时间" }
 */
export async function createFolderShare(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) {
    return jsonResponse({ error: '未授权' }, 401)
  }

  let body: {
    config_id?: unknown
    prefix?: unknown
    password?: unknown
    expires_at?: unknown
    max_views?: unknown
  }
  try {
    body = await parseJson(request)
  } catch (error) {
    return invalidJsonBodyResponse(error)
  }

  const configId = String(body.config_id ?? '').trim()
  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  const prefixResult = normalizeSharePrefix(body.prefix)
  if ('response' in prefixResult) {
    return prefixResult.response
  }
  const prefix = prefixResult.prefix

  const maxViews = Number(body.max_views ?? 0)
  if (!Number.isFinite(maxViews) || maxViews < 0) {
    return jsonResponse({ error: 'max_views 无效' }, 400)
  }

  let expiresAt: string | null = null
  let expiresIn = 0
  const expiresAtRaw = body.expires_at
  if (expiresAtRaw !== null && expiresAtRaw !== undefined && String(expiresAtRaw).trim() !== '') {
    const date = new Date(String(expiresAtRaw))
    const time = date.getTime()
    if (Number.isNaN(time)) {
      return jsonResponse({ error: 'expires_at 无效' }, 400)
    }
    if (time <= Date.now()) {
      return jsonResponse({ error: 'expires_at 需要晚于当前时间' }, 400)
    }
    expiresAt = date.toISOString()
    expiresIn = Math.max(1, Math.ceil((time - Date.now()) / 1000))
  }

  const provider = await createProvider(env, configId)
  if (!provider) {
    return jsonResponse({ error: '配置不存在或不可用' }, 404)
  }

  const existing = await findFolderShareByScope(env.DB, configId, prefix)
  if (existing) {
    return jsonResponse({ error: '该目录已存在分享' }, 409)
  }

  const passwordString = typeof body.password === 'string' ? body.password.trim() : ''
  const passwordHash = passwordString ? hashPassword(passwordString) : null

  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const shareCode = await generateUniqueFolderShareCode(env.DB)
    if (!shareCode) {
      return jsonResponse({ error: '生成分享链接失败' }, 500)
    }

    const result = await withD1Retry(env.DB)
      .prepare(
        `INSERT INTO folder_shares (id, config_id, prefix, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .bind(
        id,
        configId,
        prefix,
        user.id,
        shareCode,
        passwordHash,
        expiresIn,
        expiresAt,
        Math.floor(maxViews),
        now,
        now
      )
      .run()

    if (!result.error) {
      await logAudit(env.DB, {
        actorUserId: user.id,
        action: 'FOLDER_SHARE_CREATE',
        targetType: 'folder_share',
        targetId: shareCode,
        ip: getClientIp(request),
        userAgent: request.headers.get('User-Agent') || undefined,
        metadata: {
          configId,
          prefix,
          hasPassword: Boolean(passwordHash),
          maxViews: Math.floor(maxViews),
          expiresAt,
        },
      })

      return jsonResponse({
        share: toShareResponse({
          id,
          config_id: configId,
          prefix,
          owner_id: user.id,
          share_code: shareCode,
          password_hash: passwordHash,
          expires_in: expiresIn,
          expires_at: expiresAt,
          max_views: Math.floor(maxViews),
          views: 0,
          created_at: now,
          updated_at: now,
        }),
      })
    }

    // 并发窗口内同 scope 被抢先创建：UNIQUE 冲突直接回 409
    const raced = await findFolderShareByScope(env.DB, configId, prefix)
    if (raced) {
      return jsonResponse({ error: '该目录已存在分享' }, 409)
    }
  }

  return jsonResponse({ error: '生成分享链接失败' }, 500)
}

/**
 * 查询文件夹分享（按 config + prefix scope）
 *
 * @route GET /api/mount/folder-share
 * @param request - HTTP 请求对象（需要认证，owner/admin）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含分享信息
 *
 * @example
 * // 查询参数
 * // config_id: 存储配置 ID（必需）
 * // prefix: 目录前缀（必需，空值表示根目录）
 *
 * // 成功响应（有分享）(200)
 * { "share": { "id": "uuid", "share_code": "abc123", "...": "..." } }
 *
 * // 成功响应（无分享）(200)
 * { "share": null }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function getFolderShare(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) {
    return jsonResponse({ error: '未授权' }, 401)
  }

  const url = new URL(request.url)
  const configId = String(url.searchParams.get('config_id') || '').trim()
  if (!configId) {
    return jsonResponse({ error: '缺少 config_id' }, 400)
  }

  const prefixResult = normalizeSharePrefix(url.searchParams.get('prefix'))
  if ('response' in prefixResult) {
    return prefixResult.response
  }

  const share = await findFolderShareByScope(env.DB, configId, prefixResult.prefix)
  if (!share) {
    return jsonResponse({ share: null })
  }

  const ownershipError = requireFolderShareOwnership(user, share)
  if (ownershipError) {
    return ownershipError
  }

  return jsonResponse({ share: toShareResponse(share) })
}

/**
 * 撤销文件夹分享
 *
 * @route DELETE /api/mount/folder-share
 * @param request - HTTP 请求对象（需要认证，owner/admin）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 请求体（二选一）
 * { "config_id": "r2-main", "prefix": "docs/" }
 * { "share_code": "abc123" }
 *
 * // 成功响应（已删除）(200)
 * { "success": true, "deleted": true }
 *
 * // 成功响应（分享不存在）(200)
 * { "success": true, "deleted": false }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function deleteFolderShare(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) {
    return jsonResponse({ error: '未授权' }, 401)
  }

  let body: { config_id?: unknown; prefix?: unknown; share_code?: unknown }
  try {
    body = await parseJson(request)
  } catch (error) {
    return invalidJsonBodyResponse(error)
  }

  const shareCode = String(body.share_code ?? '').trim()

  let share: FolderShareRow | null = null
  if (shareCode) {
    share = await findFolderShareByCode(env.DB, shareCode)
  } else {
    const configId = String(body.config_id ?? '').trim()
    if (!configId) {
      return jsonResponse({ error: '缺少 config_id' }, 400)
    }
    const prefixResult = normalizeSharePrefix(body.prefix)
    if ('response' in prefixResult) {
      return prefixResult.response
    }
    share = await findFolderShareByScope(env.DB, configId, prefixResult.prefix)
  }

  if (!share) {
    return jsonResponse({ success: true, deleted: false })
  }

  const ownershipError = requireFolderShareOwnership(user, share)
  if (ownershipError) {
    return ownershipError
  }

  const result = await withD1Retry(env.DB)
    .prepare('DELETE FROM folder_shares WHERE id = ?')
    .bind(share.id)
    .run()

  if (result.error) {
    return jsonResponse({ error: '撤销分享失败' }, 400)
  }

  await logAudit(env.DB, {
    actorUserId: user.id,
    action: 'FOLDER_SHARE_DELETE',
    targetType: 'folder_share',
    targetId: share.share_code,
    ip: getClientIp(request),
    userAgent: request.headers.get('User-Agent') || undefined,
    metadata: { configId: share.config_id, prefix: share.prefix },
  })

  return jsonResponse({ success: true, deleted: true })
}
