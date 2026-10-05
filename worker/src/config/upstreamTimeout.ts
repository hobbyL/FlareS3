import type { Env } from './env'

/**
 * 上游存储 fetch 超时默认值。
 *
 * R2 签名请求与 WebDAV/Koofr provider 的所有上游 fetch 都必须带超时，
 * 避免上游挂起时长时间占用 Worker 并发；未配置、非数字、非正数时回退默认值。
 */
export const DEFAULT_UPSTREAM_FETCH_TIMEOUT_MS = 30_000
/** 只读操作（GET/HEAD/PROPFIND）超时后的轻量重试次数默认值 */
export const DEFAULT_UPSTREAM_READONLY_RETRIES = 1
/** 只读重试的固定退避间隔 */
export const UPSTREAM_READONLY_RETRY_BACKOFF_MS = 200

export interface UpstreamTimeoutConfig {
  /** 单次上游 fetch 的超时毫秒数 */
  fetchTimeoutMs: number
  /** 只读操作超时后的重试次数（写操作一律不重试） */
  readonlyRetries: number
}

/**
 * 读取正整数型环境变量。
 *
 * 与 `config/rateLimit.ts` 保持同一约定：只接受有限正数，
 * 其余情况（undefined / 空串 / NaN / 0 / 负数）回退默认值；小数向下取整。
 */
function readPositiveInt(value: string | undefined, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback
}

export function parseUpstreamTimeoutConfig(env: {
  UPSTREAM_FETCH_TIMEOUT_MS?: string
  UPSTREAM_FETCH_READONLY_RETRIES?: string
}): UpstreamTimeoutConfig {
  return {
    fetchTimeoutMs: readPositiveInt(
      env.UPSTREAM_FETCH_TIMEOUT_MS,
      DEFAULT_UPSTREAM_FETCH_TIMEOUT_MS
    ),
    readonlyRetries: readPositiveInt(
      env.UPSTREAM_FETCH_READONLY_RETRIES,
      DEFAULT_UPSTREAM_READONLY_RETRIES
    ),
  }
}

/**
 * isolate 级缓存。
 *
 * Workers 同一 isolate 内 env 绑定恒定，请求 / 定时任务入口刷新一次即可；
 * 这样无 env 入参的服务层（r2SignedRequests、storage provider）也能读到同一配置。
 * 未刷新时（如单测直接调用服务层）返回默认值。
 */
let isolateConfig: UpstreamTimeoutConfig | null = null

/** 在请求 / 定时任务入口解析并缓存上游超时配置 */
export function refreshUpstreamTimeoutConfig(env: Env): UpstreamTimeoutConfig {
  isolateConfig = parseUpstreamTimeoutConfig(env)
  return isolateConfig
}

/** 服务层读取上游超时配置（未刷新时为默认值） */
export function getUpstreamTimeoutConfig(): UpstreamTimeoutConfig {
  return isolateConfig ?? parseUpstreamTimeoutConfig({})
}
