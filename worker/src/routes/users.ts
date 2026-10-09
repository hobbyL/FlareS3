import { withD1Retry } from '../utils/db'
import { escapeLike } from '../utils/escapeLike'
import type { Env } from '../config/env'
import { jsonResponse, parseJson, getUser, requestBodyPolicyErrorResponse } from './utils'
import { hashPassword } from '../services/password'
import { logAudit, prepareAuditLogInsert } from '../services/audit'
import { prepareEnqueueFileDeletionIfNeeded } from '../services/deleteQueue'
import { getClientIp } from '../middleware/rateLimit'
import { prepareReleaseUploadReservation } from '../services/uploadReservations'
import { invalidateUserAuthTokens } from '../middleware/authSession'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'
import { normalizePageParam, normalizeLimitParam } from '../utils/pagination'

function prepareRevokeUserSessions(
  db: D1Database,
  userId: string,
  revokedAt: string = new Date().toISOString()
): D1PreparedStatement {
  return withD1Retry(db)
    .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(revokedAt, userId)
}

async function revokeUserSessions(db: D1Database, userId: string): Promise<void> {
  await prepareRevokeUserSessions(db, userId).run()
  invalidateUserAuthTokens(userId)
}

function prepareDeactivateUserPublicResources(
  db: D1Database,
  userId: string,
  now: string
): D1PreparedStatement[] {
  return [
    withD1Retry(db)
      .prepare(
        'UPDATE texts SET deleted_at = ?, updated_at = ? WHERE owner_id = ? AND deleted_at IS NULL'
      )
      .bind(now, now, userId),
    withD1Retry(db).prepare('DELETE FROM text_shares WHERE owner_id = ?').bind(userId),
    withD1Retry(db).prepare('DELETE FROM text_one_time_shares WHERE owner_id = ?').bind(userId),
    withD1Retry(db).prepare('DELETE FROM file_shares WHERE owner_id = ?').bind(userId),
  ]
}

async function deactivateUserPublicResources(
  db: D1Database,
  userId: string,
  now: string
): Promise<void> {
  await withD1Retry(db).batch(prepareDeactivateUserPublicResources(db, userId, now))
}

async function countActiveAdmins(db: D1Database): Promise<number> {
  const total = await withD1Retry(db)
    .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active'")
    .first('total')
  return Number(total || 0)
}

async function isLastActiveAdmin(db: D1Database, userId: string): Promise<boolean> {
  const target = await withD1Retry(db)
    .prepare('SELECT id, role, status FROM users WHERE id = ? LIMIT 1')
    .bind(userId)
    .first<{ id: string; role: string; status: string }>()

  if (!target) return false
  if (String(target.role) !== 'admin' || String(target.status) !== 'active') return false

  const activeAdmins = await countActiveAdmins(db)
  return activeAdmins <= 1
}

/**
 * 获取用户列表
 *
 * @route GET /api/users
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含用户列表和分页信息
 *
 * @example
 * // 查询参数
 * // page: 页码（默认 1）
 * // limit: 每页数量（默认 20，最大 100）
 * // status: 用户状态过滤（active/inactive）
 * // role: 用户角色过滤（admin/user）
 * // q: 搜索关键词（用户名）
 *
 * // 成功响应 (200)
 * {
 *   "total": 10,
 *   "users": [
 *     {
 *       "id": "uuid",
 *       "username": "admin",
 *       "role": "admin",
 *       "status": "active",
 *       "quota_bytes": 10737418240,
 *       "created_at": "2026-09-14T00:00:00.000Z",
 *       "last_login_at": "2026-09-14T00:00:00.000Z"
 *     }
 *   ]
 * }
 */
export async function listUsers(request: Request, env: Env): Promise<Response> {
  const timings: RouteTimingEntry[] = []
  const url = new URL(request.url)
  const page = normalizePageParam(url.searchParams.get('page'))
  const limit = normalizeLimitParam(url.searchParams.get('limit'))
  const status = url.searchParams.get('status')
  const role = url.searchParams.get('role')
  const q = url.searchParams.get('q')
  const createdFrom = url.searchParams.get('created_from')
  const createdTo = url.searchParams.get('created_to')
  const offset = (page - 1) * limit

  const conditions: string[] = []
  const params: unknown[] = []
  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }
  if (role) {
    conditions.push('role = ?')
    params.push(role)
  }
  if (q) {
    conditions.push("username LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(q)}%`)
  }
  if (createdFrom) {
    conditions.push('created_at >= ?')
    params.push(createdFrom)
  }
  if (createdTo) {
    conditions.push('created_at < ?')
    params.push(createdTo)
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [totalRow, rows] = await Promise.all([
    measureRouteStep(timings, 'dbCount', () =>
      withD1Retry(env.DB)
        .prepare(`SELECT COUNT(*) AS total FROM users ${whereClause}`)
        .bind(...params)
        .first('total')
    ),
    measureRouteStep(timings, 'dbRows', () =>
      withD1Retry(env.DB)
        .prepare(
          `SELECT id, username, role, status, quota_bytes, created_at, last_login_at
         FROM users ${whereClause}
         ORDER BY created_at DESC
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
      users: rows.results || [],
    }),
    timings
  )
}

const USERNAME_PATTERN = /^[\w.-]{1,64}$/

/**
 * 创建用户
 *
 * @route POST /api/users
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含创建的用户 ID
 *
 * @example
 * // 请求体
 * {
 *   "username": "newuser",
 *   "password": "password123",
 *   "role": "user",
 *   "quota_bytes": 10737418240
 * }
 *
 * // 成功响应 (200)
 * {
 *   "id": "uuid",
 *   "username": "newuser"
 * }
 *
 * // 用户名格式无效 (400)
 * { "error": "用户名仅允许字母、数字、下划线、点、连字符，长度 1-64" }
 *
 * // 用户名已存在 (409)
 * { "error": "用户名已存在" }
 *
 * // 配额无效 (400)
 * { "error": "配额无效" }
 */
export async function createUser(request: Request, env: Env): Promise<Response> {
  try {
    const body = await parseJson<{
      username: string
      password: string
      role?: 'admin' | 'user'
      quota_bytes?: number
    }>(request)
    if (!body.username || !body.password) {
      return jsonResponse({ error: '用户名或密码不能为空' }, 400)
    }
    if (!USERNAME_PATTERN.test(String(body.username))) {
      return jsonResponse({ error: '用户名仅允许字母、数字、下划线、点、连字符，长度 1-64' }, 400)
    }
    if (String(body.password).length < 8) {
      return jsonResponse({ error: '密码长度至少为 8 位' }, 400)
    }
    const existing = await withD1Retry(env.DB)
      .prepare('SELECT id FROM users WHERE username = ?')
      .bind(body.username)
      .first()
    if (existing) {
      return jsonResponse({ error: '用户名已存在' }, 409)
    }
    const role = body.role === 'admin' ? 'admin' : 'user'
    const quota = Number(body.quota_bytes || 0)
    if (!Number.isFinite(quota) || quota <= 0) {
      return jsonResponse({ error: '配额无效' }, 400)
    }
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    await withD1Retry(env.DB)
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, status, quota_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .bind(id, body.username, hashPassword(body.password), role, quota, now, now)
      .run()

    const actor = getUser(request)
    await logAudit(env.DB, {
      actorUserId: actor?.id,
      action: 'USER_CREATE',
      targetType: 'user',
      targetId: id,
      ip: getClientIp(request),
      userAgent: request.headers.get('User-Agent') || undefined,
    })

    return jsonResponse({ success: true, user_id: id })
  } catch (error) {
    const bodyError = requestBodyPolicyErrorResponse(error)
    if (bodyError) return bodyError
    return jsonResponse({ error: '创建用户失败' }, 500)
  }
}

/**
 * 更新用户信息
 *
 * @route PATCH /api/users/:id
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param userId - 用户 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 请求体
 * {
 *   "status": "active",
 *   "role": "user",
 *   "quota_bytes": 10737418240
 * }
 *
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 用户不存在 (404)
 * { "error": "用户不存在" }
 *
 * // 最后一个管理员 (400)
 * { "error": "必须保留至少一个启用中的管理员" }
 */
export async function updateUser(request: Request, env: Env, userId: string): Promise<Response> {
  try {
    const body = await parseJson<{
      status?: 'active' | 'disabled' | 'deleted'
      role?: 'admin' | 'user'
      quota_bytes?: number
    }>(request)

    if (body.status === 'deleted') {
      return jsonResponse({ error: '请使用专用删除接口删除用户' }, 400)
    }
    // 枚举白名单校验：脏值会导致用户无法登录（authSession 只认 status === 'active'）
    if (body.status !== undefined && !['active', 'disabled'].includes(String(body.status))) {
      return jsonResponse({ error: 'status 必须为 active 或 disabled' }, 400)
    }
    if (body.role !== undefined && !['admin', 'user'].includes(String(body.role))) {
      return jsonResponse({ error: 'role 必须为 admin 或 user' }, 400)
    }

    const target = await withD1Retry(env.DB)
      .prepare('SELECT role, status FROM users WHERE id = ? LIMIT 1')
      .bind(userId)
      .first<{ role: string; status: string }>()
    if (!target) {
      return jsonResponse({ error: '用户不存在' }, 404)
    }

    const targetRole = String(target.role || '')
    const targetStatus = String(target.status || '')
    const nextRole = body.role || (targetRole === 'admin' ? 'admin' : 'user')
    const nextStatus = body.status || targetStatus

    if (
      targetRole === 'admin' &&
      targetStatus === 'active' &&
      (nextRole !== 'admin' || nextStatus !== 'active')
    ) {
      const isLastAdmin = await isLastActiveAdmin(env.DB, userId)
      if (isLastAdmin) {
        return jsonResponse({ error: '必须保留至少一个启用中的管理员' }, 400)
      }
    }

    const updates: string[] = []
    const params: unknown[] = []
    if (body.status) {
      updates.push('status = ?')
      params.push(body.status)
    }
    if (body.role) {
      updates.push('role = ?')
      params.push(body.role)
    }
    if (body.quota_bytes !== undefined) {
      const quota = Number(body.quota_bytes)
      if (!Number.isFinite(quota) || quota <= 0) {
        return jsonResponse({ error: '配额无效' }, 400)
      }
      updates.push('quota_bytes = ?')
      params.push(quota)
    }
    if (!updates.length) {
      return jsonResponse({ error: '无可更新字段' }, 400)
    }

    const shouldRevokeSessions =
      nextStatus === 'disabled' || nextStatus === 'deleted' || targetStatus !== nextStatus

    updates.push('updated_at = ?')
    params.push(new Date().toISOString())
    params.push(userId)
    await withD1Retry(env.DB)
      .prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run()

    if (shouldRevokeSessions) {
      await revokeUserSessions(env.DB, userId)
    }

    const actor = getUser(request)
    const auditAction =
      body.status === 'disabled'
        ? 'USER_DISABLE'
        : body.status === 'active'
          ? 'USER_ENABLE'
          : body.status === 'deleted'
            ? 'USER_DELETE'
            : 'USER_UPDATE'
    await logAudit(env.DB, {
      actorUserId: actor?.id,
      action: auditAction,
      targetType: 'user',
      targetId: userId,
      ip: getClientIp(request),
      userAgent: request.headers.get('User-Agent') || undefined,
      metadata: {
        ...body,
        sessionsRevoked: shouldRevokeSessions,
      },
    })

    return jsonResponse({ success: true })
  } catch (error) {
    const bodyError = requestBodyPolicyErrorResponse(error)
    if (bodyError) return bodyError
    return jsonResponse({ error: '更新用户失败' }, 500)
  }
}

/**
 * 重置用户密码
 *
 * @route POST /api/users/:id/reset-password
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param userId - 用户 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 请求体
 * {
 *   "password": "newpassword123"
 * }
 *
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 密码为空 (400)
 * { "error": "密码不能为空" }
 *
 * // 用户不存在 (404)
 * { "error": "用户不存在" }
 */
export async function resetPassword(request: Request, env: Env, userId: string): Promise<Response> {
  try {
    const body = await parseJson<{ password: string }>(request)
    if (!body.password) {
      return jsonResponse({ error: '密码不能为空' }, 400)
    }
    if (String(body.password).length < 8) {
      return jsonResponse({ error: '密码长度至少为 8 位' }, 400)
    }
    // 对齐 updateUser 的 404 语义：目标不存在时明确报错，而非静默成功
    const target = await withD1Retry(env.DB)
      .prepare('SELECT id FROM users WHERE id = ? LIMIT 1')
      .bind(userId)
      .first()
    if (!target) {
      return jsonResponse({ error: '用户不存在' }, 404)
    }
    await withD1Retry(env.DB)
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(hashPassword(body.password), new Date().toISOString(), userId)
      .run()

    await revokeUserSessions(env.DB, userId)

    const actor = getUser(request)
    await logAudit(env.DB, {
      actorUserId: actor?.id,
      action: 'USER_RESET_PASSWORD',
      targetType: 'user',
      targetId: userId,
      ip: getClientIp(request),
      userAgent: request.headers.get('User-Agent') || undefined,
      metadata: {
        sessionsRevoked: true,
      },
    })

    return jsonResponse({ success: true })
  } catch (error) {
    const bodyError = requestBodyPolicyErrorResponse(error)
    if (bodyError) return bodyError
    return jsonResponse({ error: '重置密码失败' }, 500)
  }
}

/**
 * 删除用户
 *
 * @route DELETE /api/users/:id
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param userId - 用户 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "success": true,
 *   "queued": true
 * }
 *
 * // 用户不存在 (404)
 * { "error": "用户不存在" }
 *
 * // 管理员不可删除 (400)
 * { "error": "管理员用户不允许删除" }
 */
export async function deleteUser(request: Request, env: Env, userId: string): Promise<Response> {
  const target = await withD1Retry(env.DB)
    .prepare('SELECT role FROM users WHERE id = ? LIMIT 1')
    .bind(userId)
    .first()
  if (!target) {
    return jsonResponse({ error: '用户不存在' }, 404)
  }
  const targetRole = String((target as { role?: unknown }).role ?? '')
  if (targetRole === 'admin') {
    return jsonResponse({ error: '管理员用户不允许删除' }, 400)
  }

  const now = new Date().toISOString()
  const files = await withD1Retry(env.DB)
    .prepare(`SELECT id, r2_key FROM files WHERE owner_id = ? AND deleted_at IS NULL`)
    .bind(userId)
    .all()
  const activeFiles = (files.results || []).map((file) => ({
    id: String(file.id),
    r2_key: String(file.r2_key),
  }))

  const actor = getUser(request)
  const statements: D1PreparedStatement[] = [
    withD1Retry(env.DB)
      .prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
      .bind('deleted', now, userId),
    prepareRevokeUserSessions(env.DB, userId, now),
    ...prepareDeactivateUserPublicResources(env.DB, userId, now),
  ]

  if (activeFiles.length) {
    statements.push(
      withD1Retry(env.DB)
        .prepare(
          `UPDATE files SET upload_status = 'deleted', deleted_at = ?, multipart_upload_id = NULL WHERE owner_id = ? AND deleted_at IS NULL`
        )
        .bind(now, userId)
    )
    statements.push(
      ...activeFiles.map((file) => prepareReleaseUploadReservation(env.DB, file.id, now)),
      ...activeFiles.map((file) => prepareEnqueueFileDeletionIfNeeded(env.DB, file, now))
    )
  }

  statements.push(
    prepareAuditLogInsert(
      env.DB,
      {
        actorUserId: actor?.id,
        action: 'USER_DELETE',
        targetType: 'user',
        targetId: userId,
        ip: getClientIp(request),
        userAgent: request.headers.get('User-Agent') || undefined,
        metadata: {
          queuedFiles: activeFiles.length,
          sessionsRevoked: true,
        },
      },
      now
    )
  )

  await withD1Retry(env.DB).batch(statements)
  invalidateUserAuthTokens(userId, Date.parse(now) || Date.now())

  return jsonResponse({ success: true, queued: true })
}
