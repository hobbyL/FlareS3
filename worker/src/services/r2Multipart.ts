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
  return parseListPartsXml(text)
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
