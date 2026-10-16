import { jsonResponse } from '../utils/response'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const SESSION_COOKIE_NAME = 'flares3_session'

function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase())
}

function isSameOrigin(request: Request, origin: string): boolean {
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized === '127.0.0.1'
  )
}

function isLocalDevelopmentOrigin(request: Request, origin: string): boolean {
  try {
    const originUrl = new URL(origin)
    const requestUrl = new URL(request.url)
    return isLoopbackHostname(originUrl.hostname) && isLoopbackHostname(requestUrl.hostname)
  } catch {
    return false
  }
}

function hasSessionCookie(request: Request): boolean {
  const cookieHeader = request.headers.get('Cookie') || ''
  return cookieHeader.split(';').some((part) => {
    const [name, ...valueParts] = part.trim().split('=')
    return name === SESSION_COOKIE_NAME && valueParts.join('=').trim().length > 0
  })
}

function hasBearerAuthorization(request: Request): boolean {
  const authorization = request.headers.get('Authorization') || ''
  return /^Bearer\s+\S+$/i.test(authorization.trim())
}

export function originGuardMiddleware(request: Request): Response | undefined {
  if (!isUnsafeMethod(request.method)) return

  const origin = request.headers.get('Origin')
  if (origin && !isSameOrigin(request, origin) && !isLocalDevelopmentOrigin(request, origin)) {
    return jsonResponse({ error: '跨源请求被拒绝' }, 403)
  }

  const fetchSite = String(request.headers.get('Sec-Fetch-Site') || '').toLowerCase()
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return jsonResponse({ error: '跨源请求被拒绝' }, 403)
  }

  // Cookie 会话请求必须提供至少一个可验证的浏览器来源信号；否则旧浏览器、
  // HTML 表单或代理缺少来源头时会留下 CSRF 绕过窗口。无会话的 Bearer PAT
  // 客户端不受 Cookie CSRF 影响，保留脚本/CI 的无浏览器头调用兼容性。
  if (!origin && !fetchSite && (hasSessionCookie(request) || !hasBearerAuthorization(request))) {
    return jsonResponse({ error: '请求缺少来源校验信息' }, 403)
  }
}
