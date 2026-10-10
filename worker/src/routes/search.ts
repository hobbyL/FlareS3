import { withD1Retry } from '../utils/db'
import { escapeLike } from '../utils/escapeLike'
import type { Env } from '../config/env'
import { jsonResponse, getUser } from './utils'
import { listShareItems } from '../services/shares'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'

/** 每个来源返回的最大命中数（files / texts / shares 各自独立 top N）。 */
const SEARCH_TOP_N = 10

/**
 * 搜索关键词长度上限：超出即截断（对齐 texts 标题 200 上限口径）。
 * 防御超长 q 造成的 LIKE 参数膨胀；不改变语义（仅取前 N 字符匹配）。
 */
const MAX_SEARCH_QUERY_LENGTH = 200

type FileSearchHit = {
  id: string
  filename: string
  r2_key: string
  size: number | null
  created_at: string
  config_id: string | null
}

type TextSearchHit = {
  id: string
  title: string
  content_preview: string
  updated_at: string
}

type ShareSearchHit = {
  type: string
  resource_id: string
  resource_name: string
  share_code: string
  share_url: string
  created_at: string
}

/**
 * 全局搜索：一次请求聚合查询文件 / 文档 / 分享三源，各返回 top 10。
 *
 * 口径与既有列表路由一致：
 * - files：`filename LIKE`，仅 `upload_status='completed'` 且未软删除；
 *   非 admin 限本人（`owner_id = user.id`），admin 全局。
 * - texts：`title LIKE OR content LIKE`，未软删除；非 admin 限本人，admin 全局。
 * - shares：复用 `listShareItems`（内部已做 owner scope + 名称/短码搜索），
 *   非 admin 仅本人分享，admin 全局；取前 10 条。
 * 所有 LIKE 均经 `escapeLike` + `ESCAPE '\\'`，杜绝 `% _` 通配注入 / 全量放大。
 * 空 q（trim 后为空）直接返回三组空数组（200），不视为错误。
 *
 * @route GET /api/search
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含 files / texts / shares 三组命中（各 ≤10）
 *
 * @example
 * // 查询参数
 * // q: 搜索关键词（trim 后为空或过短返回空分组；超过 200 字符截断）
 *
 * // 成功响应 (200)
 * {
 *   "files": [
 *     {
 *       "id": "uuid",
 *       "filename": "report.pdf",
 *       "r2_key": "flares3/cfg/report.pdf",
 *       "size": 1048576,
 *       "created_at": "2026-10-01T00:00:00.000Z",
 *       "config_id": "uuid"
 *     }
 *   ],
 *   "texts": [
 *     {
 *       "id": "uuid",
 *       "title": "周报",
 *       "content_preview": "本周完成...",
 *       "updated_at": "2026-10-02T00:00:00.000Z"
 *     }
 *   ],
 *   "shares": [
 *     {
 *       "type": "file",
 *       "resource_id": "uuid",
 *       "resource_name": "report.pdf",
 *       "share_code": "abc123",
 *       "share_url": "/f/abc123",
 *       "created_at": "2026-10-03T00:00:00.000Z"
 *     }
 *   ]
 * }
 *
 * // 空关键词 (200)
 * { "files": [], "texts": [], "shares": [] }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 */
export async function globalSearch(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const timings: RouteTimingEntry[] = []
  const url = new URL(request.url)
  const rawQuery = String(url.searchParams.get('q') ?? '').trim()
  const query = rawQuery.slice(0, MAX_SEARCH_QUERY_LENGTH)

  // 空关键词：返回三组空数组（200），避免无过滤的全量扫描 / 误报错。
  if (!query) {
    return withRouteTimingHeaders(jsonResponse({ files: [], texts: [], shares: [] }), timings)
  }

  const like = `%${escapeLike(query)}%`
  const isAdmin = user.role === 'admin'

  const [files, texts, shares] = await Promise.all([
    measureRouteStep(timings, 'searchFiles', () => searchFiles(env, user.id, isAdmin, like)),
    measureRouteStep(timings, 'searchTexts', () => searchTexts(env, user.id, isAdmin, like)),
    measureRouteStep(timings, 'searchShares', () => searchShares(env, user, query, timings)),
  ])

  return withRouteTimingHeaders(jsonResponse({ files, texts, shares }), timings)
}

/** 文件命中：filename LIKE，completed 且未删除，非 admin 限本人。 */
async function searchFiles(
  env: Env,
  userId: string,
  isAdmin: boolean,
  like: string
): Promise<FileSearchHit[]> {
  const conditions = ["f.upload_status = 'completed'", 'f.deleted_at IS NULL']
  const params: unknown[] = []
  if (!isAdmin) {
    conditions.push('f.owner_id = ?')
    params.push(userId)
  }
  conditions.push("f.filename LIKE ? ESCAPE '\\'")
  params.push(like)

  const rows = await withD1Retry(env.DB)
    .prepare(
      `SELECT f.id, f.filename, f.r2_key, f.size, f.created_at, f.config_id
       FROM files f
       WHERE ${conditions.join(' AND ')}
       ORDER BY f.created_at DESC
       LIMIT ?`
    )
    .bind(...params, SEARCH_TOP_N)
    .all<FileSearchHit>()
  return rows.results || []
}

/** 文档命中：title/content LIKE，未删除，非 admin 限本人；附内容片段。 */
async function searchTexts(
  env: Env,
  userId: string,
  isAdmin: boolean,
  like: string
): Promise<TextSearchHit[]> {
  const conditions = ['t.deleted_at IS NULL']
  const params: unknown[] = []
  if (!isAdmin) {
    conditions.push('t.owner_id = ?')
    params.push(userId)
  }
  conditions.push("(t.title LIKE ? ESCAPE '\\' OR t.content LIKE ? ESCAPE '\\')")
  params.push(like, like)

  const rows = await withD1Retry(env.DB)
    .prepare(
      `SELECT t.id, t.title, SUBSTR(t.content, 1, 200) AS content_preview, t.updated_at
       FROM texts t
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.updated_at DESC
       LIMIT ?`
    )
    .bind(...params, SEARCH_TOP_N)
    .all<TextSearchHit>()
  return rows.results || []
}

/**
 * 分享命中：复用 listShareItems（owner scope + 名称/短码搜索 + 排序已内建），
 * 取前 top N 并裁剪为搜索结果所需的精简字段。
 */
async function searchShares(
  env: Env,
  user: NonNullable<ReturnType<typeof getUser>>,
  query: string,
  timings: RouteTimingEntry[]
): Promise<ShareSearchHit[]> {
  const { items } = await listShareItems(
    env,
    user,
    {
      page: 1,
      limit: SEARCH_TOP_N,
      type: '',
      status: '',
      sort_by: '',
      sort_order: '',
      owner_id: '',
      q: query,
      expires_from: '',
      expires_to: '',
    },
    timings
  )
  return items.map((item) => ({
    type: item.type,
    resource_id: item.resource_id,
    resource_name: item.resource_name,
    share_code: item.share_code,
    share_url: item.share_url,
    created_at: item.created_at,
  }))
}
