import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { invalidJsonBodyResponse, jsonResponse, parseJson } from './utils'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'

/**
 * 获取审计日志列表
 *
 * @route GET /api/audit
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含审计日志列表和分页信息
 *
 * @example
 * // 查询参数
 * // page: 页码（默认 1）
 * // limit: 每页数量（默认 20，最大 100）
 * // action: 操作类型过滤
 * // actor_user_id: 操作者用户 ID 过滤
 * // created_from: 创建时间起始
 * // created_to: 创建时间结束
 *
 * // 成功响应 (200)
 * {
 *   "total": 100,
 *   "page": 1,
 *   "limit": 20,
 *   "logs": [
 *     {
 *       "id": "uuid",
 *       "actor_user_id": "uuid",
 *       "actor_username": "admin",
 *       "action": "LOGIN_SUCCESS",
 *       "target_type": "user",
 *       "target_id": "uuid",
 *       "ip": "127.0.0.1",
 *       "user_agent": "Mozilla/5.0...",
 *       "metadata": {},
 *       "created_at": "2026-09-14T00:00:00.000Z"
 *     }
 *   ]
 * }
 */
export async function listAudit(request: Request, env: Env): Promise<Response> {
  const timings: RouteTimingEntry[] = []
  const url = new URL(request.url)
  const page = Math.max(1, Number(url.searchParams.get('page') || 1))
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)))
  const action = url.searchParams.get('action')
  const actorUserId = url.searchParams.get('actor_user_id')
  const createdFrom = url.searchParams.get('created_from')
  const createdTo = url.searchParams.get('created_to')
  const offset = (page - 1) * limit

  const conditions: string[] = []
  const params: unknown[] = []
  if (action) {
    conditions.push('a.action = ?')
    params.push(action)
  }
  if (actorUserId) {
    conditions.push('a.actor_user_id = ?')
    params.push(actorUserId)
  }
  if (createdFrom) {
    conditions.push('a.created_at >= ?')
    params.push(createdFrom)
  }
  if (createdTo) {
    conditions.push('a.created_at < ?')
    params.push(createdTo)
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [totalRow, rows] = await Promise.all([
    measureRouteStep(timings, 'dbCount', () =>
      withD1Retry(env.DB)
        .prepare(`SELECT COUNT(*) AS total FROM audit_logs a ${whereClause}`)
        .bind(...params)
        .first('total')
    ),
    measureRouteStep(timings, 'dbRows', () =>
      withD1Retry(env.DB)
        .prepare(
          `SELECT a.id, a.actor_user_id, u.username AS actor_username, a.action, a.target_type, a.target_id, a.ip, a.user_agent, a.metadata, a.created_at
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
         ${whereClause}
         ORDER BY a.created_at DESC
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
      logs: rows.results || [],
    }),
    timings
  )
}

/**
 * 删除单个审计日志
 *
 * @route DELETE /api/audit/:id
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param auditId - 审计日志 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 记录不存在 (404)
 * { "error": "记录不存在" }
 */
export async function deleteAudit(request: Request, env: Env, auditId: string): Promise<Response> {
  if (!auditId) {
    return jsonResponse({ error: 'id 不能为空' }, 400)
  }

  const existing = await withD1Retry(env.DB)
    .prepare('SELECT id FROM audit_logs WHERE id = ? LIMIT 1')
    .bind(auditId)
    .first('id')

  if (!existing) {
    return jsonResponse({ error: '记录不存在' }, 404)
  }

  await withD1Retry(env.DB).prepare('DELETE FROM audit_logs WHERE id = ?').bind(auditId).run()

  return jsonResponse({ success: true })
}

/**
 * 批量删除审计日志
 *
 * @route POST /api/audit/batch-delete
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含删除统计
 *
 * @example
 * // 请求体
 * {
 *   "ids": ["uuid1", "uuid2", "uuid3"]
 * }
 *
 * // 成功响应 (200)
 * {
 *   "success": true,
 *   "deleted": 3
 * }
 *
 * // ids 为空 (400)
 * { "error": "ids 不能为空" }
 *
 * // 超出限制 (400)
 * { "error": "一次最多删除 200 条" }
 */
export async function batchDeleteAudit(request: Request, env: Env): Promise<Response> {
  let body: { ids?: unknown }
  try {
    body = await parseJson<{ ids?: unknown }>(request)
  } catch (error) {
    return invalidJsonBodyResponse(error)
  }

  const rawIds = Array.isArray(body.ids) ? body.ids : []
  const ids = Array.from(new Set(rawIds.map((value) => String(value ?? '').trim()).filter(Boolean)))

  if (!ids.length) {
    return jsonResponse({ error: 'ids 不能为空' }, 400)
  }

  if (ids.length > 200) {
    return jsonResponse({ error: '一次最多删除 200 条' }, 400)
  }

  const placeholders = ids.map(() => '?').join(',')
  await withD1Retry(env.DB)
    .prepare(`DELETE FROM audit_logs WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run()

  return jsonResponse({ success: true, deleted: ids.length })
}
