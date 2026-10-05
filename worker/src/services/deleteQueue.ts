import { withD1Retry } from '../utils/db'
export type DeleteQueueFile = {
  id: string
  r2_key: string
}

export function prepareEnqueueFileDeletionIfNeeded(
  db: D1Database,
  file: DeleteQueueFile,
  createdAt: string = new Date().toISOString()
): D1PreparedStatement {
  return withD1Retry(db)
    .prepare(
      `INSERT INTO delete_queue (id, file_id, r2_key, created_at)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM delete_queue WHERE file_id = ? AND processed_at IS NULL
       )`
    )
    .bind(crypto.randomUUID(), file.id, file.r2_key, createdAt, file.id)
}

export async function enqueueFileDeletionIfNeeded(
  db: D1Database,
  file: DeleteQueueFile,
  createdAt: string = new Date().toISOString()
): Promise<void> {
  await prepareEnqueueFileDeletionIfNeeded(db, file, createdAt).run()
}
