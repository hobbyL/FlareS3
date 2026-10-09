import type { Env } from '../config/env'
import { withD1Retry } from '../utils/db'
import { listShareItems, type ShareRecordStatus, type ShareRecordType } from '../services/shares'
import { listShareAccessLogs, type ShareAccessLogShareType } from '../services/shareAccessLog'
import { getUser, jsonResponse } from './utils'
import { withRouteTimingHeaders, type RouteTimingEntry } from '../utils/routeTiming'
import { MAX_PAGE_VALUE, normalizePositiveInt } from '../utils/pagination'

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

function parseFilters(request: Request): ShareListQuery {
  const url = new URL(request.url)
  return {
    // page 统一 clamp 到共享的 MAX_PAGE_VALUE，避免极端大数溢出 offset
    page: normalizePositiveInt(url.searchParams.get('page'), 1, MAX_PAGE_VALUE),
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

/** 访问明细端点支持的分享类型（text_one_time 无密码/无消费记录，不在范围内） */
const ACCESS_SHARE_TYPES: readonly ShareAccessLogShareType[] = ['file', 'text', 'folder']

/**
 * 按「列表口径 id」查对应分享表的 owner：
 * - file → file_shares.file_id
 * - text → text_shares.text_id
 * - folder → folder_shares.id
 * 与 /api/shares 列表返回的 resource_id 保持一致，前端可直接透传。
 *
 * text/file 的分享行不存在（从未分享或分享已关闭）时回退查资源表 owner：
 * 访问日志是历史数据，资源仍存在时应继续可查（如文档列表的"分享记录"入口）。
 * folder 的 id 即分享行本身，删除后无资源可回退，维持 404。
 */
async function findShareOwner(
  env: Env,
  shareType: ShareAccessLogShareType,
  shareId: string
): Promise<{ ownerId: string } | null> {
  const statementByType: Record<ShareAccessLogShareType, string> = {
    file: 'SELECT owner_id FROM file_shares WHERE file_id = ? LIMIT 1',
    text: 'SELECT owner_id FROM text_shares WHERE text_id = ? LIMIT 1',
    folder: 'SELECT owner_id FROM folder_shares WHERE id = ? LIMIT 1',
  }

  const row = await withD1Retry(env.DB).prepare(statementByType[shareType]).bind(shareId).first()

  const shareOwnerId = row ? String((row as any).owner_id ?? '') : ''
  if (shareOwnerId) return { ownerId: shareOwnerId }

  const fallbackByType: Partial<Record<ShareAccessLogShareType, string>> = {
    file: 'SELECT owner_id FROM files WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    text: 'SELECT owner_id FROM texts WHERE id = ? AND deleted_at IS NULL LIMIT 1',
  }
  const fallbackSql = fallbackByType[shareType]
  if (!fallbackSql) return null

  const resource = await withD1Retry(env.DB).prepare(fallbackSql).bind(shareId).first()

  const ownerId = resource ? String((resource as any).owner_id ?? '') : ''
  return ownerId ? { ownerId } : null
}

/**
 * 获取分享的访问明细
 *
 * @route GET /api/shares/:shareType/:shareId/accesses
 * @param request - HTTP 请求对象（需要认证，owner/admin）
 * @param env - Cloudflare Workers 环境变量
 * @param shareType - 分享类型（file | text | folder）
 * @param shareId - 分享资源 ID（与 /api/shares 列表的 resource_id 同口径）
 * @returns JSON 响应，包含访问日志分页
 *
 * @example
 * // 查询参数
 * // page: 页码（默认 1，每页固定 20 条）
 *
 * // 成功响应 (200)
 * {
 *   "items": [
 *     {
 *       "id": 21,
 *       "ip": "203.0.113.7",
 *       "user_agent": "Mozilla/5.0 ...",
 *       "path": "docs/readme.md",
 *       "result": "ok",
 *       "created_at": "2026-10-07T01:00:00.000Z"
 *     }
 *   ],
 *   "total": 41,
 *   "page": 1,
 *   "limit": 20
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // 无效的分享类型 (400)
 * { "error": "无效的分享类型" }
 *
 * // 分享不存在 (404)
 * { "error": "分享不存在" }
 *
 * // 无权限（非 owner 且非 admin）(403)
 * { "error": "无权限" }
 */
export async function listShareAccesses(
  request: Request,
  env: Env,
  shareType: string,
  shareId: string
): Promise<Response> {
  const user = getUser(request)
  if (!user) {
    return jsonResponse({ error: '未授权' }, 401)
  }

  const normalizedType = String(shareType || '').trim() as ShareAccessLogShareType
  if (!ACCESS_SHARE_TYPES.includes(normalizedType)) {
    return jsonResponse({ error: '无效的分享类型' }, 400)
  }

  const normalizedShareId = String(shareId || '').trim()
  if (!normalizedShareId) {
    return jsonResponse({ error: '分享不存在' }, 404)
  }

  const owner = await findShareOwner(env, normalizedType, normalizedShareId)
  if (!owner) {
    return jsonResponse({ error: '分享不存在' }, 404)
  }

  if (user.role !== 'admin' && owner.ownerId !== user.id) {
    return jsonResponse({ error: '无权限' }, 403)
  }

  const url = new URL(request.url)
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page') ?? 1)) || 1)
  const limit = 20

  const result = await listShareAccessLogs(env.DB, {
    share_type: normalizedType,
    share_id: normalizedShareId,
    page,
    limit,
  })

  return jsonResponse({
    items: result.items,
    total: result.total,
    page,
    limit,
  })
}
