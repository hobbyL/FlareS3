import { extractR2ConfigIdFromKey } from './r2'

export type FileStorageReference = {
  r2_key?: unknown
  config_id?: unknown
}

export function getExplicitProviderConfigId(file: FileStorageReference): string | null {
  const configId = String(file.config_id || '').trim()
  if (!configId) return null
  return extractR2ConfigIdFromKey(String(file.r2_key || '')) ? null : configId
}

export function getFileStorageConfigId(file: FileStorageReference): string {
  return extractR2ConfigIdFromKey(String(file.r2_key || '')) || String(file.config_id || '')
}
