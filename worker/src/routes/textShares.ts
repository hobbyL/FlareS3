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
import {
  consumeTextShareViewIfAllowed,
  SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE,
} from '../services/shareViewGuard'
import {
  MAX_SHARE_PASSWORD_FORM_BYTES,
  rejectInvalidContentLength,
} from '../services/requestBodyPolicy'
import { generateRandomCode } from '../utils/random'
import { SHARE_SHORT_CODE_LENGTH } from '../utils/codePolicy'
import { buildPage, escapeHtml, htmlResponse } from './sharePage'
import { formatDateTimeLocal } from '../services/shareFormatting'

type LoadTextAuthResult =
  | { response: Response }
  | {
      user: AuthUser
      text: unknown
      ownerId: string
    }

type ResolveShareRecordResult = { error: { status: number; message: string } } | { share: unknown }

async function loadTextAndAuthorize(
  request: Request,
  env: Env,
  textId: string
): Promise<LoadTextAuthResult> {
  const user = getUser(request)
  if (!user) {
    return { response: jsonResponse({ error: '未授权' }, 401) }
  }

  if (!textId) {
    return { response: jsonResponse({ error: 'id 不能为空' }, 400) }
  }

  const text = await withD1Retry(env.DB)
    .prepare('SELECT id, owner_id, title FROM texts WHERE id = ? AND deleted_at IS NULL LIMIT 1')
    .bind(textId)
    .first()

  if (!text) {
    return { response: jsonResponse({ error: '文本不存在' }, 404) }
  }

  const ownerId = String((text as any).owner_id)
  if (user.role !== 'admin' && ownerId !== user.id) {
    return { response: jsonResponse({ error: '无权限' }, 403) }
  }

  return { user, text, ownerId }
}

/**
 * 获取文本分享信息
 *
 * @route GET /api/texts/:id/share
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param textId - 文本 ID
 * @returns JSON 响应，包含文本分享信息
 *
 * @example
 * // 成功响应（有分享）(200)
 * {
 *   "share": {
 *     "id": "uuid",
 *     "text_id": "uuid",
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
 * // 文本不存在 (404)
 * { "error": "文本不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function getTextShare(request: Request, env: Env, textId: string): Promise<Response> {
  const auth = await loadTextAndAuthorize(request, env, textId)
  if ('response' in auth) {
    return auth.response
  }

  const share = await withD1Retry(env.DB)
    .prepare(
      `SELECT id, text_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at
     FROM text_shares
     WHERE text_id = ?
     LIMIT 1`
    )
    .bind(textId)
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
 * 创建或更新文本分享
 *
 * @route POST /api/texts/:id/share
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param textId - 文本 ID
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
 *     "text_id": "uuid",
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
 * // max_views 无效 (400)
 * { "error": "max_views 无效" }
 *
 * // expires_at 无效 (400)
 * { "error": "expires_at 无效" }
 *
 * // expires_at 需要晚于当前时间 (400)
 * { "error": "expires_at 需要晚于当前时间" }
 */
export async function upsertTextShare(
  request: Request,
  env: Env,
  textId: string
): Promise<Response> {
  const auth = await loadTextAndAuthorize(request, env, textId)
  if ('response' in auth) {
    return auth.response
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
      'SELECT id, owner_id, share_code, password_hash, views FROM text_shares WHERE text_id = ? LIMIT 1'
    )
    .bind(textId)
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
          `INSERT INTO text_shares (id, text_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .bind(
          id,
          textId,
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
            `SELECT id, text_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at
           FROM text_shares
           WHERE text_id = ?
           LIMIT 1`
          )
          .bind(textId)
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
  const currentHasPassword = Boolean((existing as any).password_hash)

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
        .prepare(`UPDATE text_shares SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...loopParams)
        .run()

      if (!result.error) {
        const saved = await withD1Retry(env.DB)
          .prepare(
            `SELECT id, text_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at
           FROM text_shares
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

  if (!shouldClearPassword && !shouldUpdatePassword && !currentHasPassword) {
    // keep as-is (no password)
  }

  const updateResult = await withD1Retry(env.DB)
    .prepare(`UPDATE text_shares SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run()

  if (updateResult.error) {
    return jsonResponse({ error: '保存分享设置失败' }, 400)
  }

  const saved = await withD1Retry(env.DB)
    .prepare(
      `SELECT id, text_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at
     FROM text_shares
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
 * 删除文本分享
 *
 * @route DELETE /api/texts/:id/share
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param textId - 文本 ID
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
export async function deleteTextShare(
  request: Request,
  env: Env,
  textId: string
): Promise<Response> {
  const auth = await loadTextAndAuthorize(request, env, textId)
  if ('response' in auth) {
    return auth.response
  }

  const share = await withD1Retry(env.DB)
    .prepare('SELECT id FROM text_shares WHERE text_id = ? LIMIT 1')
    .bind(textId)
    .first()

  if (!share) {
    return jsonResponse({ success: true, deleted: false })
  }

  const result = await withD1Retry(env.DB)
    .prepare('DELETE FROM text_shares WHERE id = ?')
    .bind(String((share as any).id))
    .run()

  if (result.error) {
    return jsonResponse({ error: '关闭分享失败' }, 400)
  }

  return jsonResponse({ success: true, deleted: true })
}

async function resolveShareRecord(env: Env, code: string): Promise<ResolveShareRecordResult> {
  const share = await withD1Retry(env.DB)
    .prepare(
      `SELECT s.id, s.text_id, s.share_code, s.password_hash, s.expires_at, s.max_views, s.views,
            t.title AS text_title, t.content AS text_content, t.deleted_at AS text_deleted_at,
            u.status AS owner_status
     FROM text_shares s
     LEFT JOIN texts t ON t.id = s.text_id
     LEFT JOIN users u ON u.id = s.owner_id
     WHERE s.share_code = ?
     LIMIT 1`
    )
    .bind(code)
    .first()

  if (!share) {
    return { error: { status: 404, message: '分享链接不存在' } }
  }

  if ((share as any).text_deleted_at) {
    return { error: { status: 404, message: '内容不存在' } }
  }

  if (String((share as any).owner_status || '') !== 'active') {
    return { error: { status: 404, message: '内容不存在' } }
  }

  const expiresAt = String((share as any).expires_at || '').trim()
  if (expiresAt) {
    const expiresAtMs = new Date(expiresAt).getTime()
    if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
      return { error: { status: 410, message: '链接已过期' } }
    }
  }

  const maxViews = Number((share as any).max_views || 0)
  const views = Number((share as any).views || 0)
  if (Number.isFinite(maxViews) && maxViews > 0 && views >= maxViews) {
    return { error: { status: 410, message: SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE } }
  }

  return { share }
}

function renderPasswordForm({
  title,
  meta,
  error,
}: {
  title: string
  meta: string
  error?: string
}): Response {
  const errorHtml = error
    ? `<div class="alert alert-error" role="alert">
  <div class="alert-title">验证失败</div>
  <p class="alert-message">${escapeHtml(error)}</p>
</div>`
    : ''
  const html = buildPage({
    title,
    body: `
<div class="header">
  <h1 class="title">${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
</div>
<div class="body">
  <div class="centered">
    <p class="muted">该内容需要访问口令。</p>
    ${errorHtml}
    <form method="post">
      <label for="password">访问口令</label>
      <div class="input-group">
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          placeholder="请输入访问口令"
          required
          autofocus
        />
        <button
          type="button"
          class="toggle-btn"
          data-toggle-password
          data-target="password"
          aria-pressed="false"
        >
          显示
        </button>
      </div>
      <p class="hint">口令区分大小写；输入后按回车即可。</p>
      <button type="submit">查看内容</button>
    </form>
  </div>
</div>`,
  })

  return htmlResponse(html, 200)
}

/**
 * 渲染分享确认页面（需要用户点击按钮查看内容）
 *
 * @param title - 页面标题
 * @param meta - 元信息（如访问次数、过期时间）
 * @returns HTML 响应
 */
export function renderConfirmPage({ title, meta }: { title: string; meta: string }): Response {
  const html = buildPage({
    title,
    body: `
<div class="header">
  <h1 class="title">${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
</div>
<div class="body">
  <div class="centered">
    <p class="muted">点击下方按钮查看内容。</p>
    <form method="post">
      <button type="submit">查看内容</button>
    </form>
  </div>
</div>`,
  })

  return htmlResponse(html, 200)
}

/**
 * 渲染通用消息页面（用于错误提示或信息展示）
 *
 * @param title - 页面标题
 * @param message - 消息内容
 * @param status - HTTP 状态码（默认 200）
 * @returns HTML 响应
 */
export function renderMessagePage(title: string, message: string, status = 200): Response {
  const html = buildPage({
    title,
    body: `
<div class="header">
  <h1 class="title">${escapeHtml(title)}</h1>
  <div class="meta"></div>
</div>
<div class="body">
  <p class="muted">${escapeHtml(message)}</p>
</div>`,
  })

  return htmlResponse(html, status)
}

/**
 * 渲染文本内容展示页面
 *
 * @param title - 页面标题
 * @param meta - 元信息（如访问次数、过期时间）
 * @param content - 要显示的文本内容
 * @returns HTML 响应
 */
export function renderContentPage({
  title,
  meta,
  content,
}: {
  title: string
  meta: string
  content: string
}): Response {
  const html = buildPage({
    title,
    body: `
<div class="header">
  <h1 class="title">${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
</div>
<div class="body">
  <pre>${escapeHtml(content)}</pre>
</div>`,
  })

  return htmlResponse(html, 200)
}

/**
 * 访问文本分享页面
 *
 * @route GET|POST /s/:code
 * @param request - HTTP 请求对象
 * @param env - Cloudflare Workers 环境变量
 * @param code - 分享短码
 * @returns HTML 响应
 *
 * @example
 * // GET 请求（无密码）
 * // 返回确认页面，提示点击查看
 *
 * // GET 请求（有密码）
 * // 返回密码输入表单
 *
 * // POST 请求（无密码）
 * // 消费访问次数，返回内容页面
 *
 * // POST 请求（有密码）
 * // FormData: password=xxxx
 * // 验证密码，消费访问次数，返回内容页面
 *
 * // 短码为空 (400)
 * // HTML: "短码不能为空"
 *
 * // 分享不存在 (404)
 * // HTML: "分享链接不存在"
 *
 * // 内容不存在 (404)
 * // HTML: "内容不存在"
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
 *
 * // 方法不允许 (405)
 * // "Method Not Allowed"
 */
export async function viewTextShare(request: Request, env: Env, code: string): Promise<Response> {
  const normalizedCode = String(code || '').trim()
  if (!normalizedCode) {
    return renderMessagePage('分享', '短码不能为空', 400)
  }

  const resolved = await resolveShareRecord(env, normalizedCode)
  if ('error' in resolved) {
    return renderMessagePage('分享', resolved.error.message, resolved.error.status)
  }

  const share = resolved.share
  const shareId = String((share as any).id)
  const title = String((share as any).text_title || '共享文档')
  const content = String((share as any).text_content || '')

  const meta = (() => {
    const views = Number((share as any).views || 0)
    const maxViews = Number((share as any).max_views || 0)
    const expiresAt = String((share as any).expires_at || '').trim()

    const parts: string[] = []
    if (Number.isFinite(maxViews) && maxViews > 0) {
      parts.push(`已访问 ${views}/${maxViews}`)
    } else {
      parts.push(`已访问 ${views}`)
    }

    if (expiresAt) {
      parts.push(`过期时间 ${formatDateTimeLocal(expiresAt)}`)
    }

    return parts.join(' · ')
  })()

  const passwordHash = String((share as any).password_hash || '').trim()
  const needsPassword = Boolean(passwordHash)
  const consumeAndRender = async (): Promise<Response> => {
    try {
      const { consumed } = await consumeTextShareViewIfAllowed(env.DB, shareId)
      if (!consumed) {
        return renderMessagePage('分享', SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE, 410)
      }

      return renderContentPage({ title, meta, content })
    } catch {
      return renderMessagePage('分享', '访问失败，请稍后重试', 500)
    }
  }

  if (request.method.toUpperCase() === 'GET') {
    if (needsPassword) {
      return renderPasswordForm({ title, meta })
    }

    return renderConfirmPage({ title, meta })
  }

  if (request.method.toUpperCase() === 'POST') {
    if (!needsPassword) {
      return consumeAndRender()
    }

    const ip = getClientIp(request)
    if (await isSharePasswordBlocked(env, normalizedCode, ip)) {
      return renderPasswordForm({ title, meta, error: '尝试次数过多，请 10 分钟后重试' })
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
      return renderPasswordForm({ title, meta, error: '请输入访问口令' })
    }

    if (!verifyPassword(password, passwordHash)) {
      await recordSharePasswordFailedAttempt(env, normalizedCode, ip)
      if (await isSharePasswordBlocked(env, normalizedCode, ip)) {
        return renderPasswordForm({ title, meta, error: '尝试次数过多，请 10 分钟后重试' })
      }
      return renderPasswordForm({ title, meta, error: '口令不正确' })
    }

    await clearSharePasswordFailedAttempts(env, normalizedCode, ip)
    return consumeAndRender()
  }

  return new Response('Method Not Allowed', { status: 405 })
}
