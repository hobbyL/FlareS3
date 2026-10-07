import { withD1Retry } from '../utils/db'
export const SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE = '访问次数已用尽'

type ShareViewConsumeResult = {
  consumed: boolean
}

async function consumeShareViewIfAllowed(
  db: D1Database,
  statement: string,
  shareId: string
): Promise<ShareViewConsumeResult> {
  const now = new Date().toISOString()
  const result = await withD1Retry(db).prepare(statement).bind(now, shareId).run()

  if (result.error) {
    throw new Error(String(result.error))
  }

  return { consumed: Number(result.meta?.changes ?? 0) > 0 }
}

export async function consumeFileShareViewIfAllowed(
  db: D1Database,
  shareId: string
): Promise<ShareViewConsumeResult> {
  return consumeShareViewIfAllowed(
    db,
    `UPDATE file_shares
     SET views = views + 1, updated_at = ?
     WHERE id = ? AND (max_views = 0 OR views < max_views)`,
    shareId
  )
}

export async function consumeTextShareViewIfAllowed(
  db: D1Database,
  shareId: string
): Promise<ShareViewConsumeResult> {
  return consumeShareViewIfAllowed(
    db,
    `UPDATE text_shares
     SET views = views + 1, updated_at = ?
     WHERE id = ? AND (max_views = 0 OR views < max_views)`,
    shareId
  )
}

export async function consumeFolderShareViewIfAllowed(
  db: D1Database,
  shareId: string
): Promise<ShareViewConsumeResult> {
  return consumeShareViewIfAllowed(
    db,
    `UPDATE folder_shares
     SET views = views + 1, updated_at = ?
     WHERE id = ? AND (max_views = 0 OR views < max_views)`,
    shareId
  )
}
