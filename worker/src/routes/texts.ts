import { withD1Retry } from '../utils/db'
import { escapeLike } from '../utils/escapeLike'
import type { Env } from '../config/env'
import { invalidJsonBodyResponse, jsonResponse, parseJson, getUser } from './utils'
import { logAudit, prepareAuditLogInsert } from '../services/audit'
import { getClientIp } from '../middleware/rateLimit'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'
import { normalizePageParam, normalizeLimitParam } from '../utils/pagination'

const MAX_TITLE_LENGTH = 200
const MAX_CONTENT_LENGTH = 100_000

/** 回收站清空 / Cron 清理的单轮批量上限（防长事务；剩余行下一轮继续） */
const TEXTS_TRASH_DELETE_BATCH_SIZE = 100
/** 单次 cron 运行的清空轮数上限（100 × 20 = 2000 行），防超时 */
const TEXTS_TRASH_DELETE_MAX_ROUNDS = 20

// 无原型字典：`?sort_by=constructor` 等原型链属性不得命中白名单（真值检查陷阱）
const TRASH_SORT_FIELDS: Record<string, string> = Object.assign(Object.create(null), {
  deleted_at: 't.deleted_at',
  updated_at: 't.updated_at',
  title: 't.title',
})

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
  const page = normalizePageParam(url.searchParams.get('page'))
  const limit = normalizeLimitParam(url.searchParams.get('limit'))
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

// ── 文本回收站 ──

/**
 * 加载回收站文本并做权限校验（恢复 / 永久删除共用守卫）。
 *
 * 返回 Response 表示守卫失败直接返回；否则返回用户与文本行。
 */
type LoadTrashTextResult =
  | { response: Response }
  | { user: NonNullable<ReturnType<typeof getUser>>; text: { id: string; owner_id: string } }

async function loadTrashText(
  request: Request,
  env: Env,
  textId: string
): Promise<LoadTrashTextResult> {
  const user = getUser(request)
  if (!user) return { response: jsonResponse({ error: '未授权' }, 401) }
  if (!textId) return { response: jsonResponse({ error: 'id 不能为空' }, 400) }

  const existing = await withD1Retry(env.DB)
    .prepare('SELECT id, owner_id FROM texts WHERE id = ? AND deleted_at IS NOT NULL LIMIT 1')
    .bind(textId)
    .first<{ id: string; owner_id: string }>()

  if (!existing) {
    return { response: jsonResponse({ error: '文本不存在' }, 404) }
  }
  if (user.role !== 'admin' && String(existing.owner_id) !== user.id) {
    return { response: jsonResponse({ error: '无权限' }, 403) }
  }

  return { user, text: { id: String(existing.id), owner_id: String(existing.owner_id) } }
}

/** 物理删除文本及其分享行（text_shares / text_one_time_shares / texts + audit 同 batch）。 */
async function permanentlyDeleteTextRows(
  env: Env,
  user: { id: string },
  request: Request,
  textId: string,
  nowIso: string
): Promise<void> {
  await withD1Retry(env.DB).batch([
    withD1Retry(env.DB).prepare('DELETE FROM text_shares WHERE text_id = ?').bind(textId),
    withD1Retry(env.DB).prepare('DELETE FROM text_one_time_shares WHERE text_id = ?').bind(textId),
    withD1Retry(env.DB).prepare('DELETE FROM texts WHERE id = ?').bind(textId),
    prepareAuditLogInsert(env.DB, {
      actorUserId: user.id,
      action: 'TEXT_DELETE_PERMANENT',
      targetType: 'text',
      targetId: textId,
      ip: getClientIp(request),
      userAgent: request.headers.get('User-Agent') || undefined,
    }),
  ])
}

/**
 * 获取回收站文本列表
 *
 * @route GET /api/texts/trash
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含回收站文本列表和分页信息
 *
 * @example
 * // 查询参数
 * // page: 页码（默认 1）
 * // limit: 每页数量（默认 20，最大 100）
 * // q: 标题模糊搜索
 * // owner_id: 所有者 ID 过滤（仅管理员可用）
 * // deleted_from: 删除时间起始
 * // deleted_to: 删除时间结束
 * // sort_by: 排序字段（deleted_at | updated_at | title）
 * // sort_order: 排序方向（asc | desc）
 *
 * // 成功响应 (200)
 * {
 *   "total": 5,
 *   "page": 1,
 *   "limit": 20,
 *   "texts": [
 *     {
 *       "id": "uuid",
 *       "owner_id": "uuid",
 *       "owner_username": "admin",
 *       "title": "已删除的文本",
 *       "content_preview": "内容预览...",
 *       "content_length": 100,
 *       "created_at": "2026-09-14T00:00:00.000Z",
 *       "updated_at": "2026-10-01T00:00:00.000Z",
 *       "deleted_at": "2026-10-09T00:00:00.000Z"
 *     }
 *   ]
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 */
export async function listTrashTexts(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  const timings: RouteTimingEntry[] = []

  const url = new URL(request.url)
  const page = normalizePageParam(url.searchParams.get('page'))
  const limit = normalizeLimitParam(url.searchParams.get('limit'))
  const q = String(url.searchParams.get('q') || '').trim()
  const ownerId = String(url.searchParams.get('owner_id') || '').trim()
  const deletedFrom = String(url.searchParams.get('deleted_from') || '').trim()
  const deletedTo = String(url.searchParams.get('deleted_to') || '').trim()
  const offset = (page - 1) * limit

  const conditions: string[] = ['t.deleted_at IS NOT NULL']
  const params: unknown[] = []

  if (user.role !== 'admin') {
    conditions.push('t.owner_id = ?')
    params.push(user.id)
  } else if (ownerId) {
    conditions.push('t.owner_id = ?')
    params.push(ownerId)
  }

  if (q) {
    conditions.push("t.title LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(q)}%`)
  }

  if (deletedFrom) {
    conditions.push('t.deleted_at >= ?')
    params.push(deletedFrom)
  }
  if (deletedTo) {
    conditions.push('t.deleted_at < ?')
    params.push(deletedTo)
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`
  const sortByRaw = url.searchParams.get('sort_by') || 'deleted_at'
  const sortColumn = TRASH_SORT_FIELDS[sortByRaw] || TRASH_SORT_FIELDS.deleted_at
  const sortDir = url.searchParams.get('sort_order') === 'asc' ? 'ASC' : 'DESC'

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
                t.created_at, t.updated_at, t.deleted_at
         FROM texts t
         LEFT JOIN users u ON u.id = t.owner_id
         ${whereClause}
         ORDER BY ${sortColumn} ${sortDir}
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
 * 恢复回收站文本
 *
 * @route POST /api/texts/:id/restore
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param textId - 文本 ID
 * @returns JSON 响应
 *
 * @example
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // 文本不存在或不在回收站 (404)
 * { "error": "文本不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function restoreText(request: Request, env: Env, textId: string): Promise<Response> {
  const loaded = await loadTrashText(request, env, textId)
  if ('response' in loaded) return loaded.response

  const now = new Date().toISOString()
  const result = await withD1Retry(env.DB)
    .prepare('UPDATE texts SET deleted_at = NULL, updated_at = ? WHERE id = ?')
    .bind(now, loaded.text.id)
    .run()

  if (result.error) {
    return jsonResponse({ error: '恢复文本失败' }, 400)
  }

  await logAudit(env.DB, {
    actorUserId: loaded.user.id,
    action: 'TEXT_RESTORE',
    targetType: 'text',
    targetId: loaded.text.id,
    ip: getClientIp(request),
    userAgent: request.headers.get('User-Agent') || undefined,
  })

  return jsonResponse({ success: true })
}

/**
 * 永久删除回收站文本（连带删除分享行）
 *
 * @route DELETE /api/texts/:id/permanent
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param textId - 文本 ID
 * @returns JSON 响应
 *
 * @example
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 文本不存在或不在回收站 (404)
 * { "error": "文本不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function permanentlyDeleteText(
  request: Request,
  env: Env,
  textId: string
): Promise<Response> {
  const loaded = await loadTrashText(request, env, textId)
  if ('response' in loaded) return loaded.response

  await permanentlyDeleteTextRows(
    env,
    loaded.user,
    request,
    loaded.text.id,
    new Date().toISOString()
  )
  return jsonResponse({ success: true })
}

/**
 * 清空回收站（仅本人；分批物理删除，部分失败可重试续跑）
 *
 * @route DELETE /api/texts/trash/permanent
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应
 *
 * @example
 * // 成功响应 (200)
 * { "success": true, "deleted": 12 }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 */
export async function permanentlyDeleteTrashTexts(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  // 游标分批（id 升序）：每批 batch 物理删除，任一批失败即中断抛出；
  // 已删除行已落库，未处理行下次调用从游标头部继续（部分成功可重试续跑）。
  const nowIso = new Date().toISOString()
  let cursor: string | null = null
  let deleted = 0
  for (;;) {
    const page = await withD1Retry(env.DB)
      .prepare(
        `SELECT id FROM texts
     WHERE owner_id = ? AND deleted_at IS NOT NULL AND id > ?
     ORDER BY id ASC
     LIMIT ?`
      )
      .bind(user.id, cursor ?? '', TEXTS_TRASH_DELETE_BATCH_SIZE)
      .all<{ id: string }>()
    const rows: Array<{ id: string }> = page.results || []
    if (!rows.length) break

    for (const row of rows) {
      cursor = row.id
      await permanentlyDeleteTextRows(env, user, request, row.id, nowIso)
      deleted += 1
    }

    if (rows.length < TEXTS_TRASH_DELETE_BATCH_SIZE) break
  }

  await logAudit(env.DB, {
    actorUserId: user.id,
    action: 'TEXT_TRASH_CLEAR',
    targetType: 'text',
    targetId: '',
    ip: getClientIp(request),
    userAgent: request.headers.get('User-Agent') || undefined,
    metadata: { deleted },
  })

  return jsonResponse({ success: true, deleted })
}
