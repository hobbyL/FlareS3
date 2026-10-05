import { defineStore } from 'pinia'
import api from '../services/api.js'

const DEFAULT_TTL_MS = 5 * 60 * 1000
/** 每页拉取数量（后端 /api/users 的 limit 上限为 100） */
const USERS_PAGE_LIMIT = 100
/** 翻页安全上限：最多 5 页 = 500 人，防止超大实例下请求失控 */
const MAX_USERS_PAGES = 5
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

      // 后端返回 { users, total }：循环翻页拉全量，达安全上限即停（可接受列表不完整）
      const request = (async () => {
        const collected = []
        for (let page = 1; page <= MAX_USERS_PAGES; page += 1) {
          const result = await api.getUsers({ page, limit: USERS_PAGE_LIMIT })
          if (requestVersion !== cacheVersion) {
            return this.users
          }
          const users = Array.isArray(result?.users) ? result.users : []
          collected.push(...users)
          const total = Number(result?.total)
          const reachedEnd =
            users.length < USERS_PAGE_LIMIT || (Number.isFinite(total) && collected.length >= total)
          if (reachedEnd) break
          if (page === MAX_USERS_PAGES) {
            console.warn(
              `[userOptions] 用户数超过翻页安全上限（${MAX_USERS_PAGES * USERS_PAGE_LIMIT}），候选列表可能不完整`
            )
          }
        }
        this.users = normalizeActiveUsers(collected)
        this.loadedAt = Date.now()
        return this.users
      })().finally(() => {
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
