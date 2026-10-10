import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { R2Config } from './r2ConfigRegistry'
import {
  buildCompleteMultipartUploadXml,
  decodeXmlEntities,
  extractXmlBlocks,
  extractXmlValue,
  normalizeCompleteMultipartParts,
  parseListPartsXml,
} from './s3Xml'
import {
  buildS3HttpError,
  createS3Client,
  fetchSigned,
  readS3ErrorText,
  readS3XmlText,
} from './r2SignedRequests'

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

/**
 * listParts 分页循环的保底页数上限。
 *
 * S3 单页最多返回 1000 片，MAX_S3_MULTIPART_PARTS=10000 对应最多 10 页；
 * 超过 20 页视为异常（如上游分页标记损坏），抛错而不是无限循环。
 */
const LIST_PARTS_MAX_PAGES = 20

function extractIsTruncated(xml: string): boolean {
  return (
    String(extractXmlValue(xml, 'IsTruncated') || '')
      .trim()
      .toLowerCase() === 'true'
  )
}

function extractNextPartNumberMarker(xml: string): number | null {
  const raw = extractXmlValue(xml, 'NextPartNumberMarker')
  if (!raw) return null
  const marker = Number(decodeXmlEntities(raw))
  if (!Number.isFinite(marker) || !Number.isInteger(marker) || marker < 1) return null
  return marker
}

export async function listParts(
  config: R2Config,
  key: string,
  uploadId: string
): Promise<Array<{ PartNumber?: number; ETag?: string }>> {
  const client = createS3Client(config)
  const allParts: Array<{ PartNumber?: number; ETag?: string }> = []
  let partNumberMarker: number | undefined = undefined

  for (let page = 0; page < LIST_PARTS_MAX_PAGES; page++) {
    const response = await fetchSigned(
      client,
      new ListPartsCommand({
        Bucket: config.bucketName,
        Key: key,
        UploadId: uploadId,
        ...(partNumberMarker !== undefined ? { PartNumberMarker: String(partNumberMarker) } : {}),
      }),
      { method: 'GET', expiresInSeconds: 60 }
    )

    if (!response.ok) {
      const text = await readS3ErrorText(response)
      throw buildS3HttpError(response.status, text)
    }

    const text = await readS3XmlText(response, 'S3 分片列表响应')
    allParts.push(...parseListPartsXml(text))

    // 单页上限 1000 片：超出时必须跟随 NextPartNumberMarker 翻页，否则结果静默截断
    if (!extractIsTruncated(text)) {
      return allParts
    }

    const nextMarker = extractNextPartNumberMarker(text)
    if (nextMarker === null) {
      throw new Error('S3 分片列表分页标记无效（IsTruncated 缺少 NextPartNumberMarker）')
    }
    if (nextMarker === partNumberMarker) {
      throw new Error('S3 分片列表分页标记未推进（疑似上游响应异常）')
    }
    partNumberMarker = nextMarker
  }

  throw new Error(`S3 分片列表分页超过 ${LIST_PARTS_MAX_PAGES} 页上限`)
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

/**
 * 服务端多段拷贝的单段大小：1 GiB。
 *
 * S3 UploadPartCopy 单段源范围上限约 5GiB；取更保守的 1GiB 可缩短单段请求时长、
 * 降低单段失败后的重做成本。配合 10000 片的 S3 分片数上限，可覆盖约 9.5TiB，
 * 远超 R2 单对象 ~5TiB 的实际上限，故对任意 R2 对象均可完成拷贝。
 */
export const MULTIPART_COPY_PART_SIZE = 1 * 1024 * 1024 * 1024

/** S3 单个 multipart 上传的分片数上限（规范固定值） */
export const MAX_MULTIPART_COPY_PARTS = 10000

/**
 * R2/S3 服务端多段拷贝：对超过单次 CopyObject 上限（~5GiB）的对象，通过
 * CreateMultipartUpload → 分段 UploadPartCopy → CompleteMultipartUpload 完成，
 * 全程零字节经过 Worker（纯服务端拷贝）。
 *
 * - 每段用 `x-amz-copy-source` + `x-amz-copy-source-range: bytes=start-end` 指定源范围，
 *   段大小 MULTIPART_COPY_PART_SIZE（≤5GiB 规范上限）。CopySource 的 bucket/key 编码口径
 *   与 r2Objects.copyObject 的 `x-amz-copy-source` 一致（源 key 逐段 encodeURIComponent）。
 *   预签名器会把这两个参数提升进签名查询串，故 fetchSigned 仅发 URL 即可，无需额外请求头。
 * - 分段 ETag 从 CopyPartResult 响应体解析（UploadPartCopy 的 ETag 在 body，不在 header）；
 *   个别兼容实现会以 200 返回 `<Error>` body，故成功状态码仍需检查 body。
 * - 目标对象的 Content-Type 在 CreateMultipartUpload 时确定（UploadPartCopy 仅拷字节、不带
 *   元数据），这里统一用 application/octet-stream：本应用的预览按 DB content_type 下发
 *   ResponseContentType、下载按 attachment 处理，均不依赖对象实际存储的 Content-Type。
 * - 任一步失败 → AbortMultipartUpload(dest, uploadId) 补偿，清理半成品 multipart（对齐
 *   d1 写一致性的「外部多步失败即回滚」语义），随后原样上抛原始错误。
 */
export async function multipartCopyObject(
  config: R2Config,
  sourceKey: string,
  destKey: string,
  totalSize: number
): Promise<void> {
  if (!Number.isFinite(totalSize) || !Number.isInteger(totalSize) || totalSize <= 0) {
    throw new Error('invalid_total_size')
  }

  const partCount = Math.ceil(totalSize / MULTIPART_COPY_PART_SIZE)
  if (partCount > MAX_MULTIPART_COPY_PARTS) {
    // 不可恢复：对象超过分片复制容量上限（~9.5TiB）。标注 413/EntityTooLarge 供上层识别。
    throw buildS3HttpError(
      413,
      '<Error><Code>EntityTooLarge</Code><Message>对象超过分片复制容量上限</Message></Error>'
    )
  }

  const client = createS3Client(config)
  const encodedSourceKey = sourceKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const copySource = `/${config.bucketName}/${encodedSourceKey}`

  const uploadId = await initiateMultipartUpload(config, destKey, 'application/octet-stream')

  try {
    const parts: { PartNumber: number; ETag: string }[] = []
    for (let index = 0; index < partCount; index++) {
      const start = index * MULTIPART_COPY_PART_SIZE
      const end = Math.min(start + MULTIPART_COPY_PART_SIZE, totalSize) - 1
      const partNumber = index + 1

      // 写操作：fetchSigned 内部对 PUT 不重试（幂等性不保证），超时/失败按原样映射
      const response = await fetchSigned(
        client,
        new UploadPartCopyCommand({
          Bucket: config.bucketName,
          Key: destKey,
          UploadId: uploadId,
          PartNumber: partNumber,
          CopySource: copySource,
          CopySourceRange: `bytes=${start}-${end}`,
        }),
        { method: 'PUT', expiresInSeconds: 60 }
      )

      if (!response.ok) {
        const text = await readS3ErrorText(response)
        throw buildS3HttpError(response.status, text)
      }

      const text = await readS3XmlText(response, 'S3 分段复制响应')
      if (extractXmlBlocks(text, 'Error').length > 0) {
        throw buildS3HttpError(response.status, text)
      }

      const etagRaw = extractXmlValue(text, 'ETag')
      const etag = etagRaw ? decodeXmlEntities(etagRaw) : ''
      if (!etag) throw new Error('missing_copy_part_etag')
      parts.push({ PartNumber: partNumber, ETag: etag })
    }

    await completeMultipartUpload(config, destKey, uploadId, parts)
  } catch (error) {
    // 补偿删除半成品 multipart，避免悬挂上传占用配额；补偿失败不覆盖原始错误
    // （原始错误更具诊断价值，且 R2 会按桶生命周期自动清理未完成的 multipart）。
    try {
      await abortMultipartUpload(config, destKey, uploadId)
    } catch {
      // 吞掉补偿异常，保留并上抛原始错误
    }
    throw error
  }
}
