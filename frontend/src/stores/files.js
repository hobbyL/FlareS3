import { defineStore } from 'pinia'
import api from '../services/api.js'

export const useFilesStore = defineStore('files', {
  state: () => ({
    files: [],
    total: 0,
    page: 1,
    limit: 20,
    loading: false,
    filters: {},
    mode: 'active',
  }),

  actions: {
    async fetchFiles(page = 1, limit = this.limit, filters = this.filters, options = {}) {
      this.loading = true
      try {
        const mode = options?.mode === 'trash' ? 'trash' : 'active'
        const response =
          mode === 'trash'
            ? await api.getTrashFiles(page, limit, filters)
            : await api.getFiles(page, limit, filters)
        const nextFiles = response.files || []
        const shouldAppend = Boolean(options?.append)

        this.files = shouldAppend ? [...this.files, ...nextFiles] : nextFiles
        this.total = response.total
        this.page = response.page
        this.limit = response.limit
        this.filters = filters || {}
        this.mode = mode
      } finally {
        this.loading = false
      }
    },

    async deleteFile(fileId) {
      await api.deleteFile(fileId)
      await this.fetchFiles(this.page, this.limit, this.filters, { mode: this.mode })
    },

    async restoreFile(fileId) {
      await api.restoreFile(fileId)
      await this.fetchFiles(this.page, this.limit, this.filters, { mode: this.mode })
    },

    async permanentlyDeleteFile(fileId) {
      await api.permanentlyDeleteFile(fileId)
      await this.fetchFiles(this.page, this.limit, this.filters, { mode: this.mode })
    },
  },
})
