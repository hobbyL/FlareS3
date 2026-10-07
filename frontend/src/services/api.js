import axios from 'axios'
import { buildLoginUrl } from '../utils/authRedirect.js'
import { dedupRequest } from '../utils/requestDedup.js'
import { resolveApiErrorNotice } from '../utils/apiError.js'

/**
 * API 客户端
 *
 * 基于 axios 封装的 HTTP 客户端，提供：
 * - 自动认证处理（401 重定向到登录页）
 * - 统一错误处理和用户提示
 * - 请求去重（防止重复调用）
 * - 30秒超时配置
 *
 * @example
 * import { api } from './services/api.js'
 *
 * // GET 请求
 * const files = await api.listFiles({ page: 1 })
 *
 * // POST 请求
 * const result = await api.createText({ content: 'Hello' })
 */
const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
})

// 消息提示函数（延迟加载以避免循环依赖）
let messageHandler = null
const showMessage = (message, type = 'error') => {
  if (!messageHandler) {
    import('../composables/useMessage.js').then((module) => {
      messageHandler = module.useMessage()
      messageHandler[type](message)
    })
  } else {
    messageHandler[type](message)
  }
}

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const isAuthApi = error.config?.url?.includes('/auth/')
    const notice = resolveApiErrorNotice(error, { isAuthApi })

    if (notice.action === 'redirect') {
      // 401: 未授权，重定向到登录页
      const currentTarget = `${window.location.pathname}${window.location.search}${window.location.hash}`
      window.location.assign(buildLoginUrl(currentTarget))
    } else if (notice.action === 'notify') {
      showMessage(notice.message, notice.type)
    }

    return Promise.reject(error)
  }
)

// 原生 axios 调用（直传上传）绕过拦截器，这里补齐 401 重定向；
// 错误提示仍由视图层 catch 统一处理，避免与拦截器双弹提示
const handleNativeUploadError = (error) => {
  const notice = resolveApiErrorNotice(error, { isAuthApi: false })
  if (notice.action === 'redirect') {
    const currentTarget = `${window.location.pathname}${window.location.search}${window.location.hash}`
    window.location.assign(buildLoginUrl(currentTarget))
  }
  return Promise.reject(error)
}

/**
 * 构造上传进度回调。
 *
 * 进度事件的 total 缺失或为 0（如无 Content-Length 的流式请求）时
 * 百分比置 0，避免出现 NaN 传给上层 UI。
 *
 * @param {Function} [onProgress] - 进度回调 (percent, loaded, total)
 * @returns {(progressEvent: object) => void} axios onUploadProgress 回调
 */
const createUploadProgressHandler = (onProgress) => (progressEvent) => {
  if (!onProgress) return
  const total = Number(progressEvent?.total) || 0
  const loaded = Number(progressEvent?.loaded) || 0
  const percent = total > 0 ? Math.round((loaded * 100) / total) : 0
  onProgress(percent, loaded, total)
}

/**
 * API 方法集合
 *
 * 包含所有后端 API 端点的封装方法
 * 部分高频方法使用 dedupRequest 包装以防止重复调用
 */
export default {
  // ========== 认证 ==========

  /**
   * 用户登录
   * @param {string} username - 用户名
   * @param {string} password - 密码
   * @returns {Promise<{user: object}>}
   */
  login: dedupRequest(
    (username, password) => api.post('/auth/login', { username, password }),
    (username) => `login:${username}`
  ),

  /**
   * 用户登出
   * @returns {Promise<{success: boolean}>}
   */
  logout: dedupRequest(() => api.post('/auth/logout'), 'logout'),

  /**
   * 获取当前认证状态
   * @returns {Promise<{authenticated: boolean, user?: object}>}
   */
  getAuthStatus: dedupRequest(() => api.get('/auth/status'), 'auth-status'),

  /**
   * 修改当前用户密码
   *
   * 成功后服务端会删除该用户全部会话，调用方需要随即登出并跳转登录页。
   * @param {{ current_password: string, new_password: string }} payload - 当前密码与新密码
   * @returns {Promise<{ok: boolean}>}
   */
  changePassword(payload) {
    return api.post('/auth/change-password', payload)
  },

  // ========== R2 配置（旧版）==========

  /**
   * 获取设置状态
   * @returns {Promise<{configured: boolean}>}
   */
  getSetupStatus() {
    return api.get('/setup/status')
  },

  /**
   * 保存 R2 配置
   * @param {object} config - R2 配置对象
   * @returns {Promise<{success: boolean}>}
   */
  saveR2Config(config) {
    return api.post('/setup/config', config)
  },

  /**
   * 测试 R2 连接
   * @param {object} config - R2 配置对象
   * @returns {Promise<{success: boolean}>}
   */
  testR2Connection(config) {
    return api.post('/setup/test', config)
  },

  // ========== 管理员首页 ==========

  /**
   * 获取管理员概览数据
   * @returns {Promise<{totalFiles: number, totalUsers: number, storageUsed: number}>}
   */
  getAdminOverview() {
    return api.get('/admin/overview')
  },

  /**
   * 获取任务运行记录
   * @param {object} params - 查询参数
   * @returns {Promise<{runs: Array}>}
   */
  getAdminJobRuns(params = {}) {
    return api.get('/admin/job-runs', { params })
  },

  // ========== 存储统计 ==========

  /**
   * 获取存储用量统计（admin 为全局口径，普通用户为个人配额口径）
   * @returns {Promise<{usedSpace: number, totalSpace: number, usedSpaceFormatted: string, totalSpaceFormatted: string, usagePercent: number, fileCount: number}>}
   */
  getStats() {
    return api.get('/stats')
  },

  // ========== 存储配置 ==========

  /**
   * 获取所有存储配置（使用去重）
   * @returns {Promise<{configs: Array}>}
   */
  getStorageConfigs: dedupRequest(() => api.get('/storage/configs'), 'storage-configs'),

  /**
   * 获取存储配置的敏感信息（脱敏形态，用于编辑表单回显）
   * @param {string} configId - 配置 ID
   * @param {string} type - 配置类型
   * @returns {Promise<object>}
   */
  getStorageConfigSecrets(configId, type) {
    return api.get(`/storage/configs/${configId}/secrets`, { params: { type } })
  },

  /**
   * 查看存储配置的明文密钥（审计 + 限流，需要 admin）
   * @param {string} configId - 配置 ID
   * @param {string} type - 配置类型
   * @returns {Promise<object>}
   */
  revealStorageConfigSecrets(configId, type) {
    return api.get(`/storage/configs/${configId}/secrets/reveal`, { params: { type } })
  },

  // ========== R2 配置（多配置）==========

  /**
   * 获取 R2 配置选项
   * @returns {Promise<object>}
   */
  getR2Options() {
    return api.get('/r2/options')
  },

  /**
   * 获取所有 R2 配置
   * @returns {Promise<{configs: Array}>}
   */
  getR2Configs() {
    return api.get('/r2/configs')
  },

  /**
   * 创建 R2 配置
   * @param {object} payload - 配置数据
   * @returns {Promise<{id: string}>}
   */
  createR2Config(payload) {
    return api.post('/r2/configs', payload)
  },

  /**
   * 更新 R2 配置
   * @param {string} configId - 配置 ID
   * @param {object} payload - 配置数据
   * @returns {Promise<{success: boolean}>}
   */
  updateR2Config(configId, payload) {
    return api.patch(`/r2/configs/${configId}`, payload)
  },

  /**
   * 删除 R2 配置
   * @param {string} configId - 配置 ID
   * @returns {Promise<{success: boolean}>}
   */
  deleteR2Config(configId) {
    return api.delete(`/r2/configs/${configId}`)
  },

  /**
   * 测试 R2 配置连接
   * @param {string} configId - 配置 ID
   * @returns {Promise<{success: boolean}>}
   */
  testR2Config(configId) {
    return api.post(`/r2/configs/${configId}/test`)
  },

  /**
   * 设置默认 R2 配置
   * @param {string} configId - 配置 ID
   * @returns {Promise<{success: boolean}>}
   */
  setDefaultR2Config(configId) {
    return api.post('/r2/default', { id: configId })
  },

  /**
   * 设置旧文件 R2 配置
   * @param {string} configId - 配置 ID
   * @returns {Promise<{success: boolean}>}
   */
  setLegacyFilesR2Config(configId) {
    return api.post('/r2/legacy-files', { id: configId })
  },

  // ========== WebDAV / Koofr 配置 ==========

  /**
   * 获取所有 WebDAV 配置
   * @returns {Promise<{configs: Array}>}
   */
  getWebDAVConfigs() {
    return api.get('/webdav/configs')
  },

  /**
   * 创建 WebDAV 配置
   * @param {object} payload - 配置数据
   * @returns {Promise<{id: string}>}
   */
  createWebDAVConfig(payload) {
    return api.post('/webdav/configs', payload)
  },

  /**
   * 更新 WebDAV 配置
   * @param {string} configId - 配置 ID
   * @param {object} payload - 配置数据
   * @returns {Promise<{success: boolean}>}
   */
  updateWebDAVConfig(configId, payload) {
    return api.patch(`/webdav/configs/${configId}`, payload)
  },

  /**
   * 删除 WebDAV 配置
   * @param {string} configId - 配置 ID
   * @returns {Promise<{success: boolean}>}
   */
  deleteWebDAVConfig(configId) {
    return api.delete(`/webdav/configs/${configId}`)
  },

  /**
   * 测试 WebDAV 配置连接
   * @param {string} configId - 配置 ID
   * @returns {Promise<{success: boolean}>}
   */
  testWebDAVConfig(configId) {
    return api.post(`/webdav/configs/${configId}/test`)
  },

  // ========== 文件上传 ==========

  /**
   * 获取上传配置选项（使用去重）
   * @returns {Promise<object>}
   */
  getUploadOptions: dedupRequest(() => api.get('/r2/options'), 'upload-options'),

  /**
   * 获取预签名上传 URL
   * @param {object} data - 上传参数
   * @param {string} data.filename - 文件名
   * @param {string} data.content_type - 内容类型
   * @param {number} data.size - 文件大小
   * @param {number} data.expires_in - 过期时间（天）
   * @param {boolean} data.require_login - 是否需要登录
   * @param {string} data.config_id - 配置 ID
   * @param {string} data.dir - 目录
   * @returns {Promise<{file_id: string, upload_url: string, download_url: string}>}
   */
  getUploadURL(data) {
    return api.post('/upload/presign', data)
  },

  /**
   * 初始化分片上传（使用去重）
   * @param {object} data - 初始化参数
   * @returns {Promise<{file_id: string, upload_id: string}>}
   */
  initMultipartUpload: dedupRequest(
    (data) => api.post('/upload/multipart/init', data),
    (data) =>
      [
        'multipart-init',
        data.filename,
        data.size,
        data.content_type,
        data.expires_in,
        data.require_login,
        data.config_id,
        data.dir,
      ].join(':')
  ),

  /**
   * 获取已上传的分片列表
   * @param {string} fileId - 文件 ID
   * @param {string} uploadId - 上传 ID
   * @returns {Promise<{parts: Array}>}
   */
  getMultipartUploadedParts(fileId, uploadId) {
    return api.get('/upload/multipart/parts', {
      params: { file_id: fileId, upload_id: uploadId },
    })
  },

  /**
   * 获取分片上传 URL
   * @param {object} data - 分片上传参数
   * @returns {Promise<{upload_url: string}>}
   */
  getMultipartUploadURL(data) {
    return api.post('/upload/multipart/presign', data)
  },

  /**
   * 完成分片上传
   * @param {object} data - 完成参数
   * @returns {Promise<{success: boolean}>}
   */
  completeMultipartUpload(data) {
    return api.post('/upload/multipart/complete', data)
  },

  /**
   * 中止分片上传
   * @param {object} data - 中止参数
   * @returns {Promise<{success: boolean}>}
   */
  abortMultipartUpload(data) {
    return api.post('/upload/multipart/abort', data)
  },

  /**
   * 确认上传完成
   * @param {string} fileId - 文件 ID
   * @returns {Promise<{success: boolean, filename: string, download_url: string}>}
   */
  confirmUpload(fileId) {
    return api.post('/upload/confirm', { file_id: fileId })
  },

  /**
   * 服务端上传文件
   * @param {object} options - 上传选项
   * @param {string} options.configId - 配置 ID
   * @param {File} options.file - 文件对象
   * @param {string} options.filename - 文件名
   * @param {number} options.expiresIn - 过期时间（天）
   * @param {boolean} options.requireLogin - 是否需要登录
   * @param {string} options.dir - 目录
   * @param {Function} options.onProgress - 进度回调
   * @returns {Promise<object>}
   */
  serverUpload({ configId, file, filename, expiresIn, requireLogin, dir, onProgress }) {
    const formData = new FormData()
    formData.append('config_id', configId)
    formData.append('file', file)
    formData.append('filename', filename || file.name)
    formData.append('expires_in', String(expiresIn ?? 7))
    formData.append('require_login', String(requireLogin !== false))
    if (dir) formData.append('dir', dir)
    return axios
      .post('/api/upload/server', formData, {
        withCredentials: true,
        timeout: 300000,
        onUploadProgress: createUploadProgressHandler(onProgress),
      })
      .then((res) => res.data)
      .catch(handleNativeUploadError)
  },

  // ========== 文件管理 ==========

  /**
   * 获取文件列表
   * @param {number} page - 页码
   * @param {number} limit - 每页数量
   * @param {object} filters - 过滤条件
   * @returns {Promise<{files: Array, total: number}>}
   */
  getFiles(page = 1, limit = 20, filters = {}) {
    return api.get('/files', { params: { page, limit, ...(filters || {}) } })
  },

  /**
   * 获取回收站文件列表
   * @param {number} page - 页码
   * @param {number} limit - 每页数量
   * @param {object} filters - 过滤条件
   * @returns {Promise<{files: Array, total: number}>}
   */
  getTrashFiles(page = 1, limit = 20, filters = {}) {
    return api.get('/files/trash', { params: { page, limit, ...(filters || {}) } })
  },

  /**
   * 恢复文件
   * @param {string} fileId - 文件 ID
   * @returns {Promise<{success: boolean}>}
   */
  restoreFile(fileId) {
    return api.post(`/files/${fileId}/restore`)
  },

  /**
   * 永久删除文件
   * @param {string} fileId - 文件 ID
   * @returns {Promise<{success: boolean}>}
   */
  permanentlyDeleteFile(fileId) {
    return api.delete(`/files/${fileId}/permanent`)
  },

  /**
   * 永久删除回收站所有文件
   * @returns {Promise<{deleted: number, queued: number, total: number}>}
   */
  permanentlyDeleteTrashFiles() {
    return api.delete('/files/trash/permanent')
  },

  /**
   * 删除文件（移至回收站）
   * @param {string} fileId - 文件 ID
   * @returns {Promise<{success: boolean}>}
   */
  deleteFile(fileId) {
    return api.delete(`/files/${fileId}`)
  },

  /**
   * 重命名文件（同目录更新文件名与存储 key 尾段）
   * @param {string} fileId - 文件 ID
   * @param {object} payload - 重命名载荷
   * @param {string} payload.new_name - 新文件名
   * @returns {Promise<{success: boolean, filename: string, r2_key: string}>}
   */
  renameFile(fileId, payload) {
    return api.post(`/files/${fileId}/rename`, payload)
  },

  /**
   * 获取文件下载 URL
   * @param {string} fileId - 文件 ID
   * @returns {string} 下载 URL
   */
  getDownloadURL(fileId) {
    return `/api/files/${fileId}/download`
  },

  // ========== 文件分享 ==========

  /**
   * 获取文件分享信息
   * @param {string} fileId - 文件 ID
   * @returns {Promise<object>}
   */
  getFileShare(fileId) {
    return api.get(`/files/${fileId}/share`)
  },

  /**
   * 创建或更新文件分享
   * @param {string} fileId - 文件 ID
   * @param {object} payload - 分享配置
   * @returns {Promise<{success: boolean}>}
   */
  upsertFileShare(fileId, payload) {
    return api.post(`/files/${fileId}/share`, payload)
  },

  /**
   * 删除文件分享
   * @param {string} fileId - 文件 ID
   * @returns {Promise<{success: boolean}>}
   */
  deleteFileShare(fileId) {
    return api.delete(`/files/${fileId}/share`)
  },

  /**
   * 获取分享列表
   * @param {object} params - 查询参数
   * @returns {Promise<{shares: Array}>}
   */
  listShares(params = {}) {
    return api.get('/shares', { params })
  },

  /**
   * 获取分享访问记录（分页，仅 owner/admin）
   * @param {string} shareType - 分享类型（file / text / folder）
   * @param {string} shareId - 资源 ID（file_id / text_id / folder_shares.id）
   * @param {object} params - 查询参数（page）
   * @returns {Promise<{items: Array, total: number, page: number, limit: number}>}
   */
  getShareAccesses(shareType, shareId, params = {}) {
    return api.get(`/shares/${shareType}/${shareId}/accesses`, { params })
  },

  // ========== 文件夹分享 ==========

  /**
   * 查询目录的文件夹分享（同 scope 唯一）
   * @param {object} params - 查询参数（config_id / prefix）
   * @returns {Promise<{share: object|null}>}
   */
  getFolderShare(params = {}) {
    return api.get('/mount/folder-share', { params })
  },

  /**
   * 创建文件夹分享
   * @param {object} payload - { config_id, prefix, password?, expires_at?, max_views? }
   * @returns {Promise<{share: object}>}
   */
  createFolderShare(payload) {
    return api.post('/mount/folder-share', payload)
  },

  /**
   * 撤销文件夹分享
   * @param {object} payload - { share_code } 或 { config_id, prefix }
   * @returns {Promise<{success: boolean, deleted: boolean}>}
   */
  deleteFolderShare(payload) {
    return api.delete('/mount/folder-share', { data: payload })
  },

  // ========== 挂载管理 ==========

  /**
   * 列出挂载对象
   * @param {object} options - 查询选项
   * @param {string} options.configId - 配置 ID
   * @param {string} options.prefix - 前缀路径
   * @param {string} options.continuationToken - 分页令牌
   * @param {number} options.limit - 返回数量限制
   * @returns {Promise<{objects: Array, nextContinuationToken: string}>}
   */
  listMountedObjects({ configId, prefix = '', continuationToken, limit } = {}) {
    const params = {
      config_id: configId,
      prefix,
      continuation_token: continuationToken,
      limit,
    }
    return api.get('/mount/objects', { params })
  },

  /**
   * 删除挂载对象
   * @param {object} options - 删除选项
   * @param {string} options.configId - 配置 ID
   * @param {string} options.key - 对象键
   * @returns {Promise<{success: boolean}>}
   */
  deleteMountedObject({ configId, key } = {}) {
    const params = {
      config_id: configId,
      key,
    }
    return api.delete('/mount/object', { params })
  },

  /**
   * 上传挂载对象
   * @param {object} options - 上传选项
   * @param {string} options.configId - 配置 ID
   * @param {string} options.path - 对象路径
   * @param {File} options.file - 文件对象
   * @param {Function} options.onProgress - 进度回调
   * @returns {Promise<object>}
   */
  uploadMountedObject({ configId, path, file, onProgress }) {
    const formData = new FormData()
    formData.append('config_id', configId)
    formData.append('path', path)
    formData.append('file', file)
    return axios
      .post('/api/mount/upload', formData, {
        withCredentials: true,
        timeout: 300000,
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: createUploadProgressHandler(onProgress),
      })
      .then((res) => res.data)
      .catch(handleNativeUploadError)
  },

  /**
   * 创建挂载文件夹
   * @param {object} options - 创建选项
   * @param {string} options.configId - 配置 ID
   * @param {string} options.key - 文件夹键
   * @returns {Promise<{success: boolean}>}
   */
  createMountedFolder({ configId, key }) {
    return api.post('/mount/folder', { config_id: configId, key })
  },

  /**
   * 移动 / 重命名挂载对象（同一挂载点内）
   * @param {object} options - 移动选项
   * @param {string} options.configId - 配置 ID
   * @param {string} options.key - 源对象键（文件对象，不允许尾斜杠）
   * @param {string} options.toDir - 目标目录（空字符串表示挂载点根）
   * @param {string} options.newName - 新文件名
   * @returns {Promise<{ok: boolean, key: string}>}
   */
  moveMountObject({ configId, key, toDir = '', newName } = {}) {
    return api.post('/mount/move', {
      config_id: configId,
      key,
      to_dir: toDir,
      new_name: newName,
    })
  },

  // ========== 用户管理 ==========

  /**
   * 获取用户列表
   * @param {object} params - 查询参数
   * @returns {Promise<{users: Array, total: number}>}
   */
  getUsers(params = {}) {
    return api.get('/users', { params })
  },

  /**
   * 创建用户
   * @param {object} payload - 用户数据
   * @returns {Promise<{id: string}>}
   */
  createUser(payload) {
    return api.post('/users', payload)
  },

  /**
   * 更新用户信息
   * @param {string} userId - 用户 ID
   * @param {object} payload - 更新数据
   * @returns {Promise<{success: boolean}>}
   */
  updateUser(userId, payload) {
    return api.patch(`/users/${userId}`, payload)
  },

  /**
   * 重置用户密码
   * @param {string} userId - 用户 ID
   * @param {string} password - 新密码
   * @returns {Promise<{success: boolean}>}
   */
  resetUserPassword(userId, password) {
    return api.post(`/users/${userId}/reset-password`, { password })
  },

  /**
   * 删除用户
   * @param {string} userId - 用户 ID
   * @returns {Promise<{success: boolean}>}
   */
  deleteUser(userId) {
    return api.delete(`/users/${userId}`)
  },

  // ========== 审计日志 ==========

  /**
   * 获取审计日志
   * @param {object} params - 查询参数
   * @returns {Promise<{logs: Array, total: number}>}
   */
  getAudit(params = {}) {
    return api.get('/audit', { params })
  },

  /**
   * 删除审计日志
   * @param {string} auditId - 审计日志 ID
   * @returns {Promise<{success: boolean}>}
   */
  deleteAuditLog(auditId) {
    return api.delete(`/audit/${auditId}`)
  },

  /**
   * 批量删除审计日志
   * @param {Array<string>} ids - 审计日志 ID 数组
   * @returns {Promise<{deleted: number}>}
   */
  batchDeleteAuditLogs(ids = []) {
    return api.post('/audit/batch-delete', { ids })
  },

  // ========== 文本管理 ==========

  /**
   * 获取文本列表
   * @param {number} page - 页码
   * @param {number} limit - 每页数量
   * @param {object} params - 查询参数
   * @returns {Promise<{texts: Array, total: number}>}
   */
  getTexts(page = 1, limit = 20, params = {}) {
    return api.get('/texts', { params: { page, limit, ...(params || {}) } })
  },

  /**
   * 获取单个文本
   * @param {string} textId - 文本 ID
   * @returns {Promise<object>}
   */
  getText(textId) {
    return api.get(`/texts/${textId}`)
  },

  /**
   * 创建文本
   * @param {object} payload - 文本数据
   * @returns {Promise<{id: string}>}
   */
  createText(payload) {
    return api.post('/texts', payload)
  },

  /**
   * 更新文本
   * @param {string} textId - 文本 ID
   * @param {object} payload - 更新数据
   * @returns {Promise<{success: boolean}>}
   */
  updateText(textId, payload) {
    return api.patch(`/texts/${textId}`, payload)
  },

  /**
   * 删除文本
   * @param {string} textId - 文本 ID
   * @returns {Promise<{success: boolean}>}
   */
  deleteText(textId) {
    return api.delete(`/texts/${textId}`)
  },

  /**
   * 创建一次性文本分享
   * @param {string} textId - 文本 ID
   * @returns {Promise<{share_url: string}>}
   */
  createTextOneTimeShare(textId) {
    return api.post(`/texts/${textId}/one-time-share`)
  },

  /**
   * 删除一次性文本分享
   * @param {string} textId - 文本 ID
   * @returns {Promise<{success: boolean}>}
   */
  deleteTextOneTimeShare(textId) {
    return api.delete(`/texts/${textId}/one-time-share`)
  },

  // ========== 文本分享 ==========

  /**
   * 获取文本分享信息
   * @param {string} textId - 文本 ID
   * @returns {Promise<object>}
   */
  getTextShare(textId) {
    return api.get(`/texts/${textId}/share`)
  },

  /**
   * 创建或更新文本分享
   * @param {string} textId - 文本 ID
   * @param {object} payload - 分享配置
   * @returns {Promise<{success: boolean}>}
   */
  upsertTextShare(textId, payload) {
    return api.post(`/texts/${textId}/share`, payload)
  },

  /**
   * 删除文本分享
   * @param {string} textId - 文本 ID
   * @returns {Promise<{success: boolean}>}
   */
  deleteTextShare(textId) {
    return api.delete(`/texts/${textId}/share`)
  },

  // ========== R2 直接上传 ==========

  /**
   * 直接上传到 R2
   * @param {string} url - 预签名上传 URL
   * @param {File} file - 文件对象
   * @param {Function} onProgress - 进度回调
   * @param {object} options - 额外选项
   * @param {AbortSignal} options.signal - 取消信号
   * @returns {Promise<object>}
   */
  uploadToR2(url, file, onProgress, options = {}) {
    const { signal } = options || {}
    return axios.put(url, file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
      },
      onUploadProgress: createUploadProgressHandler(onProgress),
      signal,
    })
  },
}
