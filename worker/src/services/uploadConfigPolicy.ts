import type { Env } from '../config/env'
import type { AuthUser } from '../middleware/authSession'
import {
  listR2ConfigOptions,
  loadR2Config,
  loadR2ConfigById,
  type LoadedR2Config,
  type R2ConfigOption,
} from './r2'
import { listWebDAVConfigs } from './storage/webdav-config'

export type UploadConfigOption = {
  id: string
  name: string
  type: 'r2' | 'webdav' | 'koofr'
}

export type UploadConfigOptionsResult = {
  default_config_id: string | null
  options: UploadConfigOption[]
}

export class UploadConfigPolicyError extends Error {
  readonly status: number
  readonly code: 'FORBIDDEN_CONFIG'

  constructor(message: string, status: number, code: 'FORBIDDEN_CONFIG') {
    super(message)
    this.name = 'UploadConfigPolicyError'
    this.status = status
    this.code = code
  }
}

function buildFallbackOption(loaded: LoadedR2Config): UploadConfigOption {
  return {
    id: loaded.id,
    name: loaded.source === 'legacy' ? '旧版配置' : '默认上传配置',
    type: 'r2',
  }
}

export function isUploadConfigPolicyError(error: unknown): error is UploadConfigPolicyError {
  return error instanceof UploadConfigPolicyError
}

export async function listUploadConfigOptionsForUser(
  env: Env,
  user: AuthUser
): Promise<UploadConfigOptionsResult> {
  const result = await listR2ConfigOptions(env)
  const masterKey = String(env.R2_MASTER_KEY || '').trim()
  const webdavConfigs = await listWebDAVConfigs(env.DB, masterKey)

  const allOptions: UploadConfigOption[] = [
    ...result.options.map((opt) => ({ id: opt.id, name: opt.name, type: 'r2' as const })),
    ...webdavConfigs.map((cfg) => ({ id: cfg.id, name: cfg.name, type: cfg.type as 'webdav' | 'koofr' })),
  ]

  if (user.role === 'admin') {
    return {
      default_config_id: result.default_config_id,
      options: allOptions,
    }
  }

  const allowed = await loadR2Config(env)
  if (!allowed) {
    return {
      default_config_id: null,
      options: [],
    }
  }

  const visibleOption =
    allOptions.find((option) => option.id === allowed.id) || buildFallbackOption(allowed)

  return {
    default_config_id: allowed.id,
    options: [visibleOption],
  }
}

export async function resolveUploadConfigForUser(
  env: Env,
  user: AuthUser,
  requestedId?: string | null
): Promise<LoadedR2Config | null> {
  const normalizedRequestedId = String(requestedId || '').trim()

  if (user.role === 'admin') {
    return normalizedRequestedId ? loadR2ConfigById(env, normalizedRequestedId) : loadR2Config(env)
  }

  const allowed = await loadR2Config(env)
  if (!allowed) {
    return null
  }

  if (normalizedRequestedId && normalizedRequestedId !== allowed.id) {
    throw new UploadConfigPolicyError('无权使用指定上传配置', 403, 'FORBIDDEN_CONFIG')
  }

  return allowed
}

export async function resolveUploadConfigType(
  env: Env,
  configId: string
): Promise<'r2' | 'webdav' | 'koofr' | null> {
  const r2Loaded = await loadR2ConfigById(env, configId)
  if (r2Loaded) return 'r2'

  const { loadWebDAVConfigById } = await import('./storage/webdav-config')
  const webdavLoaded = await loadWebDAVConfigById(env, configId)
  if (webdavLoaded) return webdavLoaded.type

  return null
}
