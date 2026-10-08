import { isSecureRequest } from '../utils/requestSecurity'

function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get('Content-Type') || ''
  return contentType.toLowerCase().includes('text/html')
}

function buildHtmlCsp(): string {
  return [
    "default-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "script-src 'self'",
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
    headers.set('Content-Security-Policy', buildHtmlCsp())
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
