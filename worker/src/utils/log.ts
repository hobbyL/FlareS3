export type StructuredLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface StructuredLogContext {
  requestId?: string | null
  userId?: string
  ip?: string
  userAgent?: string
  [key: string]: unknown
}

export function serializeError(error: unknown): string | undefined {
  if (!error) return
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error && error.stack) {
    return error.stack
  }
  return undefined
}

export function logStructured(
  level: StructuredLogLevel,
  event: string,
  payload?: Record<string, unknown>,
  context?: StructuredLogContext
): void {
  const logEntry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context,
    ...payload,
  }

  const line = JSON.stringify(logEntry)

  switch (level) {
    case 'debug':
      console.debug(line)
      break
    case 'info':
      console.info(line)
      break
    case 'warn':
      console.warn(line)
      break
    case 'error':
      console.error(line)
      break
  }
}

export function logInfo(
  event: string,
  payload?: Record<string, unknown>,
  context?: StructuredLogContext
): void {
  logStructured('info', event, payload, context)
}

export function logWarn(
  event: string,
  payload?: Record<string, unknown>,
  context?: StructuredLogContext
): void {
  logStructured('warn', event, payload, context)
}

export function logError(
  event: string,
  error: unknown,
  payload?: Record<string, unknown>,
  context?: StructuredLogContext
): void {
  const errorPayload = {
    ...payload,
    error: serializeError(error),
    stack: getErrorStack(error),
  }
  logStructured('error', event, errorPayload, context)
}

export function logDebug(
  event: string,
  payload?: Record<string, unknown>,
  context?: StructuredLogContext
): void {
  logStructured('debug', event, payload, context)
}

/**
 * 从请求对象构造结构化日志上下文（requestId / userId / ip / userAgent）。
 * 空值一律省略，避免污染日志字段。
 */
function buildRequestContext(request: Request): StructuredLogContext {
  const req = request as Request & { requestId?: string; user?: { id?: string } }
  const context: StructuredLogContext = {
    requestId: req.requestId ?? null,
  }
  if (req.user?.id) {
    context.userId = String(req.user.id)
  }
  const ip = request.headers.get('CF-Connecting-IP')
  if (ip) context.ip = ip
  const userAgent = request.headers.get('User-Agent')
  if (userAgent) context.userAgent = userAgent
  return context
}

/**
 * 构造请求维度的日志载荷：method / path / action / status（可选 durationMs）。
 * `action` 统一为 `${METHOD} ${path}`，便于按操作聚合检索。
 */
function buildRequestPayload(
  request: Request,
  response: Response,
  durationMs?: number
): Record<string, unknown> {
  const method = request.method.toUpperCase()
  const path = new URL(request.url).pathname
  const payload: Record<string, unknown> = {
    method,
    path,
    action: `${method} ${path}`,
    status: response.status,
  }
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    payload.durationMs = Math.round(durationMs)
  }
  return payload
}

/**
 * 记录一次请求开始（debug 级）。仅在开启访问日志时调用，用于排查耗时/链路。
 */
export function logRequestStart(request: Request): void {
  const method = request.method.toUpperCase()
  const path = new URL(request.url).pathname
  logDebug(
    'request.start',
    { method, path, action: `${method} ${path}` },
    buildRequestContext(request)
  )
}

/**
 * 记录一次请求结果，按状态码选择日志级别并携带 requestId / userId / action：
 * - 5xx -> `request.error`（error 级，始终记录）
 * - 4xx -> `request.client_error`（warn 级，仅在开启访问日志时）
 * - 2xx/3xx -> `request.access`（info 级，仅在开启访问日志时）
 *
 * 契约：任何 5xx 响应都必须输出 `request.error`，无论是否开启访问日志、
 * 是否捕获到具体的 error 对象。`error` / `stack` 字段仅在有异常时出现。
 */
export function logRequestOutcome(
  request: Request,
  response: Response,
  options: { error?: unknown; durationMs?: number; accessLog?: boolean } = {}
): void {
  const status = response.status
  const accessLog = options.accessLog === true

  // 非 5xx 且未开启访问日志时保持静默（沿用历史行为：默认只记录 5xx）
  if (status < 500 && !accessLog) {
    return
  }

  const context = buildRequestContext(request)
  const payload = buildRequestPayload(request, response, options.durationMs)

  if (status >= 500) {
    logError('request.error', options.error, payload, context)
    return
  }
  if (status >= 400) {
    logWarn('request.client_error', payload, context)
    return
  }
  logInfo('request.access', payload, context)
}
