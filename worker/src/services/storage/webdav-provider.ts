/**
 * WebDAVProvider — 通用 WebDAV 协议存储提供者。
 *
 * 实现 StorageProvider 接口，通过 PROPFIND/GET/PUT/DELETE/MKCOL 操作 WebDAV 兼容存储。
 * 子类 KoofrProvider 在此基础上特化 REST API 能力。
 */

import type {
  StorageDownloadResult,
  StorageListParams,
  StorageListResult,
  StorageListItem,
  StoragePreviewResult,
  StorageProvider,
  StorageUploadResult,
} from './types'
import { StorageError } from './types'
import { sanitizeContentDispositionFilename } from '../r2'
import { MAX_UPSTREAM_XML_RESPONSE_BYTES, readBoundedResponseText } from '../upstreamResponsePolicy'
import { fetchWithUpstreamTimeout } from '../upstreamFetch'
import { normalizeRemotePath as normalizeConfiguredRemotePath } from './pathPolicy'

// ── 配置类型 ──

export type WebDAVConfig = {
  endpoint: string // e.g. https://app.koofr.net/dav/Koofr
  username: string
  password: string
  remotePath?: string // e.g. /flares3, defaults to /
}

// ── 路径辅助 ──

function normalizeRemotePath(path?: string): string {
  const result = normalizeConfiguredRemotePath(path || '/')
  if (!result.ok) throw new StorageError(result.message)
  return result.remotePath === '/' ? '' : result.remotePath
}

function encodePath(path: string): string {
  const value = String(path || '')
  const leadingSlash = value.startsWith('/')
  const trailingSlash = value.endsWith('/') && value.length > 1
  const segments = value.split('/').filter((segment) => segment.length > 0)
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/')
  const prefix = leadingSlash ? '/' : ''
  const suffix = trailingSlash ? '/' : ''
  return `${prefix}${encoded}${suffix}` || '/'
}

function combinePaths(prefix: string, path: string): string {
  const left = String(prefix || '').replace(/\/+$/, '')
  const right = String(path || '').replace(/^\/+/, '')
  if (!left && !right) return '/'
  if (!left) return `/${right}`
  if (!right) return left.startsWith('/') ? left : `/${left}`
  return `${left.startsWith('/') ? left : `/${left}`}/${right}`
}

function stripRemotePathFromKey(key: string, remotePath: string): string {
  const normalizedKey = String(key || '').replace(/^\/+/, '')
  const remotePrefix = String(remotePath || '').replace(/^\/+|\/+$/g, '')
  if (!remotePrefix) return normalizedKey
  if (normalizedKey === remotePrefix) return ''
  const prefix = `${remotePrefix}/`
  return normalizedKey.startsWith(prefix) ? normalizedKey.slice(prefix.length) : normalizedKey
}

function decodeUrlPathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function buildProxyDownloadHeaders(response: Response, filename: string): Headers {
  const headers = new Headers()
  const contentType = response.headers.get('Content-Type')
  if (contentType) headers.set('Content-Type', contentType)

  const contentLength = response.headers.get('Content-Length')
  if (contentLength && /^\d+$/.test(contentLength)) {
    headers.set('Content-Length', contentLength)
  }

  const acceptRanges = response.headers.get('Accept-Ranges')
  if (acceptRanges) headers.set('Accept-Ranges', acceptRanges)

  const contentRange = response.headers.get('Content-Range')
  if (contentRange) headers.set('Content-Range', contentRange)

  const etag = response.headers.get('ETag')
  if (etag) headers.set('ETag', etag)

  const lastModified = response.headers.get('Last-Modified')
  if (lastModified) headers.set('Last-Modified', lastModified)

  const safeFilename = sanitizeContentDispositionFilename(filename)
  headers.set('Content-Disposition', `attachment; filename="${safeFilename}"`)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  return headers
}

// ── XML 解析辅助 ──

const DAV_NAMESPACES = ['d:', 'D:', 'lp1:', '']

function extractDavValue(xml: string, localName: string): string | null {
  for (const ns of DAV_NAMESPACES) {
    const match = xml.match(new RegExp(`<${ns}${localName}[^>]*>([^<]+)</${ns}${localName}>`))
    if (match?.[1]) return match[1]
  }
  return null
}

function extractDavBlocks(xml: string, localName: string): string[] {
  const blocks: string[] = []
  for (const ns of DAV_NAMESPACES) {
    const regex = new RegExp(`<${ns}${localName}[^>]*>([\\s\\S]*?)</${ns}${localName}>`, 'g')
    let match: RegExpExecArray | null
    while ((match = regex.exec(xml)) !== null) {
      blocks.push(match[1] ?? '')
    }
    if (blocks.length > 0) break
  }
  return blocks
}

function isCollectionBlock(block: string): boolean {
  for (const ns of DAV_NAMESPACES) {
    if (block.includes(`<${ns}collection`)) return true
  }
  return false
}

function decodeXmlEntities(value: string): string {
  const input = String(value ?? '')
  if (!input.includes('&')) return input

  let output = input
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')

  output = output.replace(/&#(x?[0-9a-fA-F]+);/g, (match, code) => {
    const raw = String(code || '')
    const num =
      raw.startsWith('x') || raw.startsWith('X')
        ? Number.parseInt(raw.slice(1), 16)
        : Number.parseInt(raw, 10)
    if (!Number.isFinite(num)) return match
    try {
      return String.fromCodePoint(num)
    } catch {
      return match
    }
  })

  output = output.replaceAll('&amp;', '&')
  return output
}

// ── 错误包装 ──

function wrapWebDAVError(error: unknown, fallbackMessage = 'WebDAV 请求失败'): StorageError {
  if (error instanceof StorageError) return error
  const raw = error instanceof Error ? error.message : String(error || '')
  const message = raw.replace(/\s+/g, ' ').trim() || fallbackMessage
  return new StorageError(message)
}

function throwForStatus(response: Response, context: string): never {
  throw new StorageError(`${context} 失败（HTTP ${response.status}）`, undefined, response.status)
}

// ── Provider 实现 ──

export class WebDAVProvider implements StorageProvider {
  protected readonly config: WebDAVConfig
  protected readonly remotePath: string

  constructor(config: WebDAVConfig) {
    this.config = config
    this.remotePath = normalizeRemotePath(config.remotePath)
  }

  // ── HTTP 辅助 ──

  protected buildUrl(path: string): string {
    const base = this.config.endpoint.replace(/\/+$/, '')
    const normalizedPath = combinePaths(this.remotePath, path)
    return `${base}${encodePath(normalizedPath)}`
  }

  protected buildRootUrl(path: string): string {
    const base = this.config.endpoint.replace(/\/+$/, '')
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    return `${base}${encodePath(normalizedPath)}`
  }

  protected authHeader(): string {
    const credentials = btoa(`${this.config.username}:${this.config.password}`)
    return `Basic ${credentials}`
  }

  protected async webdavRequest(
    method: string,
    path: string,
    init: RequestInit & { body?: BodyInit | null } = {},
    options: { useRootPath?: boolean } = {}
  ): Promise<Response> {
    const url = options.useRootPath ? this.buildRootUrl(path) : this.buildUrl(path)
    const headers = new Headers(init.headers)
    headers.set('Authorization', this.authHeader())

    let response: Response
    try {
      // 上游 fetch 统一带超时；PROPFIND/GET/HEAD 为只读方法，超时后按配置轻量重试
      response = await fetchWithUpstreamTimeout(url, {
        ...init,
        method,
        headers,
      })
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 网络请求失败')
    }
    return response
  }

  // ── PROPFIND ──

  async list(params: StorageListParams): Promise<StorageListResult> {
    const prefix = params.prefix ?? ''
    const path = prefix.startsWith('/') ? prefix : `/${prefix}`

    const propfindBody =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<d:propfind xmlns:d="DAV:">' +
      '<d:prop>' +
      '<d:resourcetype/>' +
      '<d:getcontentlength/>' +
      '<d:getlastmodified/>' +
      '</d:prop>' +
      '</d:propfind>'

    let response: Response
    try {
      response = await this.webdavRequest('PROPFIND', path, {
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          Depth: '1',
        },
        body: propfindBody,
      })
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 列表请求失败')
    }

    if (response.status === 404) {
      return {
        is_truncated: false,
        key_count: 0,
        common_prefixes: [],
        contents: [],
      }
    }

    if (!(response.status === 207 || response.ok)) {
      throwForStatus(response, 'WebDAV 列表')
    }

    const text = await readBoundedResponseText(
      response,
      MAX_UPSTREAM_XML_RESPONSE_BYTES,
      'WebDAV 列表响应'
    )
    return this.parsePropfindResponse(text, prefix)
  }

  protected parsePropfindResponse(xml: string, requestPrefix: string): StorageListResult {
    const responseBlocks = extractDavBlocks(xml, 'response')

    const basePath = this.config.endpoint.replace(/\/+$/, '')
    const remoteSegmentCount = this.remotePath.split('/').filter(Boolean).length
    const baseSegmentCount = new URL(basePath).pathname
      .replace(/\/+$/, '')
      .split('/')
      .filter(Boolean).length

    const commonPrefixes: string[] = []
    const contents: StorageListItem[] = []

    for (const block of responseBlocks) {
      const hrefRaw = extractDavValue(block, 'href')
      if (!hrefRaw) continue

      const href = decodeXmlEntities(hrefRaw)

      // 跳过自身（请求的目录本身）
      try {
        const hrefPath = new URL(href, basePath).pathname.replace(/\/+$/, '')
        const requestPath = new URL(this.buildUrl(requestPrefix), basePath).pathname.replace(
          /\/+$/,
          ''
        )
        if (hrefPath === requestPath) continue
      } catch {
        // URL 解析失败时跳过
        continue
      }

      const isDir = isCollectionBlock(block)

      // 将 href 转为相对 key
      let key: string
      try {
        const hrefUrl = new URL(href, basePath)
        const segments = hrefUrl.pathname.split('/').filter(Boolean)
        const relativeSegments = segments.slice(baseSegmentCount + remoteSegmentCount)
        const decodedSegments = relativeSegments.map(decodeUrlPathSegment)
        if (decodedSegments.some((segment) => segment === null)) continue
        key = stripRemotePathFromKey(decodedSegments.join('/'), this.remotePath)
      } catch {
        continue
      }

      if (!key) continue

      if (isDir) {
        const prefixKey = key.endsWith('/') ? key : `${key}/`
        commonPrefixes.push(prefixKey)
      } else {
        const size = Number(extractDavValue(block, 'getcontentlength') || 0)
        const lastModifiedRaw = extractDavValue(block, 'getlastmodified')

        const item: StorageListItem = {
          key,
          size: Number.isFinite(size) ? size : 0,
        }
        if (lastModifiedRaw) {
          item.last_modified = decodeXmlEntities(lastModifiedRaw)
        }
        contents.push(item)
      }
    }

    return {
      is_truncated: false,
      key_count: commonPrefixes.length + contents.length,
      common_prefixes: [...new Set(commonPrefixes)],
      contents,
    }
  }

  // ── GET（下载） ──

  async download(
    key: string,
    filename: string,
    _expiresInSeconds: number
  ): Promise<StorageDownloadResult> {
    const path = key.startsWith('/') ? key : `/${key}`
    let response: Response
    try {
      response = await this.webdavRequest('GET', path)
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 下载失败')
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new StorageError('对象不存在', 'NotFound', 404)
      }
      throwForStatus(response, 'WebDAV 下载')
    }

    // Only pass through download-safe metadata; upstream WebDAV headers are not trusted for this origin.
    const newHeaders = buildProxyDownloadHeaders(response, filename)
    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    })

    return { kind: 'proxy', response }
  }

  // ── GET + Range（预览） ──

  async preview(
    key: string,
    _filename: string,
    _expiresInSeconds: number,
    responseContentType?: string
  ): Promise<StoragePreviewResult> {
    const path = key.startsWith('/') ? key : `/${key}`

    const headers: Record<string, string> = {
      Range: 'bytes=0-204799', // 前 200KB
    }

    let response: Response
    try {
      response = await this.webdavRequest('GET', path, { headers })
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 预览失败')
    }

    if (!response.ok && response.status !== 206) {
      if (response.status === 404) {
        throw new StorageError('对象不存在', 'NotFound', 404)
      }
      throwForStatus(response, 'WebDAV 预览')
    }

    // 设置 Content-Type
    if (responseContentType) {
      const newHeaders = new Headers(response.headers)
      newHeaders.set('Content-Type', responseContentType)
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      })
    }

    return { kind: 'proxy', response }
  }

  // ── DELETE ──

  async delete(key: string): Promise<void> {
    const path = key.startsWith('/') ? key : `/${key}`
    let response: Response
    try {
      response = await this.webdavRequest('DELETE', path)
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 删除失败')
    }

    if (response.status === 404) {
      throw new StorageError('对象不存在', 'NotFound', 404)
    }

    if (!response.ok && response.status !== 204) {
      throwForStatus(response, 'WebDAV 删除')
    }
  }

  // ── 按前缀删除 ──

  async deleteByPrefix(prefix: string): Promise<{ deleted_count: number }> {
    const normalizedPrefix = String(prefix || '').trim()
    if (!normalizedPrefix) {
      return { deleted_count: 0 }
    }

    const listed = await this.list({ prefix: normalizedPrefix, delimiter: '/' })

    // 收集所有需要删除的 key
    const keysToDelete: string[] = [
      ...listed.common_prefixes, // 子目录
      ...listed.contents.map((item) => item.key), // 文件
    ]

    let deletedCount = 0
    for (const key of keysToDelete) {
      try {
        await this.delete(key)
        deletedCount++
      } catch (error) {
        if (error instanceof StorageError && error.httpStatusCode === 404) {
          continue
        }
        throw error
      }
    }

    return { deleted_count: deletedCount }
  }

  // ── 检查存在 ──

  async checkExists(key: string): Promise<boolean> {
    const path = key.startsWith('/') ? key : `/${key}`

    const propfindBody =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<d:propfind xmlns:d="DAV:">' +
      '<d:prop><d:resourcetype/></d:prop>' +
      '</d:propfind>'

    let response: Response
    try {
      response = await this.webdavRequest('PROPFIND', path, {
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          Depth: '0',
        },
        body: propfindBody,
      })
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 存在性检查失败')
    }

    if (response.status === 404) return false
    if (response.status === 207 || response.ok) return true
    return false
  }

  // ── 获取大小 ──

  async getSize(key: string): Promise<number | null> {
    const path = key.startsWith('/') ? key : `/${key}`

    let response: Response
    try {
      response = await this.webdavRequest('HEAD', path)
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 获取大小失败')
    }

    if (response.status === 404) return null
    if (!response.ok) {
      throwForStatus(response, 'WebDAV 获取大小')
    }

    const contentLength = Number(response.headers.get('content-length'))
    if (!Number.isFinite(contentLength) || contentLength < 0) return null
    return contentLength
  }

  // ── 测试连接 ──

  async testConnection(): Promise<void> {
    const propfindBody =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<d:propfind xmlns:d="DAV:">' +
      '<d:prop><d:resourcetype/></d:prop>' +
      '</d:propfind>'

    // 先测试根连接（不经过 remotePath 前缀）
    let response: Response
    try {
      response = await this.webdavRequest(
        'PROPFIND',
        '/',
        {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            Depth: '0',
          },
          body: propfindBody,
        },
        { useRootPath: true }
      )
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 连接测试失败')
    }

    if (response.status === 401) {
      throw new StorageError('认证失败，请检查用户名和密码', 'Unauthorized', 401)
    }
    if (!(response.status === 207 || response.ok)) {
      throwForStatus(response, 'WebDAV 连接测试')
    }

    // 如果配置了远程目录，确保其存在（不存在则自动创建）
    if (this.remotePath) {
      await this.ensureRemotePath()
    }
  }

  protected async ensureRemotePath(): Promise<void> {
    const path = this.remotePath.startsWith('/') ? this.remotePath : `/${this.remotePath}`

    // 检查目录是否已存在
    const propfindBody =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<d:propfind xmlns:d="DAV:">' +
      '<d:prop><d:resourcetype/></d:prop>' +
      '</d:propfind>'

    let response: Response
    try {
      response = await this.webdavRequest(
        'PROPFIND',
        path,
        {
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            Depth: '0',
          },
          body: propfindBody,
        },
        { useRootPath: true }
      )
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 远程目录检查失败')
    }

    if (response.status === 207 || response.ok) return // 已存在

    if (response.status === 404) {
      // 逐级创建目录（相对根路径，不含 remotePath 前缀）
      const segments = path.split('/').filter(Boolean)
      let current = ''
      for (const seg of segments) {
        current += `/${seg}`
        const folderPath = current.endsWith('/') ? current : `${current}/`
        let mkcolResponse: Response
        try {
          mkcolResponse = await this.webdavRequest('MKCOL', folderPath, undefined, {
            useRootPath: true,
          })
        } catch (error) {
          throw wrapWebDAVError(error, 'WebDAV 创建远程目录失败')
        }
        if (mkcolResponse.status === 201 || mkcolResponse.status === 405) continue
        if (mkcolResponse.status === 409) {
          throw new StorageError('父目录不存在', 'Conflict', 409)
        }
        throwForStatus(mkcolResponse, 'WebDAV 创建远程目录')
      }
    } else {
      throwForStatus(response, 'WebDAV 远程目录检查')
    }
  }

  // ── PUT（上传） ──

  async upload(
    key: string,
    body: ArrayBuffer,
    contentType: string,
    _size: number
  ): Promise<StorageUploadResult> {
    const path = key.startsWith('/') ? key : `/${key}`
    let response: Response
    try {
      response = await this.webdavRequest('PUT', path, {
        headers: {
          'Content-Type': contentType,
        },
        body,
      })
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 上传失败')
    }

    if (!response.ok && response.status !== 201 && response.status !== 204) {
      if (response.status === 409) {
        throw new StorageError('父目录不存在', 'Conflict', 409)
      }
      throwForStatus(response, 'WebDAV 上传')
    }

    return { kind: 'consumed', key }
  }

  // ── MKCOL（创建目录） ──

  async createFolder(key: string): Promise<void> {
    const folderKey = key.endsWith('/') ? key : `${key}/`
    const path = folderKey.startsWith('/') ? folderKey : `/${folderKey}`

    let response: Response
    try {
      response = await this.webdavRequest('MKCOL', path)
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 创建目录失败')
    }

    // 201 = 创建成功, 405 = 已存在（视为成功）
    if (response.status === 201 || response.status === 405) return

    if (response.status === 409) {
      throw new StorageError('父目录不存在', 'Conflict', 409)
    }

    throwForStatus(response, 'WebDAV 创建目录')
  }

  // ── MOVE（移动 / 重命名） ──

  async move(sourceKey: string, destKey: string, _options?: { size?: number }): Promise<void> {
    const sourcePath = sourceKey.startsWith('/') ? sourceKey : `/${sourceKey}`
    // Destination 必须是绝对 URL，且与请求 URL 一样逐段编码
    const destinationUrl = this.buildUrl(destKey)

    let response: Response
    try {
      response = await this.webdavRequest('MOVE', sourcePath, {
        headers: {
          Destination: destinationUrl,
          // 禁止覆盖目标：目标已存在时服务端返回 412，路由层映射为 409 冲突
          Overwrite: 'F',
        },
      })
    } catch (error) {
      throw wrapWebDAVError(error, 'WebDAV 移动失败')
    }

    if (response.status === 404) {
      throw new StorageError('对象不存在', 'NotFound', 404)
    }
    if (response.status === 412 || response.status === 409) {
      throw new StorageError('目标文件已存在', 'Conflict', 409)
    }
    if (!response.ok) {
      throwForStatus(response, 'WebDAV 移动')
    }
  }
}
