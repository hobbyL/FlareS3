import { withD1Retry } from '../utils/db'
import { escapeLike } from '../utils/escapeLike'
import type { Env } from '../config/env'
import { invalidJsonBodyResponse, jsonResponse, parseJson, getUser } from './utils'
import { logAudit } from '../services/audit'
import { getClientIp } from '../middleware/rateLimit'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'

const MAX_TITLE_LENGTH = 200
const MAX_CONTENT_LENGTH = 100_000

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clampString(value: string, maxLength: number): string {
  if (!value) return ''
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

/**
 * 获取文本列表
 *
 * @route GET /api/texts
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含文本列表和分页信息
 *
 * @example
 * // 查询参数
 * // page: 页码（默认 1）
 * // limit: 每页数量（默认 20，最大 100）
 * // q: 搜索关键词
 * // owner_id: 所有者 ID（仅管理员可用）
 *
 * // 成功响应 (200)
 * {
 *   "total": 50,
 *   "texts": [
 *     {
 *       "id": "uuid",
 *       "owner_id": "uuid",
 *       "owner_username": "admin",
 *       "title": "示例文本",
 *       "content_preview": "内容预览...",
 *       "content_length": 1000,
 *       "created_at": "2026-09-14T00:00:00.000Z",
 *       "updated_at": "2026-09-14T00:00:00.000Z"
 *     }
 *   ]
 * }
 */
export async function listTexts(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  const timings: RouteTimingEntry[] = []

  const url = new URL(request.url)
  const page = Math.max(1, Number(url.searchParams.get('page') || 1))
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)))
  const q = String(url.searchParams.get('q') || '').trim()
  const ownerId = String(url.searchParams.get('owner_id') || '').trim()
  const offset = (page - 1) * limit

  const conditions: string[] = ['t.deleted_at IS NULL']
  const params: unknown[] = []

  if (user.role !== 'admin') {
    conditions.push('t.owner_id = ?')
    params.push(user.id)
  } else if (ownerId) {
    conditions.push('t.owner_id = ?')
    params.push(ownerId)
  }

  if (q) {
    conditions.push("(t.title LIKE ? ESCAPE '\\' OR t.content LIKE ? ESCAPE '\\')")
    const like = `%${escapeLike(q)}%`
    params.push(like, like)
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [totalRow, rows] = await Promise.all([
    measureRouteStep(timings, 'dbCount', () =>
      withD1Retry(env.DB)
        .prepare(`SELECT COUNT(*) AS total FROM texts t ${whereClause}`)
        .bind(...params)
        .first('total')
    ),
    measureRouteStep(timings, 'dbRows', () =>
      withD1Retry(env.DB)
        .prepare(
          `SELECT t.id, t.owner_id, u.username AS owner_username, t.title,
                SUBSTR(t.content, 1, 200) AS content_preview,
                LENGTH(t.content) AS content_length,
                t.created_at, t.updated_at
         FROM texts t
         LEFT JOIN users u ON u.id = t.owner_id
         ${whereClause}
         ORDER BY t.updated_at DESC
         LIMIT ? OFFSET ?`
        )
        .bind(...params, limit, offset)
        .all()
    ),
  ])
  const total = Number(totalRow || 0)

  return withRouteTimingHeaders(
    jsonResponse({
      total,
      page,
      limit,
      texts: rows.results || [],
    }),
    timings
  )
}

/**
 * 获取单个文本详情
 *
 * @route GET /api/texts/:id
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param textId - 文本 ID
 * @returns JSON 响应，包含文本详情
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "text": {
 *     "id": "uuid",
 *     "owner_id": "uuid",
 *     "owner_username": "admin",
 *     "title": "示例文本",
 *     "content": "完整内容...",
 *     "created_at": "2026-09-14T00:00:00.000Z",
 *     "updated_at": "2026-09-14T00:00:00.000Z"
 *   }
 * }
 *
 * // 文本不存在 (404)
 * { "error": "文本不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function getText(request: Request, env: Env, textId: string): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  if (!textId) return jsonResponse({ error: 'id 不能为空' }, 400)

  const row = await withD1Retry(env.DB)
    .prepare(
      `SELECT t.id, t.owner_id, u.username AS owner_username, t.title, t.content, t.created_at, t.updated_at
     FROM texts t
     LEFT JOIN users u ON u.id = t.owner_id
     WHERE t.id = ? AND t.deleted_at IS NULL
     LIMIT 1`
    )
    .bind(textId)
    .first()

  if (!row) {
    return jsonResponse({ error: '文本不存在' }, 404)
  }

  if (user.role !== 'admin' && String((row as any).owner_id) !== user.id) {
    return jsonResponse({ error: '无权限' }, 403)
  }

  return jsonResponse({ text: row })
}

/**
 * 创建文本
 *
 * @route POST /api/texts
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含创建的文本 ID
 *
 * @example
 * // 请求体
 * {
 *   "title": "示例文本",
 *   "content": "文本内容..."
 * }
 *
 * // 成功响应 (200)
 * {
 *   "id": "uuid",
 *   "title": "示例文本"
 * }
 *
 * // 内容为空 (400)
 * { "error": "内容不能为空" }
 *
 * // 内容过长 (413)
 * { "error": "内容过长" }
 */
export async function createText(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  let body: { title?: unknown; content?: unknown }
  try {
    body = await parseJson(request)
  } catch (error) {
    return invalidJsonBodyResponse(error)
  }

  const title = clampString(normalizeString(body.title).trim(), MAX_TITLE_LENGTH)
  const content = normalizeString(body.content).trim()

  if (!content) {
    return jsonResponse({ error: '内容不能为空' }, 400)
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    return jsonResponse({ error: '内容过长' }, 413)
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  const result = await withD1Retry(env.DB)
    .prepare(
      `INSERT INTO texts (id, owner_id, title, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, user.id, title, content, now, now)
    .run()

  if (result.error) {
    return jsonResponse({ error: '保存文本失败' }, 400)
  }

  await logAudit(env.DB, {
    actorUserId: user.id,
    action: 'TEXT_CREATE',
    targetType: 'text',
    targetId: id,
    ip: getClientIp(request),
    userAgent: request.headers.get('User-Agent') || undefined,
    metadata: { length: content.length },
  })

  return jsonResponse({ success: true, id })
}

/**
 * 更新文本
 *
 * @route PATCH /api/texts/:id
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param textId - 文本 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 请求体
 * {
 *   "title": "更新后的标题",
 *   "content": "更新后的内容..."
 * }
 *
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 文本不存在 (404)
 * { "error": "文本不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function updateText(request: Request, env: Env, textId: string): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  if (!textId) return jsonResponse({ error: 'id 不能为空' }, 400)

  const existing = await withD1Retry(env.DB)
    .prepare('SELECT id, owner_id FROM texts WHERE id = ? AND deleted_at IS NULL LIMIT 1')
    .bind(textId)
    .first()

  if (!existing) {
    return jsonResponse({ error: '文本不存在' }, 404)
  }

  if (user.role !== 'admin' && String((existing as any).owner_id) !== user.id) {
    return jsonResponse({ error: '无权限' }, 403)
  }

  let body: { title?: unknown; content?: unknown }
  try {
    body = await parseJson(request)
  } catch (error) {
    return invalidJsonBodyResponse(error)
  }

  const updates: string[] = []
  const params: unknown[] = []

  if (body.title !== undefined) {
    const title = clampString(normalizeString(body.title).trim(), MAX_TITLE_LENGTH)
    updates.push('title = ?')
    params.push(title)
  }

  if (body.content !== undefined) {
    const content = normalizeString(body.content).trim()
    if (!content) {
      return jsonResponse({ error: '内容不能为空' }, 400)
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return jsonResponse({ error: '内容过长' }, 413)
    }
    updates.push('content = ?')
    params.push(content)
  }

  if (!updates.length) {
    return jsonResponse({ error: '无可更新字段' }, 400)
  }

  const now = new Date().toISOString()
  updates.push('updated_at = ?')
  params.push(now)
  params.push(textId)

  const result = await withD1Retry(env.DB)
    .prepare(`UPDATE texts SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run()

  if (result.error) {
    return jsonResponse({ error: '更新文本失败' }, 400)
  }

  await logAudit(env.DB, {
    actorUserId: user.id,
    action: 'TEXT_UPDATE',
    targetType: 'text',
    targetId: textId,
    ip: getClientIp(request),
    userAgent: request.headers.get('User-Agent') || undefined,
    metadata: {
      updated_title: body.title !== undefined,
      updated_content: body.content !== undefined,
    },
  })

  return jsonResponse({ success: true })
}

/**
 * 删除文本（软删除）
 *
 * @route DELETE /api/texts/:id
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param textId - 文本 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 文本不存在 (404)
 * { "error": "文本不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function deleteText(request: Request, env: Env, textId: string): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  if (!textId) return jsonResponse({ error: 'id 不能为空' }, 400)

  const existing = await withD1Retry(env.DB)
    .prepare('SELECT id, owner_id FROM texts WHERE id = ? AND deleted_at IS NULL LIMIT 1')
    .bind(textId)
    .first()

  if (!existing) {
    return jsonResponse({ error: '文本不存在' }, 404)
  }

  if (user.role !== 'admin' && String((existing as any).owner_id) !== user.id) {
    return jsonResponse({ error: '无权限' }, 403)
  }

  const now = new Date().toISOString()
  const result = await withD1Retry(env.DB)
    .prepare('UPDATE texts SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .bind(now, now, textId)
    .run()

  if (result.error) {
    return jsonResponse({ error: '删除文本失败' }, 400)
  }

  await logAudit(env.DB, {
    actorUserId: user.id,
    action: 'TEXT_DELETE',
    targetType: 'text',
    targetId: textId,
    ip: getClientIp(request),
    userAgent: request.headers.get('User-Agent') || undefined,
  })

  return jsonResponse({ success: true })
}
