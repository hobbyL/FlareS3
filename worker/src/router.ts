import { Router } from 'itty-router'
import type { Env } from './config/env'
import { requireAuth, requireAdmin } from './middleware/roleGuard'
import { login, logout, status as authStatus } from './routes/auth'
import { listUsers, createUser, updateUser, resetPassword, deleteUser } from './routes/users'
import { shortlink } from './routes/shortlink'
import { getStats } from './routes/stats'
import { listAudit, deleteAudit, batchDeleteAudit } from './routes/audit'
import { getAdminOverview } from './routes/adminOverview'
import { listAdminJobRuns } from './routes/adminJobRuns'
import { listTexts, getText, createText, updateText, deleteText } from './routes/texts'
import { getTextShare, upsertTextShare, deleteTextShare, viewTextShare } from './routes/textShares'
import { listShares } from './routes/shares'
import { createTextOneTimeShare, deleteTextOneTimeShare } from './routes/textOneTimeShares'

type RouteHandler = (request: Request, env: Env) => Response | Promise<Response>

function withAuth(handler: RouteHandler): RouteHandler {
  return (request, env) => {
    const auth = requireAuth(request)
    if (auth) return auth
    return handler(request, env)
  }
}

function withAdmin(handler: RouteHandler): RouteHandler {
  return (request, env) => {
    const auth = requireAdmin(request)
    if (auth) return auth
    return handler(request, env)
  }
}

function lazyRoute<TModule>(
  loadModule: () => Promise<TModule>,
  handler: (module: TModule, request: Request, env: Env) => Response | Promise<Response>
): RouteHandler {
  let modulePromise: Promise<TModule> | undefined
  return async (request, env) => {
    modulePromise ||= loadModule()
    const module = await modulePromise
    return handler(module, request, env)
  }
}

export const router = Router()

// ── Auth ──
router.post('/api/auth/login', (request, env: Env) => login(request, env))
router.post('/api/auth/logout', (request, env: Env) => logout(request, env))
router.get(
  '/api/auth/status',
  withAuth((request, _env: Env) => authStatus(request))
)

// ── Users ──
router.get(
  '/api/users',
  withAdmin((request, env: Env) => listUsers(request, env))
)
router.post(
  '/api/users',
  withAdmin((request, env: Env) => createUser(request, env))
)
router.patch(
  '/api/users/:id',
  withAdmin((request, env: Env) => updateUser(request, env, (request as any).params.id))
)
router.post(
  '/api/users/:id/reset-password',
  withAdmin((request, env: Env) => resetPassword(request, env, (request as any).params.id))
)
router.delete(
  '/api/users/:id',
  withAdmin((request, env: Env) => deleteUser(request, env, (request as any).params.id))
)

// ── Setup ──
router.get(
  '/api/setup/status',
  withAdmin(
    lazyRoute(
      () => import('./routes/setup'),
      (module, request, env) => module.status(request, env)
    )
  )
)
router.post(
  '/api/setup/config',
  withAdmin(
    lazyRoute(
      () => import('./routes/setup'),
      (module, request, env) => module.saveConfig(request, env)
    )
  )
)
router.post(
  '/api/setup/test',
  withAdmin(
    lazyRoute(
      () => import('./routes/setup'),
      (module, request) => module.testConfig(request)
    )
  )
)

// ── Storage configs ──
router.get(
  '/api/storage/configs',
  withAdmin(
    lazyRoute(
      () => import('./routes/storageConfigs'),
      (module, request, env) => module.listAllConfigs(request, env)
    )
  )
)
router.get(
  '/api/storage/configs/:id/secrets',
  withAdmin(
    lazyRoute(
      () => import('./routes/storageConfigs'),
      (module, request, env) =>
        module.getConfigSecrets(request, env, (request as any).params.id)
    )
  )
)

// ── R2 configs ──
router.get(
  '/api/r2/options',
  withAuth(
    lazyRoute(
      () => import('./routes/r2Configs'),
      (module, request, env) => module.listOptions(request, env)
    )
  )
)
router.get(
  '/api/r2/configs',
  withAdmin(
    lazyRoute(
      () => import('./routes/r2Configs'),
      (module, request, env) => module.listConfigs(request, env)
    )
  )
)
router.post(
  '/api/r2/configs',
  withAdmin(
    lazyRoute(
      () => import('./routes/r2Configs'),
      (module, request, env) => module.createConfig(request, env)
    )
  )
)
router.patch(
  '/api/r2/configs/:id',
  withAdmin(
    lazyRoute(
      () => import('./routes/r2Configs'),
      (module, request, env) => module.updateConfig(request, env, (request as any).params.id)
    )
  )
)
router.delete(
  '/api/r2/configs/:id',
  withAdmin(
    lazyRoute(
      () => import('./routes/r2Configs'),
      (module, request, env) => module.deleteConfig(request, env, (request as any).params.id)
    )
  )
)
router.post(
  '/api/r2/configs/:id/test',
  withAdmin(
    lazyRoute(
      () => import('./routes/r2Configs'),
      (module, request, env) => module.testById(request, env, (request as any).params.id)
    )
  )
)
router.post(
  '/api/r2/default',
  withAdmin(
    lazyRoute(
      () => import('./routes/r2Configs'),
      (module, request, env) => module.setDefault(request, env)
    )
  )
)
router.post(
  '/api/r2/legacy-files',
  withAdmin(
    lazyRoute(
      () => import('./routes/r2Configs'),
      (module, request, env) => module.setLegacyFiles(request, env)
    )
  )
)

// ── WebDAV configs ──
router.get(
  '/api/webdav/configs',
  withAdmin(
    lazyRoute(
      () => import('./routes/webdavConfigs'),
      (module, request, env) => module.listConfigs(request, env)
    )
  )
)
router.post(
  '/api/webdav/configs',
  withAdmin(
    lazyRoute(
      () => import('./routes/webdavConfigs'),
      (module, request, env) => module.createConfig(request, env)
    )
  )
)
router.patch(
  '/api/webdav/configs/:id',
  withAdmin(
    lazyRoute(
      () => import('./routes/webdavConfigs'),
      (module, request, env) => module.updateConfig(request, env, (request as any).params.id)
    )
  )
)
router.delete(
  '/api/webdav/configs/:id',
  withAdmin(
    lazyRoute(
      () => import('./routes/webdavConfigs'),
      (module, request, env) => module.deleteConfig(request, env, (request as any).params.id)
    )
  )
)
router.post(
  '/api/webdav/configs/:id/test',
  withAdmin(
    lazyRoute(
      () => import('./routes/webdavConfigs'),
      (module, request, env) => module.testById(request, env, (request as any).params.id)
    )
  )
)

// ── Upload ──
router.post(
  '/api/upload/presign',
  withAuth(
    lazyRoute(
      () => import('./routes/upload'),
      (module, request, env) => module.presignUpload(request, env)
    )
  )
)
router.post(
  '/api/upload/confirm',
  withAuth(
    lazyRoute(
      () => import('./routes/upload'),
      (module, request, env) => module.confirmUpload(request, env)
    )
  )
)
router.post(
  '/api/upload/multipart/init',
  withAuth(
    lazyRoute(
      () => import('./routes/upload'),
      (module, request, env) => module.initMultipart(request, env)
    )
  )
)
router.post(
  '/api/upload/multipart/presign',
  withAuth(
    lazyRoute(
      () => import('./routes/upload'),
      (module, request, env) => module.presignMultipart(request, env)
    )
  )
)
router.post(
  '/api/upload/multipart/complete',
  withAuth(
    lazyRoute(
      () => import('./routes/upload'),
      (module, request, env) => module.completeMultipart(request, env)
    )
  )
)
router.post(
  '/api/upload/multipart/abort',
  withAuth(
    lazyRoute(
      () => import('./routes/upload'),
      (module, request, env) => module.abortMultipart(request, env)
    )
  )
)
router.post(
  '/api/upload/server',
  withAuth(
    lazyRoute(
      () => import('./routes/upload'),
      (module, request, env) => module.serverUpload(request, env)
    )
  )
)

// ── Files ──
router.get(
  '/api/files',
  withAuth(
    lazyRoute(
      () => import('./routes/files'),
      (module, request, env) => module.listFiles(request, env)
    )
  )
)
router.get(
  '/api/files/trash',
  withAuth(
    lazyRoute(
      () => import('./routes/files'),
      (module, request, env) => module.listTrashFiles(request, env)
    )
  )
)
router.delete(
  '/api/files/trash/permanent',
  withAuth(
    lazyRoute(
      () => import('./routes/files'),
      (module, request, env) => module.permanentlyDeleteTrashFiles(request, env)
    )
  )
)
router.delete(
  '/api/files/:id',
  withAuth(
    lazyRoute(
      () => import('./routes/files'),
      (module, request, env) => module.deleteFile(request, env, (request as any).params.id)
    )
  )
)
router.post(
  '/api/files/:id/restore',
  withAuth(
    lazyRoute(
      () => import('./routes/files'),
      (module, request, env) => module.restoreFile(request, env, (request as any).params.id)
    )
  )
)
router.delete(
  '/api/files/:id/permanent',
  withAuth(
    lazyRoute(
      () => import('./routes/files'),
      (module, request, env) =>
        module.permanentlyDeleteFile(request, env, (request as any).params.id)
    )
  )
)
router.get(
  '/api/files/:id/preview',
  withAuth(
    lazyRoute(
      () => import('./routes/files'),
      (module, request, env) => module.previewFile(request, env, (request as any).params.id)
    )
  )
)
router.get(
  '/api/files/:id/download',
  lazyRoute(
    () => import('./routes/files'),
    (module, request, env) => module.downloadFile(request, env, (request as any).params.id)
  )
)

// ── Mount ──
router.get(
  '/api/mount/objects',
  withAdmin(
    lazyRoute(
      () => import('./routes/mount'),
      (module, request, env) => module.listMountedObjects(request, env)
    )
  )
)
router.get(
  '/api/mount/download',
  withAdmin(
    lazyRoute(
      () => import('./routes/mount'),
      (module, request, env) => module.downloadMountedObject(request, env)
    )
  )
)
router.get(
  '/api/mount/preview',
  withAdmin(
    lazyRoute(
      () => import('./routes/mount'),
      (module, request, env) => module.previewMountedObject(request, env)
    )
  )
)
router.delete(
  '/api/mount/object',
  withAdmin(
    lazyRoute(
      () => import('./routes/mount'),
      (module, request, env) => module.deleteMountedObject(request, env)
    )
  )
)
router.post(
  '/api/mount/upload',
  withAdmin(
    lazyRoute(
      () => import('./routes/mount'),
      (module, request, env) => module.uploadMountedObject(request, env)
    )
  )
)
router.post(
  '/api/mount/folder',
  withAdmin(
    lazyRoute(
      () => import('./routes/mount'),
      (module, request, env) => module.createMountedFolder(request, env)
    )
  )
)

// ── File shares ──
router.get(
  '/api/files/:id/share',
  withAuth(
    lazyRoute(
      () => import('./routes/fileShares'),
      (module, request, env) => module.getFileShare(request, env, (request as any).params.id)
    )
  )
)
router.post(
  '/api/files/:id/share',
  withAuth(
    lazyRoute(
      () => import('./routes/fileShares'),
      (module, request, env) => module.upsertFileShare(request, env, (request as any).params.id)
    )
  )
)
router.delete(
  '/api/files/:id/share',
  withAuth(
    lazyRoute(
      () => import('./routes/fileShares'),
      (module, request, env) => module.deleteFileShare(request, env, (request as any).params.id)
    )
  )
)

// ── Shares ──
router.get(
  '/api/shares',
  withAuth((request, env: Env) => listShares(request, env))
)

// ── Stats ──
router.get(
  '/api/stats',
  withAuth((request, env: Env) => getStats(request, env))
)

// ── Admin ──
router.get(
  '/api/admin/overview',
  withAdmin((request, env: Env) => getAdminOverview(request, env))
)
router.get(
  '/api/admin/job-runs',
  withAdmin((request, env: Env) => listAdminJobRuns(request, env))
)

// ── Audit ──
router.get(
  '/api/audit',
  withAdmin((request, env: Env) => listAudit(request, env))
)
router.delete(
  '/api/audit/:id',
  withAdmin((request, env: Env) => deleteAudit(request, env, (request as any).params.id))
)
router.post(
  '/api/audit/batch-delete',
  withAdmin((request, env: Env) => batchDeleteAudit(request, env))
)

// ── Texts ──
router.get(
  '/api/texts',
  withAuth((request, env: Env) => listTexts(request, env))
)
router.post(
  '/api/texts',
  withAuth((request, env: Env) => createText(request, env))
)
router.get(
  '/api/texts/:id',
  withAuth((request, env: Env) => getText(request, env, (request as any).params.id))
)
router.patch(
  '/api/texts/:id',
  withAuth((request, env: Env) => updateText(request, env, (request as any).params.id))
)
router.delete(
  '/api/texts/:id',
  withAuth((request, env: Env) => deleteText(request, env, (request as any).params.id))
)

// ── Text shares ──
router.get(
  '/api/texts/:id/share',
  withAuth((request, env: Env) => getTextShare(request, env, (request as any).params.id))
)
router.post(
  '/api/texts/:id/share',
  withAuth((request, env: Env) => upsertTextShare(request, env, (request as any).params.id))
)
router.delete(
  '/api/texts/:id/share',
  withAuth((request, env: Env) => deleteTextShare(request, env, (request as any).params.id))
)

// ── Text one-time shares ──
router.post(
  '/api/texts/:id/one-time-share',
  withAuth((request, env: Env) => createTextOneTimeShare(request, env, (request as any).params.id))
)
router.delete(
  '/api/texts/:id/one-time-share',
  withAuth((request, env: Env) => deleteTextOneTimeShare(request, env, (request as any).params.id))
)

// ── Public share pages ──
router.get('/s/:code', (request, env: Env) => shortlink(request, env, (request as any).params.code))
router.post('/s/:code', (request, env: Env) =>
  shortlink(request, env, (request as any).params.code)
)
router.get('/t/:code', (request, env: Env) =>
  viewTextShare(request, env, (request as any).params.code)
)
router.post('/t/:code', (request, env: Env) =>
  viewTextShare(request, env, (request as any).params.code)
)
router.get(
  '/f/:code',
  lazyRoute(
    () => import('./routes/fileShares'),
    (module, request, env) => module.viewFileShare(request, env, (request as any).params.code)
  )
)
router.post(
  '/f/:code',
  lazyRoute(
    () => import('./routes/fileShares'),
    (module, request, env) => module.viewFileShare(request, env, (request as any).params.code)
  )
)

// ── Catch-all ──
router.all('*', () => new Response('Not Found', { status: 404 }))
