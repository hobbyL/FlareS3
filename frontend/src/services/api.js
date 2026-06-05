import axios from 'axios'
import { buildLoginUrl } from '../utils/authRedirect.js'

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
})

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const isAuthApi = error.config?.url?.includes('/auth/')
    if (error.response?.status === 401 && !isAuthApi) {
      const currentTarget = `${window.location.pathname}${window.location.search}${window.location.hash}`
      window.location.assign(buildLoginUrl(currentTarget))
    }
    return Promise.reject(error)
  }
)

export default {
  // 认证
  login(username, password) {
    return api.post('/auth/login', { username, password })
  },

  logout() {
    return api.post('/auth/logout')
  },

  getAuthStatus() {
    return api.get('/auth/status')
  },

  // R2 配置（旧版）
  getSetupStatus() {
    return api.get('/setup/status')
  },

  saveR2Config(config) {
    return api.post('/setup/config', config)
  },

  testR2Connection(config) {
    return api.post('/setup/test', config)
  },

  // 管理员首页
  getAdminOverview() {
    return api.get('/admin/overview')
  },

  getAdminJobRuns(params = {}) {
    return api.get('/admin/job-runs', { params })
  },

  // 统一存储配置
  getStorageConfigs() {
    return api.get('/storage/configs')
  },

  getStorageConfigSecrets(configId, type, options = {}) {
    return api.get(`/storage/configs/${configId}/secrets`, {
      params: {
        ...(type ? { type } : {}),
        ...(options.reveal === false ? { reveal: '0' } : {}),
      },
    })
  },

  // R2 配置（多配置）
  getR2Options() {
    return api.get('/r2/options')
  },

  getR2Configs() {
    return api.get('/r2/configs')
  },

  createR2Config(payload) {
    return api.post('/r2/configs', payload)
  },

  updateR2Config(configId, payload) {
    return api.patch(`/r2/configs/${configId}`, payload)
  },

  deleteR2Config(configId) {
    return api.delete(`/r2/configs/${configId}`)
  },

  testR2Config(configId) {
    return api.post(`/r2/configs/${configId}/test`)
  },

  setDefaultR2Config(configId) {
    return api.post('/r2/default', { id: configId })
  },

  setLegacyFilesR2Config(configId) {
    return api.post('/r2/legacy-files', { id: configId })
  },

  // WebDAV / Koofr 配置
  getWebDAVConfigs() {
    return api.get('/webdav/configs')
  },

  createWebDAVConfig(payload) {
    return api.post('/webdav/configs', payload)
  },

  updateWebDAVConfig(configId, payload) {
    return api.patch(`/webdav/configs/${configId}`, payload)
  },

  deleteWebDAVConfig(configId) {
    return api.delete(`/webdav/configs/${configId}`)
  },

  testWebDAVConfig(configId) {
    return api.post(`/webdav/configs/${configId}/test`)
  },

  // 文件上传
  getUploadOptions() {
    return api.get('/r2/options')
  },

  getUploadURL(data) {
    return api.post('/upload/presign', data)
  },

  initMultipartUpload(data) {
    return api.post('/upload/multipart/init', data)
  },

  getMultipartUploadURL(data) {
    return api.post('/upload/multipart/presign', data)
  },

  completeMultipartUpload(data) {
    return api.post('/upload/multipart/complete', data)
  },

  abortMultipartUpload(data) {
    return api.post('/upload/multipart/abort', data)
  },

  confirmUpload(fileId) {
    return api.post('/upload/confirm', { file_id: fileId })
  },

  serverUpload({ configId, file, filename, expiresIn, requireLogin, dir, onProgress }) {
    const formData = new FormData()
    formData.append('config_id', configId)
    formData.append('file', file)
    formData.append('filename', filename || file.name)
    formData.append('expires_in', String(expiresIn ?? 7))
    formData.append('require_login', String(requireLogin !== false))
    if (dir) formData.append('dir', dir)
    return axios.post('/api/upload/server', formData, {
      withCredentials: true,
      timeout: 300000,
      onUploadProgress: (progressEvent) => {
        if (onProgress) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total)
          onProgress(percent, progressEvent.loaded, progressEvent.total)
        }
      },
    }).then((res) => res.data)
  },
  // 文件管理
  getFiles(page = 1, limit = 20, filters = {}) {
    return api.get('/files', { params: { page, limit, ...(filters || {}) } })
  },

  getTrashFiles(page = 1, limit = 20, filters = {}) {
    return api.get('/files/trash', { params: { page, limit, ...(filters || {}) } })
  },

  restoreFile(fileId) {
    return api.post(`/files/${fileId}/restore`)
  },

  permanentlyDeleteFile(fileId) {
    return api.delete(`/files/${fileId}/permanent`)
  },

  permanentlyDeleteTrashFiles() {
    return api.delete('/files/trash/permanent')
  },

  // 挂载
  listMountedObjects({ configId, prefix = '', continuationToken, limit } = {}) {
    const params = {
      config_id: configId,
      prefix,
      continuation_token: continuationToken,
      limit,
    }
    return api.get('/mount/objects', { params })
  },

  deleteMountedObject({ configId, key } = {}) {
    const params = {
      config_id: configId,
      key,
    }
    return api.delete('/mount/object', { params })
  },

  uploadMountedObject({ configId, path, file, onProgress }) {
    const formData = new FormData()
    formData.append('config_id', configId)
    formData.append('path', path)
    formData.append('file', file)
    return axios.post('/api/mount/upload', formData, {
      withCredentials: true,
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        if (onProgress) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total)
          onProgress(percent, progressEvent.loaded, progressEvent.total)
        }
      },
    })
  },

  createMountedFolder({ configId, key }) {
    return api.post('/mount/folder', { config_id: configId, key })
  },

  deleteFile(fileId) {
    return api.delete(`/files/${fileId}`)
  },

  getDownloadURL(fileId) {
    return `/api/files/${fileId}/download`
  },

  // 文件分享
  getFileShare(fileId) {
    return api.get(`/files/${fileId}/share`)
  },

  upsertFileShare(fileId, payload) {
    return api.post(`/files/${fileId}/share`, payload)
  },

  deleteFileShare(fileId) {
    return api.delete(`/files/${fileId}/share`)
  },

  listShares(params = {}) {
    return api.get('/shares', { params })
  },

  // 用户管理
  getUsers(params = {}) {
    return api.get('/users', { params })
  },

  createUser(payload) {
    return api.post('/users', payload)
  },

  updateUser(userId, payload) {
    return api.patch(`/users/${userId}`, payload)
  },

  resetUserPassword(userId, password) {
    return api.post(`/users/${userId}/reset-password`, { password })
  },

  deleteUser(userId) {
    return api.delete(`/users/${userId}`)
  },

  // 审计
  getAudit(params = {}) {
    return api.get('/audit', { params })
  },

  deleteAuditLog(auditId) {
    return api.delete(`/audit/${auditId}`)
  },

  batchDeleteAuditLogs(ids = []) {
    return api.post('/audit/batch-delete', { ids })
  },

  // 文本
  getTexts(page = 1, limit = 20, params = {}) {
    return api.get('/texts', { params: { page, limit, ...(params || {}) } })
  },

  getText(textId) {
    return api.get(`/texts/${textId}`)
  },

  createText(payload) {
    return api.post('/texts', payload)
  },

  updateText(textId, payload) {
    return api.patch(`/texts/${textId}`, payload)
  },

  deleteText(textId) {
    return api.delete(`/texts/${textId}`)
  },

  createTextOneTimeShare(textId) {
    return api.post(`/texts/${textId}/one-time-share`)
  },

  deleteTextOneTimeShare(textId) {
    return api.delete(`/texts/${textId}/one-time-share`)
  },

  // 文档分享
  getTextShare(textId) {
    return api.get(`/texts/${textId}/share`)
  },

  upsertTextShare(textId, payload) {
    return api.post(`/texts/${textId}/share`, payload)
  },

  deleteTextShare(textId) {
    return api.delete(`/texts/${textId}/share`)
  },

  // 直接上传到 R2
  uploadToR2(url, file, onProgress, options = {}) {
    const { signal } = options || {}
    return axios.put(url, file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
      },
      onUploadProgress: (progressEvent) => {
        if (onProgress) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total)
          onProgress(percent, progressEvent.loaded, progressEvent.total)
        }
      },
      signal,
    })
  },
}
