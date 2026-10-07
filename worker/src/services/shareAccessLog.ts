import { withD1Retry } from '../utils/db'
import { logWarn } from '../utils/log'
import type { Env } from '../config/env'

/** 访问结果枚举：成功 / 口令错误 / 已过期 / 次数耗尽 / 分享或资源不存在 */
export type ShareAccessResult = 'ok' | 'rejected_password' | 'expired' | 'exhausted' | 'not_found'

/** 分享类型枚举：单文件 / 文本 / 文件夹 */
export type ShareAccessLogShareType = 'file' | 'text' | 'folder'

export interface ShareAccessLogItem {
  id: number
  ip: string | null
  user_agent: string | null
  path: string | null
  result: ShareAccessResult
  created_at: string
}

export interface ShareAccessLogPage {
  items: ShareAccessLogItem[]
  total: number
}

/**
 * 尽力而为记录一条分享访问日志。
 *
 * 契约：任何失败（表缺失 / D1 抖动）只 `logWarn('share.access.log.failed')`，
 * 绝不向调用方抛出——访问日志属于可观测性数据，不能阻断分享主流程响应。
 */
export async function recordShareAccess(
  env: Env,
  params: {
    share_type: ShareAccessLogShareType
    share_id: string
    ip?: string | null
    user_agent?: string | null
    path?: string | null
    result: ShareAccessResult
  }
): Promise<void> {
  const shareId = String(params.share_id ?? '')
  if (!shareId) {
    // code 完全未知（找不到分享行）时没有可关联的 share_id，跳过落库
    return
  }

  try {
    await withD1Retry(env.DB)
      .prepare(
        `INSERT INTO share_access_logs
           (share_type, share_id, ip, user_agent, path, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.share_type,
        shareId,
        params.ip ?? null,
        params.user_agent ?? null,
        params.path ?? null,
        params.result,
        new Date().toISOString()
      )
      .run()
  } catch (error) {
    logWarn('share.access.log.failed', {
      shareType: params.share_type,
      shareId,
      result: params.result,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
  }
}

/**
 * 分页查询某条分享的访问日志（id 倒序，最新在前）。
 * page 从 1 开始；total 为该分享的全量行数。
 */
export async function listShareAccessLogs(
  db: D1Database,
  params: {
    share_type: ShareAccessLogShareType
    share_id: string
    page: number
    limit: number
  }
): Promise<ShareAccessLogPage> {
  const offset = Math.max(0, (params.page - 1) * params.limit)

  const rowsResult = await withD1Retry(db)
    .prepare(
      `SELECT id, ip, user_agent, path, result, created_at
       FROM share_access_logs
       WHERE share_type = ? AND share_id = ?
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    )
    .bind(params.share_type, params.share_id, params.limit, offset)
    .all<ShareAccessLogItem>()

  const countResult = await withD1Retry(db)
    .prepare(
      `SELECT COUNT(*) AS total
       FROM share_access_logs
       WHERE share_type = ? AND share_id = ?`
    )
    .bind(params.share_type, params.share_id)
    .first<{ total: number }>()

  const rows = Array.isArray(rowsResult?.results) ? rowsResult.results : []
  const total = Number(countResult?.total ?? 0)

  return {
    items: rows.map((row) => ({
      id: Number(row.id),
      ip: row.ip ?? null,
      user_agent: row.user_agent ?? null,
      path: row.path ?? null,
      result: row.result,
      created_at: row.created_at,
    })),
    total: Number.isFinite(total) ? total : 0,
  }
}
