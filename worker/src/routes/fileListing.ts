import type { Env } from '../config/env'
import { jsonResponse, getUser, calcPresignedDownloadUrlTtlSeconds } from './utils'
import { generateDownloadUrl, resolveR2ConfigForKey } from '../services/r2'
import { getExplicitProviderConfigId, getFileStorageConfigId } from '../services/fileStorage'
import {
  measureRouteStep,
  withRouteTimingHeaders,
  type RouteTimingEntry,
} from '../utils/routeTiming'

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

export async function listFiles(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  const timings: RouteTimingEntry[] = []

  const url = new URL(request.url)
  const page = Math.max(1, Number(url.searchParams.get('page') || 1))
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)))
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
    conditions.push('f.filename LIKE ?')
    params.push(`%${filename.trim()}%`)
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
      env.DB.prepare(`SELECT COUNT(*) AS total FROM files f ${whereClause}`)
        .bind(...params)
        .first('total')
    ),
    measureRouteStep(timings, 'dbRows', () =>
      env.DB.prepare(
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

export async function listTrashFiles(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)
  const timings: RouteTimingEntry[] = []

  const url = new URL(request.url)
  const page = Math.max(1, Number(url.searchParams.get('page') || 1))
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)))
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
    conditions.push('f.filename LIKE ?')
    params.push(`%${filename.trim()}%`)
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
      env.DB.prepare(`SELECT COUNT(*) AS total FROM files f ${whereClause}`)
        .bind(...params)
        .first('total')
    ),
    measureRouteStep(timings, 'dbRows', () =>
      env.DB.prepare(
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
