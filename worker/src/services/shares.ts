import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import type { AuthUser } from '../middleware/authSession'
import { measureRouteStep, type RouteTimingEntry } from '../utils/routeTiming'

export type ShareRecordType = 'file' | 'text' | 'text_one_time'
export type ShareRecordStatus = 'active' | 'expired' | 'exhausted' | 'consumed'
export type ShareSortBy = 'updated_at' | 'expires_at'
export type ShareSortOrder = 'asc' | 'desc'

export type ShareListItem = {
  type: ShareRecordType
  resource_id: string
  resource_name: string
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
  if (normalizeText(row.file_deleted_at)) return null
  if (normalizeText(row.owner_status) !== 'active') return null

  const shareCode = normalizeText(row.share_code)
  return {
    type: 'file',
    resource_id: normalizeText(row.file_id),
    resource_name: normalizeText(row.filename),
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
  if (normalizeText(row.text_deleted_at)) return null
  if (normalizeText(row.owner_status) !== 'active') return null

  const shareCode = normalizeText(row.share_code)
  return {
    type: 'text',
    resource_id: normalizeText(row.text_id),
    resource_name: normalizeText(row.text_title),
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
  if (normalizeText(row.text_deleted_at)) return null
  if (normalizeText(row.owner_status) !== 'active') return null

  const shareCode = normalizeText(row.share_code)
  return {
    type: 'text_one_time',
    resource_id: normalizeText(row.text_id),
    resource_name: normalizeText(row.text_title),
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
  timings: RouteTimingEntry[] = []
): Promise<ShareListItem[]> {
  const rows = await measureRouteStep(timings, 'shareFileRows', () =>
    withD1Retry(db)
      .prepare(
        `SELECT s.file_id, s.owner_id, s.share_code, s.password_hash, s.expires_at, s.max_views, s.views, s.created_at, s.updated_at,
                f.filename, f.deleted_at AS file_deleted_at,
                u.username AS owner_username, u.status AS owner_status
         FROM file_shares s
         LEFT JOIN files f ON f.id = s.file_id
         LEFT JOIN users u ON u.id = s.owner_id`
      )
      .all()
  )

  return (rows.results || [])
    .map((row) => toFileShareItem(row as Record<string, unknown>))
    .filter(Boolean) as ShareListItem[]
}

async function queryTextShares(
  db: D1Database,
  timings: RouteTimingEntry[] = []
): Promise<ShareListItem[]> {
  const rows = await measureRouteStep(timings, 'shareTextRows', () =>
    withD1Retry(db)
      .prepare(
        `SELECT s.text_id, s.owner_id, s.share_code, s.password_hash, s.expires_at, s.max_views, s.views, s.created_at, s.updated_at,
                t.title AS text_title, t.deleted_at AS text_deleted_at,
                u.username AS owner_username, u.status AS owner_status
         FROM text_shares s
         LEFT JOIN texts t ON t.id = s.text_id
         LEFT JOIN users u ON u.id = s.owner_id`
      )
      .all()
  )

  return (rows.results || [])
    .map((row) => toTextShareItem(row as Record<string, unknown>))
    .filter(Boolean) as ShareListItem[]
}

async function queryTextOneTimeShares(
  db: D1Database,
  timings: RouteTimingEntry[] = []
): Promise<ShareListItem[]> {
  const rows = await measureRouteStep(timings, 'shareOneTimeRows', () =>
    withD1Retry(db)
      .prepare(
        `SELECT s.text_id, s.owner_id, s.share_code, s.expires_at, s.consumed_at, s.created_at, s.updated_at,
                t.title AS text_title, t.deleted_at AS text_deleted_at,
                u.username AS owner_username, u.status AS owner_status
         FROM text_one_time_shares s
         LEFT JOIN texts t ON t.id = s.text_id
         LEFT JOIN users u ON u.id = s.owner_id`
      )
      .all()
  )

  return (rows.results || [])
    .map((row) => toTextOneTimeShareItem(row as Record<string, unknown>))
    .filter(Boolean) as ShareListItem[]
}

export async function listShareItems(
  env: Env,
  user: AuthUser,
  filters: ShareListFilters,
  timings: RouteTimingEntry[] = []
): Promise<{ items: ShareListItem[]; total: number }> {
  const [fileItems, textItems, textOneTimeItems] = await Promise.all([
    queryFileShares(env.DB, timings),
    queryTextShares(env.DB, timings),
    queryTextOneTimeShares(env.DB, timings),
  ])

  const effectiveOwnerId = user.role === 'admin' ? normalizeText(filters.owner_id) : user.id
  const normalizedQuery = normalizeSearchText(filters.q)
  const normalizedType = normalizeText(filters.type)
  const normalizedStatus = normalizeText(filters.status)
  const normalizedSortBy = normalizeShareSortBy(filters.sort_by)
  const normalizedSortOrder = normalizeShareSortOrder(filters.sort_order)
  const expiresFromTime = toNullableTime(filters.expires_from)
  const expiresToTime = toNullableTime(filters.expires_to)

  const filtered = await measureRouteStep(timings, 'shareFilterSort', async () =>
    [...fileItems, ...textItems, ...textOneTimeItems]
      .filter(
        (item) => item.owner_id === effectiveOwnerId || (user.role === 'admin' && !effectiveOwnerId)
      )
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
