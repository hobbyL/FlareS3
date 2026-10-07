import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import type { AuthUser } from '../middleware/authSession'
import { getUser, invalidJsonBodyResponse, jsonResponse, parseJson } from './utils'
import { hashPassword, verifyPassword } from '../services/password'
import {
  clearSharePasswordFailedAttempts,
  getClientIp,
  isSharePasswordBlocked,
  recordSharePasswordFailedAttempt,
} from '../middleware/rateLimit'
import { generateRandomCode } from '../utils/random'
import { SHARE_SHORT_CODE_LENGTH } from '../utils/codePolicy'
import {
  MAX_SHARE_PASSWORD_FORM_BYTES,
  rejectInvalidContentLength,
} from '../services/requestBodyPolicy'
import {
  consumeFileShareViewIfAllowed,
  SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE,
} from '../services/shareViewGuard'
import { buildSharedDownloadResponse } from '../services/fileShareDownload'
import { formatDateTimeLocal } from '../services/shareFormatting'
import { recordShareAccess, type ShareAccessResult } from '../services/shareAccessLog'
import { tryHandleFolderShareView } from './folderShareView'
import {
  renderFileConfirmPage,
  renderFileMessagePage,
  renderFilePasswordForm,
} from './fileSharePages'

type LoadFileAuthResult =
  | { response: Response }
  | {
      user: AuthUser
      file: {
        id: string
        owner_id: string
        filename: string
        upload_status: string
        expires_at: string | null
      }
      ownerId: string
    }

async function loadFileAndAuthorize(
  request: Request,
  env: Env,
  fileId: string
): Promise<LoadFileAuthResult> {
  const user = getUser(request)
  if (!user) {
    return { response: jsonResponse({ error: '未授权' }, 401) }
  }

  if (!fileId) {
    return { response: jsonResponse({ error: 'id 不能为空' }, 400) }
  }

  const file = await withD1Retry(env.DB)
    .prepare(
      'SELECT id, owner_id, filename, upload_status, expires_at FROM files WHERE id = ? AND upload_status != ? LIMIT 1'
    )
    .bind(fileId, 'deleted')
    .first()

  if (!file) {
    return { response: jsonResponse({ error: '文件不存在' }, 404) }
  }

  const ownerId = String((file as any).owner_id)
  if (user.role !== 'admin' && ownerId !== user.id) {
    return { response: jsonResponse({ error: '无权限' }, 403) }
  }

  return {
    user,
    file: {
      id: String((file as any).id),
      owner_id: ownerId,
      filename: String((file as any).filename || ''),
      upload_status: String((file as any).upload_status || ''),
      expires_at: (file as any).expires_at ? String((file as any).expires_at) : null,
    },
    ownerId,
  }
}

function validateFileShareTarget(file: {
  upload_status: string
  expires_at: string | null
}): Response | null {
  if (file.upload_status !== 'completed') {
    return jsonResponse({ error: '文件未完成上传' }, 400)
  }

  const expiresAt = new Date(String(file.expires_at || ''))
  const expiresAtMs = expiresAt.getTime()
  if (Number.isNaN(expiresAtMs)) {
    return jsonResponse({ error: '文件过期时间无效' }, 500)
  }

  if (Date.now() > expiresAtMs) {
    return jsonResponse({ error: '文件已过期' }, 410)
  }

  return null
}

/**
 * 获取文件分享信息
 *
 * @route GET /api/files/:id/share
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param fileId - 文件 ID
 * @returns JSON 响应，包含文件分享信息
 *
 * @example
 * // 成功响应（有分享）(200)
 * {
 *   "share": {
 *     "id": "uuid",
 *     "file_id": "uuid",
 *     "owner_id": "uuid",
 *     "share_code": "abc123",
 *     "has_password": true,
 *     "expires_in": 604800,
 *     "expires_at": "2026-09-21T00:00:00.000Z",
 *     "max_views": 100,
 *     "views": 10,
 *     "created_at": "2026-09-14T00:00:00.000Z",
 *     "updated_at": "2026-09-14T00:00:00.000Z"
 *   }
 * }
 *
 * // 成功响应（无分享）(200)
 * { "share": null }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // 文件不存在 (404)
 * { "error": "文件不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function getFileShare(request: Request, env: Env, fileId: string): Promise<Response> {
  const auth = await loadFileAndAuthorize(request, env, fileId)
  if ('response' in auth) {
    return auth.response
  }

  const share = await withD1Retry(env.DB)
    .prepare(
      `SELECT id, file_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at
     FROM file_shares
     WHERE file_id = ?
     LIMIT 1`
    )
    .bind(fileId)
    .first()

  if (!share) {
    return jsonResponse({ share: null })
  }

  const hasPassword = Boolean((share as any).password_hash)
  const result = {
    ...(share as any),
    has_password: hasPassword,
  }
  delete (result as any).password_hash

  return jsonResponse({ share: result })
}

/**
 * 创建或更新文件分享
 *
 * @route POST /api/files/:id/share
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param fileId - 文件 ID
 * @returns JSON 响应，包含创建或更新后的分享信息
 *
 * @example
 * // 请求体
 * {
 *   "max_views": 100,
 *   "expires_at": "2026-09-21T00:00:00.000Z",
 *   "password": "secret123",
 *   "regenerate": false
 * }
 *
 * // 成功响应 (200)
 * {
 *   "share": {
 *     "id": "uuid",
 *     "file_id": "uuid",
 *     "owner_id": "uuid",
 *     "share_code": "abc123",
 *     "has_password": true,
 *     "expires_in": 604800,
 *     "expires_at": "2026-09-21T00:00:00.000Z",
 *     "max_views": 100,
 *     "views": 0,
 *     "created_at": "2026-09-14T00:00:00.000Z",
 *     "updated_at": "2026-09-14T00:00:00.000Z"
 *   }
 * }
 *
 * // 文件未完成上传 (400)
 * { "error": "文件未完成上传" }
 *
 * // 文件已过期 (410)
 * { "error": "文件已过期" }
 *
 * // max_views 无效 (400)
 * { "error": "max_views 无效" }
 *
 * // expires_at 无效 (400)
 * { "error": "expires_at 无效" }
 *
 * // expires_at 需要晚于当前时间 (400)
 * { "error": "expires_at 需要晚于当前时间" }
 */
export async function upsertFileShare(
  request: Request,
  env: Env,
  fileId: string
): Promise<Response> {
  const auth = await loadFileAndAuthorize(request, env, fileId)
  if ('response' in auth) {
    return auth.response
  }

  const shareTargetError = validateFileShareTarget(auth.file)
  if (shareTargetError) {
    return shareTargetError
  }

  let body: {
    max_views?: unknown
    expires_at?: unknown
    password?: unknown
    regenerate?: unknown
  }

  try {
    body = await parseJson(request)
  } catch (error) {
    return invalidJsonBodyResponse(error)
  }

  const maxViewsRaw = body.max_views
  const maxViews = Number(maxViewsRaw ?? 0)
  if (!Number.isFinite(maxViews) || maxViews < 0) {
    return jsonResponse({ error: 'max_views 无效' }, 400)
  }

  const expiresAtRaw = body.expires_at
  let expiresAt: string | null = null
  let expiresIn = 0

  if (expiresAtRaw === null || expiresAtRaw === undefined || String(expiresAtRaw).trim() === '') {
    expiresAt = null
    expiresIn = 0
  } else {
    const date = new Date(String(expiresAtRaw))
    const time = date.getTime()
    if (Number.isNaN(time)) {
      return jsonResponse({ error: 'expires_at 无效' }, 400)
    }
    if (time <= Date.now()) {
      return jsonResponse({ error: 'expires_at 需要晚于当前时间' }, 400)
    }
    expiresAt = date.toISOString()
    expiresIn = Math.max(1, Math.ceil((time - Date.now()) / 1000))
  }

  const now = new Date().toISOString()

  const existing = await withD1Retry(env.DB)
    .prepare(
      'SELECT id, owner_id, share_code, password_hash, views FROM file_shares WHERE file_id = ? LIMIT 1'
    )
    .bind(fileId)
    .first()

  const regenerate = Boolean(body.regenerate)

  const passwordValue = body.password
  const passwordString = typeof passwordValue === 'string' ? passwordValue.trim() : ''
  const shouldClearPassword = passwordValue === null
  const shouldUpdatePassword = typeof passwordValue === 'string' && passwordString.length > 0

  if (!existing) {
    const id = crypto.randomUUID()

    let passwordHash: string | null = null
    if (shouldUpdatePassword) {
      passwordHash = hashPassword(passwordString)
    }

    for (let i = 0; i < 10; i += 1) {
      const shareCode = generateRandomCode(SHARE_SHORT_CODE_LENGTH)
      const result = await withD1Retry(env.DB)
        .prepare(
          `INSERT INTO file_shares (id, file_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .bind(
          id,
          fileId,
          auth.ownerId,
          shareCode,
          passwordHash,
          expiresIn,
          expiresAt,
          Math.floor(maxViews),
          now,
          now
        )
        .run()

      if (!result.error) {
        const saved = await withD1Retry(env.DB)
          .prepare(
            `SELECT id, file_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at
           FROM file_shares
           WHERE file_id = ?
           LIMIT 1`
          )
          .bind(fileId)
          .first()

        const hasPassword = Boolean((saved as any)?.password_hash)
        const responseShare = {
          ...(saved as any),
          has_password: hasPassword,
        }
        delete (responseShare as any).password_hash
        return jsonResponse({ share: responseShare })
      }
    }

    return jsonResponse({ error: '生成分享链接失败' }, 500)
  }

  const shareId = String((existing as any).id)
  const currentShareCode = String((existing as any).share_code)

  const nextShareCode = regenerate ? generateRandomCode(SHARE_SHORT_CODE_LENGTH) : currentShareCode

  const updates: string[] = ['max_views = ?', 'expires_in = ?', 'expires_at = ?', 'updated_at = ?']
  const params: unknown[] = [Math.floor(maxViews), expiresIn, expiresAt, now]

  if (regenerate) {
    updates.unshift('share_code = ?')
    params.unshift(nextShareCode)
  }

  if (shouldClearPassword) {
    updates.push('password_hash = NULL')
  } else if (shouldUpdatePassword) {
    updates.push('password_hash = ?')
    params.push(hashPassword(passwordString))
  }

  params.push(shareId)

  if (regenerate) {
    for (let i = 0; i < 10; i += 1) {
      const code = i === 0 ? nextShareCode : generateRandomCode(SHARE_SHORT_CODE_LENGTH)
      const loopParams = params.slice()
      ;(loopParams as any)[0] = code

      const result = await withD1Retry(env.DB)
        .prepare(`UPDATE file_shares SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...loopParams)
        .run()

      if (!result.error) {
        const saved = await withD1Retry(env.DB)
          .prepare(
            `SELECT id, file_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at
           FROM file_shares
           WHERE id = ?
           LIMIT 1`
          )
          .bind(shareId)
          .first()

        const hasPassword = Boolean((saved as any)?.password_hash)
        const responseShare = {
          ...(saved as any),
          has_password: hasPassword,
        }
        delete (responseShare as any).password_hash
        return jsonResponse({ share: responseShare })
      }
    }

    return jsonResponse({ error: '重置分享链接失败' }, 500)
  }

  const updateResult = await withD1Retry(env.DB)
    .prepare(`UPDATE file_shares SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run()

  if (updateResult.error) {
    return jsonResponse({ error: '保存分享设置失败' }, 400)
  }

  const saved = await withD1Retry(env.DB)
    .prepare(
      `SELECT id, file_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at
     FROM file_shares
     WHERE id = ?
     LIMIT 1`
    )
    .bind(shareId)
    .first()

  const hasPassword = Boolean((saved as any)?.password_hash)
  const responseShare = {
    ...(saved as any),
    has_password: hasPassword,
  }
  delete (responseShare as any).password_hash

  return jsonResponse({ share: responseShare })
}

/**
 * 删除文件分享
 *
 * @route DELETE /api/files/:id/share
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param fileId - 文件 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 成功响应（分享已删除）(200)
 * {
 *   "success": true,
 *   "deleted": true
 * }
 *
 * // 成功响应（分享不存在）(200)
 * {
 *   "success": true,
 *   "deleted": false
 * }
 *
 * // 关闭分享失败 (400)
 * { "error": "关闭分享失败" }
 */
export async function deleteFileShare(
  request: Request,
  env: Env,
  fileId: string
): Promise<Response> {
  const auth = await loadFileAndAuthorize(request, env, fileId)
  if ('response' in auth) {
    return auth.response
  }

  const share = await withD1Retry(env.DB)
    .prepare('SELECT id FROM file_shares WHERE file_id = ? LIMIT 1')
    .bind(fileId)
    .first()

  if (!share) {
    return jsonResponse({ success: true, deleted: false })
  }

  const result = await withD1Retry(env.DB)
    .prepare('DELETE FROM file_shares WHERE id = ?')
    .bind(String((share as any).id))
    .run()

  if (result.error) {
    return jsonResponse({ error: '关闭分享失败' }, 400)
  }

  return jsonResponse({ success: true, deleted: true })
}

type ResolveFileShareRecordResult =
  | { error: { status: number; message: string; shareId?: string } }
  | {
      share: {
        id: string
        file_id: string
        share_code: string
        password_hash: string | null
        expires_at: string | null
        max_views: number
        views: number
      }
      file: {
        filename: string
        r2_key: string
        expires_at: string
        config_id: string | null
      }
    }

async function resolveFileShareRecord(
  env: Env,
  code: string
): Promise<ResolveFileShareRecordResult> {
  const row = await withD1Retry(env.DB)
    .prepare(
      `SELECT s.id AS share_id, s.file_id, s.share_code, s.password_hash, s.expires_at AS share_expires_at, s.max_views, s.views,
            f.filename, f.r2_key, f.expires_at AS file_expires_at, f.upload_status, f.deleted_at, f.config_id,
            u.status AS owner_status
     FROM file_shares s
     LEFT JOIN files f ON f.id = s.file_id
     LEFT JOIN users u ON u.id = s.owner_id
     WHERE s.share_code = ?
     LIMIT 1`
    )
    .bind(code)
    .first()

  if (!row) {
    return { error: { status: 404, message: '分享链接不存在' } }
  }

  // 访问日志的 share_id 口径与 /api/shares 列表的 resource_id 一致（file → file_id）
  const accessShareId = String(row.file_id ?? '')

  if (!row.filename || !row.r2_key || row.upload_status !== 'completed' || row.deleted_at) {
    return { error: { status: 404, message: '文件不存在', shareId: accessShareId } }
  }

  if (String(row.owner_status || '') !== 'active') {
    return { error: { status: 404, message: '文件不存在', shareId: accessShareId } }
  }

  const fileExpiresAt = new Date(String(row.file_expires_at))
  const fileExpiresAtMs = fileExpiresAt.getTime()
  if (Number.isNaN(fileExpiresAtMs)) {
    return { error: { status: 500, message: '文件过期时间无效', shareId: accessShareId } }
  }
  if (Date.now() > fileExpiresAtMs) {
    return { error: { status: 410, message: '文件已过期', shareId: accessShareId } }
  }

  const shareExpiresAtRaw = row.share_expires_at ? String(row.share_expires_at).trim() : ''
  if (shareExpiresAtRaw) {
    const shareExpiresAt = new Date(shareExpiresAtRaw)
    const shareExpiresAtMs = shareExpiresAt.getTime()
    if (Number.isNaN(shareExpiresAtMs)) {
      return { error: { status: 500, message: '链接过期时间无效', shareId: accessShareId } }
    }
    if (Date.now() > shareExpiresAtMs) {
      return { error: { status: 410, message: '链接已过期', shareId: accessShareId } }
    }
  }

  const maxViews = Number(row.max_views ?? 0)
  const views = Number(row.views ?? 0)
  const safeMaxViews = Number.isFinite(maxViews) ? Math.floor(maxViews) : 0
  const safeViews = Number.isFinite(views) ? Math.floor(views) : 0
  if (safeMaxViews > 0 && safeViews >= safeMaxViews) {
    return {
      error: {
        status: 410,
        message: SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE,
        shareId: accessShareId,
      },
    }
  }

  return {
    share: {
      id: String(row.share_id),
      file_id: String(row.file_id),
      share_code: String(row.share_code),
      password_hash: row.password_hash ? String(row.password_hash) : null,
      expires_at: shareExpiresAtRaw || null,
      max_views: safeMaxViews,
      views: safeViews,
    },
    file: {
      filename: String(row.filename),
      r2_key: String(row.r2_key),
      expires_at: String(row.file_expires_at),
      config_id: row.config_id ? String(row.config_id) : null,
    },
  }
}

/** resolve 错误 → 访问日志 result（无 shareId 的「code 未知」不落库） */
function mapFileShareResolveErrorToAccessResult(error: {
  status: number
  message: string
}): ShareAccessResult | null {
  if (error.message === SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE) return 'exhausted'
  if (error.status === 410) return 'expired'
  if (error.status === 404) return 'not_found'
  return null
}

/**
 * 访问文件分享页面
 *
 * @route GET|POST /f/:code
 * @param request - HTTP 请求对象
 * @param env - Cloudflare Workers 环境变量
 * @param code - 分享短码
 * @returns HTML 响应或文件下载重定向
 *
 * @example
 * // GET 请求（无密码）
 * // 返回确认页面，提示点击下载
 *
 * // GET 请求（有密码）
 * // 返回密码输入表单
 *
 * // POST 请求（无密码）
 * // 消费访问次数，返回文件下载
 *
 * // POST 请求（有密码）
 * // FormData: password=xxxx
 * // 验证密码，消费访问次数，返回文件下载
 *
 * // 短码为空 (400)
 * // HTML: "短码不能为空"
 *
 * // 分享不存在 (404)
 * // HTML: "分享链接不存在"
 *
 * // 文件不存在 (404)
 * // HTML: "文件不存在"
 *
 * // 链接已过期 (410)
 * // HTML: "链接已过期"
 *
 * // 访问次数已用完 (410)
 * // HTML: "访问次数已用完"
 *
 * // 密码错误
 * // HTML: 密码表单 + "口令不正确"
 *
 * // 密码尝试次数过多
 * // HTML: 密码表单 + "尝试次数过多，请 10 分钟后重试"
 */
export async function viewFileShare(request: Request, env: Env, code: string): Promise<Response> {
  const normalized = String(code || '').trim()
  if (!normalized) {
    return renderFileMessagePage('分享', '短码不能为空', 400)
  }

  // /f/:code 双模：folder_shares 未命中（返回 null）时继续走既有 file 流程，
  // file 分享行为与响应保持零改动
  const folderResponse = await tryHandleFolderShareView(request, env, normalized)
  if (folderResponse) {
    return folderResponse
  }

  const resolved = await resolveFileShareRecord(env, normalized)
  if ('error' in resolved) {
    if (request.method.toUpperCase() === 'POST') {
      const accessResult = mapFileShareResolveErrorToAccessResult(resolved.error)
      if (accessResult) {
        await recordShareAccess(env, {
          share_type: 'file',
          share_id: resolved.error.shareId ?? '',
          ip: getClientIp(request),
          user_agent: request.headers.get('User-Agent'),
          result: accessResult,
        })
      }
    }
    return renderFileMessagePage('分享', resolved.error.message, resolved.error.status)
  }

  const share = resolved.share
  const file = resolved.file
  const title = file.filename || '共享文件'

  const meta = (() => {
    const parts: string[] = []
    if (share.max_views > 0) {
      parts.push(`已访问 ${share.views}/${share.max_views}`)
    } else {
      parts.push(`已访问 ${share.views}`)
    }
    if (share.expires_at) {
      parts.push(`过期时间 ${formatDateTimeLocal(share.expires_at)}`)
    }
    return parts.join(' · ')
  })()

  const passwordHash = String(share.password_hash || '').trim()
  const needsPassword = Boolean(passwordHash)

  const method = request.method.toUpperCase()

  const consumeAndRedirect = async (): Promise<Response> => {
    try {
      const { consumed } = await consumeFileShareViewIfAllowed(env.DB, share.id)
      if (!consumed) {
        await recordShareAccess(env, {
          share_type: 'file',
          share_id: share.file_id,
          ip: getClientIp(request),
          user_agent: request.headers.get('User-Agent'),
          result: 'exhausted',
        })
        return renderFileMessagePage('分享', SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE, 410)
      }

      const download = await buildSharedDownloadResponse(env, file)
      if (!download.ok) {
        // 消费已发生（访问成立），下载失败仍记 ok
        await recordShareAccess(env, {
          share_type: 'file',
          share_id: share.file_id,
          ip: getClientIp(request),
          user_agent: request.headers.get('User-Agent'),
          result: 'ok',
        })
        return renderFileMessagePage('分享', download.error.message, download.error.status)
      }
      await recordShareAccess(env, {
        share_type: 'file',
        share_id: share.file_id,
        ip: getClientIp(request),
        user_agent: request.headers.get('User-Agent'),
        result: 'ok',
      })
      return download.response
    } catch {
      return renderFileMessagePage('分享', '访问失败，请稍后重试', 500)
    }
  }

  if (method === 'GET') {
    if (needsPassword) {
      return renderFilePasswordForm({ title, meta })
    }

    return renderFileConfirmPage({ title, meta })
  }

  if (method === 'POST') {
    if (!needsPassword) {
      return consumeAndRedirect()
    }

    const ip = getClientIp(request)
    if (await isSharePasswordBlocked(env, normalized, ip)) {
      return renderFilePasswordForm({ title, meta, error: '尝试次数过多，请 10 分钟后重试' })
    }

    const bodySizeError = rejectInvalidContentLength(
      request,
      MAX_SHARE_PASSWORD_FORM_BYTES,
      '分享口令表单'
    )
    if (bodySizeError) return bodySizeError

    let password = ''
    try {
      const form = await request.formData()
      password = String(form.get('password') || '')
    } catch {
      password = ''
    }

    if (!password) {
      return renderFilePasswordForm({ title, meta, error: '请输入访问口令' })
    }

    if (!verifyPassword(password, passwordHash)) {
      await recordSharePasswordFailedAttempt(env, normalized, ip)
      await recordShareAccess(env, {
        share_type: 'file',
        share_id: share.file_id,
        ip,
        user_agent: request.headers.get('User-Agent'),
        result: 'rejected_password',
      })
      if (await isSharePasswordBlocked(env, normalized, ip)) {
        return renderFilePasswordForm({ title, meta, error: '尝试次数过多，请 10 分钟后重试' })
      }
      return renderFilePasswordForm({ title, meta, error: '口令不正确' })
    }

    await clearSharePasswordFailedAttempts(env, normalized, ip)
    return consumeAndRedirect()
  }

  return new Response('Method Not Allowed', { status: 405 })
}
