import { withD1Retry } from '../utils/db'
import { escapeLike } from '../utils/escapeLike'
import type { Env } from '../config/env'
import type { AuthUser } from '../middleware/authSession'
import { logWarn } from '../utils/log'
import { measureRouteStep, type RouteTimingEntry } from '../utils/routeTiming'

export type ShareRecordType = 'file' | 'text' | 'text_one_time' | 'folder'
export type ShareRecordStatus = 'active' | 'expired' | 'exhausted' | 'consumed'
export type ShareSortBy = 'updated_at' | 'expires_at'
export type ShareSortOrder = 'asc' | 'desc'

export type ShareListItem = {
  type: ShareRecordType
  resource_id: string
  resource_name: string
  /** folder 分享的挂载点名称（其余类型为 null） */
  config_name: string | null
  owner_id: string
  owner_username: string
  share_code: string
  share_url: string
  status: ShareRecordStatus
  views: number | null
  max_views: number | null
  has_password: boolean
  expires_at: string | null
  consumed_at: string | null
  created_at: string
  updated_at: string
}

type ShareListFilters = {
  page: number
  limit: number
  type: string
  status: string
  sort_by: string
  sort_order: string
  owner_id: string
  q: string
  expires_from: string
  expires_to: string
}

/**
 * 单张分享表的扫描上限。四张表结构不同（过滤键 / 排序键 / 列数均不一致），
 * 跨表筛选与排序在内存完成，若不做限制就只能全表载入，表增长后单次请求的
 * 内存与 CPU 无界。超过上限时按当前排序键保留前 N 条并记 warn 日志
 * （列表本身已分页，登录用户在列表页最多消费 limit ≤ 100 条）。
 */
const SHARE_QUERY_SCAN_LIMIT = 2000

/** 分享列表只支持按 expires_at 过滤；该哨兵表示「永不过期」，不参与范围过滤。 */
const NEVER_EXPIRES_AT_ISO = '9999-12-31T23:59:59.999Z'

/**
 * 排序键上界哨兵：ISO 时间串定长且字典序等价于时间序，
 * 用它把「无过期时间」（NULL / 空串 / 哨兵）统一排到升序末尾。
 */
const SORT_KEY_ENDS_AT_ISO = '9999-12-31T23:59:59.999Z~'

/**
 * SQL 层能消费的过滤条件（与 `listShareItems` 的内存过滤口径保持一致）。
 *
 * 时间条件用 SQLite 的 `julianday` 比较而非字符串比较：`expires_at` 可能带时区偏移
 * （如 `+08:00`），字典序与真实时间序不一致。`julianday` 返回 NULL 时比较结果为 NULL，
 * 自然被 WHERE 排除，与内存侧「无过期时间不命中范围」的语义一致。
 */
const SQL_EXPIRES_TIME = `julianday(NULLIF(s.expires_at, ''))`
const SQL_EXPIRES_TIME_NEVER = `julianday(NULLIF(s.expires_at, ''), '+1 day')`
const SQL_EXPIRES_TIME_END = `julianday(NULLIF(s.expires_at, ''), '9999 years')`

/**
 * 把内存过滤条件按表下推为 SQL WHERE 子句。
 *
 * 只下推各表公共、可静态绑定的条件：非 admin 的 owner 限界、过期时间范围、q 搜索。
 * `type` / `status` 不下推——四张表异构，逐表判定会把可读性换成一堆特例分支，
 * 收益有限；分页与排序仍由内存路径统一负责（跨表合并排序无法在单条 SQL 内完成）。
 *
 * @param isAdmin - 管理员可见全部；非管理员必须限本人（对应内存侧的 owner 校验）
 * @param includeOwnerSearch - file/text 表在 admin 下额外按 owner 用户名 / ID 搜索；
 *   folder 表不 JOIN users，无法搜索 owner 字段，故保持与内存侧 `matchesShareQuery` 一致
 * @param normalizedQuery - 已小写的搜索词（空串表示不过滤）
 * @param expiresFromTime - 过期时间下界（毫秒时间戳，null 表示不限）
 * @param expiresToTime - 过期时间上界（毫秒时间戳，开区间，null 表示不限）
 * @param userId - 当前登录用户 ID（非 admin 时的 owner 限界值）
 */
function buildShareSqlFilters(options: {
  isAdmin: boolean
  includeOwnerSearch: boolean
  normalizedQuery: string
  expiresFromTime: number | null
  expiresToTime: number | null
  userId: string
}): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (!options.isAdmin) {
    conditions.push('s.owner_id = ?')
    params.push(options.userId)
  }

  if (options.normalizedQuery) {
    const like = `%${escapeLike(options.normalizedQuery)}%`
    const searchClauses = [
      "LOWER(COALESCE(s.share_code, '')) LIKE ? ESCAPE '\\'",
      "LOWER(COALESCE(s.resource_name, '')) LIKE ? ESCAPE '\\'",
    ]
    params.push(like, like)

    if (options.includeOwnerSearch) {
      searchClauses.push("LOWER(COALESCE(u.username, '')) LIKE ? ESCAPE '\\'")
      searchClauses.push("LOWER(COALESCE(s.owner_id, '')) LIKE ? ESCAPE '\\'")
      params.push(like, like)
    }

    conditions.push(`(${searchClauses.join(' OR ')})`)
  }

  // 范围过滤：哨兵（永不过期）与无效时间不命中，与内存侧一致
  if (options.expiresFromTime !== null) {
    conditions.push(`${SQL_EXPIRES_TIME} >= ${SQL_EXPIRES_TIME_NEVER}`)
    conditions.push(`${SQL_EXPIRES_TIME} >= julianday(?)`)
    params.push(options.expiresFromTime)
  }

  if (options.expiresToTime !== null) {
    conditions.push(`${SQL_EXPIRES_TIME} < ${SQL_EXPIRES_TIME_END}`)
    conditions.push(`${SQL_EXPIRES_TIME} < julianday(?)`)
    params.push(options.expiresToTime)
  }

  return { conditions, params }
}

/**
 * 扫描条数超过上限时告警：结果已按排序键截断，属于「不完整但稳定」的降级，
 * 需要人工关注（表规模已超出当前实现的设计容量）。
 */
function logShareScanTruncated(source: string, rowCount: number): void {
  if (rowCount <= SHARE_QUERY_SCAN_LIMIT) return
  logWarn('share.list.scan.truncated', {
    source,
    scanned: rowCount,
    limit: SHARE_QUERY_SCAN_LIMIT,
  })
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeNullableText(value: unknown): string | null {
  const normalized = normalizeText(value)
  return normalized || null
}

function normalizeNumber(value: unknown): number {
  const num = Number(value ?? 0)
  return Number.isFinite(num) ? num : 0
}

function toTime(value: unknown): number {
  const text = normalizeText(value)
  if (!text) return 0
  const time = new Date(text).getTime()
  return Number.isFinite(time) ? time : 0
}

function toNullableTime(value: unknown): number | null {
  const text = normalizeText(value)
  if (!text) return null
  const time = new Date(text).getTime()
  return Number.isFinite(time) ? time : null
}

function normalizeShareSortBy(value: unknown): ShareSortBy {
  return normalizeText(value) === 'expires_at' ? 'expires_at' : 'updated_at'
}

function normalizeShareSortOrder(value: unknown): ShareSortOrder {
  return normalizeText(value) === 'asc' ? 'asc' : 'desc'
}

function compareNumbers(left: number, right: number, order: ShareSortOrder): number {
  return order === 'asc' ? left - right : right - left
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  order: ShareSortOrder
): number {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return compareNumbers(left, right, order)
}

function compareShareItems(
  left: ShareListItem,
  right: ShareListItem,
  sortBy: ShareSortBy,
  sortOrder: ShareSortOrder
): number {
  if (sortBy === 'expires_at') {
    const expiresDiff = compareNullableNumbers(
      toNullableTime(left.expires_at),
      toNullableTime(right.expires_at),
      sortOrder
    )
    if (expiresDiff !== 0) {
      return expiresDiff
    }
  } else {
    const updatedDiff = compareNumbers(toTime(left.updated_at), toTime(right.updated_at), sortOrder)
    if (updatedDiff !== 0) {
      return updatedDiff
    }
  }

  const updatedFallback = compareNumbers(toTime(left.updated_at), toTime(right.updated_at), 'desc')
  if (updatedFallback !== 0) {
    return updatedFallback
  }

  return `${left.type}:${left.resource_id}`.localeCompare(`${right.type}:${right.resource_id}`)
}

function normalizeSearchText(value: unknown): string {
  return normalizeText(value).toLowerCase()
}

function includesSearchText(value: unknown, query: string): boolean {
  return normalizeSearchText(value).includes(query)
}

function matchesShareQuery(item: ShareListItem, user: AuthUser, query: string): boolean {
  if (!query) return true

  const baseFields = [item.resource_name, item.share_code]
  if (baseFields.some((value) => includesSearchText(value, query))) {
    return true
  }

  if (user.role !== 'admin') {
    return false
  }

  return [item.owner_username, item.owner_id].some((value) => includesSearchText(value, query))
}

function isExpired(isoString: unknown): boolean {
  const text = normalizeText(isoString)
  if (!text) return false
  const time = new Date(text).getTime()
  return Number.isFinite(time) && time <= Date.now()
}

function matchesExpiresRange(
  item: ShareListItem,
  expiresFromTime: number | null,
  expiresToTime: number | null
): boolean {
  const hasRange = expiresFromTime !== null || expiresToTime !== null
  if (!hasRange) return true

  const expiresAtTime = toNullableTime(item.expires_at)
  if (expiresAtTime === null) {
    return false
  }

  if (expiresFromTime !== null && expiresAtTime < expiresFromTime) {
    return false
  }

  if (expiresToTime !== null && expiresAtTime >= expiresToTime) {
    return false
  }

  return true
}

function resolveStandardShareStatus(row: {
  expires_at?: unknown
  max_views?: unknown
  views?: unknown
}): ShareRecordStatus {
  if (isExpired(row.expires_at)) return 'expired'

  const maxViews = normalizeNumber(row.max_views)
  const views = normalizeNumber(row.views)
  if (maxViews > 0 && views >= maxViews) {
    return 'exhausted'
  }

  return 'active'
}

function resolveOneTimeShareStatus(row: {
  expires_at?: unknown
  consumed_at?: unknown
}): ShareRecordStatus {
  if (normalizeText(row.consumed_at)) return 'consumed'
  if (isExpired(row.expires_at)) return 'expired'
  return 'active'
}

function toFileShareItem(row: Record<string, unknown>): ShareListItem | null {
  if (normalizeText(row.resource_deleted_at)) return null
  if (normalizeText(row.owner_status) !== 'active') return null

  const shareCode = normalizeText(row.share_code)
  return {
    type: 'file',
    resource_id: normalizeText(row.file_id),
    resource_name: normalizeText(row.resource_name),
    config_name: null,
    owner_id: normalizeText(row.owner_id),
    owner_username: normalizeText(row.owner_username),
    share_code: shareCode,
    share_url: `/f/${shareCode}`,
    status: resolveStandardShareStatus(row),
    views: normalizeNumber(row.views),
    max_views: normalizeNumber(row.max_views),
    has_password: Boolean(normalizeText(row.password_hash)),
    expires_at: normalizeNullableText(row.expires_at),
    consumed_at: null,
    created_at: normalizeText(row.created_at),
    updated_at: normalizeText(row.updated_at),
  }
}

function toTextShareItem(row: Record<string, unknown>): ShareListItem | null {
  if (normalizeText(row.resource_deleted_at)) return null
  if (normalizeText(row.owner_status) !== 'active') return null

  const shareCode = normalizeText(row.share_code)
  return {
    type: 'text',
    resource_id: normalizeText(row.text_id),
    resource_name: normalizeText(row.resource_name),
    config_name: null,
    owner_id: normalizeText(row.owner_id),
    owner_username: normalizeText(row.owner_username),
    share_code: shareCode,
    share_url: `/t/${shareCode}`,
    status: resolveStandardShareStatus(row),
    views: normalizeNumber(row.views),
    max_views: normalizeNumber(row.max_views),
    has_password: Boolean(normalizeText(row.password_hash)),
    expires_at: normalizeNullableText(row.expires_at),
    consumed_at: null,
    created_at: normalizeText(row.created_at),
    updated_at: normalizeText(row.updated_at),
  }
}

function toTextOneTimeShareItem(row: Record<string, unknown>): ShareListItem | null {
  if (normalizeText(row.resource_deleted_at)) return null
  if (normalizeText(row.owner_status) !== 'active') return null

  const shareCode = normalizeText(row.share_code)
  return {
    type: 'text_one_time',
    resource_id: normalizeText(row.text_id),
    resource_name: normalizeText(row.resource_name),
    config_name: null,
    owner_id: normalizeText(row.owner_id),
    owner_username: normalizeText(row.owner_username),
    share_code: shareCode,
    share_url: `/s/${shareCode}`,
    status: resolveOneTimeShareStatus(row),
    views: null,
    max_views: null,
    has_password: false,
    expires_at: normalizeNullableText(row.expires_at),
    consumed_at: normalizeNullableText(row.consumed_at),
    created_at: normalizeText(row.created_at),
    updated_at: normalizeText(row.updated_at),
  }
}

async function queryFileShares(
  db: D1Database,
  sqlFilters: { conditions: string[]; params: unknown[] },
  sortBy: ShareSortBy,
  sortOrder: ShareSortOrder,
  timings: RouteTimingEntry[] = []
): Promise<ShareListItem[]> {
  const where = sqlFilters.conditions.length ? `WHERE ${sqlFilters.conditions.join(' AND ')}` : ''
  const rows = await measureRouteStep(timings, 'shareFileRows', () =>
    withD1Retry(db)
      .prepare(
        `SELECT s.file_id, s.owner_id, s.share_code, s.password_hash, s.expires_at, s.max_views, s.views, s.created_at, s.updated_at,
                f.filename AS resource_name, f.deleted_at AS resource_deleted_at,
                u.username AS owner_username, u.status AS owner_status
         FROM file_shares s
         LEFT JOIN files f ON f.id = s.file_id
         LEFT JOIN users u ON u.id = s.owner_id
         ${where}
         ORDER BY ${buildShareSortKey('s.expires_at', sortBy, sortOrder)},
                  ${buildShareSortKey('s.updated_at', sortBy, 'desc')},
                  s.file_id ASC
         LIMIT ?`
      )
      .bind(...sqlFilters.params, SHARE_QUERY_SCAN_LIMIT + 1)
      .all()
  )

  const results = rows.results || []
  logShareScanTruncated('file_shares', results.length)
  return results
    .slice(0, SHARE_QUERY_SCAN_LIMIT)
    .map((row) => toFileShareItem(row as Record<string, unknown>))
    .filter(Boolean) as ShareListItem[]
}

/**
 * 单表排序键：NULL / 空串 / 永不过期哨兵统一映射为 `SORT_KEY_ENDS_AT_ISO`，
 * 其余取原值。ISO 时间串为定长字典序，故可直接用 MAX/MIN + COLLATE NOCASE 比较，
 * 无需在 SQL 里做日期解析。与内存侧 `compareNullableNumbers` 的「null 末位」一致。
 */
function buildShareSortKey(column: string, sortBy: ShareSortBy, sortOrder: ShareSortOrder): string {
  const isNeverExpires = `(${column} IS NULL OR ${column} = '' OR ${column} = '${NEVER_EXPIRES_AT_ISO}')`
  if (sortBy === 'expires_at') {
    const key = `CASE WHEN ${isNeverExpires} THEN '${SORT_KEY_ENDS_AT_ISO}' ELSE ${column} END`
    return `${key} COLLATE NOCASE ${sortOrder === 'asc' ? 'ASC' : 'DESC'}`
  }
  return `${column} COLLATE NOCASE ${sortOrder === 'asc' ? 'ASC' : 'DESC'}`
}

async function queryTextShares(
  db: D1Database,
  sqlFilters: { conditions: string[]; params: unknown[] },
  sortBy: ShareSortBy,
  sortOrder: ShareSortOrder,
  timings: RouteTimingEntry[] = []
): Promise<ShareListItem[]> {
  const where = sqlFilters.conditions.length ? `WHERE ${sqlFilters.conditions.join(' AND ')}` : ''
  const rows = await measureRouteStep(timings, 'shareTextRows', () =>
    withD1Retry(db)
      .prepare(
        `SELECT s.text_id, s.owner_id, s.share_code, s.password_hash, s.expires_at, s.max_views, s.views, s.created_at, s.updated_at,
                t.title AS resource_name, t.deleted_at AS resource_deleted_at,
                u.username AS owner_username, u.status AS owner_status
         FROM text_shares s
         LEFT JOIN texts t ON t.id = s.text_id
         LEFT JOIN users u ON u.id = s.owner_id
         ${where}
         ORDER BY ${buildShareSortKey('s.expires_at', sortBy, sortOrder)},
                  ${buildShareSortKey('s.updated_at', sortBy, 'desc')},
                  s.text_id ASC
         LIMIT ?`
      )
      .bind(...sqlFilters.params, SHARE_QUERY_SCAN_LIMIT + 1)
      .all()
  )

  const results = rows.results || []
  logShareScanTruncated('text_shares', results.length)
  return results
    .slice(0, SHARE_QUERY_SCAN_LIMIT)
    .map((row) => toTextShareItem(row as Record<string, unknown>))
    .filter(Boolean) as ShareListItem[]
}

async function queryTextOneTimeShares(
  db: D1Database,
  sqlFilters: { conditions: string[]; params: unknown[] },
  sortBy: ShareSortBy,
  sortOrder: ShareSortOrder,
  timings: RouteTimingEntry[] = []
): Promise<ShareListItem[]> {
  const where = sqlFilters.conditions.length ? `WHERE ${sqlFilters.conditions.join(' AND ')}` : ''
  const rows = await measureRouteStep(timings, 'shareOneTimeRows', () =>
    withD1Retry(db)
      .prepare(
        `SELECT s.text_id, s.owner_id, s.share_code, s.expires_at, s.consumed_at, s.created_at, s.updated_at,
                t.title AS resource_name, t.deleted_at AS resource_deleted_at,
                u.username AS owner_username, u.status AS owner_status
         FROM text_one_time_shares s
         LEFT JOIN texts t ON t.id = s.text_id
         LEFT JOIN users u ON u.id = s.owner_id
         ${where}
         ORDER BY ${buildShareSortKey('s.expires_at', sortBy, sortOrder)},
                  ${buildShareSortKey('s.updated_at', sortBy, 'desc')},
                  s.text_id ASC
         LIMIT ?`
      )
      .bind(...sqlFilters.params, SHARE_QUERY_SCAN_LIMIT + 1)
      .all()
  )

  const results = rows.results || []
  logShareScanTruncated('text_one_time_shares', results.length)
  return results
    .slice(0, SHARE_QUERY_SCAN_LIMIT)
    .map((row) => toTextOneTimeShareItem(row as Record<string, unknown>))
    .filter(Boolean) as ShareListItem[]
}

function toFolderShareItem(row: Record<string, unknown>): ShareListItem | null {
  if (normalizeText(row.owner_status) !== 'active') return null

  const shareCode = normalizeText(row.share_code)
  return {
    type: 'folder',
    resource_id: normalizeText(row.id),
    resource_name: normalizeText(row.resource_name),
    config_name: normalizeNullableText(row.config_name),
    owner_id: normalizeText(row.owner_id),
    owner_username: normalizeText(row.owner_username),
    share_code: shareCode,
    share_url: `/f/${shareCode}`,
    status: resolveStandardShareStatus(row),
    views: normalizeNumber(row.views),
    max_views: normalizeNumber(row.max_views),
    has_password: Boolean(normalizeText(row.password_hash)),
    expires_at: normalizeNullableText(row.expires_at),
    consumed_at: null,
    created_at: normalizeText(row.created_at),
    updated_at: normalizeText(row.updated_at),
  }
}

async function queryFolderShares(
  db: D1Database,
  sqlFilters: { conditions: string[]; params: unknown[] },
  sortBy: ShareSortBy,
  sortOrder: ShareSortOrder,
  timings: RouteTimingEntry[] = []
): Promise<ShareListItem[]> {
  try {
    const where = sqlFilters.conditions.length ? `WHERE ${sqlFilters.conditions.join(' AND ')}` : ''
    const rows = await measureRouteStep(timings, 'shareFolderRows', () =>
      withD1Retry(db)
        .prepare(
          `SELECT s.id, s.owner_id, s.share_code, s.password_hash, s.expires_at, s.max_views, s.views, s.created_at, s.updated_at,
                  s.prefix AS resource_name,
                  COALESCE(rc.name, wc.name) AS config_name,
                  u.username AS owner_username, u.status AS owner_status
           FROM folder_shares s
           LEFT JOIN r2_configs rc ON rc.id = s.config_id
           LEFT JOIN webdav_configs wc ON wc.id = s.config_id
           LEFT JOIN users u ON u.id = s.owner_id
           ${where}
           ORDER BY ${buildShareSortKey('s.expires_at', sortBy, sortOrder)},
                    ${buildShareSortKey('s.updated_at', sortBy, 'desc')},
                    s.id ASC
           LIMIT ?`
        )
        .bind(...sqlFilters.params, SHARE_QUERY_SCAN_LIMIT + 1)
        .all()
    )

    const results = rows.results || []
    logShareScanTruncated('folder_shares', results.length)
    return results
      .slice(0, SHARE_QUERY_SCAN_LIMIT)
      .map((row) => toFolderShareItem(row as Record<string, unknown>))
      .filter(Boolean) as ShareListItem[]
  } catch (error) {
    // folder_shares 表缺失（migration 未跑）等场景下降级为空列表，
    // 不阻断 file/text 分享的既有列表行为
    logWarn('share.folder.list.failed', {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
    return []
  }
}

export async function listShareItems(
  env: Env,
  user: AuthUser,
  filters: ShareListFilters,
  timings: RouteTimingEntry[] = []
): Promise<{ items: ShareListItem[]; total: number }> {
  const effectiveOwnerId = user.role === 'admin' ? normalizeText(filters.owner_id) : user.id
  const normalizedQuery = normalizeSearchText(filters.q)
  const normalizedType = normalizeText(filters.type)
  const normalizedStatus = normalizeText(filters.status)
  const normalizedSortBy = normalizeShareSortBy(filters.sort_by)
  const normalizedSortOrder = normalizeShareSortOrder(filters.sort_order)
  const expiresFromTime = toNullableTime(filters.expires_from)
  const expiresToTime = toNullableTime(filters.expires_to)
  const isAdmin = user.role === 'admin'

  const [fileItems, textItems, textOneTimeItems, folderItems] = await Promise.all([
    queryFileShares(
      env.DB,
      buildShareSqlFilters({
        isAdmin,
        includeOwnerSearch: isAdmin,
        normalizedQuery,
        expiresFromTime,
        expiresToTime,
        userId: user.id,
      }),
      normalizedSortBy,
      normalizedSortOrder,
      timings
    ),
    queryTextShares(
      env.DB,
      buildShareSqlFilters({
        isAdmin,
        includeOwnerSearch: isAdmin,
        normalizedQuery,
        expiresFromTime,
        expiresToTime,
        userId: user.id,
      }),
      normalizedSortBy,
      normalizedSortOrder,
      timings
    ),
    queryTextOneTimeShares(
      env.DB,
      buildShareSqlFilters({
        isAdmin,
        includeOwnerSearch: isAdmin,
        normalizedQuery,
        expiresFromTime,
        expiresToTime,
        userId: user.id,
      }),
      normalizedSortBy,
      normalizedSortOrder,
      timings
    ),
    queryFolderShares(
      env.DB,
      // folder 表不 JOIN users，无法按 owner 用户名 / ID 搜索，故不下推 owner 搜索条件
      buildShareSqlFilters({
        isAdmin,
        includeOwnerSearch: false,
        normalizedQuery,
        expiresFromTime,
        expiresToTime,
        userId: user.id,
      }),
      normalizedSortBy,
      normalizedSortOrder,
      timings
    ),
  ])

  const filtered = await measureRouteStep(timings, 'shareFilterSort', async () =>
    [...fileItems, ...textItems, ...textOneTimeItems, ...folderItems]
      .filter((item) => item.owner_id === effectiveOwnerId || (isAdmin && !effectiveOwnerId))
      .filter((item) => matchesShareQuery(item, user, normalizedQuery))
      .filter((item) => !normalizedType || item.type === normalizedType)
      .filter((item) => !normalizedStatus || item.status === normalizedStatus)
      .filter((item) => matchesExpiresRange(item, expiresFromTime, expiresToTime))
      .sort((left, right) => compareShareItems(left, right, normalizedSortBy, normalizedSortOrder))
  )

  const total = filtered.length
  const offset = (filters.page - 1) * filters.limit
  const items = filtered.slice(offset, offset + filters.limit)

  return { items, total }
}
