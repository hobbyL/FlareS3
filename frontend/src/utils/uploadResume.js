/**
 * 文件断点续传 - LocalStorage 管理
 */

const STORAGE_KEY = 'flares3_upload_progress'
const MAX_AGE = 24 * 60 * 60 * 1000 // 24 小时

/**
 * 生成文件唯一标识
 */
export function generateFileId(file) {
  return `${file.name}_${file.size}_${file.lastModified}`
}

/**
 * 获取所有上传进度
 */
function getAllProgress() {
  try {
    const data = localStorage.getItem(STORAGE_KEY)
    return data ? JSON.parse(data) : {}
  } catch (e) {
    console.warn('Failed to load upload progress:', e)
    return {}
  }
}

/**
 * 保存所有上传进度
 */
function saveAllProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress))
  } catch (e) {
    console.warn('Failed to save upload progress:', e)
  }
}

/**
 * 获取文件上传进度
 */
export function getUploadProgress(fileId) {
  const allProgress = getAllProgress()
  const progress = allProgress[fileId]

  // 检查是否过期
  if (progress && Date.now() - progress.lastUploadAt > MAX_AGE) {
    deleteUploadProgress(fileId)
    return null
  }

  return progress
}

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0
const isPositiveFinite = (value) => Number.isFinite(value) && value > 0

/**
 * 校验并归一化单条进度记录，结构非法或已过期时返回 null
 *
 * 校验口径见 design §1：续传与展示必需的字段缺一不可；
 * uploadedParts 缺失归一为 []（兼容老记录），partSize 非法归一为 0（仅影响百分比展示，
 * 真实分片集合在续传时由服务端 listParts 校正）。
 */
function normalizeProgressEntry(fileId, progress, now) {
  if (!isNonEmptyString(fileId) || !progress || typeof progress !== 'object') return null

  const { serverFileId, uploadId, filename, size, partSize, totalParts, uploadedParts } = progress
  const lastUploadAt = progress.lastUploadAt

  if (
    !isNonEmptyString(serverFileId) ||
    !isNonEmptyString(uploadId) ||
    !isNonEmptyString(filename)
  ) {
    return null
  }
  if (!isPositiveFinite(size) || !isPositiveFinite(totalParts)) return null
  // lastUploadAt 非法时无法判定过期、也无法展示时间，按结构非法处理
  if (!isPositiveFinite(lastUploadAt) || now - lastUploadAt > MAX_AGE) return null

  return {
    fileId,
    serverFileId,
    uploadId,
    filename,
    size,
    partSize: isPositiveFinite(partSize) ? partSize : 0,
    totalParts,
    uploadedParts: Array.isArray(uploadedParts) ? uploadedParts : [],
    lastUploadAt,
  }
}

/**
 * 列出所有有效的未完成上传进度
 *
 * 结构非法与过期记录一并从存储中剔除，整轮只写一次（无变更不重写）。
 * 返回值按 lastUploadAt 倒序，每项带 fileId（即存储 key）。
 */
export function listUploadProgress() {
  const allProgress = getAllProgress()
  const now = Date.now()
  const entries = []
  let cleaned = false

  for (const [fileId, progress] of Object.entries(allProgress)) {
    const entry = normalizeProgressEntry(fileId, progress, now)
    if (!entry) {
      delete allProgress[fileId]
      cleaned = true
      continue
    }
    entries.push(entry)
  }

  if (cleaned) {
    saveAllProgress(allProgress)
  }

  return entries.sort((a, b) => b.lastUploadAt - a.lastUploadAt)
}

/**
 * 保存文件上传进度
 */
export function saveUploadProgress(fileId, data) {
  const allProgress = getAllProgress()
  allProgress[fileId] = {
    ...data,
    lastUploadAt: Date.now(),
  }
  saveAllProgress(allProgress)
}

/**
 * 更新已上传的分片
 */
export function updateUploadedParts(fileId, partNumber) {
  const progress = getUploadProgress(fileId)
  if (!progress) return

  if (!progress.uploadedParts) {
    progress.uploadedParts = []
  }

  if (!progress.uploadedParts.includes(partNumber)) {
    progress.uploadedParts.push(partNumber)
  }

  saveUploadProgress(fileId, progress)
}

/**
 * 删除文件上传进度
 */
export function deleteUploadProgress(fileId) {
  const allProgress = getAllProgress()
  delete allProgress[fileId]
  saveAllProgress(allProgress)
}

/**
 * 清理过期的上传进度
 */
export function cleanExpiredProgress() {
  const allProgress = getAllProgress()
  const now = Date.now()
  let cleaned = false

  for (const [fileId, progress] of Object.entries(allProgress)) {
    if (now - progress.lastUploadAt > MAX_AGE) {
      delete allProgress[fileId]
      cleaned = true
    }
  }

  if (cleaned) {
    saveAllProgress(allProgress)
  }
}

/**
 * 初始化：清理过期进度
 */
export function initUploadResume() {
  cleanExpiredProgress()
}
