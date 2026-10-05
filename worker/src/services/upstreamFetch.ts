import {
  getUpstreamTimeoutConfig,
  UPSTREAM_READONLY_RETRY_BACKOFF_MS,
} from '../config/upstreamTimeout'

/**
 * 上游 fetch 统一超时 / 只读重试设施。
 *
 * - 所有对 R2 / WebDAV / Koofr 的上游请求都应经由此处，保证带 AbortSignal 超时；
 * - 仅只读方法（GET / HEAD / PROPFIND，幂等可安全重放）在超时后轻量重试，
 *   写操作（PUT / DELETE / MKCOL / MOVE / POST 等）一律不重试。
 */

/** 幂等只读方法集合：超时后允许重试 */
const READ_ONLY_HTTP_METHODS = new Set(['GET', 'HEAD', 'PROPFIND'])

function normalizeMethod(init: RequestInit): string {
  return String(init.method || 'GET').toUpperCase()
}

/** 只读方法（GET/HEAD/PROPFIND）超时后可按配置重试 */
export function isReadOnlyHttpMethod(init: RequestInit): boolean {
  return READ_ONLY_HTTP_METHODS.has(normalizeMethod(init))
}

/** AbortSignal.timeout 超时抛出的 DOMException name 为 TimeoutError；手动 abort 为 AbortError */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带超时与只读重试的 fetch。
 *
 * @param url - 请求 URL
 * @param init - fetch init（已有 signal 时沿用调用方信号）
 * @param options.retries - 显式重试次数；缺省时按方法推断（只读取配置值，写为 0）
 *
 * @example
 * // GET 请求超时后自动重试 1 次（默认配置）
 * await fetchWithUpstreamTimeout(url, { method: 'GET' })
 */
export async function fetchWithUpstreamTimeout(
  url: string,
  init: RequestInit,
  options: { retries?: number } = {}
): Promise<Response> {
  const { fetchTimeoutMs, readonlyRetries } = getUpstreamTimeoutConfig()
  const retries =
    typeof options.retries === 'number'
      ? Math.max(0, Math.floor(options.retries))
      : isReadOnlyHttpMethod(init)
        ? readonlyRetries
        : 0

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(fetchTimeoutMs),
      })
    } catch (error) {
      // 非超时错误、或重试额度用尽：原样抛出
      if (attempt >= retries || !isTimeoutError(error)) throw error
      await delay(UPSTREAM_READONLY_RETRY_BACKOFF_MS)
    }
  }
}
