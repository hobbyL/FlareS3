import { defineStore } from 'pinia'
import { isAxiosError } from 'axios'
import api from '../services/api.js'
import { useStorageConfigsStore } from './storageConfigs.js'
import { useUserOptionsStore } from './userOptions.js'

/** 认证状态缓存有效期：5 分钟 */
const DEFAULT_TTL_MS = 5 * 60 * 1000
let authStatusRequest = null
let cacheVersion = 0

/** 判断是否为「请求未到达服务器」的网络失败 / 超时类 axios 错误 */
const isNetworkError = (error) => isAxiosError(error) && !error.response

export const useAuthStore = defineStore('auth', {
  state: () => ({
    isAuthenticated: false,
    user: null,
    checkedAt: 0,
  }),

  getters: {
    isAdmin: (state) => state.user?.role === 'admin',
  },

  actions: {
    async login(username, password) {
      try {
        const response = await api.login(username, password)
        if (response.success) {
          this.invalidate()
          useUserOptionsStore().invalidate()
          useStorageConfigsStore().invalidate()
          this.isAuthenticated = true
          this.user = response.user
          this.checkedAt = Date.now()
          return { success: true }
        }
        return { success: false, message: response.message, code: response.code }
      } catch (error) {
        return {
          success: false,
          message: error.response?.data?.error || '',
          code: error.response?.data?.code,
        }
      }
    },

    /** 已登录状态是否仍在缓存有效期内 */
    isFresh(ttlMs = DEFAULT_TTL_MS) {
      return this.isAuthenticated && this.checkedAt > 0 && Date.now() - this.checkedAt < ttlMs
    },

    /**
     * 校验登录态。
     *
     * 仅缓存"已登录"结果（默认 5 分钟）；未登录 / 请求失败一律不缓存，
     * 保证登出或会话过期后下一次导航能立即重新校验。
     *
     * 例外：网络失败 / 超时（无响应的 axios 错误）无法证明会话已失效，
     * 保留本地认证态（路由守卫照常放行），由后续业务 API 的 401 拦截器兜底登出，
     * 避免一次网络抖动就把在线用户踢到登录页。
     *
     * @param {{ force?: boolean, ttlMs?: number }} [options]
     */
    async checkAuth(options = {}) {
      const force = Boolean(options.force)
      const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : DEFAULT_TTL_MS

      if (!force && this.isFresh(ttlMs)) {
        return true
      }

      // 复用在途请求，但强制校验时必须另起一次
      if (!force && authStatusRequest) {
        return authStatusRequest
      }

      // 强制校验：推进缓存代次并丢弃在途请求，被顶替的旧请求不会回写状态
      if (force) {
        cacheVersion += 1
        authStatusRequest = null
      }

      const requestVersion = cacheVersion
      const request = api
        .getAuthStatus()
        .then((response) => {
          if (requestVersion !== cacheVersion) {
            return this.isAuthenticated
          }
          const authenticated = Boolean(response.authenticated)
          this.isAuthenticated = authenticated
          this.user = response.user || null
          this.checkedAt = authenticated ? Date.now() : 0
          return authenticated
        })
        .catch((error) => {
          if (requestVersion !== cacheVersion) {
            return false
          }
          // 网络失败 / 超时：不能证明会话失效，保留本地认证态
          if (isNetworkError(error)) {
            console.warn(
              '[auth] 登录态校验请求失败（网络错误），保留本地认证状态:',
              error?.message || error
            )
            return this.isAuthenticated
          }
          // 有响应（401/403 等）或其他未知异常：按确认未登录处理
          this.logoutLocal()
          return false
        })
        .finally(() => {
          if (authStatusRequest === request) {
            authStatusRequest = null
          }
        })

      authStatusRequest = request
      return authStatusRequest
    },

    async logout() {
      try {
        await api.logout()
      } catch (error) {
        // ignore
      }
      this.logoutLocal()
    },

    logoutLocal() {
      this.invalidate()
      useUserOptionsStore().invalidate()
      useStorageConfigsStore().invalidate()
      this.isAuthenticated = false
      this.user = null
    },

    /** 丢弃认证状态缓存，并让在途请求的结果失效 */
    invalidate() {
      cacheVersion += 1
      authStatusRequest = null
      this.checkedAt = 0
    },
  },
})
