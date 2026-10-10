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
  buildR2Key as keyBuildR2Key,
  extractR2ConfigIdFromKey as keyExtractR2ConfigIdFromKey,
  sanitizeContentDispositionFilename as keySanitizeContentDispositionFilename,
  sanitizeFilename as keySanitizeFilename,
} from './r2Keys'
import { resolveR2ConfigForKey as resolverResolveR2ConfigForKey } from './r2ConfigResolver'
import {
  createS3Client as signedCreateS3Client,
  summarizeS3Error as signedSummarizeS3Error,
  type S3ErrorSummary,
} from './r2SignedRequests'
import {
  checkObjectExists as objectsCheckObjectExists,
  copyObject as objectsCopyObject,
  deleteObject as objectsDeleteObject,
  deleteObjectsByPrefix as objectsDeleteObjectsByPrefix,
  generateDownloadUrl as objectsGenerateDownloadUrl,
  generatePreviewUrl as objectsGeneratePreviewUrl,
  generateUploadUrl as objectsGenerateUploadUrl,
  getObjectSize as objectsGetObjectSize,
  listObjectsV2 as objectsListObjectsV2,
  testConnection as objectsTestConnection,
  type DeleteByPrefixResult,
  type ListObjectsV2Content,
  type ListObjectsV2Result,
} from './r2Objects'
import {
  abortMultipartUpload as multipartAbortMultipartUpload,
  completeMultipartUpload as multipartCompleteMultipartUpload,
  generateMultipartUploadUrl as multipartGenerateMultipartUploadUrl,
  initiateMultipartUpload as multipartInitiateMultipartUpload,
  listParts as multipartListParts,
  multipartCopyObject as multipartMultipartCopyObject,
} from './r2Multipart'

export { LEGACY_R2_CONFIG_ID, SYSTEM_DEFAULT_R2_CONFIG_ID_KEY, SYSTEM_LEGACY_FILES_CONFIG_ID_KEY }

export type {
  DeleteByPrefixResult,
  ListObjectsV2Content,
  ListObjectsV2Result,
  LoadedR2Config,
  R2Config,
  R2ConfigOption,
  R2ConfigSource,
  R2ConfigSummary,
  S3ErrorSummary,
}

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
  return keySanitizeFilename(filename)
}

export function sanitizeContentDispositionFilename(filename: string): string {
  return keySanitizeContentDispositionFilename(filename)
}

export function extractR2ConfigIdFromKey(r2Key: string): string | null {
  return keyExtractR2ConfigIdFromKey(r2Key)
}

export function buildR2Key(configId: string, filename: string): string {
  return keyBuildR2Key(configId, filename)
}

export async function resolveR2ConfigForKey(
  env: Env,
  r2Key: string
): Promise<LoadedR2Config | null> {
  return resolverResolveR2ConfigForKey(env, r2Key)
}

export function createS3Client(config: R2Config) {
  return signedCreateS3Client(config)
}

export function summarizeS3Error(error: unknown): S3ErrorSummary {
  return signedSummarizeS3Error(error)
}

export async function generateUploadUrl(
  config: R2Config,
  key: string,
  contentType: string,
  expiresInSeconds: number
): Promise<string> {
  return objectsGenerateUploadUrl(config, key, contentType, expiresInSeconds)
}

export async function generateDownloadUrl(
  config: R2Config,
  key: string,
  filename: string,
  expiresInSeconds: number
): Promise<string> {
  return objectsGenerateDownloadUrl(config, key, filename, expiresInSeconds)
}

export async function generatePreviewUrl(
  config: R2Config,
  key: string,
  filename: string,
  expiresInSeconds: number,
  responseContentType?: string
): Promise<string> {
  return objectsGeneratePreviewUrl(config, key, filename, expiresInSeconds, responseContentType)
}

export async function checkObjectExists(config: R2Config, key: string): Promise<boolean> {
  return objectsCheckObjectExists(config, key)
}

export async function getObjectSize(config: R2Config, key: string): Promise<number | null> {
  return objectsGetObjectSize(config, key)
}

export async function deleteObject(config: R2Config, key: string): Promise<void> {
  return objectsDeleteObject(config, key)
}

export async function copyObject(
  config: R2Config,
  sourceKey: string,
  destKey: string
): Promise<void> {
  return objectsCopyObject(config, sourceKey, destKey)
}

export async function deleteObjectsByPrefix(
  config: R2Config,
  prefix: string
): Promise<DeleteByPrefixResult> {
  return objectsDeleteObjectsByPrefix(config, prefix)
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
  return objectsListObjectsV2(config, params)
}

export async function testConnection(config: R2Config): Promise<void> {
  return objectsTestConnection(config)
}

export async function initiateMultipartUpload(
  config: R2Config,
  key: string,
  contentType: string
): Promise<string> {
  return multipartInitiateMultipartUpload(config, key, contentType)
}

export async function abortMultipartUpload(
  config: R2Config,
  key: string,
  uploadId: string
): Promise<void> {
  return multipartAbortMultipartUpload(config, key, uploadId)
}

export async function generateMultipartUploadUrl(
  config: R2Config,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresInSeconds: number
): Promise<string> {
  return multipartGenerateMultipartUploadUrl(config, key, uploadId, partNumber, expiresInSeconds)
}

export async function listParts(
  config: R2Config,
  key: string,
  uploadId: string
): Promise<Array<{ PartNumber?: number; ETag?: string }>> {
  return multipartListParts(config, key, uploadId)
}

export async function completeMultipartUpload(
  config: R2Config,
  key: string,
  uploadId: string,
  parts: { PartNumber?: number; ETag?: string }[]
): Promise<void> {
  return multipartCompleteMultipartUpload(config, key, uploadId, parts)
}

export async function multipartCopyObject(
  config: R2Config,
  sourceKey: string,
  destKey: string,
  totalSize: number
): Promise<void> {
  return multipartMultipartCopyObject(config, sourceKey, destKey, totalSize)
}
