import {
  createS3Client,
  deleteObject as r2DeleteObject,
  deleteObjectsByPrefix as r2DeleteObjectsByPrefix,
  generateDownloadUrl,
  generatePreviewUrl,
  generateUploadUrl,
  getObjectSize,
  checkObjectExists as r2CheckObjectExists,
  listObjectsV2 as r2ListObjectsV2,
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

  async download(key: string, filename: string, expiresInSeconds: number): Promise<StorageDownloadResult> {
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
      const url = await generatePreviewUrl(this.config, key, filename, expiresInSeconds, responseContentType)
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

  async upload(key: string, _body: ArrayBuffer, contentType: string, _size: number): Promise<StorageUploadResult> {
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
      const response = await fetch(url, {
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
}
