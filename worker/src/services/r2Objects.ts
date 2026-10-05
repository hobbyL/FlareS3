import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { R2Config } from './r2ConfigRegistry'
import {
  buildDeleteObjectsXml,
  decodeXmlEntities,
  extractXmlBlocks,
  extractXmlValue,
  parseDeleteObjectsResultXml,
  type DeleteObjectsErrorItem,
} from './s3Xml'
import { sanitizeContentDispositionFilename } from './r2Keys'
import {
  buildS3HttpError,
  createS3Client,
  fetchSigned,
  readS3ErrorText,
  readS3XmlText,
} from './r2SignedRequests'

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
/** S3 DeleteObjects 单批上限（与 listObjectsV2 单页一致） */
const DELETE_OBJECTS_BATCH_SIZE = 1000

export type DeleteByPrefixResult = {
  deleted_count: number
}

/**
 * DeleteObjects 批量删除的部分失败错误。
 *
 * `failures` 携带每个失败对象的 key / Code / Message（Quiet 模式下仅失败项会返回）。
 */
export type DeleteObjectsPartialFailure = Error & {
  failures: DeleteObjectsErrorItem[]
}

function buildDeleteObjectsPartialFailure(
  failures: DeleteObjectsErrorItem[]
): DeleteObjectsPartialFailure {
  const preview = failures
    .slice(0, 5)
    .map((item) => `${item.key}(${item.code || 'Unknown'})`)
    .join(', ')
  const error = new Error(
    `S3 批量删除部分失败（${failures.length} 个对象）: ${preview}`
  ) as DeleteObjectsPartialFailure
  error.name = 'S3DeleteObjectsPartialFailure'
  error.failures = failures
  return error
}

/**
 * 构造 DeleteObjects 要求的 Content-MD5 请求头（body 的 base64 MD5 摘要）。
 *
 * Workers runtime 的 crypto.subtle.digest 非标准支持 MD5；在不含该扩展的
 * 运行时（如 Node 测试环境）降级省略此头——R2 对 DeleteObjects 不强制
 * Content-MD5（R2 兼容性文档将 DeleteObjects 标记为完全支持，且未把
 * Content-MD5 列入不支持清单，与 PutBucket* 系列明确 ❌ 不同）。
 */
async function buildDeleteObjectsContentMd5Header(body: string): Promise<Record<string, string>> {
  try {
    const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(body))
    const binary = String.fromCharCode(...new Uint8Array(digest))
    return { 'Content-MD5': btoa(binary) }
  } catch {
    return {}
  }
}

/** 调 S3 DeleteObjects（POST ?delete，Quiet 模式）批量删除，单批 ≤1000 个 key */
async function deleteObjectsBatch(config: R2Config, keys: string[]): Promise<void> {
  const client = createS3Client(config)
  const xmlBody = buildDeleteObjectsXml(keys)

  const response = await fetchSigned(
    client,
    new DeleteObjectsCommand({
      Bucket: config.bucketName,
      Delete: { Objects: keys.map((key) => ({ Key: key })) },
    }),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        ...(await buildDeleteObjectsContentMd5Header(xmlBody)),
      },
      body: xmlBody,
      expiresInSeconds: 60,
    }
  )

  if (!response.ok) {
    const text = await readS3ErrorText(response)
    throw buildS3HttpError(response.status, text)
  }

  const text = await readS3XmlText(response, 'S3 批量删除响应')
  const failures = parseDeleteObjectsResultXml(text)
  if (failures.length) {
    throw buildDeleteObjectsPartialFailure(failures)
  }
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

  // 批量 DeleteObjects 替代逐 key deleteObject：上千对象时避免触顶 Worker 子请求上限。
  // 任一批失败即抛错，调用方（mount 删除等）保持「任务失败可重试」语义；
  // S3 删除不存在的 key 视为成功，因此无需逐 key 处理 404。
  for (let i = 0; i < uniqueKeys.length; i += DELETE_OBJECTS_BATCH_SIZE) {
    const batch = uniqueKeys.slice(i, i + DELETE_OBJECTS_BATCH_SIZE)
    await deleteObjectsBatch(config, batch)
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
