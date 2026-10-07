import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { generateRandomCode } from '../utils/random'
import { SHARE_SHORT_CODE_LENGTH } from '../utils/codePolicy'
import { SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE } from './shareViewGuard'

/** folder 分享行（不含 password_hash 的公开形态见 resolveFolderShareRecord 返回） */
export type FolderShareRow = {
  id: string
  config_id: string
  prefix: string
  owner_id: string
  share_code: string
  password_hash: string | null
  expires_in: number
  expires_at: string | null
  max_views: number
  views: number
  created_at: string
  updated_at: string
}

function toFolderShareRow(row: Record<string, unknown> | null): FolderShareRow | null {
  if (!row) return null
  return {
    id: String(row.id ?? ''),
    config_id: String(row.config_id ?? ''),
    prefix: String(row.prefix ?? ''),
    owner_id: String(row.owner_id ?? ''),
    share_code: String(row.share_code ?? ''),
    password_hash: row.password_hash ? String(row.password_hash) : null,
    expires_in: Number(row.expires_in ?? 0) || 0,
    expires_at: row.expires_at ? String(row.expires_at) : null,
    max_views: Number(row.max_views ?? 0) || 0,
    views: Number(row.views ?? 0) || 0,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  }
}

const FOLDER_SHARE_SELECT = `SELECT id, config_id, prefix, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at
   FROM folder_shares`

/**
 * 生成跨分享表唯一的短码。
 *
 * /f/:code 命名空间由 file_shares 与 folder_shares 共享（text 系列在 /t、/s 下，
 * 一并查重保险），创建时先查三表确认未占用再落库；UNIQUE 约束兜底并发窗口。
 * 10 次尝试全部撞码（概率可忽略）返回 null，由调用方回 500。
 */
export async function generateUniqueFolderShareCode(db: D1Database): Promise<string | null> {
  for (let i = 0; i < 10; i += 1) {
    const code = generateRandomCode(SHARE_SHORT_CODE_LENGTH)
    const rows = await Promise.all([
      withD1Retry(db)
        .prepare('SELECT 1 AS hit FROM file_shares WHERE share_code = ? LIMIT 1')
        .bind(code)
        .first(),
      withD1Retry(db)
        .prepare('SELECT 1 AS hit FROM text_shares WHERE share_code = ? LIMIT 1')
        .bind(code)
        .first(),
      withD1Retry(db)
        .prepare('SELECT 1 AS hit FROM folder_shares WHERE share_code = ? LIMIT 1')
        .bind(code)
        .first(),
    ])
    if (rows.every((row) => !row)) {
      return code
    }
  }
  return null
}

export async function findFolderShareByCode(
  db: D1Database,
  code: string
): Promise<FolderShareRow | null> {
  const row = await withD1Retry(db)
    .prepare(`${FOLDER_SHARE_SELECT} WHERE share_code = ? LIMIT 1`)
    .bind(code)
    .first()
  return toFolderShareRow(row as Record<string, unknown> | null)
}

export async function findFolderShareByScope(
  db: D1Database,
  configId: string,
  prefix: string
): Promise<FolderShareRow | null> {
  const row = await withD1Retry(db)
    .prepare(`${FOLDER_SHARE_SELECT} WHERE config_id = ? AND prefix = ? LIMIT 1`)
    .bind(configId, prefix)
    .first()
  return toFolderShareRow(row as Record<string, unknown> | null)
}

export type ResolvedFolderShare = {
  share: {
    id: string
    config_id: string
    prefix: string
    share_code: string
    password_hash: string | null
    expires_at: string | null
    max_views: number
    views: number
  }
}

/** error.shareId：分享行存在时携带（供访问日志关联）；行不存在时省略 */
export type ResolveFolderShareError = { status: number; message: string; shareId?: string }

/**
 * 按 code 解析 folder 分享并对齐 resolveFileShareRecord 的守卫矩阵：
 * 行不存在 404 / owner 非 active 404 / 分享过期 410 / 次数耗尽 410。
 */
export async function resolveFolderShareRecord(
  env: Env,
  code: string
): Promise<{ error: ResolveFolderShareError } | ResolvedFolderShare> {
  const row = await withD1Retry(env.DB)
    .prepare(
      `SELECT s.id, s.config_id, s.prefix, s.share_code, s.password_hash, s.expires_at, s.max_views, s.views,
              u.status AS owner_status
       FROM folder_shares s
       LEFT JOIN users u ON u.id = s.owner_id
       WHERE s.share_code = ?
       LIMIT 1`
    )
    .bind(code)
    .first()

  if (!row) {
    return { error: { status: 404, message: '分享链接不存在' } }
  }

  const rowShareId = String((row as any).id ?? '')

  if (String((row as any).owner_status || '') !== 'active') {
    return { error: { status: 404, message: '分享链接不存在', shareId: rowShareId } }
  }

  const shareExpiresAtRaw = (row as any).expires_at ? String((row as any).expires_at).trim() : ''
  if (shareExpiresAtRaw) {
    const shareExpiresAtMs = new Date(shareExpiresAtRaw).getTime()
    if (Number.isNaN(shareExpiresAtMs)) {
      return { error: { status: 500, message: '链接过期时间无效', shareId: rowShareId } }
    }
    if (Date.now() > shareExpiresAtMs) {
      return { error: { status: 410, message: '链接已过期', shareId: rowShareId } }
    }
  }

  const maxViews = Number((row as any).max_views ?? 0)
  const views = Number((row as any).views ?? 0)
  const safeMaxViews = Number.isFinite(maxViews) ? Math.floor(maxViews) : 0
  const safeViews = Number.isFinite(views) ? Math.floor(views) : 0
  if (safeMaxViews > 0 && safeViews >= safeMaxViews) {
    return {
      error: {
        status: 410,
        message: SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE,
        shareId: rowShareId,
      },
    }
  }

  return {
    share: {
      id: String((row as any).id),
      config_id: String((row as any).config_id),
      prefix: String((row as any).prefix ?? ''),
      share_code: String((row as any).share_code),
      password_hash: (row as any).password_hash ? String((row as any).password_hash) : null,
      expires_at: shareExpiresAtRaw || null,
      max_views: safeMaxViews,
      views: safeViews,
    },
  }
}
