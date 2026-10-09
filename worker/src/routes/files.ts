import { withD1Retry } from '../utils/db'
import type { Env } from '../config/env'
import {
  invalidJsonBodyResponse,
  jsonResponse,
  getUser,
  calcPresignedDownloadUrlTtlSeconds,
  redirect,
  parseJson,
} from './utils'
import {
  checkObjectExists,
  generateDownloadUrl,
  generatePreviewUrl,
  resolveR2ConfigForKey,
} from '../services/r2'
import { logAudit, prepareAuditLogInsert } from '../services/audit'
import { createProvider } from '../services/storage/factory'
import { StorageError, type StorageProvider } from '../services/storage/types'
import { R2Provider } from '../services/storage/r2-provider'
import { normalizeStorageFilename } from '../services/storage/pathPolicy'
import { prepareEnqueueFileDeletionIfNeeded } from '../services/deleteQueue'
import { getClientIp } from '../middleware/rateLimit'
import { prepareReleaseUploadReservation } from '../services/uploadReservations'
import {
  MAX_PREVIEW_RESPONSE_BYTES,
  limitedPreviewResponse,
  readBoundedResponseText,
} from '../services/previewResponsePolicy'
import {
  formatUpstreamFetchError,
  getFilenameExtension,
  isArchiveFile,
  normalizeContentType,
  resolvePreviewMode,
} from '../services/filePreview'
import { getExplicitProviderConfigId } from '../services/fileStorage'
import { fetchWithUpstreamTimeout } from '../services/upstreamFetch'

export { listFiles, listTrashFiles } from './fileListing'

/**
 * 下载文件
 *
 * 登录用户的前台直链下载入口：未登录一律 302 跳转登录页；
 * require_login=1 仅 owner / admin 可下，require_login=0 任何登录用户可下
 * （公开访客须走 /s、/f 分享链路，受口令/有效期/次数约束）。
 *
 * @route GET /api/files/:id/download
 * @param request - HTTP 请求对象（未登录时 302 跳转登录页）
 * @param env - Cloudflare Workers 环境变量
 * @param fileId - 文件 ID
 * @returns 重定向到预签名下载 URL 或错误响应
 *
 * @example
 * // 成功响应 (302)
 * // 重定向到预签名下载 URL
 *
 * // 未登录 (302)
 * // 重定向到 /login?next=%2Fapi%2Ffiles%2F<id>%2Fdownload
 *
 * // 文件不存在 (404)
 * { "error": "文件不存在" }
 *
 * // 文件未完成上传 (400)
 * { "error": "文件未完成上传" }
 *
 * // 文件已过期 (410)
 * { "error": "文件已过期" }
 *
 * // 已登录非 owner/admin 下载 require_login=1 文件 (403)
 * { "error": "无权限" }
 *
 * // 存储配置未找到 (503)
 * { "error": "存储配置未找到" }
 *
 * // 文件过期时间无效 (500)
 * { "error": "文件过期时间无效" }
 *
 * // 存储上游下载失败 (502)
 * { "error": "文件下载失败：上游存储服务暂时不可用" }
 */
export async function downloadFile(request: Request, env: Env, fileId: string): Promise<Response> {
  const file = await withD1Retry(env.DB)
    .prepare(
      `SELECT f.id, f.owner_id, f.filename, f.r2_key, f.expires_at, f.upload_status, f.require_login, f.config_id,
            u.status AS owner_status
     FROM files f
     LEFT JOIN users u ON u.id = f.owner_id
     WHERE f.id = ?
     LIMIT 1`
    )
    .bind(fileId)
    .first()
  if (!file) {
    return jsonResponse({ error: '文件不存在' }, 404)
  }
  if (String((file as any).owner_status || '') !== 'active') {
    return jsonResponse({ error: '文件不存在' }, 404)
  }
  if (file.upload_status !== 'completed') {
    return jsonResponse({ error: '文件未完成上传' }, 400)
  }
  const expiresAt = new Date(String(file.expires_at))
  const expiresAtMs = expiresAt.getTime()
  if (Number.isNaN(expiresAtMs)) {
    return jsonResponse({ error: '文件过期时间无效' }, 500)
  }
  if (Date.now() > expiresAtMs) {
    return jsonResponse({ error: '文件已过期' }, 410)
  }

  const user = getUser(request)
  // 登录门槛：未登录访客一律 302 到登录页（含短链 302 过来的 require_login=0 访客），
  // 避免仅凭文件 UUID 绕过 file_shares 的口令 / 有效期 / 次数限制
  if (!user) {
    const next = encodeURIComponent(`/api/files/${fileId}/download`)
    return redirect(`/login?next=${next}`, 302)
  }

  // require_login=1：仅允许 owner / admin 直接下载；其他用户必须通过分享链接下载
  if (
    Number(file.require_login) === 1 &&
    user.role !== 'admin' &&
    String(file.owner_id) !== user.id
  ) {
    return jsonResponse({ error: '无权限' }, 403)
  }

  const r2Key = String(file.r2_key)
  const explicitProviderConfigId = getExplicitProviderConfigId(file)
  if (explicitProviderConfigId) {
    const provider = await createProvider(env, explicitProviderConfigId)
    if (!provider) return jsonResponse({ error: '存储配置未找到' }, 503)

    try {
      const result = await provider.download(r2Key, String(file.filename), 3600)

      await logAudit(env.DB, {
        actorUserId: user.id,
        action: 'FILE_DOWNLOAD',
        targetType: 'file',
        targetId: fileId,
        ip: getClientIp(request),
        userAgent: request.headers.get('User-Agent') || undefined,
        metadata: { require_login: Number(file.require_login) },
      })

      if (result.kind === 'redirect') {
        return redirect(result.url, 302)
      }
      return result.response
    } catch (error) {
      return jsonResponse({ error: `文件下载失败：${formatUpstreamFetchError(error)}` }, 502)
    }
  }

  const loaded = await resolveR2ConfigForKey(env, r2Key)

  if (loaded) {
    const ttl = calcPresignedDownloadUrlTtlSeconds(expiresAt)
    const downloadUrl = await generateDownloadUrl(loaded.config, r2Key, String(file.filename), ttl)

    await logAudit(env.DB, {
      actorUserId: user.id,
      action: 'FILE_DOWNLOAD',
      targetType: 'file',
      targetId: fileId,
      ip: getClientIp(request),
      userAgent: request.headers.get('User-Agent') || undefined,
      metadata: { require_login: Number(file.require_login) },
    })

    return redirect(downloadUrl, 302)
  }

  return jsonResponse({ error: '存储配置未找到' }, 503)
}

/**
 * 预览文件
 *
 * @route GET /api/files/:id/preview
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param fileId - 文件 ID
 * @returns 文件内容或预览信息
 *
 * @example
 * // 文本文件响应 (200)
 * // Content-Type: text/plain
 * // Body: 文件内容（限制 1MB）
 *
 * // 图片文件响应 (200)
 * // Content-Type: image/jpeg
 * // Body: 图片二进制数据
 *
 * // 文件不存在 (404)
 * { "error": "文件不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function previewFile(request: Request, env: Env, fileId: string): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const file = await withD1Retry(env.DB)
    .prepare(
      `SELECT id, owner_id, filename, r2_key, content_type, expires_at, upload_status, config_id FROM files WHERE id = ? LIMIT 1`
    )
    .bind(fileId)
    .first()

  if (!file) {
    return jsonResponse({ error: '文件不存在' }, 404)
  }
  if (user.role !== 'admin' && file.owner_id !== user.id) {
    return jsonResponse({ error: '无权限' }, 403)
  }
  if (file.upload_status !== 'completed') {
    return jsonResponse({ error: '文件未完成上传' }, 400)
  }

  const expiresAt = new Date(String(file.expires_at))
  const expiresAtMs = expiresAt.getTime()
  if (Number.isNaN(expiresAtMs)) {
    return jsonResponse({ error: '文件过期时间无效' }, 500)
  }
  if (Date.now() > expiresAtMs) {
    return jsonResponse({ error: '文件已过期' }, 410)
  }

  const contentType = normalizeContentType(file.content_type)
  const extension = getFilenameExtension(file.filename)
  if (isArchiveFile(contentType, extension)) {
    return jsonResponse({ error: '不支持预览压缩包' }, 415)
  }

  const mode = resolvePreviewMode(contentType, extension)
  if (!mode) {
    return jsonResponse({ error: '不支持预览该文件类型' }, 415)
  }

  const r2Key = String(file.r2_key)
  const explicitProviderConfigId = getExplicitProviderConfigId(file)
  if (explicitProviderConfigId) {
    const provider = await createProvider(env, explicitProviderConfigId)
    if (!provider) return jsonResponse({ error: '存储配置未找到' }, 503)

    try {
      const result = await provider.preview(
        r2Key,
        String(file.filename),
        600,
        mode.kind === 'redirect' ? mode.responseContentType : undefined
      )
      if (result.kind === 'redirect') {
        return redirect(result.url, 302)
      }
      return limitedPreviewResponse(result.response, mode.responseContentType)
    } catch (error) {
      return jsonResponse({ error: `生成预览链接失败：${formatUpstreamFetchError(error)}` }, 502)
    }
  }

  const loaded = await resolveR2ConfigForKey(env, r2Key)
  if (!loaded) return jsonResponse({ error: '存储配置未找到' }, 503)

  const ttl = calcPresignedDownloadUrlTtlSeconds(expiresAt)
  let previewUrl = ''
  try {
    previewUrl = await generatePreviewUrl(
      loaded.config,
      String(file.r2_key),
      String(file.filename),
      ttl,
      mode.kind === 'redirect' ? mode.responseContentType : undefined
    )
  } catch (error) {
    return jsonResponse({ error: `生成预览链接失败：${formatUpstreamFetchError(error)}` }, 502)
  }

  if (mode.kind === 'redirect') {
    return redirect(previewUrl, 302)
  }

  let response: Response
  try {
    // 上游预览经统一超时封装（GET 只读，超时按配置轻量重试）
    response = await fetchWithUpstreamTimeout(previewUrl, {
      headers: {
        Range: `bytes=0-${MAX_PREVIEW_RESPONSE_BYTES - 1}`,
      },
    })
  } catch (error) {
    return jsonResponse({ error: `预览内容获取失败：${formatUpstreamFetchError(error)}` }, 502)
  }
  if (response.status === 416) {
    try {
      // 416 回退：上游不支持 Range 语义时整段重取，仍经统一超时封装
      response = await fetchWithUpstreamTimeout(previewUrl, { method: 'GET' })
    } catch (error) {
      return jsonResponse({ error: `预览内容获取失败：${formatUpstreamFetchError(error)}` }, 502)
    }
  }
  if (!response.ok) {
    const text = await readBoundedResponseText(response).catch(() => '')
    return jsonResponse({ error: text || '预览内容获取失败' }, response.status || 502)
  }

  return limitedPreviewResponse(response, mode.responseContentType)
}

/**
 * 恢复已删除的文件
 *
 * @route POST /api/files/:id/restore
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param fileId - 文件 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 成功响应 (200)
 * { "message": "文件已恢复" }
 *
 * // 文件不存在 (404)
 * { "error": "文件不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 *
 * // 文件已过期，无法恢复 (410)
 * { "error": "文件已过期，无法恢复" }
 *
 * // 文件对象不存在，无法恢复 (409)
 * { "error": "文件对象不存在，无法恢复" }
 *
 * // 恢复校验失败 (502)
 * { "error": "文件恢复校验失败：..." }
 *
 * // 存储配置未找到 (503)
 * { "error": "存储配置未找到" }
 */
export async function restoreFile(request: Request, env: Env, fileId: string): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const file = await withD1Retry(env.DB)
    .prepare(
      'SELECT id, owner_id, r2_key, expires_at, upload_status, deleted_at, config_id FROM files WHERE id = ? LIMIT 1'
    )
    .bind(fileId)
    .first()

  if (!file) {
    return jsonResponse({ error: '文件不存在' }, 404)
  }
  if (user.role !== 'admin' && file.owner_id !== user.id) {
    return jsonResponse({ error: '无权限' }, 403)
  }
  if (file.upload_status !== 'deleted' || !file.deleted_at) {
    return jsonResponse({ error: '文件不在回收站' }, 400)
  }

  const expiresAt = new Date(String(file.expires_at)).getTime()
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return jsonResponse({ error: '文件已过期，无法恢复' }, 410)
  }

  const r2Key = String(file.r2_key)
  const explicitProviderConfigId = getExplicitProviderConfigId(file)
  if (explicitProviderConfigId) {
    const provider = await createProvider(env, explicitProviderConfigId)
    if (!provider) return jsonResponse({ error: '存储配置未找到' }, 503)

    const exists = await provider.checkExists(r2Key)
    if (!exists) {
      return jsonResponse({ error: '文件对象不存在，无法恢复' }, 409)
    }

    const now = new Date().toISOString()
    await withD1Retry(env.DB).batch([
      withD1Retry(env.DB)
        .prepare(
          "UPDATE files SET upload_status = 'completed', deleted_at = NULL, multipart_upload_id = NULL WHERE id = ?"
        )
        .bind(fileId),
      prepareReleaseUploadReservation(env.DB, fileId, now),
      prepareAuditLogInsert(
        env.DB,
        {
          actorUserId: user.id,
          action: 'FILE_RESTORE',
          targetType: 'file',
          targetId: fileId,
          ip: getClientIp(request),
          userAgent: request.headers.get('User-Agent') || undefined,
        },
        now
      ),
    ])
    return jsonResponse({ success: true })
  }

  const loaded = await resolveR2ConfigForKey(env, r2Key)
  if (!loaded) return jsonResponse({ error: '存储配置未找到' }, 503)

  // 对齐 provider 分支：恢复前校验 R2 对象仍存在，避免恢复出无对象的「完成」空壳
  // （delete_queue 清理重试期间对象可能已被删除）。HEAD 异常按现有错误体系返回 502。
  try {
    const exists = await checkObjectExists(loaded.config, r2Key)
    if (!exists) {
      return jsonResponse({ error: '文件对象不存在，无法恢复' }, 409)
    }
  } catch (error) {
    return jsonResponse({ error: `文件恢复校验失败：${formatUpstreamFetchError(error)}` }, 502)
  }

  const now = new Date().toISOString()
  await withD1Retry(env.DB).batch([
    withD1Retry(env.DB)
      .prepare(
        "UPDATE files SET upload_status = 'completed', deleted_at = NULL, multipart_upload_id = NULL WHERE id = ?"
      )
      .bind(fileId),
    withD1Retry(env.DB)
      .prepare(
        'UPDATE delete_queue SET processed_at = ? WHERE file_id = ? AND processed_at IS NULL'
      )
      .bind(now, fileId),
    prepareAuditLogInsert(
      env.DB,
      {
        actorUserId: user.id,
        action: 'FILE_RESTORE',
        targetType: 'file',
        targetId: fileId,
        ip: getClientIp(request),
        userAgent: request.headers.get('User-Agent') || undefined,
      },
      now
    ),
  ])

  return jsonResponse({ success: true })
}

/**
 * 判断 provider 异常是否表示远端对象不存在（404/NotFound）。
 * 永久删除路径会忽略「远端已缺失」继续清理本地记录，其余真实失败仅补 warn 日志不阻塞删除。
 */
function isRemoteObjectMissingError(error: unknown): boolean {
  return (
    error instanceof StorageError && (error.httpStatusCode === 404 || error.code === 'NotFound')
  )
}

/** 回收站永久删除的每页文件数：分页批处理，避免回收站积压时单请求超时 / 触顶子请求上限 */
const TRASH_PERMANENT_DELETE_PAGE_SIZE = 100

/**
 * 永久删除回收站中的所有文件
 *
 * @route DELETE /api/files/trash/permanent
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @returns JSON 响应，包含删除统计
 *
 * @example
 * // 成功响应 (200)
 * {
 *   "success": true,
 *   "deleted": 5,
 *   "queued": 2,
 *   "total": 7
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // 存储配置未找到 (503)
 * { "error": "存储配置未找到" }
 */
export async function permanentlyDeleteTrashFiles(request: Request, env: Env): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const now = new Date().toISOString()
  const ip = getClientIp(request)
  const userAgent = request.headers.get('User-Agent') || undefined
  let deleted = 0
  let queued = 0
  let total = 0

  // 游标分页（id 升序）：每页逐文件处理，任一文件失败即抛出中断，
  // 已处理文件已落库，未处理文件下次调用从游标头部继续（部分成功可重试续跑）。
  let cursor: string | null = null
  for (;;) {
    const { results } = await withD1Retry(env.DB)
      .prepare(
        `SELECT id, owner_id, r2_key, upload_status, deleted_at, config_id
     FROM files
     WHERE owner_id = ? AND upload_status = 'deleted' AND deleted_at IS NOT NULL
       AND id > ?
     ORDER BY id ASC
     LIMIT ?`
      )
      .bind(user.id, cursor ?? '', TRASH_PERMANENT_DELETE_PAGE_SIZE)
      .all<Record<string, unknown>>()

    const files: Record<string, unknown>[] = results || []
    if (!files.length) break
    total += files.length

    for (const file of files) {
      cursor = String(file.id)
      const fileId = String(file.id)
      const r2Key = String(file.r2_key)
      const explicitProviderConfigId = getExplicitProviderConfigId(file)

      if (explicitProviderConfigId) {
        const provider = await createProvider(env, explicitProviderConfigId)
        if (!provider) return jsonResponse({ error: '存储配置未找到' }, 503)

        try {
          await provider.delete(r2Key)
        } catch (error) {
          // 远端文件可能已不存在，永久删除继续清理本地记录；非 404 类真实失败补 warn 日志便于排障。
          if (!isRemoteObjectMissingError(error)) {
            console.warn('[files] provider delete failed', { fileId, key: r2Key, error })
          }
        }

        const batchResults = await withD1Retry(env.DB).batch([
          prepareReleaseUploadReservation(env.DB, fileId, now),
          withD1Retry(env.DB).prepare('DELETE FROM file_shares WHERE file_id = ?').bind(fileId),
          withD1Retry(env.DB).prepare('DELETE FROM files WHERE id = ?').bind(fileId),
          prepareAuditLogInsert(
            env.DB,
            {
              actorUserId: user.id,
              action: 'FILE_DELETE_PERMANENT',
              targetType: 'file',
              targetId: fileId,
              ip,
              userAgent,
            },
            now
          ),
        ])
        deleted += Number(batchResults?.[2]?.meta?.changes || 0)
        continue
      }

      const [queueInsertResult] = await withD1Retry(env.DB).batch([
        prepareEnqueueFileDeletionIfNeeded(env.DB, { id: fileId, r2_key: r2Key }, now),
        prepareAuditLogInsert(
          env.DB,
          {
            actorUserId: user.id,
            action: 'FILE_DELETE_PERMANENT',
            targetType: 'file',
            targetId: fileId,
            ip,
            userAgent,
          },
          now
        ),
      ])
      queued += Number(queueInsertResult?.meta?.changes || 0)
    }

    // 不足一页说明已取完，避免再发一次空查询
    if (files.length < TRASH_PERMANENT_DELETE_PAGE_SIZE) break
  }

  return jsonResponse({ success: true, deleted, queued, total })
}

/**
 * 永久删除单个文件
 *
 * @route DELETE /api/files/:id/permanent
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param fileId - 文件 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 文件不存在 (404)
 * { "error": "文件不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function permanentlyDeleteFile(
  request: Request,
  env: Env,
  fileId: string
): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const file = await withD1Retry(env.DB)
    .prepare(
      'SELECT id, owner_id, r2_key, upload_status, deleted_at, config_id FROM files WHERE id = ? LIMIT 1'
    )
    .bind(fileId)
    .first()

  if (!file) {
    return jsonResponse({ error: '文件不存在' }, 404)
  }
  if (user.role !== 'admin' && file.owner_id !== user.id) {
    return jsonResponse({ error: '无权限' }, 403)
  }
  if (file.upload_status !== 'deleted' || !file.deleted_at) {
    return jsonResponse({ error: '请先将文件移入回收站' }, 400)
  }

  const now = new Date().toISOString()
  const r2Key = String(file.r2_key)
  const explicitProviderConfigId = getExplicitProviderConfigId(file)

  if (explicitProviderConfigId) {
    const provider = await createProvider(env, explicitProviderConfigId)
    if (!provider) return jsonResponse({ error: '存储配置未找到' }, 503)

    try {
      await provider.delete(r2Key)
    } catch (error) {
      // 远端文件可能已不存在，永久删除继续清理本地记录；非 404 类真实失败补 warn 日志便于排障。
      if (!isRemoteObjectMissingError(error)) {
        console.warn('[files] provider delete failed', { fileId, key: r2Key, error })
      }
    }

    await withD1Retry(env.DB).batch([
      prepareReleaseUploadReservation(env.DB, fileId, now),
      withD1Retry(env.DB).prepare('DELETE FROM file_shares WHERE file_id = ?').bind(fileId),
      withD1Retry(env.DB).prepare('DELETE FROM files WHERE id = ?').bind(fileId),
      prepareAuditLogInsert(
        env.DB,
        {
          actorUserId: user.id,
          action: 'FILE_DELETE_PERMANENT',
          targetType: 'file',
          targetId: fileId,
          ip: getClientIp(request),
          userAgent: request.headers.get('User-Agent') || undefined,
        },
        now
      ),
    ])

    return jsonResponse({ success: true, queued: false })
  }

  const [queueInsertResult] = await withD1Retry(env.DB).batch([
    prepareEnqueueFileDeletionIfNeeded(env.DB, { id: fileId, r2_key: r2Key }, now),
    prepareAuditLogInsert(
      env.DB,
      {
        actorUserId: user.id,
        action: 'FILE_DELETE_PERMANENT',
        targetType: 'file',
        targetId: fileId,
        ip: getClientIp(request),
        userAgent: request.headers.get('User-Agent') || undefined,
      },
      now
    ),
  ])
  const queued = Number(queueInsertResult?.meta?.changes || 0) > 0

  return jsonResponse({ success: true, queued })
}

// ── 重命名 ──

/**
 * 判断 provider 异常是否表示对象超过 R2 CopyObject 上限。
 */
function isRenameEntityTooLargeError(error: unknown): boolean {
  return (
    error instanceof StorageError &&
    (error.httpStatusCode === 413 || error.code === 'EntityTooLarge')
  )
}

/**
 * 判断 provider 异常是否表示对象在远端不存在。
 */
function isRenameObjectMissingError(error: unknown): boolean {
  return (
    error instanceof StorageError && (error.httpStatusCode === 404 || error.code === 'NotFound')
  )
}

/**
 * 从既有 r2_key 推导重命名后的 key：保留最后一段之前的全部前缀（configId 与目录），
 * 仅替换尾段文件名。对 `storage/<configId>/<dir>/<name>` 与 `flares3/<configId>/<name>`
 * 两种结构同样成立。
 */
function buildRenamedR2Key(r2Key: string, newFilename: string): string {
  const lastSlash = r2Key.lastIndexOf('/')
  const prefix = lastSlash >= 0 ? r2Key.slice(0, lastSlash + 1) : ''
  return `${prefix}${newFilename}`
}

/**
 * 重命名文件（更新 D1 登记记录与存储 key 尾段）
 *
 * 执行顺序为「先远端后 DB」：provider.move 成功后才用带状态守卫的单 batch
 * 更新 `files.filename` / `files.r2_key` 并写审计（对齐 d1-write-consistency 状态机模式）。
 *
 * @route POST /api/files/:id/rename
 * @param request - HTTP 请求对象（需要认证，owner 或 admin）
 * @param env - Cloudflare Workers 环境变量
 * @param fileId - 文件 ID
 * @returns JSON 响应，包含新文件名与新存储 key
 *
 * @example
 * // 请求体
 * { "new_name": "report-final.pdf" }
 *
 * // 成功响应 (200)
 * {
 *   "success": true,
 *   "filename": "report-final.pdf",
 *   "r2_key": "storage/config-1/docs/report-final.pdf"
 * }
 *
 * // 未授权 (401)
 * { "error": "未授权" }
 *
 * // 文件不存在 (404)
 * { "error": "文件不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 *
 * // 文件未完成上传 / 状态不符 (409)
 * { "error": "仅完成上传的文件可重命名" }
 *
 * // 新文件名与原文件名相同 (400)
 * { "error": "新文件名与原文件名相同" }
 *
 * // 文件名非法（含路径分隔符、控制字符等）(400)
 * { "error": "文件名不能包含路径分隔符" }
 *
 * // 同名文件已存在（D1 记录或远端对象占用）(409)
 * { "error": "同名文件已存在" }
 *
 * // 文件对象在远端不存在 (409)
 * { "error": "文件对象不存在，无法重命名" }
 *
 * // 并发状态下守卫 UPDATE 未命中 (409)
 * { "error": "文件状态已变化，请刷新后重试" }
 *
 * // 对象超过 R2 复制上限 (413)
 * { "error": "文件过大，超过 R2 复制上限（5GiB），请删除后重新上传到目标名称" }
 *
 * // 存储配置未找到 (503)
 * { "error": "存储配置未找到" }
 *
 * // 上游存储失败 (502)
 * { "error": "文件重命名失败：上游存储服务暂时不可用" }
 */
export async function renameFile(request: Request, env: Env, fileId: string): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  let rawNewName = ''
  try {
    const body = await parseJson<{ new_name?: string }>(request)
    rawNewName = String(body.new_name || '').trim()
  } catch (error) {
    return invalidJsonBodyResponse(error, '请求格式错误')
  }

  if (!rawNewName) {
    return jsonResponse({ error: '缺少 new_name' }, 400)
  }

  const file = await withD1Retry(env.DB)
    .prepare(
      'SELECT id, owner_id, filename, r2_key, size, upload_status, deleted_at, config_id FROM files WHERE id = ? LIMIT 1'
    )
    .bind(fileId)
    .first()

  if (!file) {
    return jsonResponse({ error: '文件不存在' }, 404)
  }
  if (user.role !== 'admin' && file.owner_id !== user.id) {
    return jsonResponse({ error: '无权限' }, 403)
  }
  if (file.upload_status !== 'completed' || file.deleted_at) {
    return jsonResponse({ error: '仅完成上传的文件可重命名' }, 409)
  }

  const nameResult = normalizeStorageFilename(rawNewName)
  if (!nameResult.ok) {
    return jsonResponse({ error: nameResult.message }, 400)
  }

  const oldKey = String(file.r2_key)
  const newKey = buildRenamedR2Key(oldKey, nameResult.key)
  if (newKey === oldKey) {
    return jsonResponse({ error: '新文件名与原文件名相同' }, 400)
  }

  // D1 占用检查（files.r2_key UNIQUE，对齐 upload 的 occupied 检查；排除自身）
  const occupied = await withD1Retry(env.DB)
    .prepare('SELECT id FROM files WHERE r2_key = ? AND id != ? LIMIT 1')
    .bind(newKey, fileId)
    .first('id')
  if (occupied) {
    return jsonResponse({ error: '同名文件已存在' }, 409)
  }

  // 解析存储 provider：显式 provider 配置（storage/<configId>/...）或 legacy R2 key
  let provider: StorageProvider | null = null
  const explicitProviderConfigId = getExplicitProviderConfigId(file)
  if (explicitProviderConfigId) {
    provider = await createProvider(env, explicitProviderConfigId)
    if (!provider) return jsonResponse({ error: '存储配置未找到' }, 503)
  } else {
    const loaded = await resolveR2ConfigForKey(env, oldKey)
    if (!loaded) return jsonResponse({ error: '存储配置未找到' }, 503)
    provider = new R2Provider(loaded.config)
  }

  // 远端占用检查
  try {
    const destExists = await provider.checkExists(newKey)
    if (destExists) {
      return jsonResponse({ error: '同名文件已存在' }, 409)
    }
  } catch (error) {
    return jsonResponse({ error: `文件重命名校验失败：${formatUpstreamFetchError(error)}` }, 502)
  }

  // 先远端后 DB：move 成功才落库
  try {
    await provider.move(oldKey, newKey, { size: Number(file.size) })
  } catch (error) {
    if (isRenameEntityTooLargeError(error)) {
      return jsonResponse(
        { error: '文件过大，超过 R2 复制上限（5GiB），请删除后重新上传到目标名称' },
        413
      )
    }
    if (isRenameObjectMissingError(error)) {
      return jsonResponse({ error: '文件对象不存在，无法重命名' }, 409)
    }
    return jsonResponse({ error: `文件重命名失败：${formatUpstreamFetchError(error)}` }, 502)
  }

  // 带守卫的单 batch：状态被并发变更（删除/回收站）时 0 行命中
  const now = new Date().toISOString()
  const [updateResult] = await withD1Retry(env.DB).batch([
    withD1Retry(env.DB)
      .prepare(
        "UPDATE files SET filename = ?, r2_key = ? WHERE id = ? AND upload_status = 'completed' AND deleted_at IS NULL"
      )
      .bind(nameResult.key, newKey, fileId),
    prepareAuditLogInsert(
      env.DB,
      {
        actorUserId: user.id,
        action: 'FILE_RENAME',
        targetType: 'file',
        targetId: fileId,
        ip: getClientIp(request),
        userAgent: request.headers.get('User-Agent') || undefined,
        metadata: {
          oldKey,
          newKey,
          oldFilename: String(file.filename || ''),
          newFilename: nameResult.key,
        },
      },
      now
    ),
  ])

  if (!updateResult?.meta?.changes) {
    // 远端已 move 但 DB 未推进：warn 记录残留，与 multipart 守卫失败语义一致
    console.warn('[files] rename: remote object moved but guarded update missed', {
      fileId,
      oldKey,
      newKey,
    })
    return jsonResponse({ error: '文件状态已变化，请刷新后重试' }, 409)
  }

  return jsonResponse({ success: true, filename: nameResult.key, r2_key: newKey })
}

/**
 * 删除文件（移至回收站）
 *
 * @route DELETE /api/files/:id
 * @param request - HTTP 请求对象（需要认证）
 * @param env - Cloudflare Workers 环境变量
 * @param fileId - 文件 ID
 * @returns JSON 响应，包含操作结果
 *
 * @example
 * // 成功响应 (200)
 * { "success": true }
 *
 * // 文件不存在 (404)
 * { "error": "文件不存在" }
 *
 * // 无权限 (403)
 * { "error": "无权限" }
 */
export async function deleteFile(request: Request, env: Env, fileId: string): Promise<Response> {
  const user = getUser(request)
  if (!user) return jsonResponse({ error: '未授权' }, 401)

  const file = await withD1Retry(env.DB)
    .prepare('SELECT id, owner_id, upload_status, deleted_at FROM files WHERE id = ? LIMIT 1')
    .bind(fileId)
    .first()

  if (!file) {
    return jsonResponse({ error: '文件不存在' }, 404)
  }
  if (user.role !== 'admin' && file.owner_id !== user.id) {
    return jsonResponse({ error: '无权限' }, 403)
  }
  if (file.upload_status === 'deleted' || file.deleted_at) {
    return jsonResponse({ error: '文件已在回收站' }, 400)
  }

  const now = new Date().toISOString()
  await withD1Retry(env.DB).batch([
    withD1Retry(env.DB)
      .prepare(
        "UPDATE files SET upload_status = 'deleted', deleted_at = ?, multipart_upload_id = NULL WHERE id = ?"
      )
      .bind(now, fileId),
    prepareReleaseUploadReservation(env.DB, fileId, now),
    prepareAuditLogInsert(
      env.DB,
      {
        actorUserId: user.id,
        action: 'FILE_DELETE',
        targetType: 'file',
        targetId: fileId,
        ip: getClientIp(request),
        userAgent: request.headers.get('User-Agent') || undefined,
        metadata: { recycleBin: true },
      },
      now
    ),
  ])

  return jsonResponse({ success: true, queued: false, recycled: true })
}
