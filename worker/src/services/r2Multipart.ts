import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { R2Config } from './r2ConfigRegistry'
import {
  buildCompleteMultipartUploadXml,
  decodeXmlEntities,
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
