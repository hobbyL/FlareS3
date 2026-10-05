import { withD1Retry } from '../utils/db'
export type AuditEntry = {
  actorUserId?: string
  action: string
  targetType?: string
  targetId?: string
  ip?: string
  userAgent?: string
  metadata?: Record<string, unknown>
}

export function prepareAuditLogInsert(
  db: D1Database,
  entry: AuditEntry,
  createdAt: string = new Date().toISOString()
): D1PreparedStatement {
  const id = crypto.randomUUID()
  return withD1Retry(db)
    .prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, ip, user_agent, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      entry.actorUserId || null,
      entry.action,
      entry.targetType || null,
      entry.targetId || null,
      entry.ip || null,
      entry.userAgent || null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      createdAt
    )
}

export async function logAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await prepareAuditLogInsert(db, entry).run()
}
