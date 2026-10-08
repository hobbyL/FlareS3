/**
 * KoofrProvider — 继承 WebDAVProvider，特化 Koofr REST API v2 能力。
 *
 * 核心增强：
 * - download: 直接继承 WebDAV 代理流式下载。不走 REST 分享链接——
 *   Koofr 永久分享链接无过期、无次数限制、从不删除，会绕过 FlareS3
 *   的分享生命周期模型（过期/次数/撤销），曾因此被安全审计移除。
 * - testConnection: 先测试 WebDAV，再测试 REST API（验证 mountId）
 */

import type { StorageUploadResult } from './types'
import { StorageError } from './types'
import { WebDAVProvider, type WebDAVConfig } from './webdav-provider'
import { readBoundedResponseJson } from '../upstreamResponsePolicy'
import { fetchWithUpstreamTimeout } from '../upstreamFetch'

// ── 配置类型 ──

export type KoofrConfig = WebDAVConfig & {
  mountId?: string
}

type KoofrMount = {
  id: string
  name: string
  isPrimary?: boolean
}

type KoofrMountsResponse = { mounts?: KoofrMount[] } | KoofrMount[]

function normalizeMountsResponse(data: KoofrMountsResponse): KoofrMount[] {
  const mounts = Array.isArray(data) ? data : data.mounts || []
  return mounts.filter((mount) => typeof mount.id === 'string' && mount.id.trim())
}

// ── Provider 实现 ──

export class KoofrProvider extends WebDAVProvider {
  private readonly _mountId: string
  private readonly restEndpoint: string
  private restToken: string | null = null
  private _resolvedMountId: string | null = null

  constructor(config: KoofrConfig) {
    super(config)
    this._mountId = config.mountId || ''
    const davBase = config.endpoint.replace(/\/+$/, '')
    const url = new URL(davBase)
    this.restEndpoint = `${url.origin}/api/v2`
  }

  private async resolveMountId(): Promise<string> {
    if (this._resolvedMountId) return this._resolvedMountId
    if (this._mountId) {
      this._resolvedMountId = this._mountId
      return this._resolvedMountId
    }

    // 未配置 mountId，自动检测 primary mount
    const authHeader = await this.restAuthHeader()
    const url = `${this.restEndpoint}/mounts`
    const response = await fetchWithUpstreamTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      throw new StorageError(
        `Koofr 自动检测 mountId 失败（HTTP ${response.status}）`,
        undefined,
        response.status
      )
    }

    const data = await readBoundedResponseJson<KoofrMountsResponse>(response)
    const mounts = normalizeMountsResponse(data)

    if (mounts.length === 0) {
      throw new StorageError('Koofr 账户无可用存储挂载点')
    }

    // 优先选 primary，否则选第一个
    const primary = mounts.find((m) => m.isPrimary)
    const selected = primary || mounts[0]
    if (!selected) {
      throw new StorageError('Koofr 账户无可用存储挂载点')
    }
    this._resolvedMountId = selected.id
    return this._resolvedMountId
  }

  // ── Token 认证 ──

  private async authenticateRest(): Promise<string> {
    if (this.restToken) return this.restToken

    const davBase = this.config.endpoint.replace(/\/+$/, '')
    const baseUrl = new URL(davBase).origin
    const url = `${baseUrl}/token`

    const response = await fetchWithUpstreamTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: this.config.username,
        password: this.config.password,
      }),
    })

    if (!response.ok) {
      throw new StorageError(
        `Koofr 认证失败（HTTP ${response.status}）`,
        'Unauthorized',
        response.status
      )
    }

    const data = await readBoundedResponseJson<{ token?: string; Token?: string }>(response)
    const token = data.token || data.Token
    if (!token) {
      throw new StorageError('Koofr 认证响应缺少 token')
    }

    this.restToken = token
    return this.restToken
  }

  private async restAuthHeader(): Promise<string> {
    const token = await this.authenticateRest()
    return `Token token=${token}`
  }

  // ── 覆盖 testConnection：同时验证 REST API ──

  async testConnection(): Promise<void> {
    // 先测试 WebDAV
    await super.testConnection()

    // 验证 REST API：获取 token + 检测 mountId
    const authHeader = await this.restAuthHeader()
    const url = `${this.restEndpoint}/mounts`
    const response = await fetchWithUpstreamTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    })

    if (response.status === 401) {
      throw new StorageError('Koofr REST API 认证失败，请检查用户名和密码', 'Unauthorized', 401)
    }
    if (!response.ok) {
      throw new StorageError(
        `Koofr REST API 连接测试失败（HTTP ${response.status}）`,
        undefined,
        response.status
      )
    }

    // 如果配置了 mountId，验证其存在；否则自动检测
    const data = await readBoundedResponseJson<KoofrMountsResponse>(response)
    const mounts = normalizeMountsResponse(data)

    if (this._mountId) {
      const found = mounts.some((m) => m.id === this._mountId)
      if (!found) {
        throw new StorageError(
          `mountId "${this._mountId}" 不存在，可用的 mountId：${mounts.map((m) => `${m.id}(${m.name})`).join(', ') || '无'}`,
          'NotFound',
          404
        )
      }
    } else if (mounts.length > 0) {
      // 自动检测并缓存
      const primary = mounts.find((m) => m.isPrimary)
      this._resolvedMountId = (primary || mounts[0]).id
    }
  }

  // ── 覆盖 upload：优先 REST API POST，回退 WebDAV PUT ──

  async upload(
    key: string,
    body: ArrayBuffer,
    contentType: string,
    size: number
  ): Promise<StorageUploadResult> {
    try {
      return await this.restApiUpload(key, body, contentType)
    } catch {
      // REST API 上传失败，回退 WebDAV PUT
      return super.upload(key, body, contentType, size)
    }
  }

  private async restApiUpload(
    key: string,
    body: ArrayBuffer,
    contentType: string
  ): Promise<StorageUploadResult> {
    // 将 key 拆分为目录路径和文件名
    const normalizedKey = key.startsWith('/') ? key.slice(1) : key
    const lastSlash = normalizedKey.lastIndexOf('/')
    const dirPath = lastSlash >= 0 ? normalizedKey.slice(0, lastSlash) : ''
    const filename = lastSlash >= 0 ? normalizedKey.slice(lastSlash + 1) : normalizedKey

    if (!filename) {
      throw new StorageError('上传文件名不能为空')
    }

    // 拼接 remotePath（如 /flares3-dev），确保文件上传到配置的远程目录下
    const remotePrefix = this.remotePath || ''
    const effectiveDir = remotePrefix + (dirPath ? `/${dirPath}` : '')
    const pathParam = effectiveDir || '/'
    const mountId = await this.resolveMountId()
    const endpointUrl = new URL(this.restEndpoint)
    const contentBase = `${endpointUrl.origin}/content/api/v2`
    const url = `${contentBase}/mounts/${mountId}/files/put?path=${encodeURIComponent(pathParam)}&filename=${encodeURIComponent(filename)}`
    const authHeader = await this.restAuthHeader()

    // 构造 multipart/form-data 上传
    const formData = new FormData()
    formData.append('file', new Blob([body], { type: contentType }), filename)

    const response = await fetchWithUpstreamTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
      },
      body: formData,
    })

    if (!response.ok) {
      throw new StorageError(
        `Koofr REST API 上传失败（HTTP ${response.status}）`,
        undefined,
        response.status
      )
    }

    return { kind: 'consumed', key }
  }
}
