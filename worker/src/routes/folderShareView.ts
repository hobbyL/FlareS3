import type { Env } from '../config/env'
import { logWarn } from '../utils/log'
import { verifyPassword } from '../services/password'
import { createProvider } from '../services/storage/factory'
import { normalizeStoragePath } from '../services/storage/pathPolicy'
import { resolveFolderShareRecord } from '../services/folderShares'
import {
  consumeFolderShareViewIfAllowed,
  SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE,
} from '../services/shareViewGuard'
import { buildSanitizedSharedDownloadResponse } from '../services/fileShareDownload'
import { fetchWithUpstreamTimeout } from '../services/upstreamFetch'
import { recordShareAccess } from '../services/shareAccessLog'
import {
  clearSharePasswordFailedAttempts,
  getClientIp,
  isSharePasswordBlocked,
  recordSharePasswordFailedAttempt,
} from '../middleware/rateLimit'
import {
  MAX_SHARE_PASSWORD_FORM_BYTES,
  rejectInvalidContentLength,
} from '../services/requestBodyPolicy'
import { buildShareCookieName, signShareCookie, verifyShareCookie } from '../services/shareCookie'
import { isSecureRequest } from '../utils/requestSecurity'
import { formatDateTimeLocal } from '../services/shareFormatting'
import {
  renderFolderListPage,
  renderFolderMessagePage,
  renderFolderPasswordForm,
} from './folderSharePages'

function getBasename(key: string): string {
  const normalized = String(key || '')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

function buildFolderTitle(prefix: string): string {
  const trimmed = String(prefix || '').trim()
  if (!trimmed) return '共享目录'
  const withoutTrailing = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  return `${getBasename(withoutTrailing) || trimmed}/`
}

function buildShareMeta(share: {
  views: number
  max_views: number
  expires_at: string | null
}): string {
  const parts: string[] = []
  if (share.max_views > 0) {
    parts.push(`已访问 ${share.views}/${share.max_views}`)
  } else {
    parts.push(`已访问 ${share.views}`)
  }
  if (share.expires_at) {
    parts.push(`过期时间 ${formatDateTimeLocal(share.expires_at)}`)
  }
  return parts.join(' · ')
}

/** folder 分享 GET 的目录 path：允许空（根）与尾斜杠，统一强制尾斜杠形态 */
function normalizeDirectoryPathParam(value: string): { path: string } | { error: Response } {
  const result = normalizeStoragePath(value, {
    allowEmpty: true,
    allowTrailingSlash: true,
    forceTrailingSlash: true,
  })
  if (!result.ok) {
    return { error: renderFolderMessagePage('分享目录', result.message, 400) }
  }
  return { path: result.key }
}

/** folder 分享 POST 的下载 path：必须是文件形态（无尾斜杠），允许空（纯验证/回列表） */
function normalizeFilePathParam(value: string): { path: string } | { error: Response } {
  const result = normalizeStoragePath(value, { allowEmpty: true })
  if (!result.ok) {
    return { error: renderFolderMessagePage('分享目录', result.message, 400) }
  }
  return { path: result.key }
}

async function buildFolderDownloadResponse(
  env: Env,
  configId: string,
  fullKey: string,
  filename: string
): Promise<Response> {
  const provider = await createProvider(env, configId)
  if (!provider) {
    return renderFolderMessagePage('分享目录', '存储配置未找到', 503)
  }

  try {
    const result = await provider.download(fullKey, filename, 3600)
    if (result.kind === 'redirect') {
      // 上游拉取经统一超时封装（GET 只读，超时按配置轻量重试）
      const upstream = await fetchWithUpstreamTimeout(result.url, { method: 'GET' })
      const sanitized = await buildSanitizedSharedDownloadResponse(upstream, filename)
      if (!sanitized.ok) {
        return renderFolderMessagePage('分享目录', sanitized.error.message, sanitized.error.status)
      }
      return sanitized.response
    }
    return result.response
  } catch (error) {
    // 上游错误详情仅进服务端日志，响应体保持固定文案（对齐 file 分享下载管线）
    console.error('[folderShareView] provider download failed', error)
    return renderFolderMessagePage('分享目录', '文件下载失败，请稍后重试', 502)
  }
}

/**
 * folder 分享视图处理（/f/:code 双模的 folder 分支）。
 *
 * 契约：
 * - 返回 null 表示 code 不属于 folder_shares（含 owner 非 active 的降级场景），
 *   由调用方继续走既有 file 分享流程（零改动路径）；
 * - folder 命中时完整处理 GET（列表/密码表单）与 POST（密码验证 Set-Cookie、
 *   下载消费）并返回 Response；
 * - 访问日志按 PRD 矩阵尽力记录：ok / rejected_password / expired / exhausted / not_found。
 */
export async function tryHandleFolderShareView(
  request: Request,
  env: Env,
  code: string
): Promise<Response | null> {
  // folder_shares 解析失败（表缺失 / D1 抖动）时降级回 file 流程：
  // 旁路故障不得拖垮既有 file 分享行为
  let resolved: Awaited<ReturnType<typeof resolveFolderShareRecord>>
  try {
    resolved = await resolveFolderShareRecord(env, code)
  } catch (error) {
    logWarn('share.folder.resolve.failed', {
      code,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
    return null
  }

  if ('error' in resolved) {
    // folder_shares 无行：交给 file 流程继续解析（file/text/folder 短码创建时互斥）
    if (resolved.error.status === 404 && resolved.error.message === '分享链接不存在') {
      return null
    }

    // folder 行存在但已过期/耗尽：直接渲染错误页并记录访问结果
    if (request.method.toUpperCase() === 'POST') {
      const result =
        resolved.error.message === SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE ? 'exhausted' : 'expired'
      await recordShareAccess(env, {
        share_type: 'folder',
        share_id: resolved.error.shareId ?? '',
        ip: getClientIp(request),
        user_agent: request.headers.get('User-Agent'),
        result,
      })
    }
    return renderFolderMessagePage('分享目录', resolved.error.message, resolved.error.status)
  }

  const share = resolved.share
  const url = new URL(request.url)
  const method = request.method.toUpperCase()
  const passwordHash = String(share.password_hash || '').trim()
  const needsPassword = Boolean(passwordHash)
  const cookieName = buildShareCookieName(share.share_code)
  const hasValidCookie = await verifyShareCookie(
    env,
    share.share_code,
    parseCookieValue(request.headers.get('Cookie'), cookieName)
  )
  const title = buildFolderTitle(share.prefix)
  const meta = buildShareMeta(share)

  const ip = getClientIp(request)
  const userAgent = request.headers.get('User-Agent')

  if (method === 'GET') {
    const pathResult = normalizeDirectoryPathParam(url.searchParams.get('path') || '')
    if ('error' in pathResult) {
      return pathResult.error
    }

    if (needsPassword && !hasValidCookie) {
      return renderFolderPasswordForm({
        code: share.share_code,
        title,
        meta,
        path: pathResult.path,
      })
    }

    const provider = await createProvider(env, share.config_id)
    if (!provider) {
      return renderFolderMessagePage('分享目录', '存储配置未找到', 503)
    }

    try {
      const listResult = await provider.list({
        prefix: `${share.prefix}${pathResult.path}`,
        delimiter: '/',
      })
      return renderFolderListPage({
        code: share.share_code,
        title,
        meta,
        path: pathResult.path,
        sharePrefix: share.prefix,
        folders: listResult.common_prefixes || [],
        objects: listResult.contents || [],
      })
    } catch (error) {
      console.error('[folderShareView] provider list failed', error)
      return renderFolderMessagePage('分享目录', '读取目录失败，请稍后重试', 502)
    }
  }

  if (method === 'POST') {
    const bodySizeError = rejectInvalidContentLength(
      request,
      MAX_SHARE_PASSWORD_FORM_BYTES,
      '分享口令表单'
    )
    if (bodySizeError) return bodySizeError

    let formPath = ''
    let password = ''
    try {
      const form = await request.formData()
      formPath = String(form.get('path') || '')
      password = String(form.get('password') || '')
    } catch {
      formPath = ''
      password = ''
    }

    const rawPath = formPath || url.searchParams.get('path') || ''
    const pathResult = normalizeFilePathParam(rawPath)
    if ('error' in pathResult) {
      return pathResult.error
    }
    const downloadPath = pathResult.path

    const respondWithCookie = async (response: Response): Promise<Response> => {
      if (needsPassword && !hasValidCookie) {
        const shareExpiresAtMs = share.expires_at ? new Date(share.expires_at).getTime() : null
        const cookieValue = await signShareCookie(
          env,
          share.share_code,
          Number.isFinite(shareExpiresAtMs) ? shareExpiresAtMs : null
        )
        if (cookieValue) {
          const maxAge = Number(cookieValue.split('.')[0]) - Math.floor(Date.now() / 1000)
          // 与会话 cookie 相同的条件 Secure 判定：https 下带 Secure，本地 http dev 不带
          const secureFlag = isSecureRequest(request) ? '; Secure' : ''
          const headers = new Headers(response.headers)
          headers.append(
            'Set-Cookie',
            `${cookieName}=${cookieValue}; HttpOnly; SameSite=Lax; Path=/f/${share.share_code}; Max-Age=${Math.max(1, maxAge)}${secureFlag}`
          )
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        }
      }
      return response
    }

    // 有密码且 cookie 未生效：先过密码验证
    if (needsPassword && !hasValidCookie) {
      if (await isSharePasswordBlocked(env, code, ip)) {
        return renderFolderPasswordForm({
          code: share.share_code,
          title,
          meta,
          path: '',
          error: '尝试次数过多，请 10 分钟后重试',
        })
      }

      if (!password) {
        return renderFolderPasswordForm({
          code: share.share_code,
          title,
          meta,
          path: '',
          error: '请输入访问口令',
        })
      }

      if (!verifyPassword(password, passwordHash)) {
        await recordSharePasswordFailedAttempt(env, code, ip)
        await recordShareAccess(env, {
          share_type: 'folder',
          share_id: share.id,
          ip,
          user_agent: userAgent,
          path: downloadPath || null,
          result: 'rejected_password',
        })
        if (await isSharePasswordBlocked(env, code, ip)) {
          return renderFolderPasswordForm({
            code: share.share_code,
            title,
            meta,
            path: '',
            error: '尝试次数过多，请 10 分钟后重试',
          })
        }
        return renderFolderPasswordForm({
          code: share.share_code,
          title,
          meta,
          path: '',
          error: '口令不正确',
        })
      }

      await clearSharePasswordFailedAttempts(env, code, ip)

      // 纯密码验证（无下载 path）：签发 cookie 后 302 回列表页
      if (!downloadPath) {
        const redirectResponse = new Response(null, {
          status: 302,
          headers: { Location: `/f/${share.share_code}` },
        })
        return respondWithCookie(redirectResponse)
      }
    }

    // 下载请求：消费访问次数后走 provider 下载
    if (downloadPath) {
      try {
        const { consumed } = await consumeFolderShareViewIfAllowed(env.DB, share.id)
        if (!consumed) {
          await recordShareAccess(env, {
            share_type: 'folder',
            share_id: share.id,
            ip,
            user_agent: userAgent,
            path: downloadPath,
            result: 'exhausted',
          })
          return renderFolderMessagePage('分享目录', SHARE_VIEW_LIMIT_EXHAUSTED_MESSAGE, 410)
        }

        const downloadResponse = await buildFolderDownloadResponse(
          env,
          share.config_id,
          `${share.prefix}${downloadPath}`,
          getBasename(downloadPath)
        )

        await recordShareAccess(env, {
          share_type: 'folder',
          share_id: share.id,
          ip,
          user_agent: userAgent,
          path: downloadPath,
          result: 'ok',
        })

        return respondWithCookie(downloadResponse)
      } catch {
        return renderFolderMessagePage('分享目录', '访问失败，请稍后重试', 500)
      }
    }

    // 无密码分享的空 POST（如直接 POST /f/:code）：回列表页
    return new Response(null, {
      status: 302,
      headers: { Location: `/f/${share.share_code}` },
    })
  }

  return new Response('Method Not Allowed', { status: 405 })
}

/** 从 Cookie 请求头解析指定名称的值（不引入 cookie 解析依赖） */
function parseCookieValue(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim()
    }
  }
  return null
}
