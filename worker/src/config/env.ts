export type Env = {
  ASSETS?: Fetcher
  DB: D1Database
  MAX_FILE_SIZE?: string
  TOTAL_STORAGE?: string
  BOOTSTRAP_ADMIN_USER?: string
  BOOTSTRAP_ADMIN_PASS?: string
  /**
   * 用于签名认证 Cookie / Bearer token。必填，不得回退到 R2_MASTER_KEY。
   */
  AUTH_TOKEN_SECRET?: string
  FLARES3_DEBUG_HEADERS?: string
  /**
   * 访问日志开关。设为 "1" 时，除 5xx 外还会输出 4xx（warn）与 2xx/3xx（info）
   * 的结构化请求日志（携带 requestId / userId / action）。缺省关闭以控制日志量。
   */
  LOG_ACCESS?: string
  /**
   * 用于加密/解密存储在 D1 中的 R2 Access Key / Secret Key（AES-GCM）。
   * 32 字节 base64；必须长期保持不变，否则历史配置将无法解密。
   */
  R2_MASTER_KEY?: string
  /**
   * 限流阈值（均为可选，缺省时使用 `config/rateLimit.ts` 中的默认值）。
   * 详见 {@link ../config/rateLimit#getRateLimitConfig}。
   */
  RATE_LIMIT_WINDOW_MS?: string
  RATE_LIMIT_MAX?: string
  RATE_LIMIT_MAX_FAILED_ATTEMPTS?: string
  RATE_LIMIT_BLOCK_DURATION_MS?: string
  SHARE_RATE_LIMIT_MAX_FAILED_ATTEMPTS?: string
  SHARE_RATE_LIMIT_BLOCK_DURATION_MS?: string
  PUBLIC_RATE_LIMIT_WINDOW_MS?: string
  PUBLIC_RATE_LIMIT_MAX?: string
}

export const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024
export const DEFAULT_TOTAL_STORAGE = 10 * 1024 * 1024 * 1024

export function getMaxFileSize(env: Env): number {
  const value = Number(env.MAX_FILE_SIZE)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_FILE_SIZE
}

export function getTotalStorage(env: Env): number {
  const value = Number(env.TOTAL_STORAGE)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TOTAL_STORAGE
}
