import type { AuthKind, AuthUser } from '../middleware/authSession'
import {
  MAX_JSON_REQUEST_BODY_BYTES,
  readBoundedTextBody,
  requestBodyPolicyErrorResponse,
} from '../services/requestBodyPolicy'
import { jsonResponse } from '../utils/response'

export { jsonResponse }
export { requestBodyPolicyErrorResponse } from '../services/requestBodyPolicy'
export {
  calcPresignedDownloadUrlTtlSeconds,
  MAX_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS,
} from '../services/presignedUrlTtl'

export type AuthedRequest = Request & {
  user?: AuthUser
  sessionId?: string
  authKind?: AuthKind
}

export function redirect(location: string, status: number = 302): Response {
  const headers = new Headers()
  headers.set('Location', location)
  return new Response(null, { status, headers })
}

export async function parseJson<T>(request: Request): Promise<T> {
  const text = await readBoundedTextBody(request, MAX_JSON_REQUEST_BODY_BYTES, 'JSON 请求体')
  if (!text) {
    throw new Error('empty_body')
  }
  return JSON.parse(text) as T
}

export function invalidJsonBodyResponse(error: unknown, fallbackMessage = '请求体无效'): Response {
  const policyResponse = requestBodyPolicyErrorResponse(error)
  if (policyResponse) return policyResponse
  return jsonResponse({ error: fallbackMessage }, 400)
}

export function getUser(request: Request): AuthUser | undefined {
  return (request as AuthedRequest).user
}

/**
 * 端点自校验鉴权（admin 口径，返回 Response 表示拒绝）。
 *
 * 与 `router.ts` 的 `withAdmin` 同口径：无用户 → 401，非 admin → 403。
 * mount 等同时挂了 `withAdmin` 的处理器用它做二道校验，保证 handler 被
 * 直接调用（测试、内部复用、未来新增未包 `withAdmin` 的路由）时也不会
 * 退化成「不校验鉴权」——先前这些 handler 只查 `getUser` 存在性，
 * 非 admin 会话能越过路由层进入处理器，与 `withAdmin` 的语义不一致。
 */
export function requireAdminUser(request: Request): Response {
  const user = getUser(request)
  if (!user) {
    return jsonResponse({ error: '未授权' }, 401)
  }
  if (user.role !== 'admin') {
    return jsonResponse({ error: '无权限' }, 403)
  }
  return undefined as unknown as Response
}

/**
 * 端点自校验鉴权（登录口径，返回 Response 表示拒绝）。
 *
 * 与 `router.ts` 的 `withAuth` 同口径：无用户 → 401。用于只是「需要登录」
 * 而非「需要管理员」的处理器，避免误用 admin 口径把普通用户挡在外面。
 */
export function requireAuthedUser(request: Request): Response {
  const user = getUser(request)
  if (!user) {
    return jsonResponse({ error: '未授权' }, 401)
  }
  return undefined as unknown as Response
}

/** 本次请求的鉴权来源（'session' | 'pat'）；未认证为 undefined。 */
export function getAuthKind(request: Request): AuthKind | undefined {
  return (request as AuthedRequest).authKind
}

/**
 * 敏感端点的 PAT 拦截：以 PAT（authKind==='pat'）访问时返回 403，否则返回 undefined 放行。
 *
 * 用于改密 / 会话管理 / token 自管理等「需会话登录」的操作，
 * 防止 API Token 自我扩权与自传播。
 */
export function patForbiddenResponse(request: Request): Response | undefined {
  if (getAuthKind(request) === 'pat') {
    return jsonResponse({ error: '此操作需会话登录，不支持 API Token' }, 403)
  }
  return undefined
}
