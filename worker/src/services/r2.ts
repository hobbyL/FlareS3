import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  ListPartsCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Env } from '../config/env'
import {
  LEGACY_R2_CONFIG_ID,
  SYSTEM_DEFAULT_R2_CONFIG_ID_KEY,
  SYSTEM_LEGACY_FILES_CONFIG_ID_KEY,
  getDefaultR2ConfigId as registryGetDefaultR2ConfigId,
  getLegacyFilesR2ConfigId as registryGetLegacyFilesR2ConfigId,
  getLegacyR2ConfigSummary as registryGetLegacyR2ConfigSummary,
  listDbR2Configs as registryListDbR2Configs,
  listR2ConfigOptions as registryListR2ConfigOptions,
  listR2ConfigSummaries as registryListR2ConfigSummaries,
  loadR2Config as registryLoadR2Config,
  loadR2ConfigById as registryLoadR2ConfigById,
  setDefaultR2ConfigId as registrySetDefaultR2ConfigId,
  setLegacyFilesR2ConfigId as registrySetLegacyFilesR2ConfigId,
  type LoadedR2Config,
  type R2Config,
  type R2ConfigOption,
  type R2ConfigSource,
  type R2ConfigSummary,
} from './r2ConfigRegistry'
import {
  MAX_UPSTREAM_ERROR_TEXT_BYTES,
  MAX_UPSTREAM_XML_RESPONSE_BYTES,
  readBoundedResponseText,
} from './upstreamResponsePolicy'
import {
  buildCompleteMultipartUploadXml,
  decodeXmlEntities,
  extractXmlBlocks,
  extractXmlValue,
  normalizeCompleteMultipartParts,
} from './s3Xml'

export { LEGACY_R2_CONFIG_ID, SYSTEM_DEFAULT_R2_CONFIG_ID_KEY, SYSTEM_LEGACY_FILES_CONFIG_ID_KEY }

export type { LoadedR2Config, R2Config, R2ConfigOption, R2ConfigSource, R2ConfigSummary }

export const getDefaultR2ConfigId = registryGetDefaultR2ConfigId
export const setDefaultR2ConfigId = registrySetDefaultR2ConfigId
export const getLegacyFilesR2ConfigId = registryGetLegacyFilesR2ConfigId
export const setLegacyFilesR2ConfigId = registrySetLegacyFilesR2ConfigId
export const getLegacyR2ConfigSummary = registryGetLegacyR2ConfigSummary
export const listDbR2Configs = registryListDbR2Configs
export const loadR2ConfigById = registryLoadR2ConfigById
export const loadR2Config = registryLoadR2Config
export const listR2ConfigSummaries = registryListR2ConfigSummaries
export const listR2ConfigOptions = registryListR2ConfigOptions

export function sanitizeFilename(filename: string): string {
  const normalized = String(filename ?? '').replaceAll('\\', '/')
  let withoutControls = ''
  for (const char of normalized) {
    const code = char.charCodeAt(0)
    withoutControls += code <= 0x1f || code === 0x7f ? '/' : char
  }
  const parts = withoutControls.split('/').filter(Boolean)
  const base = parts.length ? parts[parts.length - 1] : withoutControls
  const safe = String(base || '').trim()
  return safe || 'file'
}

export function sanitizeContentDispositionFilename(filename: string): string {
  return sanitizeFilename(filename).replaceAll('"', '')
}

export function extractR2ConfigIdFromKey(r2Key: string): string | null {
  const parts = r2Key.split('/').filter(Boolean)
  if (parts.length < 3) {
    return null
  }
  if (parts[0] !== 'flares3') {
    return null
  }
  return parts[1] || null
}

export function buildR2Key(configId: string, filename: string): string {
  const safeConfigId = String(configId).replaceAll('/', '_')
  const safeFilename = sanitizeFilename(filename)
  return `flares3/${safeConfigId}/${safeFilename}`
}

export async function resolveR2ConfigForKey(
  env: Env,
  r2Key: string
): Promise<LoadedR2Config | null> {
  const configId = extractR2ConfigIdFromKey(r2Key)
  if (configId) {
    return loadR2ConfigById(env, configId)
  }

  const legacyFilesId = await getLegacyFilesR2ConfigId(env)
  if (legacyFilesId) {
    const loaded = await loadR2ConfigById(env, legacyFilesId)
    if (loaded) return loaded
  }

  const fallback = await loadR2Config(env)
  if (!fallback) {
    return loadR2ConfigById(env, LEGACY_R2_CONFIG_ID)
  }
  return fallback
}

export function createS3Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
    // 避免 PutObject 预签名 URL 自动附带 x-amz-checksum-* 查询参数，
    // 这会在部分 S3 兼容实现（含 R2 场景）导致浏览器直传校验失败。
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

export type S3ErrorSummary = {
  code?: string
  message?: string
  httpStatusCode?: number
}

export function summarizeS3Error(error: unknown): S3ErrorSummary {
  if (!error || typeof error !== 'object') return {}
  const err = error as { name?: unknown; message?: unknown; $metadata?: unknown }
  const meta = (err.$metadata ?? {}) as { httpStatusCode?: unknown }
  return {
    code: typeof err.name === 'string' ? err.name : undefined,
    message: typeof err.message === 'string' ? err.message : undefined,
    httpStatusCode: typeof meta.httpStatusCode === 'number' ? meta.httpStatusCode : undefined,
  }
}

function buildS3HttpError(status: number, bodyText: string): Error {
  const code = extractXmlValue(bodyText, 'Code')
  const message = extractXmlValue(bodyText, 'Message')
  const error = new Error(
    message || `S3 请求失败（HTTP ${status}${bodyText ? `: ${bodyText}` : ''}）`
  ) as Error & { name?: string; $metadata?: { httpStatusCode?: number } }
  error.name = code || 'S3RequestFailed'
  error.$metadata = { httpStatusCode: status }
  return error
}

async function readS3ErrorText(response: Response): Promise<string> {
  return readBoundedResponseText(response, MAX_UPSTREAM_ERROR_TEXT_BYTES, 'S3 错误响应', {
    truncate: true,
  })
}

async function readS3XmlText(response: Response, label: string): Promise<string> {
  return readBoundedResponseText(response, MAX_UPSTREAM_XML_RESPONSE_BYTES, label)
}

async function fetchSigned(
  client: S3Client,
  command: unknown,
  init: RequestInit & { expiresInSeconds?: number }
): Promise<Response> {
  const expiresInSeconds = typeof init.expiresInSeconds === 'number' ? init.expiresInSeconds : 60
  const url = await getSignedUrl(client, command as any, {
    expiresIn: expiresInSeconds,
  })
  return fetch(url, init)
}

export async function generateUploadUrl(
  config: R2Config,
  key: string,
  contentType: string,
  expiresInSeconds: number
): Promise<string> {
  const client = createS3Client(config)
  const command = new PutObjectCommand({
    Bucket: config.bucketName,
    Key: key,
    ContentType: contentType,
  })
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

export async function generateDownloadUrl(
  config: R2Config,
  key: string,
  filename: string,
  expiresInSeconds: number
): Promise<string> {
  const client = createS3Client(config)
  const safeFilename = sanitizeContentDispositionFilename(filename)
  const contentDisposition = `attachment; filename="${safeFilename}"`
  const command = new GetObjectCommand({
    Bucket: config.bucketName,
    Key: key,
    ResponseContentDisposition: contentDisposition,
  })
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

export async function generatePreviewUrl(
  config: R2Config,
  key: string,
  filename: string,
  expiresInSeconds: number,
  responseContentType?: string
): Promise<string> {
  const client = createS3Client(config)
  const safeFilename = sanitizeContentDispositionFilename(filename)
  const contentDisposition = `inline; filename="${safeFilename}"`
  const command = new GetObjectCommand({
    Bucket: config.bucketName,
    Key: key,
    ResponseContentDisposition: contentDisposition,
    ...(responseContentType ? { ResponseContentType: responseContentType } : {}),
  })
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

export async function checkObjectExists(config: R2Config, key: string): Promise<boolean> {
  const client = createS3Client(config)
  const response = await fetchSigned(
    client,
    new HeadObjectCommand({
      Bucket: config.bucketName,
      Key: key,
    }),
    { method: 'HEAD', expiresInSeconds: 60 }
  )

  if (response.ok) return true
  if (response.status === 404) return false
  const text = await readS3ErrorText(response)
  throw buildS3HttpError(response.status, text)
}

export async function getObjectSize(config: R2Config, key: string): Promise<number | null> {
  const client = createS3Client(config)
  const response = await fetchSigned(
    client,
    new HeadObjectCommand({
      Bucket: config.bucketName,
      Key: key,
    }),
    { method: 'HEAD', expiresInSeconds: 60 }
  )

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    const text = await readS3ErrorText(response)
    throw buildS3HttpError(response.status, text)
  }

  const contentLength = Number(response.headers.get('content-length'))
  if (!Number.isFinite(contentLength) || !Number.isInteger(contentLength) || contentLength < 0) {
    throw new Error('invalid_content_length')
  }

  return contentLength
}

export async function initiateMultipartUpload(
  config: R2Config,
  key: string,
  contentType: string
): Promise<string> {
  const client = createS3Client(config)
  const response = await fetchSigned(
    client,
    new CreateMultipartUploadCommand({
      Bucket: config.bucketName,
      Key: key,
      ContentType: contentType,
    }),
    {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      expiresInSeconds: 60,
    }
  )

  if (!response.ok) {
    const text = await readS3ErrorText(response)
    throw buildS3HttpError(response.status, text)
  }

  const text = await readS3XmlText(response, 'S3 创建分片上传响应')
  const uploadId = extractXmlValue(text, 'UploadId')
  if (!uploadId) throw new Error('missing_upload_id')
  return uploadId
}

export async function abortMultipartUpload(
  config: R2Config,
  key: string,
  uploadId: string
): Promise<void> {
  const client = createS3Client(config)
  const response = await fetchSigned(
    client,
    new AbortMultipartUploadCommand({
      Bucket: config.bucketName,
      Key: key,
      UploadId: uploadId,
    }),
    { method: 'DELETE', expiresInSeconds: 60 }
  )

  if (response.ok) return
  const text = await readS3ErrorText(response)
  throw buildS3HttpError(response.status, text)
}

export async function generateMultipartUploadUrl(
  config: R2Config,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresInSeconds: number
): Promise<string> {
  const client = createS3Client(config)
  const command = new UploadPartCommand({
    Bucket: config.bucketName,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  })
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

export async function listParts(
  config: R2Config,
  key: string,
  uploadId: string
): Promise<Array<{ PartNumber?: number; ETag?: string }>> {
  const client = createS3Client(config)
  const response = await fetchSigned(
    client,
    new ListPartsCommand({
      Bucket: config.bucketName,
      Key: key,
      UploadId: uploadId,
    }),
    { method: 'GET', expiresInSeconds: 60 }
  )

  if (!response.ok) {
    const text = await readS3ErrorText(response)
    throw buildS3HttpError(response.status, text)
  }

  const text = await readS3XmlText(response, 'S3 分片列表响应')
  const parts = extractXmlBlocks(text, 'Part')
    .map((block) => {
      const partNumber = Number(extractXmlValue(block, 'PartNumber'))
      const etag = extractXmlValue(block, 'ETag') || undefined
      return { PartNumber: partNumber, ETag: etag }
    })
    .filter((part) => Number.isFinite(part.PartNumber) && Number(part.PartNumber) > 0)
  return parts
}

export async function completeMultipartUpload(
  config: R2Config,
  key: string,
  uploadId: string,
  parts: { PartNumber?: number; ETag?: string }[]
): Promise<void> {
  const client = createS3Client(config)
  const normalized = normalizeCompleteMultipartParts(parts || [])
  const xmlBody = buildCompleteMultipartUploadXml(normalized)

  const response = await fetchSigned(
    client,
    new CompleteMultipartUploadCommand({
      Bucket: config.bucketName,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: normalized.map((part) => ({
          PartNumber: part.partNumber,
          ETag: part.etag,
        })),
      },
    }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: xmlBody,
      expiresInSeconds: 60,
    }
  )

  if (response.ok) return
  const text = await readS3ErrorText(response)
  throw buildS3HttpError(response.status, text)
}

export async function deleteObject(config: R2Config, key: string): Promise<void> {
  const client = createS3Client(config)
  const response = await fetchSigned(
    client,
    new DeleteObjectCommand({
      Bucket: config.bucketName,
      Key: key,
    }),
    { method: 'DELETE', expiresInSeconds: 60 }
  )
  if (response.ok) return
  const text = await readS3ErrorText(response)
  throw buildS3HttpError(response.status, text)
}

const DELETE_BY_PREFIX_PAGE_SIZE = 1000
const DELETE_BY_PREFIX_CONCURRENCY = 20

export type DeleteByPrefixResult = {
  deleted_count: number
}

export async function deleteObjectsByPrefix(
  config: R2Config,
  prefix: string
): Promise<DeleteByPrefixResult> {
  const normalizedPrefix = String(prefix || '').trim()
  if (!normalizedPrefix) {
    return { deleted_count: 0 }
  }

  const collectedKeys: string[] = []
  let continuationToken: string | undefined = undefined

  for (;;) {
    const listed = await listObjectsV2(config, {
      prefix: normalizedPrefix,
      maxKeys: DELETE_BY_PREFIX_PAGE_SIZE,
      continuationToken,
    })

    const keys = (listed.contents || [])
      .map((item) => String(item.key || '').trim())
      .filter(Boolean)

    if (keys.length) {
      collectedKeys.push(...keys)
    }

    if (!listed.is_truncated) {
      break
    }

    const nextToken = String(listed.next_continuation_token || '').trim()
    if (!nextToken) {
      break
    }

    continuationToken = nextToken
  }

  const uniqueKeys = Array.from(new Set(collectedKeys))
  if (!uniqueKeys.length) {
    return { deleted_count: 0 }
  }

  for (let i = 0; i < uniqueKeys.length; i += DELETE_BY_PREFIX_CONCURRENCY) {
    const chunk = uniqueKeys.slice(i, i + DELETE_BY_PREFIX_CONCURRENCY)
    await Promise.all(
      chunk.map(async (keyItem) => {
        try {
          await deleteObject(config, keyItem)
        } catch (error) {
          const summary = summarizeS3Error(error)
          if (summary.httpStatusCode === 404 || summary.code === 'NoSuchKey') {
            return
          }
          throw error
        }
      })
    )
  }

  return { deleted_count: uniqueKeys.length }
}

export type ListObjectsV2Content = {
  key: string
  size: number
  last_modified?: string
  etag?: string
}

export type ListObjectsV2Result = {
  is_truncated: boolean
  key_count: number
  next_continuation_token?: string
  common_prefixes: string[]
  contents: ListObjectsV2Content[]
}

export async function listObjectsV2(
  config: R2Config,
  params: {
    prefix?: string
    delimiter?: string
    continuationToken?: string
    maxKeys?: number
  }
): Promise<ListObjectsV2Result> {
  const client = createS3Client(config)
  const maxKeys = Math.min(1000, Math.max(1, Number(params.maxKeys ?? 100)))

  const response = await fetchSigned(
    client,
    new ListObjectsV2Command({
      Bucket: config.bucketName,
      Prefix: params.prefix || undefined,
      Delimiter: params.delimiter || undefined,
      ContinuationToken: params.continuationToken || undefined,
      MaxKeys: maxKeys,
    }),
    { method: 'GET', expiresInSeconds: 60 }
  )

  if (!response.ok) {
    const text = await readS3ErrorText(response)
    throw buildS3HttpError(response.status, text)
  }

  const text = await readS3XmlText(response, 'S3 对象列表响应')
  const keyCount = Number(decodeXmlEntities(extractXmlValue(text, 'KeyCount') || '0') || 0)
  const isTruncated =
    String(extractXmlValue(text, 'IsTruncated') || '')
      .trim()
      .toLowerCase() === 'true'

  const nextContinuationTokenRaw = extractXmlValue(text, 'NextContinuationToken')
  const nextContinuationToken = nextContinuationTokenRaw
    ? decodeXmlEntities(nextContinuationTokenRaw)
    : undefined

  const commonPrefixes = extractXmlBlocks(text, 'CommonPrefixes')
    .map((block) => extractXmlValue(block, 'Prefix'))
    .filter(Boolean)
    .map((value) => decodeXmlEntities(String(value)))

  const contents = extractXmlBlocks(text, 'Contents')
    .map((block) => {
      const keyRaw = extractXmlValue(block, 'Key')
      const key = keyRaw ? decodeXmlEntities(keyRaw) : ''
      const size = Number(extractXmlValue(block, 'Size') || 0)
      const lastModifiedRaw = extractXmlValue(block, 'LastModified')
      const etagRaw = extractXmlValue(block, 'ETag')

      const item: ListObjectsV2Content = {
        key,
        size: Number.isFinite(size) ? size : 0,
      }
      if (lastModifiedRaw) item.last_modified = decodeXmlEntities(lastModifiedRaw)
      if (etagRaw) item.etag = decodeXmlEntities(etagRaw)
      return item
    })
    .filter((item) => item.key)

  return {
    is_truncated: isTruncated,
    key_count: Number.isFinite(keyCount) ? keyCount : 0,
    next_continuation_token: nextContinuationToken,
    common_prefixes: commonPrefixes,
    contents,
  }
}

export async function testConnection(config: R2Config): Promise<void> {
  const client = createS3Client(config)
  const response = await fetchSigned(
    client,
    new ListObjectsV2Command({
      Bucket: config.bucketName,
      MaxKeys: 1,
    }),
    { method: 'GET', expiresInSeconds: 60 }
  )

  if (response.ok) return
  const text = await readS3ErrorText(response)
  throw buildS3HttpError(response.status, text)
}
