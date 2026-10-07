/**
 * StorageProvider — 统一存储操作接口。
 *
 * 实现: R2Provider (S3)、WebDAVProvider (WebDAV)、KoofrProvider (WebDAV+REST)
 */

// ── 通用类型 ──

export type StorageListParams = {
  prefix?: string
  delimiter?: string
  continuationToken?: string
  maxKeys?: number
}

export type StorageListItem = {
  key: string
  size: number
  last_modified?: string
  etag?: string
}

export type StorageListResult = {
  is_truncated: boolean
  key_count: number
  next_continuation_token?: string
  common_prefixes: string[]
  contents: StorageListItem[]
}

export type StorageDownloadResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'proxy'; response: Response }

export type StoragePreviewResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'proxy'; response: Response }

export type StorageUploadResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'consumed'; key: string }

export type StorageMoveOptions = {
  /** 对象大小（字节）。R2 后端用于预检 CopyObject 单请求上限（~5GiB）。 */
  size?: number
}

// ── 错误 ──

export class StorageError extends Error {
  readonly code?: string
  readonly httpStatusCode?: number

  constructor(message: string, code?: string, httpStatusCode?: number) {
    super(message)
    this.name = 'StorageError'
    this.code = code
    this.httpStatusCode = httpStatusCode
  }
}

// ── Provider 接口 ──

export interface StorageProvider {
  list(params: StorageListParams): Promise<StorageListResult>
  download(key: string, filename: string, expiresInSeconds: number): Promise<StorageDownloadResult>
  preview(
    key: string,
    filename: string,
    expiresInSeconds: number,
    responseContentType?: string
  ): Promise<StoragePreviewResult>
  delete(key: string): Promise<void>
  deleteByPrefix(prefix: string): Promise<{ deleted_count: number }>
  checkExists(key: string): Promise<boolean>
  getSize(key: string): Promise<number | null>
  testConnection(): Promise<void>
  upload(
    key: string,
    body: ArrayBuffer,
    contentType: string,
    size: number
  ): Promise<StorageUploadResult>
  createFolder(key: string): Promise<void>
  /** 同一配置内移动/重命名对象（key 均为路由层校验后的规范 key）。 */
  move(sourceKey: string, destKey: string, options?: StorageMoveOptions): Promise<void>
}
