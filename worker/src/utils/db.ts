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
 * 新代码建议直接使用 {@link withD1Retry} 包装整个 db，保持 D1 原生返回形态。
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

/**
 * 仅需查询能力的 D1 视图。
 *
 * 辅助函数以此窄类型声明依赖，即可同时接受原生 `env.DB`
 * 与 {@link withD1Retry} 的包装结果。
 */
export type D1QueryDb = Pick<D1Database, 'prepare' | 'batch'>

type ResolvedRetryOptions = {
  maxRetries: number
  timeoutMs: number
}

/** 共用的「超时 + 可重试错误指数退避」执行核心 */
async function runWithRetry<T>(exec: () => Promise<T>, options: ResolvedRetryOptions): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await executeWithTimeout(exec(), options.timeoutMs)
    } catch (error) {
      lastError = error

      // 不可重试错误直接抛出
      if (!isRetryableError(error)) throw error
      if (attempt === options.maxRetries) throw error

      const backoffMs = 100 * Math.pow(2, attempt)
      await delay(backoffMs)
    }
  }

  throw lastError
}

/** 包装 D1PreparedStatement：执行方法获得超时与重试保护，返回形态与 D1 原生一致 */
class RetryD1Statement implements D1PreparedStatement {
  // 供 RetryD1Database.batch 解包（包装语句需还原为原生语句后才可批量执行）
  readonly statement: D1PreparedStatement

  constructor(
    statement: D1PreparedStatement,
    private readonly options: ResolvedRetryOptions
  ) {
    this.statement = statement
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new RetryD1Statement(this.statement.bind(...values), this.options)
  }

  first<T = unknown>(colName: string): Promise<T | null>
  first<T = Record<string, unknown>>(): Promise<T | null>
  first<T = unknown>(colName?: string): Promise<T | null> {
    return runWithRetry(
      () => (colName === undefined ? this.statement.first<T>() : this.statement.first<T>(colName)),
      this.options
    )
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return runWithRetry(() => this.statement.all<T>(), this.options)
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return runWithRetry(() => this.statement.run<T>(), this.options)
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const exec = (): Promise<T[] | [string[], ...T[]]> =>
      options?.columnNames === true
        ? this.statement.raw<T>({ columnNames: true })
        : this.statement.raw<T>()
    return runWithRetry(exec, this.options)
  }
}

function unwrapStatement(statement: D1PreparedStatement): D1PreparedStatement {
  return statement instanceof RetryD1Statement ? statement.statement : statement
}

/** 包装 D1 数据库：prepare 出的语句执行自动获得超时与重试保护 */
class RetryD1Database implements D1QueryDb {
  constructor(
    private readonly db: D1QueryDb,
    private readonly options: ResolvedRetryOptions
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new RetryD1Statement(this.db.prepare(query), this.options)
  }

  /**
   * batch 仅加超时保护、不自动重试：
   * 批量语句通常包含写入，重放可能造成重复写入等副作用。
   */
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return executeWithTimeout(
      this.db.batch<T>(statements.map(unwrapStatement)),
      this.options.timeoutMs
    )
  }
}

/**
 * 以「保持 D1 原生语义」的方式为 db 增加查询超时与瞬时错误重试。
 *
 * 与 {@link queryWithRetry} 的区别：`all()` 返回完整 `D1Result`（不拆 `.results`），
 * 因此现有调用点无需改动对返回值的用法。
 */
export function withD1Retry(
  db: D1QueryDb,
  options: { maxRetries?: number; timeoutMs?: number } = {}
): D1QueryDb {
  return new RetryD1Database(db, {
    maxRetries: options.maxRetries ?? 2,
    timeoutMs: options.timeoutMs ?? 5000,
  })
}
