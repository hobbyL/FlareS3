import type { Env } from '../config/env'
import { getUser, jsonResponse, redirect } from './utils'
import { viewTextShare } from './textShares'
import { tryViewTextOneTimeShare } from './textOneTimeShares'
import { queryWithRetry } from '../utils/db'

/**
 * 短链接路由处理
 *
 * @route GET /s/:code
 * @param request - HTTP 请求对象
 * @param env - Cloudflare Workers 环境变量
 * @param code - 短链接代码
 * @returns 重定向到对应资源或分享页面
 *
 * @example
 * // 文件短链接（无需登录）(302)
 * // 重定向到 /api/files/:id/download
 *
 * // 文件短链接（需要登录）(302)
 * // 未登录用户重定向到 /login?next=/s/:code
 * // 已登录用户重定向到 /api/files/:id/download
 *
 * // 文本分享短链接 (200/302)
 * // 返回文本分享页面或确认页面
 *
 * // 一次性文本分享短链接 (200/302)
 * // 返回一次性分享确认页面或内容页面
 *
 * // 短码为空 (400)
 * { "error": "短码不能为空" }
 *
 * // 资源不存在 (404)
 * // 返回 404 响应
 */
export async function shortlink(request: Request, env: Env, code: string): Promise<Response> {
  if (!code) return jsonResponse({ error: '短码不能为空' }, 400)
  const file = await queryWithRetry<{
    id: string
    require_login: number
    upload_status: string
    deleted_at: string | null
    owner_status: string | null
  }>(
    env.DB.prepare(
      `SELECT f.id, f.require_login, f.upload_status, f.deleted_at, u.status AS owner_status
     FROM files f
     LEFT JOIN users u ON u.id = f.owner_id
     WHERE f.short_code = ?
     LIMIT 1`
    ).bind(code),
    { operation: 'first' }
  )
  if (!file) {
    const oneTime = await tryViewTextOneTimeShare(request, env, code)
    if (oneTime) return oneTime
    return viewTextShare(request, env, code)
  }
  if (
    file.upload_status !== 'completed' ||
    file.deleted_at ||
    String(file.owner_status || '') !== 'active'
  ) {
    return new Response('Not Found', { status: 404 })
  }
  if (Number(file.require_login) === 1) {
    const user = getUser(request)
    if (!user) {
      const next = encodeURIComponent(`/s/${code}`)
      return redirect(`/login?next=${next}`, 302)
    }
  }
  return redirect(`/api/files/${file.id}/download`, 302)
}
