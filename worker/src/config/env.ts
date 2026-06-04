export type Env = {
  ASSETS?: Fetcher
  DB: D1Database
  MAX_FILE_SIZE?: string
  TOTAL_STORAGE?: string
  BOOTSTRAP_ADMIN_USER?: string
  BOOTSTRAP_ADMIN_PASS?: string
  /**
   * 用于签名认证 Cookie / Bearer token。未设置时回退使用 R2_MASTER_KEY。
   */
  AUTH_TOKEN_SECRET?: string
  /**
   * 用于加密/解密存储在 D1 中的 R2 Access Key / Secret Key（AES-GCM）。
   * 32 字节 base64；必须长期保持不变，否则历史配置将无法解密。
   */
  R2_MASTER_KEY?: string
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
