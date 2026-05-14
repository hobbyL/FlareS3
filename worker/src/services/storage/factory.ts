import type { Env } from '../../config/env'
import { loadR2ConfigById } from '../r2'
import type { StorageProvider } from './types'
import { R2Provider } from './r2-provider'
import { WebDAVProvider } from './webdav-provider'
import { KoofrProvider } from './koofr-provider'
import { loadWebDAVConfigById } from './webdav-config'

export async function createProvider(env: Env, configId: string): Promise<StorageProvider | null> {
  // 1. 尝试 R2 配置
  const r2Loaded = await loadR2ConfigById(env, configId)
  if (r2Loaded) {
    return new R2Provider(r2Loaded.config)
  }

  // 2. 尝试 WebDAV / Koofr 配置
  const webdavLoaded = await loadWebDAVConfigById(env, configId)
  if (webdavLoaded) {
    if (webdavLoaded.type === 'koofr') {
      return new KoofrProvider({
        endpoint: webdavLoaded.config.endpoint,
        username: webdavLoaded.config.username,
        password: webdavLoaded.config.password,
        mountId: webdavLoaded.config.mountId,
        remotePath: webdavLoaded.config.remotePath,
      })
    }
    return new WebDAVProvider({
      endpoint: webdavLoaded.config.endpoint,
      username: webdavLoaded.config.username,
      password: webdavLoaded.config.password,
      remotePath: webdavLoaded.config.remotePath,
    })
  }

  return null
}
