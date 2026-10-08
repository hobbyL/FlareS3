/**
 * 判定请求是否经 https 到达（含反代转发场景）。
 *
 * 会话 cookie 与 folder 分享 cookie 的 Secure 标志共用此判定：
 * https 下签发带 Secure 的 cookie，本地 http dev 下不加以保持可用。
 */
export function isSecureRequest(request: Request): boolean {
  const url = new URL(request.url)
  if (url.protocol === 'https:') return true
  const forwardedProto = request.headers.get('X-Forwarded-Proto')
  return forwardedProto?.split(',')[0]?.trim() === 'https'
}
