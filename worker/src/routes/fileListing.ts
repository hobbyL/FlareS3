import { withD1Retry } from '../utils/db'
import { escapeLike } from '../utils/escapeLike'
import type { Env } from '../config/env'
import { jsonResponse, getUser, calcPresignedDownloadUrlTtlSeconds } from './utils'
import { generateDownloadUrl, resolveR2ConfigForKey } from '../services/r2'
import { getExplicitProviderConfigId, getFileStorageConfigId } from '../services/fileStorage'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'
import { normalizePageParam, normalizeLimitParam } from '../utils/pagination'

const ALLOWED_SORT_FIELDS: Record<string, string> = {
  created_at: 'f.created_at',
  filename: 'f.filename',
  size: 'f.size',
  expires_at: 'f.expires_at',
}

const TRASH_SORT_FIELDS: Record<string, string> = {
  ...ALLOWED_SORT_FIELDS,
  deleted_at: 'f.deleted_at',
}

function parseSortParams(
  url: URL,
  fields: Record<string, string>,
  defaultField: string
): { sortColumn: string; sortDir: 'ASC' | 'DESC' } {
  const sortByRaw = url.searchParams.get('sort_by') || defaultField
  const sortOrderRaw = url.searchParams.get('sort_order') || 'desc'
  const sortColumn = fields[sortByRaw] || fields[defaultField]
  const sortDir = sortOrderRaw === 'asc' ? 'ASC' : 'DESC'
  return { sortColumn, sortDir }
}

function formatDuration(ms: number): string {
  if (ms < 0) return '已过期'
  const minutes = Math.floor(ms / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  const remMinutes = minutes % 60
  if (days > 0) return `${days}天 ${remHours}小时 ${remMinutes}分钟`
  if (hours > 0) return `${hours}小时 ${remMinutes}分钟`
  return `${remMinutes}分钟`
}

/**
 * 获取文件列表
 *
 * @route GET /api/files
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含文件列表和分页信息
 *
 * @example
 * // 查询参数
 * // page: 页码（默认 1）
 * // limit: 每页数量（默认 20，最大 100）
 * // scope: 范围过滤（mine: 仅我的文件，仅管理员可用）
 * // filename: 文件名模糊搜索
 * // owner_id: 所有者 ID 过滤（仅管理员可用）
 * // upload_status: 上传状态过滤（completed | deleted）
 * // created_from: 创建时间起始
 * // created_to: 创建时间结束
 * // sort_by: 排序字段（created_at | filename | size | expires_at）
 * // sort_order: 排序方向（asc | desc）
 *
 * // 成功响应 (200)
 * {
 *   "total": 50,
 *   "page": 1,
 *   "limit": 20,
 *   "files": [
 *     {
 *       "id": "uuid",
 *       "owner_id": "uuid",
 *       "owner_username": "admin",
 *       "filename": "example.pdf",
 *       "r2_key": "uploads/example.pdf",
 *       "size": 1048576,
 *       "content_type": "application/pdf",
 *       "expires_in": 2592000,
 *       "created_at": "2026-09-14T00:00:00.000Z",
 *       "expires_at": "2026-10-14T00:00:00.000Z",
 *       "upload_status": "completed",
 *       "short_code": "abc123",
 *       "require_login": 0,
 *       "config_id": "uuid",
 *       "r2_config_id": "uuid",
 *       "remaining_time": "30天 0小时 0分钟",
 *       "download_url": "https://example.com/download"
 *     }
 *   ]
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 */
export async function listFiles(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  const timings: RouteTimingEntry[] = []

  const url = new URL(request.url)
  const page = normalizePageParam(url.searchParams.get('page'))
  const limit = normalizeLimitParam(url.searchParams.get('limit'))
  const scope = url.searchParams.get('scope')
  const filename = url.searchParams.get('filename')
  const ownerId = url.searchParams.get('owner_id')
  const uploadStatus = url.searchParams.get('upload_status')
  const createdFrom = url.searchParams.get('created_from')
  const createdTo = url.searchParams.get('created_to')
  const offset = (page - 1) * limit

  const conditions: string[] = [
    "f.upload_status IN ('completed','deleted')",
    'f.deleted_at IS NULL',
  ]
  const params: unknown[] = []
  if (user.role !== 'admin' || scope === 'mine') {
    conditions.push('f.owner_id = ?')
    params.push(user.id)
  } else if (ownerId) {
    conditions.push('f.owner_id = ?')
    params.push(ownerId)
  }
  if (filename && filename.trim()) {
    conditions.push("f.filename LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(filename.trim())}%`)
  }
  if (uploadStatus) {
    conditions.push('f.upload_status = ?')
    params.push(uploadStatus)
  }
  if (createdFrom) {
    conditions.push('f.created_at >= ?')
    params.push(createdFrom)
  }
  if (createdTo) {
    conditions.push('f.created_at < ?')
    params.push(createdTo)
  }
  const whereClause = `WHERE ${conditions.join(' AND ')}`
  const { sortColumn, sortDir } = parseSortParams(url, ALLOWED_SORT_FIELDS, 'created_at')

  const [totalRow, rows] = await Promise.all([
    measureRouteStep(timings, 'dbCount', () =>
      withD1Retry(env.DB)
        .prepare(`SELECT COUNT(*) AS total FROM files f ${whereClause}`)
        .bind(...params)
        .first('total')
    ),
    measureRouteStep(timings, 'dbRows', () =>
      withD1Retry(env.DB)
        .prepare(
          `SELECT f.id, f.owner_id, u.username AS owner_username, f.filename, f.r2_key, f.size, f.content_type, f.expires_in, f.created_at, f.expires_at, f.upload_status, f.short_code, f.require_login, f.config_id
         FROM files f
         LEFT JOIN users u ON u.id = f.owner_id
         ${whereClause}
         ORDER BY ${sortColumn} ${sortDir}
         LIMIT ? OFFSET ?`
        )
        .bind(...params, limit, offset)
        .all()
    ),
  ])
  const total = Number(totalRow || 0)

  const now = Date.now()
  const filesWithUrl = await measureRouteStep(timings, 'postProcess', () =>
    Promise.all(
      (rows.results || []).map(async (row) => {
        const expiresAt = new Date(String(row.expires_at)).getTime()
        const remaining = Number.isFinite(expiresAt) ? formatDuration(expiresAt - now) : '未知'
        let downloadUrl = ''
        const allowDirect = Number(row.require_login) === 0

        if (
          allowDirect &&
          row.upload_status === 'completed' &&
          Number.isFinite(expiresAt) &&
          now < expiresAt
        ) {
          const explicitProviderConfigId = getExplicitProviderConfigId(row)
          if (explicitProviderConfigId) {
            downloadUrl = `/api/files/${row.id}/download`
          } else {
            const loaded = await resolveR2ConfigForKey(env, String(row.r2_key))
            if (loaded) {
              try {
                const ttl = calcPresignedDownloadUrlTtlSeconds(new Date(expiresAt), now)
                downloadUrl = await generateDownloadUrl(
                  loaded.config,
                  String(row.r2_key),
                  String(row.filename),
                  ttl
                )
              } catch (error) {
                downloadUrl = `/api/files/${row.id}/download`
              }
            } else {
              downloadUrl = `/api/files/${row.id}/download`
            }
          }
        }

        return {
          ...row,
          r2_config_id: getFileStorageConfigId(row),
          remaining_time: remaining,
          download_url: downloadUrl,
        }
      })
    )
  )

  return withRouteTimingHeaders(
    jsonResponse({
      total,
      page,
      limit,
      files: filesWithUrl,
    }),
    timings
  )
}

/**
 * 获取回收站文件列表
 *
 * @route GET /api/files/trash
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含回收站文件列表和分页信息
 *
 * @example
 * // 查询参数
 * // page: 页码（默认 1）
 * // limit: 每页数量（默认 20，最大 100）
 * // scope: 范围过滤（mine: 仅我的文件，仅管理员可用）
 * // filename: 文件名模糊搜索
 * // owner_id: 所有者 ID 过滤（仅管理员可用）
 * // deleted_from: 删除时间起始
 * // deleted_to: 删除时间结束
 * // sort_by: 排序字段（created_at | filename | size | expires_at | deleted_at）
 * // sort_order: 排序方向（asc | desc）
 *
 * // 成功响应 (200)
 * {
 *   "total": 10,
 *   "page": 1,
 *   "limit": 20,
 *   "files": [
 *     {
 *       "id": "uuid",
 *       "owner_id": "uuid",
 *       "owner_username": "admin",
 *       "filename": "deleted.pdf",
 *       "r2_key": "uploads/deleted.pdf",
 *       "size": 1048576,
 *       "content_type": "application/pdf",
 *       "created_at": "2026-09-10T00:00:00.000Z",
 *       "deleted_at": "2026-09-14T00:00:00.000Z",
 *       "upload_status": "deleted",
 *       "config_id": "uuid",
 *       "r2_config_id": "uuid"
 *     }
 *   ]
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 */
export async function listTrashFiles(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  const timings: RouteTimingEntry[] = []

  const url = new URL(request.url)
  const page = normalizePageParam(url.searchParams.get('page'))
  const limit = normalizeLimitParam(url.searchParams.get('limit'))
  const scope = url.searchParams.get('scope')
  const filename = url.searchParams.get('filename')
  const ownerId = url.searchParams.get('owner_id')
  const deletedFrom = url.searchParams.get('deleted_from')
  const deletedTo = url.searchParams.get('deleted_to')
  const offset = (page - 1) * limit

  const conditions: string[] = ["f.upload_status = 'deleted'", 'f.deleted_at IS NOT NULL']
  const params: unknown[] = []

  if (user.role !== 'admin' || scope === 'mine') {
    conditions.push('f.owner_id = ?')
    params.push(user.id)
  } else if (ownerId) {
    conditions.push('f.owner_id = ?')
    params.push(ownerId)
  }

  if (filename && filename.trim()) {
    conditions.push("f.filename LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(filename.trim())}%`)
  }

  if (deletedFrom) {
    conditions.push('f.deleted_at >= ?')
    params.push(deletedFrom)
  }
  if (deletedTo) {
    conditions.push('f.deleted_at < ?')
    params.push(deletedTo)
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`
  const { sortColumn, sortDir } = parseSortParams(url, TRASH_SORT_FIELDS, 'deleted_at')

  const [totalRow, rows] = await Promise.all([
    measureRouteStep(timings, 'dbCount', () =>
      withD1Retry(env.DB)
        .prepare(`SELECT COUNT(*) AS total FROM files f ${whereClause}`)
        .bind(...params)
        .first('total')
    ),
    measureRouteStep(timings, 'dbRows', () =>
      withD1Retry(env.DB)
        .prepare(
          `SELECT f.id, f.owner_id, u.username AS owner_username, f.filename, f.r2_key, f.size, f.content_type, f.expires_in, f.created_at, f.expires_at, f.upload_status, f.short_code, f.require_login, f.deleted_at, f.config_id
         FROM files f
         LEFT JOIN users u ON u.id = f.owner_id
         ${whereClause}
         ORDER BY ${sortColumn} ${sortDir}
         LIMIT ? OFFSET ?`
        )
        .bind(...params, limit, offset)
        .all()
    ),
  ])
  const total = Number(totalRow || 0)

  const files = await measureRouteStep(timings, 'postProcess', async () =>
    (rows.results || []).map((row) => ({
      ...row,
      r2_config_id: getFileStorageConfigId(row),
      remaining_time: '-',
      download_url: '',
    }))
  )

  return withRouteTimingHeaders(
    jsonResponse({
      total,
      page,
      limit,
      files,
    }),
    timings
  )
}
