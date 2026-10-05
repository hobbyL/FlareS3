import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { getTotalStorage } from '../config/env'
import { hashPassword } from '../services/password'
import { logAudit } from '../services/audit'
import { getClientIp } from './rateLimit'
import { jsonResponse } from '../utils/response'
import { logError } from '../utils/log'

type BootstrapState = 'unknown' | 'ready' | 'blocked'

let bootstrapState: BootstrapState = 'unknown'
let bootstrapPromise: Promise<Response | undefined> | null = null

function getD1Changes(result: unknown): number {
  const metaChanges = Number((result as any)?.meta?.changes ?? 0)
  return Number.isFinite(metaChanges) ? metaChanges : 0
}

async function hasAnyUsers(db: D1Database): Promise<boolean> {
  const id = await withD1Retry(db).prepare('SELECT id FROM users LIMIT 1').first('id')
  return Boolean(id)
}

async function doBootstrap(request: Request, env: Env): Promise<Response | undefined> {
  const alreadyInitialized = await hasAnyUsers(env.DB)
  if (alreadyInitialized) {
    bootstrapState = 'ready'
    return
  }

  if (!env.BOOTSTRAP_ADMIN_USER || !env.BOOTSTRAP_ADMIN_PASS) {
    bootstrapState = 'blocked'
    return jsonResponse(
      { error: '管理员未初始化，请设置 BOOTSTRAP_ADMIN_USER/BOOTSTRAP_ADMIN_PASS' },
      500
    )
  }

  const now = new Date().toISOString()
  const userId = crypto.randomUUID()
  const quota = getTotalStorage(env)
  const result = await withD1Retry(env.DB)
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, status, quota_bytes, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 'active', ?, ?, ?)
     ON CONFLICT(username) DO NOTHING`
    )
    .bind(userId, env.BOOTSTRAP_ADMIN_USER, hashPassword(env.BOOTSTRAP_ADMIN_PASS), quota, now, now)
    .run()

  if (result.error) {
    return jsonResponse({ error: '管理员初始化失败' }, 500)
  }

  if (getD1Changes(result) > 0) {
    await logAudit(env.DB, {
      actorUserId: userId,
      action: 'BOOTSTRAP_ADMIN',
      targetType: 'user',
      targetId: userId,
      ip: getClientIp(request),
      userAgent: request.headers.get('User-Agent') || undefined,
    })
  }

  bootstrapState = 'ready'
}

export async function bootstrapAdmin(request: Request, env: Env): Promise<Response | undefined> {
  if (bootstrapState === 'ready') return
  if (bootstrapState === 'blocked') {
    return jsonResponse(
      { error: '管理员未初始化，请设置 BOOTSTRAP_ADMIN_USER/BOOTSTRAP_ADMIN_PASS' },
      500
    )
  }

  if (bootstrapPromise) return bootstrapPromise

  bootstrapPromise = (async () => {
    try {
      return await doBootstrap(request, env)
    } catch (error) {
      logError('bootstrap.admin.failed', error)
      return jsonResponse({ error: '管理员初始化失败' }, 500)
    } finally {
      bootstrapPromise = null
    }
  })()

  return bootstrapPromise
}
