import { S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { R2Config } from './r2ConfigRegistry'
import {
  MAX_UPSTREAM_ERROR_TEXT_BYTES,
  MAX_UPSTREAM_XML_RESPONSE_BYTES,
  readBoundedResponseText,
} from './upstreamResponsePolicy'
import { extractXmlValue } from './s3Xml'
import {
  getUpstreamTimeoutConfig,
  UPSTREAM_READONLY_RETRY_BACKOFF_MS,
} from '../config/upstreamTimeout'
import { fetchWithUpstreamTimeout, isReadOnlyHttpMethod, isTimeoutError } from './upstreamFetch'

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

export function buildS3HttpError(status: number, bodyText: string): Error {
  const code = extractXmlValue(bodyText, 'Code')
  const message = extractXmlValue(bodyText, 'Message')
  const error = new Error(
    message || `S3 请求失败（HTTP ${status}${bodyText ? `: ${bodyText}` : ''}）`
  ) as Error & { name?: string; $metadata?: { httpStatusCode?: number } }
  error.name = code || 'S3RequestFailed'
  error.$metadata = { httpStatusCode: status }
  return error
}

export async function readS3ErrorText(response: Response): Promise<string> {
  return readBoundedResponseText(response, MAX_UPSTREAM_ERROR_TEXT_BYTES, 'S3 错误响应', {
    truncate: true,
  })
}

export async function readS3XmlText(response: Response, label: string): Promise<string> {
  return readBoundedResponseText(response, MAX_UPSTREAM_XML_RESPONSE_BYTES, label)
}

export async function fetchSigned(
  client: S3Client,
  command: unknown,
  init: RequestInit & { expiresInSeconds?: number }
): Promise<Response> {
  const expiresInSeconds = typeof init.expiresInSeconds === 'number' ? init.expiresInSeconds : 60
  const { expiresInSeconds: _omitExpires, ...fetchInit } = init
  // 只读操作（GET/HEAD）超时后按配置轻量重试；写操作（POST/DELETE/PUT）不重试
  const { readonlyRetries } = getUpstreamTimeoutConfig()
  const retries = isReadOnlyHttpMethod(fetchInit) ? readonlyRetries : 0

  for (let attempt = 0; ; attempt++) {
    try {
      // 每次尝试重新签名：重试复用旧 URL 可能撞上签名过期窗口。
      // 内层 retries 固定为 0：重试由本层统一控制，避免两层重试相乘放大尝试次数
      const url = await getSignedUrl(client, command as any, {
        expiresIn: expiresInSeconds,
      })
      return await fetchWithUpstreamTimeout(url, fetchInit, { retries: 0 })
    } catch (error) {
      if (attempt >= retries || !isTimeoutError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, UPSTREAM_READONLY_RETRY_BACKOFF_MS))
    }
  }
}
