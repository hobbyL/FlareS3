import { defineStore } from 'pinia'
import api from '../services/api.js'

const DEFAULT_TTL_MS = 5 * 60 * 1000
let activeUsersRequest = null
let cacheVersion = 0

function normalizeActiveUsers(users) {
  return (users || []).filter((user) => user?.status !== 'deleted')
}

export const useUserOptionsStore = defineStore('userOptions', {
  state: () => ({
    users: [],
    loadedAt: 0,
    loading: false,
  }),

  actions: {
    isFresh(ttlMs = DEFAULT_TTL_MS) {
      return this.loadedAt > 0 && Date.now() - this.loadedAt < ttlMs
    },

    async fetchActiveUsers(options = {}) {
      const force = Boolean(options.force)
      const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : DEFAULT_TTL_MS

      if (!force && this.isFresh(ttlMs)) {
        return this.users
      }

      // 复用在途请求，但强制刷新时必须另起一次
      if (!force && activeUsersRequest) {
        return activeUsersRequest
      }

      // 强制刷新：推进缓存代次并丢弃在途请求，被顶替的旧请求不会回写用户列表
      if (force) {
        cacheVersion += 1
        activeUsersRequest = null
      }

      const requestVersion = cacheVersion
      this.loading = true
      const request = api
        .getUsers({ page: 1, limit: 100 })
        .then((result) => {
          if (requestVersion !== cacheVersion) {
            return this.users
          }
          this.users = normalizeActiveUsers(result?.users)
          this.loadedAt = Date.now()
          return this.users
        })
        .finally(() => {
          if (activeUsersRequest === request) {
            this.loading = false
            activeUsersRequest = null
          }
        })

      activeUsersRequest = request
      return activeUsersRequest
    },

    invalidate() {
      cacheVersion += 1
      activeUsersRequest = null
      this.users = []
      this.loadedAt = 0
      this.loading = false
    },
  },
})
