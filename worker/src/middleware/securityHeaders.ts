import { isSecureRequest } from '../utils/requestSecurity'

/**
 * CSP nonce 内部约定头：渲染侧（sharePage.htmlResponse）把本次页面内联脚本的
 * nonce 存到该头，withCommonHeaders 读取后生成 script-src 'nonce-...'，
 * 并在最终响应前移除该头，不对外泄漏。
 */
export const CSP_NONCE_HEADER = 'X-Flares3-Csp-Nonce'

function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get('Content-Type') || ''
  return contentType.toLowerCase().includes('text/html')
}

function buildHtmlCsp(nonce: string | null): string {
  // nonce 仅放行本次渲染的内联脚本；其余内联脚本仍被拒绝（禁止 'unsafe-inline'）
  const scriptSrc = nonce ? `script-src 'self' 'nonce-${nonce}'` : "script-src 'self'"
  return [
    "default-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https:",
    "frame-src 'self' https:",
    "object-src 'none'",
  ].join('; ')
}

export function withCommonHeaders(request: Request, response: Response): Response {
  const headers = new Headers(response.headers)

  const requestId = (request as Request & { requestId?: string }).requestId
  if (requestId) {
    headers.set('X-Request-Id', requestId)
  }

  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'same-origin')
  headers.set('X-Frame-Options', 'DENY')
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
  )
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  if (isSecureRequest(request)) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  if (isHtmlResponse(response)) {
    // 渲染侧经约定头传入本次页面的脚本 nonce；生成 CSP 后移除，不泄漏到最终响应
    const nonce = headers.get(CSP_NONCE_HEADER)
    headers.set('Content-Security-Policy', buildHtmlCsp(nonce))
    if (nonce) {
      headers.delete(CSP_NONCE_HEADER)
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
