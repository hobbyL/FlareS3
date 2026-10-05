import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import { getUser, jsonResponse } from './utils'
import { renderConfirmPage, renderContentPage, renderMessagePage } from './textShares'
import { generateRandomCode } from '../utils/random'
import { SHARE_SHORT_CODE_LENGTH } from '../utils/codePolicy'
import { formatDateTimeLocal } from '../services/shareFormatting'

type LoadTextAuthResult =
  | {
      user: NonNullable<ReturnType<typeof getUser>>
      text: { id: string; owner_id: string; title: string }
      ownerId: string
    }
  | { response: Response }

function getD1Changes(result: unknown): number {
  const metaChanges = Number((result as any)?.meta?.changes ?? 0)
  return Number.isFinite(metaChanges) ? metaChanges : 0
}

async function loadTextAndAuthorize(
  request: Request,
  env: Env,
  textId: string
): Promise<LoadTextAuthResult> {
  const user = getUser(request)
  if (!user) return { response: jsonResponse({ error: '未授权' }, 401) }
  if (!textId) return { response: jsonResponse({ error: 'id 不能为空' }, 400) }

  const text = await withD1Retry(env.DB)
    .prepare('SELECT id, owner_id, title FROM texts WHERE id = ? AND deleted_at IS NULL LIMIT 1')
    .bind(textId)
    .first<{ id: string; owner_id: string; title: string }>()

  if (!text) {
    return { response: jsonResponse({ error: '文本不存在' }, 404) }
  }

  const ownerId = String(text.owner_id)
  if (user.role !== 'admin' && ownerId !== user.id) {
    return { response: jsonResponse({ error: '无权限' }, 403) }
  }

  return { user, text, ownerId }
}

/**
 * 创建一次性文本分享
 *
 * @route POST /api/texts/:id/one-time-share
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param textId - 文本 ID
 * @returns JSON 响应，包含一次性分享信息
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "share": {
 *     "share_code": "abc123",
 *     "expires_at": "2026-09-14T01:00:00.000Z"
 *   }
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // 文本不存在 (404)
 * { "error": "文本不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 *
 * // 生成失败 (500)
 * { "error": "生成一次性分享链接失败" }
 */
export async function createTextOneTimeShare(
  request: Request,
  env: Env,
  textId: string
): Promise<Response> {
  const auth = await loadTextAndAuthorize(request, env, textId)
  if ('response' in auth) {
    return auth.response
  }

  const now = new Date()
  const nowIso = now.toISOString()
  const expiresAtIso = new Date(now.getTime() + 60 * 60 * 1000).toISOString()

  const existing = await withD1Retry(env.DB)
    .prepare('SELECT id FROM text_one_time_shares WHERE text_id = ? LIMIT 1')
    .bind(textId)
    .first()

  if (!existing) {
    const id = crypto.randomUUID()
    for (let i = 0; i < 10; i += 1) {
      const shareCode = generateRandomCode(SHARE_SHORT_CODE_LENGTH)
      const result = await withD1Retry(env.DB)
        .prepare(
          `INSERT INTO text_one_time_shares (id, text_id, owner_id, share_code, expires_at, consumed_at, created_at, updated_at)
	         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
        )
        .bind(id, textId, auth.ownerId, shareCode, expiresAtIso, nowIso, nowIso)
        .run()

      if (!result.error) {
        return jsonResponse({ share: { share_code: shareCode, expires_at: expiresAtIso } })
      }
    }

    return jsonResponse({ error: '生成一次性分享链接失败' }, 500)
  }

  const shareId = String((existing as any).id)
  for (let i = 0; i < 10; i += 1) {
    const shareCode = generateRandomCode(SHARE_SHORT_CODE_LENGTH)
    const result = await withD1Retry(env.DB)
      .prepare(
        `UPDATE text_one_time_shares
	       SET share_code = ?, expires_at = ?, consumed_at = NULL, created_at = ?, updated_at = ?
	       WHERE id = ?`
      )
      .bind(shareCode, expiresAtIso, nowIso, nowIso, shareId)
      .run()

    if (!result.error) {
      return jsonResponse({ share: { share_code: shareCode, expires_at: expiresAtIso } })
    }
  }

  return jsonResponse({ error: '生成一次性分享链接失败' }, 500)
}

/**
 * 删除一次性文本分享
 *
 * @route DELETE /api/texts/:id/one-time-share
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
 */
export async function deleteTextOneTimeShare(
  request: Request,
  env: Env,
  textId: string
): Promise<Response> {
  const auth = await loadTextAndAuthorize(request, env, textId)
  if ('response' in auth) {
    return auth.response
  }

  const existing = await withD1Retry(env.DB)
    .prepare('SELECT id FROM text_one_time_shares WHERE text_id = ? LIMIT 1')
    .bind(textId)
    .first<{ id: string }>()

  if (!existing) {
    return jsonResponse({ success: true, deleted: false })
  }

  const result = await withD1Retry(env.DB)
    .prepare('DELETE FROM text_one_time_shares WHERE id = ?')
    .bind(existing.id)
    .run()

  return jsonResponse({
    success: true,
    deleted: getD1Changes(result) > 0,
  })
}

/**
 * 尝试访问一次性文本分享
 *
 * @route GET|POST /s/:code
 * @param request - HTTP 请求对象
 * @param env - Cloudflare Workers 环境变量
 * @param code - 分享短码
 * @returns HTML 响应或 null（如果短码不匹配一次性分享）
 *
 * @example
 * // GET 请求
 * // 返回确认页面，提示点击查看
 *
 * // POST 请求
 * // 消费链接（设置 consumed_at），返回内容页面
 *
 * // 短码不匹配
 * // 返回 null（由调用方继续尝试其他分享类型）
 *
 * // 内容不存在 (404)
 * // HTML: "内容不存在"
 *
 * // 链接已过期 (410)
 * // HTML: "链接已过期"
 *
 * // 链接已失效（已消费）(410)
 * // HTML: "链接已失效"
 *
 * // 方法不允许 (405)
 * // "Method Not Allowed"
 */
export async function tryViewTextOneTimeShare(
  request: Request,
  env: Env,
  code: string
): Promise<Response | null> {
  if (!code) return null

  const share = await withD1Retry(env.DB)
    .prepare(
      `SELECT s.id, s.text_id, s.share_code, s.expires_at, s.consumed_at,
            t.title AS text_title, t.content AS text_content, t.deleted_at AS text_deleted_at,
            u.status AS owner_status
     FROM text_one_time_shares s
     LEFT JOIN texts t ON t.id = s.text_id
     LEFT JOIN users u ON u.id = s.owner_id
     WHERE s.share_code = ?
     LIMIT 1`
    )
    .bind(code)
    .first()

  if (!share) return null

  if ((share as any).text_deleted_at) {
    return renderMessagePage('分享', '内容不存在', 404)
  }

  if (String((share as any).owner_status || '') !== 'active') {
    return renderMessagePage('分享', '内容不存在', 404)
  }

  const expiresAt = String((share as any).expires_at || '').trim()
  if (expiresAt) {
    const expiresAtMs = new Date(expiresAt).getTime()
    if (Number.isFinite(expiresAtMs) && Date.now() > expiresAtMs) {
      return renderMessagePage('分享', '链接已过期', 410)
    }
  }

  const consumedAt = String((share as any).consumed_at || '').trim()
  if (consumedAt) {
    return renderMessagePage('分享', '链接已失效', 410)
  }

  const title = String((share as any).text_title || '共享文档')
  const content = String((share as any).text_content || '')
  const metaParts = ['一次性链接（仅可访问 1 次）']
  if (expiresAt) {
    metaParts.push(`过期时间 ${formatDateTimeLocal(expiresAt)}`)
  }
  const meta = metaParts.join(' · ')
  const method = request.method.toUpperCase()

  if (method === 'GET') {
    return renderConfirmPage({ title, meta })
  }

  if (method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const shareId = String((share as any).id)
  const nowIso = new Date().toISOString()
  const update = await withD1Retry(env.DB)
    .prepare(
      `UPDATE text_one_time_shares
     SET consumed_at = ?, updated_at = ?
     WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`
    )
    .bind(nowIso, nowIso, shareId, nowIso)
    .run()

  if (update.error) {
    return renderMessagePage('分享', '服务异常', 500)
  }

  if (getD1Changes(update) <= 0) {
    return renderMessagePage('分享', '链接已失效', 410)
  }

  return renderContentPage({ title, meta, content })
}
