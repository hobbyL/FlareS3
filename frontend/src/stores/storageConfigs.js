import { defineStore } from 'pinia'
import api from '../services/api.js'

/** 存储配置列表缓存有效期：5 分钟 */
const DEFAULT_TTL_MS = 5 * 60 * 1000
let configsRequest = null
let cacheVersion = 0

const EMPTY_RESULT = { configs: [], default_config_id: null, legacy_files_config_id: null }

export const useStorageConfigsStore = defineStore('storageConfigs', {
  state: () => ({
    configs: [],
    defaultConfigId: null,
    legacyFilesConfigId: null,
    loadedAt: 0,
    loading: false,
  }),

  getters: {
    /** 还原成 `api.getStorageConfigs()` 的原始响应结构，便于调用方直接替换 */
    result: (state) => ({
      configs: state.configs,
      default_config_id: state.defaultConfigId,
      legacy_files_config_id: state.legacyFilesConfigId,
    }),
  },

  actions: {
    isFresh(ttlMs = DEFAULT_TTL_MS) {
      return this.loadedAt > 0 && Date.now() - this.loadedAt < ttlMs
    },

    /**
     * 读取存储配置列表（读穿缓存）。
     *
     * @param {{ force?: boolean, ttlMs?: number }} [options]
     * @returns {Promise<{configs: Array, default_config_id: string|null, legacy_files_config_id: string|null}>}
     */
    async fetchConfigs(options = {}) {
      const force = Boolean(options.force)
      const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : DEFAULT_TTL_MS

      if (!force && this.isFresh(ttlMs)) {
        return this.result
      }

      // 复用在途请求，但强制刷新时必须另起一次，避免拿到过期的在途结果
      if (!force && configsRequest) {
        return configsRequest
      }

      // 强制刷新：推进缓存代次并丢弃在途请求，
      // 任何被顶替的旧请求都会因 requestVersion 不等而被丢弃，不会回写新结果。
      if (force) {
        cacheVersion += 1
        configsRequest = null
      }

      const requestVersion = cacheVersion
      this.loading = true
      const request = api
        .getStorageConfigs()
        .then((response) => {
          if (requestVersion !== cacheVersion) {
            return this.result
          }
          this.configs = response?.configs || []
          this.defaultConfigId = response?.default_config_id || null
          this.legacyFilesConfigId = response?.legacy_files_config_id || null
          this.loadedAt = Date.now()
          return this.result
        })
        .finally(() => {
          if (configsRequest === request) {
            this.loading = false
            configsRequest = null
          }
        })

      configsRequest = request
      return configsRequest
    },

    /** 任何配置写操作（新增 / 编辑 / 删除 / 设为默认）后必须调用 */
    invalidate() {
      cacheVersion += 1
      configsRequest = null
      this.configs = EMPTY_RESULT.configs.slice()
      this.defaultConfigId = null
      this.legacyFilesConfigId = null
      this.loadedAt = 0
      this.loading = false
    },
  },
})
