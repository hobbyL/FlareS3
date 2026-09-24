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
