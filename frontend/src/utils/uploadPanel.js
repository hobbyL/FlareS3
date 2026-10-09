export const createCancelledError = () => new Error('UPLOAD_CANCELLED')
export const isCancelledError = (error) =>
  error?.code === 'ERR_CANCELED' ||
  error?.name === 'CanceledError' ||
  error?.message === 'UPLOAD_CANCELLED'

export const formatBytes = (bytes) => {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const unit = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(unit)), sizes.length - 1)
  return `${(value / Math.pow(unit, index)).toFixed(2)} ${sizes[index]}`
}

const resolveSameOriginUrl = (value, fallbackPath = '') => {
  const raw = String(value || '').trim()
  const path = raw.startsWith('/') && !raw.startsWith('//') ? raw : fallbackPath
  if (!path) return ''
  if (typeof window === 'undefined') return path
  return `${window.location.origin}${path}`
}

export const resolveDownloadUrl = (value, fallbackPath = '') => {
  const raw = String(value || '').trim()
  if (raw) {
    if (raw.startsWith('/') && !raw.startsWith('//')) {
      return resolveSameOriginUrl(raw)
    }
    try {
      const url = new URL(raw)
      if (url.protocol === 'https:') {
        return url.toString()
      }
    } catch {
      // Fall through to the authenticated app download URL.
    }
  }
  return resolveSameOriginUrl(fallbackPath)
}

export const resolveShortUrl = (value) => {
  const raw = String(value || '').trim()
  if (raw.startsWith('/s/') && !raw.startsWith('//')) {
    return resolveSameOriginUrl(raw)
  }
  return ''
}

/**
 * 从文件的 webkitRelativePath 计算该文件应落入的 dir 前缀（文件夹上传）。
 *
 * relativePath 形如 `a/b/c.txt`（目录名为首段，末段为文件名）；取除末段外
 * 的目录部分作为相对前缀，拼在面板 dir 之后。服务端 sanitizeDir 为最终守卫
 * （拒绝 `..`/`.` 段、归一化分隔符），前端只做纯拼接与基本清洗。
 *
 * @param {string} relativePath - File.webkitRelativePath（可能为空：普通多选）
 * @param {string} panelDir - 面板级 dir 输入框的值
 * @returns {string|undefined} 拼接后的 dir；无前缀时返回 undefined（与现有队列字段一致）
 */
export const buildFolderEntryDir = (relativePath, panelDir = '') => {
  const panel = String(panelDir || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')

  const relative = String(relativePath || '').replace(/\\/g, '/')
  // 末段是文件名，去掉后即目录部分；无目录段（普通多选）时 relativeDir 为空
  const lastSlash = relative.lastIndexOf('/')
  const relativeDir =
    lastSlash === -1
      ? ''
      : relative
          .slice(0, lastSlash)
          .replace(/\/+/g, '/')
          .replace(/^\/+|\/+$/g, '')

  const combined = [panel, relativeDir].filter(Boolean).join('/')
  return combined || undefined
}
