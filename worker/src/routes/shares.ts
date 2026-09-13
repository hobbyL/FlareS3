import type { Env } from '../config/env'
import { listShareItems, type ShareRecordStatus, type ShareRecordType } from '../services/shares'
import { getUser, jsonResponse } from './utils'
import { withRouteTimingHeaders, type RouteTimingEntry } from '../utils/routeTiming'

type ShareListQuery = {
  page: number
  limit: number
  type: ShareRecordType | ''
  status: ShareRecordStatus | ''
  sort_by: string
  sort_order: string
  owner_id: string
  q: string
  expires_from: string
  expires_to: string
}

function normalizePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(1, Math.floor(parsed)))
}

function parseFilters(request: Request): ShareListQuery {
  const url = new URL(request.url)
  return {
    page: normalizePositiveInt(url.searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER),
    limit: normalizePositiveInt(url.searchParams.get('limit'), 20, 100),
    type: (url.searchParams.get('type') || '').trim() as ShareRecordType | '',
    status: (url.searchParams.get('status') || '').trim() as ShareRecordStatus | '',
    sort_by: (url.searchParams.get('sort_by') || '').trim(),
    sort_order: (url.searchParams.get('sort_order') || '').trim(),
    owner_id: (url.searchParams.get('owner_id') || '').trim(),
    q: (url.searchParams.get('q') || '').trim(),
    expires_from: (url.searchParams.get('expires_from') || '').trim(),
    expires_to: (url.searchParams.get('expires_to') || '').trim(),
  }
}

/**
 * 获取分享列表（文件分享和文本分享的统一视图）
 *
 * @route GET /api/shares
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含分享列表和分页信息
 *
 * @example
 * // 查询参数
 * // page: 页码（默认 1）
 * // limit: 每页数量（默认 20，最大 100）
 * // type: 分享类型过滤（file | text）
 * // status: 分享状态过滤（active | expired）
 * // sort_by: 排序字段（created_at | expires_at | view_count）
 * // sort_order: 排序顺序（asc | desc）
 * // owner_id: 所有者 ID 过滤（仅管理员可用）
 * // q: 搜索关键词
 * // expires_from: 过期时间起始
 * // expires_to: 过期时间结束
 *
 * // 成功响应 (200)
 * {
 *   "total": 50,
 *   "page": 1,
 *   "limit": 20,
 *   "items": [
 *     {
 *       "id": "uuid",
 *       "type": "file",
 *       "owner_id": "uuid",
 *       "owner_username": "admin",
 *       "title": "文件名.pdf",
 *       "short_code": "abc123",
 *       "require_password": false,
 *       "view_count": 10,
 *       "download_count": 5,
 *       "expires_at": "2026-09-21T00:00:00.000Z",
 *       "status": "active",
 *       "created_at": "2026-09-14T00:00:00.000Z"
 *     }
 *   ]
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 */
export async function listShares(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) {
    return jsonResponse({ error: '未授权' }, 401)
  }
  const timings: RouteTimingEntry[] = []

  const filters = parseFilters(request)
  const result = await listShareItems(env, user, filters, timings)

  return withRouteTimingHeaders(
    jsonResponse({
      total: result.total,
      page: filters.page,
      limit: filters.limit,
      items: result.items,
    }),
    timings
  )
}
