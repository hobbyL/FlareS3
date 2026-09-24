import type { Env } from './env'

/**
 * 限流默认值。
 *
 * 所有阈值都可以通过 wrangler `[vars]` 或 Cloudflare 环境变量覆盖；
 * 未配置、非数字、非正数时一律回退到这里的默认值，保证限流永远处于生效状态。
 */
export const DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS = 60 * 1000
export const DEFAULT_LOGIN_RATE_LIMIT_MAX = 300
export const DEFAULT_LOGIN_MAX_FAILED_ATTEMPTS = 10
export const DEFAULT_LOGIN_BLOCK_DURATION_MS = 5 * 60 * 1000
export const DEFAULT_SHARE_MAX_FAILED_ATTEMPTS = 5
export const DEFAULT_SHARE_BLOCK_DURATION_MS = 10 * 60 * 1000
export const DEFAULT_PUBLIC_RATE_LIMIT_WINDOW_MS = 60 * 1000
export const DEFAULT_PUBLIC_RATE_LIMIT_MAX = 120

/** `rate_limits.ip` 中分享码密码错误计数使用的 key 前缀 */
export const SHARE_SCOPE_PREFIX = 'share:'
/** `rate_limits.ip` 中公开入口计数使用的 key 前缀 */
export const PUBLIC_RATE_LIMIT_PREFIX = 'public:'

export interface RateLimitConfig {
  /** 登录接口滑动窗口长度（毫秒） */
  loginWindowMs: number
  /** 登录接口单窗口内允许的最大请求数 */
  loginMax: number
  /** 触发 IP 封禁所需的连续登录失败次数 */
  loginMaxFailedAttempts: number
  /** 登录失败达到阈值后的封禁时长（毫秒） */
  loginBlockDurationMs: number
  /** 触发分享码封禁所需的连续密码错误次数 */
  shareMaxFailedAttempts: number
  /** 分享码密码错误达到阈值后的封禁时长（毫秒） */
  shareBlockDurationMs: number
  /** 公开入口（/s/、/t/、/f/、文件下载）滑动窗口长度（毫秒） */
  publicWindowMs: number
  /** 公开入口单窗口内允许的最大请求数 */
  publicMax: number
}

/**
 * 读取正整数型环境变量。
 *
 * 与 `getMaxFileSize` / `getTotalStorage` 保持同一约定：
 * 只接受有限正数，其余情况（undefined / 空串 / NaN / 0 / 负数）回退默认值。
 */
function readPositiveInt(value: string | undefined, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback
}

/**
 * 从环境变量解析限流配置。
 *
 * @param env - Cloudflare Workers 环境变量
 * @returns 完整的限流配置，字段全部为正整数
 *
 * @example
 * // 未配置任何环境变量时
 * getRateLimitConfig({} as Env)
 * // => { loginWindowMs: 60000, loginMax: 300, ... }
 *
 * // 覆盖公开入口限流为 30 次/分钟
 * getRateLimitConfig({ PUBLIC_RATE_LIMIT_MAX: '30' } as Env).publicMax // => 30
 */
export function getRateLimitConfig(env: Env): RateLimitConfig {
  return {
    loginWindowMs: readPositiveInt(env.RATE_LIMIT_WINDOW_MS, DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS),
    loginMax: readPositiveInt(env.RATE_LIMIT_MAX, DEFAULT_LOGIN_RATE_LIMIT_MAX),
    loginMaxFailedAttempts: readPositiveInt(
      env.RATE_LIMIT_MAX_FAILED_ATTEMPTS,
      DEFAULT_LOGIN_MAX_FAILED_ATTEMPTS
    ),
    loginBlockDurationMs: readPositiveInt(
      env.RATE_LIMIT_BLOCK_DURATION_MS,
      DEFAULT_LOGIN_BLOCK_DURATION_MS
    ),
    shareMaxFailedAttempts: readPositiveInt(
      env.SHARE_RATE_LIMIT_MAX_FAILED_ATTEMPTS,
      DEFAULT_SHARE_MAX_FAILED_ATTEMPTS
    ),
    shareBlockDurationMs: readPositiveInt(
      env.SHARE_RATE_LIMIT_BLOCK_DURATION_MS,
      DEFAULT_SHARE_BLOCK_DURATION_MS
    ),
    publicWindowMs: readPositiveInt(
      env.PUBLIC_RATE_LIMIT_WINDOW_MS,
      DEFAULT_PUBLIC_RATE_LIMIT_WINDOW_MS
    ),
    publicMax: readPositiveInt(env.PUBLIC_RATE_LIMIT_MAX, DEFAULT_PUBLIC_RATE_LIMIT_MAX),
  }
}
