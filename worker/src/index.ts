import { withD1Retry } from './utils/db'
import type { Env } from './config/env'
import { validateEnvOrWarn } from './config/envValidation'
import { refreshUpstreamTimeoutConfig } from './config/upstreamTimeout'
import { requestIdMiddleware } from './middleware/requestId'
import { originGuardMiddleware } from './middleware/originGuard'
import { rateLimitMiddleware } from './middleware/rateLimit'
import { bootstrapAdmin } from './middleware/bootstrapAdmin'
import { authSessionMiddleware } from './middleware/authSession'
import { withCommonHeaders } from './middleware/securityHeaders'
import { handleFrontendRequest } from './middleware/assets'
import { router } from './router'
import { logRequestOutcome, logRequestStart, logWarn } from './utils/log'

const isolateCreatedAt = Date.now()
let isolateRequestCount = 0
let lastRequestStartedAt: number | null = null
let envValidated = false

type TimingEntry = {
  name: string
  durationMs: number
}

type RuntimeDiagnostics = {
  isolateAgeMs: number
  isolateIdleMs: number | null
  isolateRequestCount: number
}

function isBackendPath(pathname: string): boolean {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/s/') ||
    pathname.startsWith('/t/') ||
    pathname.startsWith('/f/') ||
    isHealthPath(pathname)
  )
}

/**
 * health 探针路径归一判断：`/health` 与 `/api/health` 语义等价。
 *
 * 独立成函数而非内联两处比较：守卫与限流需要按同一口径识别探针，
 * 避免后续新增探针路径时出现中间件与路由分支不一致。
 */
function isHealthPath(pathname: string): boolean {
  return pathname === '/health' || pathname === '/api/health'
}

function shouldRunBootstrapAdmin(request: Request, pathname: string): boolean {
  return request.method === 'POST' && pathname === '/api/auth/login'
}

async function healthResponse(env: Env): Promise<Response> {
  const timestamp = new Date().toISOString()
  let dbStatus: 'ok' | 'error' | 'unavailable' = 'unavailable'
  if (env.DB) {
    try {
      await withD1Retry(env.DB).prepare('SELECT 1').first()
      dbStatus = 'ok'
    } catch (error) {
      dbStatus = 'error'
      // 错误详情仅进服务端日志：/health 为公开端点，D1 错误消息含内部 schema 细节
      console.error('[health] database check failed', error)
    }
  }
  const overall = dbStatus === 'ok' || dbStatus === 'unavailable' ? 'ok' : 'degraded'
  const payload: Record<string, unknown> = {
    status: overall,
    timestamp,
    checks: { db: dbStatus },
  }
  if (dbStatus === 'error') {
    payload.db_error = true
  }
  return new Response(JSON.stringify(payload), {
    status: dbStatus === 'error' ? 503 : 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function measure<T>(
  timings: TimingEntry[],
  name: string,
  action: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now()
  try {
    return await action()
  } finally {
    timings.push({
      name,
      durationMs: Math.max(0, performance.now() - startedAt),
    })
  }
}

function formatTimingDuration(durationMs: number): string {
  return Math.max(0, durationMs).toFixed(1)
}

function createRuntimeDiagnostics(): RuntimeDiagnostics {
  const now = Date.now()
  isolateRequestCount += 1
  const isolateIdleMs =
    lastRequestStartedAt === null ? null : Math.max(0, now - lastRequestStartedAt)
  lastRequestStartedAt = now

  return {
    isolateAgeMs: Math.max(0, now - isolateCreatedAt),
    isolateIdleMs,
    isolateRequestCount,
  }
}

function withTimingHeaders(
  env: Env,
  response: Response,
  timings: TimingEntry[],
  requestStartedAt: number,
  runtime: RuntimeDiagnostics
): Response {
  if (String(env.FLARES3_DEBUG_HEADERS || '').trim() !== '1') {
    return response
  }

  const allTimings = [
    ...timings,
    {
      name: 'total',
      durationMs: Math.max(0, performance.now() - requestStartedAt),
    },
  ]
  if (!allTimings.length) return response

  const headers = new Headers(response.headers)
  const serverTiming = allTimings
    .map((entry) => `${entry.name};dur=${formatTimingDuration(entry.durationMs)}`)
    .join(', ')
  const existingServerTiming = headers.get('Server-Timing')
  headers.set(
    'Server-Timing',
    existingServerTiming ? `${existingServerTiming}, ${serverTiming}` : serverTiming
  )
  headers.set(
    'X-Flares3-Timing',
    allTimings
      .map((entry) => `${entry.name}=${formatTimingDuration(entry.durationMs)}ms`)
      .join('; ')
  )
  headers.set('X-Flares3-Isolate-Request', String(runtime.isolateRequestCount))
  headers.set('X-Flares3-Isolate-Cold', runtime.isolateRequestCount === 1 ? '1' : '0')
  headers.set('X-Flares3-Isolate-Age', `${formatTimingDuration(runtime.isolateAgeMs)}ms`)
  headers.set('X-Flares3-Isolate-Idle', `${formatTimingDuration(runtime.isolateIdleMs ?? 0)}ms`)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const requestStartedAt = performance.now()
  // 刷新 isolate 级上游超时配置（env 恒定，幂等），供无 env 入参的服务层读取
  refreshUpstreamTimeoutConfig(env)
  const runtimeDiagnostics = createRuntimeDiagnostics()
  const timings: TimingEntry[] = []
  requestIdMiddleware(request)
  const accessLog = String(env.LOG_ACCESS || '').trim() === '1'
  let isBackend = false
  let response: Response | undefined
  let requestError: unknown

  // 环境变量验证（仅在首次请求时执行）
  if (!envValidated) {
    envValidated = true
    if (!validateEnvOrWarn(env)) {
      logWarn('worker.env_validation_failed', {
        message: '环境变量验证失败，但继续启动（请检查日志）',
      })
    }
  }

  try {
    const pathname = new URL(request.url).pathname
    isBackend = isBackendPath(pathname)
    if (isBackend && accessLog) {
      logRequestStart(request)
    }

    if (isHealthPath(pathname)) {
      // health 探针归位到安全中间件之后：先过 originGuard 与 rateLimit 再做 D1 探测，
      // 消除无限速的 D1 读放大/计费放大面；探针返回语义（200/503 JSON）保持不变。
      // 有意跳过 bootstrap/auth/route：探针无需会话，也不应触碰登录与用户表
      response = await measure(timings, 'origin', () =>
        Promise.resolve(originGuardMiddleware(request))
      )
      if (!response) {
        response = await measure(timings, 'rateLimit', () => rateLimitMiddleware(request, env))
      }
      if (!response) {
        response = await measure(timings, 'health', () => healthResponse(env))
      }
    } else if (!isBackend) {
      response = await measure(timings, 'assets', () => handleFrontendRequest(request, env))
    } else {
      response = await measure(timings, 'origin', () =>
        Promise.resolve(originGuardMiddleware(request))
      )
      if (!response) {
        response = await measure(timings, 'rateLimit', () => rateLimitMiddleware(request, env))
      }
      if (!response) {
        response = await measure(timings, 'bootstrap', () =>
          shouldRunBootstrapAdmin(request, pathname)
            ? bootstrapAdmin(request, env)
            : Promise.resolve<Response | undefined>(undefined)
        )
      }
      if (!response) {
        response = await measure(timings, 'auth', () => authSessionMiddleware(request, env))
      }
      if (!response) {
        response = await measure(timings, 'route', async () => {
          try {
            return await router.handle(request, env, ctx)
          } catch (error) {
            requestError = error
            return new Response('Internal Server Error', { status: 500 })
          }
        })
      }
    }
  } catch (error) {
    requestError = error
    response = new Response('Internal Server Error', { status: 500 })
  }

  if (!response) {
    response = new Response('Internal Server Error', { status: 500 })
  }

  response = withTimingHeaders(env, response, timings, requestStartedAt, runtimeDiagnostics)
  const durationMs = Math.max(0, performance.now() - requestStartedAt)
  if (isBackend) {
    // 后端请求：5xx 始终记录；4xx/2xx 仅在开启访问日志（LOG_ACCESS=1）时记录
    logRequestOutcome(request, response, { error: requestError, durationMs, accessLog })
  } else if (response.status >= 500) {
    // 非后端（静态资源等）：仅记录 5xx，避免噪声
    logRequestOutcome(request, response, { error: requestError, durationMs })
  }
  return withCommonHeaders(request, response)
}

export default {
  fetch: handleRequest,
  scheduled: async (_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) => {
    refreshUpstreamTimeoutConfig(env)
    const { handleScheduled } = await import('./scheduled')
    await handleScheduled(env)
  },
}
