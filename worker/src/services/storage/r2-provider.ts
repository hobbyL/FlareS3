import {
  copyObject as r2CopyObject,
  createS3Client,
  deleteObject as r2DeleteObject,
  deleteObjectsByPrefix as r2DeleteObjectsByPrefix,
  generateDownloadUrl,
  generatePreviewUrl,
  generateUploadUrl,
  getObjectSize,
  checkObjectExists as r2CheckObjectExists,
  listObjectsV2 as r2ListObjectsV2,
  multipartCopyObject as r2MultipartCopyObject,
  summarizeS3Error,
  testConnection as r2TestConnection,
  type R2Config,
} from '../r2'
import type {
  StorageDownloadResult,
  StorageListParams,
  StorageListResult,
  StoragePreviewResult,
  StorageProvider,
  StorageUploadResult,
} from './types'
import { StorageError } from './types'
import { logWarn } from '../../utils/log'
import { fetchWithUpstreamTimeout } from '../upstreamFetch'

function wrapS3Error(error: unknown): StorageError {
  const summary = summarizeS3Error(error)
  const parts = [
    summary.code,
    typeof summary.httpStatusCode === 'number' ? `HTTP ${summary.httpStatusCode}` : null,
    summary.message,
  ].filter(Boolean)
  return new StorageError(
    parts.length ? parts.join(' / ') : 'S3 请求失败',
    summary.code || undefined,
    summary.httpStatusCode
  )
}

/** 判断上游 S3 错误是否为 CopyObject 超限（EntityTooLarge），用于触发多段拷贝回退 */
function isEntityTooLargeError(error: unknown): boolean {
  return summarizeS3Error(error).code === 'EntityTooLarge'
}

/** S3 CopyObject 单请求上限（约 5GiB），超过改走服务端多段拷贝（UploadPartCopy） */
const R2_COPY_OBJECT_MAX_BYTES = 5 * 1024 * 1024 * 1024

export class R2Provider implements StorageProvider {
  constructor(private readonly config: R2Config) {}

  async list(params: StorageListParams): Promise<StorageListResult> {
    try {
      return await r2ListObjectsV2(this.config, {
        prefix: params.prefix,
        delimiter: params.delimiter,
        continuationToken: params.continuationToken || undefined,
        maxKeys: params.maxKeys,
      })
    } catch (error) {
      throw wrapS3Error(error)
    }
  }

  async download(
    key: string,
    filename: string,
    expiresInSeconds: number
  ): Promise<StorageDownloadResult> {
    try {
      const url = await generateDownloadUrl(this.config, key, filename, expiresInSeconds)
      return { kind: 'redirect', url }
    } catch (error) {
      throw wrapS3Error(error)
    }
  }

  async preview(
    key: string,
    filename: string,
    expiresInSeconds: number,
    responseContentType?: string
  ): Promise<StoragePreviewResult> {
    try {
      const url = await generatePreviewUrl(
        this.config,
        key,
        filename,
        expiresInSeconds,
        responseContentType
      )
      return { kind: 'redirect', url }
    } catch (error) {
      throw wrapS3Error(error)
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await r2DeleteObject(this.config, key)
    } catch (error) {
      const wrapped = wrapS3Error(error)
      if (wrapped.httpStatusCode === 404 || wrapped.code === 'NoSuchKey') {
        throw new StorageError('对象不存在', 'NoSuchKey', 404)
      }
      throw wrapped
    }
  }

  async deleteByPrefix(prefix: string): Promise<{ deleted_count: number }> {
    try {
      return await r2DeleteObjectsByPrefix(this.config, prefix)
    } catch (error) {
      throw wrapS3Error(error)
    }
  }

  async checkExists(key: string): Promise<boolean> {
    try {
      return await r2CheckObjectExists(this.config, key)
    } catch (error) {
      throw wrapS3Error(error)
    }
  }

  async getSize(key: string): Promise<number | null> {
    try {
      return await getObjectSize(this.config, key)
    } catch (error) {
      throw wrapS3Error(error)
    }
  }

  async testConnection(): Promise<void> {
    try {
      await r2TestConnection(this.config)
    } catch (error) {
      throw wrapS3Error(error)
    }
  }

  async upload(
    key: string,
    _body: ArrayBuffer,
    contentType: string,
    _size: number
  ): Promise<StorageUploadResult> {
    try {
      const url = await generateUploadUrl(this.config, key, contentType, 3600)
      return { kind: 'redirect', url }
    } catch (error) {
      throw wrapS3Error(error)
    }
  }

  async createFolder(key: string): Promise<void> {
    // S3 没有"目录"概念，按照 S3 惯例创建一个以 / 结尾的零字节占位对象
    const folderKey = key.endsWith('/') ? key : `${key}/`
    try {
      const url = await generateUploadUrl(this.config, folderKey, 'application/x-directory', 3600)
      // 写操作仅加超时不重试（幂等性不保证），超时异常沿 wrapS3Error 既有映射上抛
      const response = await fetchWithUpstreamTimeout(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/x-directory' },
        body: new ArrayBuffer(0),
      })
      if (!response.ok) {
        throw new StorageError(
          `创建目录失败（HTTP ${response.status}）`,
          undefined,
          response.status
        )
      }
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw wrapS3Error(error)
    }
  }

  async move(sourceKey: string, destKey: string, options?: { size?: number }): Promise<void> {
    const size = options?.size
    const knownSize = typeof size === 'number' && Number.isFinite(size) ? size : null

    // 复制阶段：≤5GiB 单次 CopyObject；>5GiB 走服务端多段拷贝（UploadPartCopy）。
    // size 未知/低估但对象实际 >5GiB 时，单次 CopyObject 会返回 EntityTooLarge，
    // 据此回退多段拷贝（回退前用 HEAD 补齐 totalSize）。
    try {
      if (knownSize !== null && knownSize > R2_COPY_OBJECT_MAX_BYTES) {
        await r2MultipartCopyObject(this.config, sourceKey, destKey, knownSize)
      } else {
        try {
          await r2CopyObject(this.config, sourceKey, destKey)
        } catch (error) {
          if (!isEntityTooLargeError(error)) throw error
          const resolvedSize = knownSize ?? (await getObjectSize(this.config, sourceKey))
          if (resolvedSize === null) throw error
          await r2MultipartCopyObject(this.config, sourceKey, destKey, resolvedSize)
        }
      }
    } catch (error) {
      throw wrapS3Error(error)
    }

    // copy 成功后删除源对象；非原子两步。delete 失败仅 warn（与 deleteByPrefix 容错语义
    // 一致）：残留源对象可由用户手动清理，幂等重试同一 move 即可收敛
    try {
      await r2DeleteObject(this.config, sourceKey)
    } catch (error) {
      const wrapped = wrapS3Error(error)
      if (wrapped.httpStatusCode === 404 || wrapped.code === 'NoSuchKey') return
      logWarn('storage.r2.moveDeleteSourceFailed', {
        sourceKey,
        destKey,
        error: {
          code: wrapped.code,
          httpStatusCode: wrapped.httpStatusCode,
          message: wrapped.message,
        },
      })
    }
  }
}
