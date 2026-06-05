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
import { DEFAULT_TOTAL_STORAGE } from '../config/env'
import { decryptString } from './crypto'
export const LEGACY_R2_CONFIG_ID = 'legacy'
export const SYSTEM_DEFAULT_R2_CONFIG_ID_KEY = 'r2_default_config_id'
export const SYSTEM_LEGACY_FILES_CONFIG_ID_KEY = 'r2_legacy_files_config_id'

export type R2Config = {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucketName: string
}

export type R2ConfigSource = 'legacy' | 'db'

export type LoadedR2Config = {
  id: string
  source: R2ConfigSource
  config: R2Config
}

export type R2ConfigOption = {
  id: string
  name: string
  source: R2ConfigSource
}

export type R2ConfigSummary = {
  id: string
  name: string
  source: R2ConfigSource
  endpoint: string
  bucketName: string
  quotaBytes: number
  createdAt?: string
  updatedAt?: string
}

async function getSystemConfigValue(db: D1Database, key: string): Promise<string | null> {
  const value = await db
    .prepare('SELECT value FROM system_config WHERE key = ?')
    .bind(key)
    .first('value')
  return value ? String(value) : null
}

async function getSystemConfigValues(db: D1Database, keys: string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map()

  const placeholders = keys.map(() => '?').join(',')
  const rows = await db
    .prepare(`SELECT key, value FROM system_config WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>()

  const values = new Map<string, string>()
  for (const row of rows.results || []) {
    values.set(String(row.key), String(row.value))
  }
  return values
}

async function setSystemConfigValue(db: D1Database, key: string, value: string): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO system_config (key, value, updated_at)
     VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`
    )
    .bind(key, value, now, value, now)
    .run()
}

export async function getDefaultR2ConfigId(env: Env): Promise<string | null> {
  return getSystemConfigValue(env.DB, SYSTEM_DEFAULT_R2_CONFIG_ID_KEY)
}

export async function setDefaultR2ConfigId(env: Env, id: string): Promise<void> {
  await setSystemConfigValue(env.DB, SYSTEM_DEFAULT_R2_CONFIG_ID_KEY, id)
}

export async function getLegacyFilesR2ConfigId(env: Env): Promise<string | null> {
  return getSystemConfigValue(env.DB, SYSTEM_LEGACY_FILES_CONFIG_ID_KEY)
}

export async function setLegacyFilesR2ConfigId(env: Env, id: string | null): Promise<void> {
  if (!id) {
    await env.DB.prepare('DELETE FROM system_config WHERE key = ?')
      .bind(SYSTEM_LEGACY_FILES_CONFIG_ID_KEY)
      .run()
    return
  }
  await setSystemConfigValue(env.DB, SYSTEM_LEGACY_FILES_CONFIG_ID_KEY, id)
}

async function getLegacyDbConfig(db: D1Database, masterKey: string): Promise<R2Config | null> {
  const values = await getSystemConfigValues(db, [
    'r2_endpoint',
    'r2_bucket_name',
    'r2_access_key_id_enc',
    'r2_secret_access_key_enc',
  ])
  const endpoint = values.get('r2_endpoint')
  if (!endpoint) {
    return null
  }
  const bucketName = values.get('r2_bucket_name')
  const accessKeyEnc = values.get('r2_access_key_id_enc')
  const secretKeyEnc = values.get('r2_secret_access_key_enc')
  if (!bucketName || !accessKeyEnc || !secretKeyEnc) {
    return null
  }
  const accessKeyId = await decryptString(String(accessKeyEnc), masterKey)
  const secretAccessKey = await decryptString(String(secretKeyEnc), masterKey)
  return {
    endpoint: String(endpoint),
    accessKeyId,
    secretAccessKey,
    bucketName: String(bucketName),
  }
}

export async function getLegacyR2ConfigSummary(db: D1Database): Promise<R2ConfigSummary | null> {
  const values = await getSystemConfigValues(db, [
    'r2_endpoint',
    'r2_bucket_name',
    'r2_access_key_id_enc',
    'r2_secret_access_key_enc',
  ])
  const endpoint = values.get('r2_endpoint')
  const bucketName = values.get('r2_bucket_name')
  const accessKeyEnc = values.get('r2_access_key_id_enc')
  const secretKeyEnc = values.get('r2_secret_access_key_enc')
  if (!endpoint || !bucketName || !accessKeyEnc || !secretKeyEnc) {
    return null
  }

  return {
    id: LEGACY_R2_CONFIG_ID,
    name: '旧版配置',
    source: 'legacy',
    endpoint,
    bucketName,
    quotaBytes: DEFAULT_TOTAL_STORAGE,
  }
}

async function getDbConfigById(
  db: D1Database,
  masterKey: string,
  id: string
): Promise<R2Config | null> {
  const row = await db
    .prepare(
      'SELECT endpoint, bucket_name, access_key_id_enc, secret_access_key_enc FROM r2_configs WHERE id = ? LIMIT 1'
    )
    .bind(id)
    .first<{
      endpoint: string
      bucket_name: string
      access_key_id_enc: string
      secret_access_key_enc: string
    }>()
  if (!row) {
    return null
  }
  const accessKeyId = await decryptString(String(row.access_key_id_enc), masterKey)
  const secretAccessKey = await decryptString(String(row.secret_access_key_enc), masterKey)
  return {
    endpoint: String(row.endpoint),
    accessKeyId,
    secretAccessKey,
    bucketName: String(row.bucket_name),
  }
}

export async function listDbR2Configs(db: D1Database): Promise<R2ConfigSummary[]> {
  const rows = await db
    .prepare(
      'SELECT id, name, endpoint, bucket_name, quota_bytes, created_at, updated_at FROM r2_configs ORDER BY created_at DESC'
    )
    .all<{
      id: string
      name: string
      endpoint: string
      bucket_name: string
      quota_bytes: number
      created_at: string
      updated_at: string
    }>()
  return (rows.results || []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    source: 'db',
    endpoint: String(row.endpoint),
    bucketName: String(row.bucket_name),
    quotaBytes: Number(row.quota_bytes || DEFAULT_TOTAL_STORAGE),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }))
}

export async function loadR2ConfigById(env: Env, id: string): Promise<LoadedR2Config | null> {
  if (!env.R2_MASTER_KEY) {
    return null
  }

  if (id === LEGACY_R2_CONFIG_ID) {
    const legacy = await getLegacyDbConfig(env.DB, env.R2_MASTER_KEY)
    if (!legacy) return null
    return { id: LEGACY_R2_CONFIG_ID, source: 'legacy', config: legacy }
  }

  const dbConfig = await getDbConfigById(env.DB, env.R2_MASTER_KEY, id)
  if (!dbConfig) {
    return null
  }
  return { id, source: 'db', config: dbConfig }
}

export async function loadR2Config(env: Env): Promise<LoadedR2Config | null> {
  const configuredDefault = await getDefaultR2ConfigId(env)
  if (configuredDefault) {
    const loaded = await loadR2ConfigById(env, configuredDefault)
    if (loaded) return loaded
  }

  if (!env.R2_MASTER_KEY) {
    return null
  }

  const legacyFilesConfigId = await getSystemConfigValue(env.DB, SYSTEM_LEGACY_FILES_CONFIG_ID_KEY)
  if (legacyFilesConfigId) {
    const loaded = await loadR2ConfigById(env, legacyFilesConfigId)
    if (loaded) return loaded
  }

  const legacy = await loadR2ConfigById(env, LEGACY_R2_CONFIG_ID)
  if (legacy) return legacy

  const configs = await listDbR2Configs(env.DB)
  for (const config of configs) {
    const loaded = await loadR2ConfigById(env, config.id)
    if (loaded) return loaded
  }

  return null
}
export async function listR2ConfigSummaries(env: Env): Promise<{
  default_config_id: string | null
  legacy_files_config_id: string | null
  configs: R2ConfigSummary[]
}> {
  const [settings, legacyConfig, dbConfigs] = await Promise.all([
    getSystemConfigValues(env.DB, [
      SYSTEM_DEFAULT_R2_CONFIG_ID_KEY,
      SYSTEM_LEGACY_FILES_CONFIG_ID_KEY,
    ]),
    env.R2_MASTER_KEY ? getLegacyR2ConfigSummary(env.DB) : Promise.resolve(null),
    env.R2_MASTER_KEY ? listDbR2Configs(env.DB) : Promise.resolve([]),
  ])

  const configs = [...(legacyConfig ? [legacyConfig] : []), ...dbConfigs]
  const availableIds = new Set(configs.map((cfg) => cfg.id))

  let defaultId = settings.get(SYSTEM_DEFAULT_R2_CONFIG_ID_KEY) || null
  if (defaultId && !availableIds.has(defaultId)) {
    defaultId = null
  }

  let legacyFilesId = settings.get(SYSTEM_LEGACY_FILES_CONFIG_ID_KEY) || null
  if (legacyFilesId && !availableIds.has(legacyFilesId)) {
    legacyFilesId = null
  }

  if (!defaultId) {
    defaultId = legacyFilesId || configs[0]?.id || null
  }

  return {
    default_config_id: defaultId,
    legacy_files_config_id: legacyFilesId,
    configs,
  }
}

export async function listR2ConfigOptions(env: Env): Promise<{
  default_config_id: string | null
  legacy_files_config_id: string | null
  options: R2ConfigOption[]
}> {
  const result = await listR2ConfigSummaries(env)

  return {
    default_config_id: result.default_config_id,
    legacy_files_config_id: result.legacy_files_config_id,
    options: result.configs.map((cfg) => ({ id: cfg.id, name: cfg.name, source: cfg.source })),
  }
}

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

function extractXmlValue(xml: string, tagName: string): string | null {
  const match = xml.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`))
  return match?.[1] ? String(match[1]) : null
}

function extractXmlBlocks(xml: string, tagName: string): string[] {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'g')
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[1] ?? '')
  }
  return blocks
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
  const text = await response.text()
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
    const text = await response.text()
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

  const text = await response.text()
  if (!response.ok) {
    throw buildS3HttpError(response.status, text)
  }

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
  const text = await response.text()
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

  const text = await response.text()
  if (!response.ok) {
    throw buildS3HttpError(response.status, text)
  }

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
  const normalized = (parts || [])
    .map((part) => ({
      partNumber: Number(part.PartNumber),
      etag: typeof part.ETag === 'string' ? part.ETag : '',
    }))
    .filter((part) => Number.isFinite(part.partNumber) && part.partNumber > 0 && part.etag)
    .sort((a, b) => a.partNumber - b.partNumber)

  const xmlBody =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<CompleteMultipartUpload>` +
    normalized
      .map(
        (part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`
      )
      .join('') +
    `</CompleteMultipartUpload>`

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
  const text = await response.text()
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
  const text = await response.text()
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

  const text = await response.text()
  if (!response.ok) {
    throw buildS3HttpError(response.status, text)
  }

  const decodeXmlEntities = (value: string): string => {
    const input = String(value ?? '')
    if (!input.includes('&')) return input

    let output = input
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')

    output = output.replace(/&#(x?[0-9a-fA-F]+);/g, (match, code) => {
      const raw = String(code || '')
      const num =
        raw.startsWith('x') || raw.startsWith('X')
          ? Number.parseInt(raw.slice(1), 16)
          : Number.parseInt(raw, 10)
      if (!Number.isFinite(num)) return match
      try {
        return String.fromCodePoint(num)
      } catch {
        return match
      }
    })

    output = output.replaceAll('&amp;', '&')
    return output
  }

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
  const text = await response.text()
  throw buildS3HttpError(response.status, text)
}
