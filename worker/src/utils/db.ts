/**
 * 数据库查询工具 - 提供超时和重试机制
 */

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'

// 可重试的错误类型
const RETRYABLE_ERROR_PATTERNS = [
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'database is locked',
  'database is busy',
  'network error',
  'timeout',
]

// 数据库超时错误
export class DatabaseTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseTimeoutError'
  }
}

// 判断错误是否可重试
function isRetryableError(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => message.includes(pattern.toLowerCase()))
}

// 延迟函数
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带超时的查询执行
 */
async function executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: number | null = null

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new DatabaseTimeoutError(`Database query timeout after ${timeoutMs}ms`))
    }, timeoutMs) as unknown as number
  })

  try {
    const result = await Promise.race([promise, timeoutPromise])
    if (timeoutId !== null) clearTimeout(timeoutId)
    return result
  } catch (error) {
    if (timeoutId !== null) clearTimeout(timeoutId)
    throw error
  }
}

/**
 * 带重试的查询执行（单条 / 单语句）
 *
 * `statement` 自带执行能力（`.first()/.all()/.run()`），因此无需再传入 `db`。
 * 批量场景请使用 {@link batchQueryWithRetry}（它需要 `db.batch()`）。
 */
export async function queryWithRetry<T = unknown>(
  statement: D1PreparedStatement,
  options: {
    maxRetries?: number
    timeoutMs?: number
    operation?: 'first' | 'all' | 'run'
  } = {}
): Promise<T | null> {
  const { maxRetries = 2, timeoutMs = 5000, operation = 'first' } = options
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let queryPromise: Promise<any>

      switch (operation) {
        case 'all':
          queryPromise = statement.all()
          break
        case 'run':
          queryPromise = statement.run()
          break
        default:
          queryPromise = statement.first()
      }

      const result = await executeWithTimeout(queryPromise, timeoutMs)

      // D1 的 all() 返回 { results: T[] }
      if (operation === 'all' && result && typeof result === 'object' && 'results' in result) {
        return result.results as any
      }

      return result as T
    } catch (error) {
      lastError = error

      // 如果不是可重试错误，直接抛出
      if (!isRetryableError(error)) {
        throw error
      }

      // 如果已达到最大重试次数，抛出错误
      if (attempt === maxRetries) {
        throw error
      }

      // 指数退避：100ms, 200ms
      const backoffMs = 100 * Math.pow(2, attempt)
      await delay(backoffMs)
    }
  }

  throw lastError
}

/**
 * 批量查询（使用 D1 batch API）
 */
export async function batchQueryWithRetry(
  db: D1Database,
  statements: D1PreparedStatement[],
  options: {
    maxRetries?: number
    timeoutMs?: number
  } = {}
): Promise<any[]> {
  const { maxRetries = 2, timeoutMs = 10000 } = options
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await executeWithTimeout(db.batch(statements), timeoutMs)
      return result
    } catch (error) {
      lastError = error

      if (!isRetryableError(error)) {
        throw error
      }

      if (attempt === maxRetries) {
        throw error
      }

      const backoffMs = 100 * Math.pow(2, attempt)
      await delay(backoffMs)
    }
  }

  throw lastError
}
