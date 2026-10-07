import { getMountedPreviewKind } from './mountPreview.js'

export function normalizeMountPrefix(value) {
  const raw = String(value || '').trim()
  if (!raw || raw === '/') return ''

  let next = raw
  if (next.startsWith('/')) next = next.slice(1)
  if (next && !next.endsWith('/')) next += '/'
  return next
}

export function formatMountBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '-'
  if (value === 0) return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(value) / Math.log(k)))
  const sized = Math.round((value / Math.pow(k, i)) * 100) / 100
  return `${sized} ${sizes[i]}`
}

export function formatMountDateTime(isoString, locale) {
  if (!isoString) return '-'
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString(locale)
}

export function getMountObjectBasename(key) {
  const normalized = String(key || '')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

export function getMountParentPrefix(value) {
  const raw = String(value || '')
  if (!raw) return ''
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return ''
  return trimmed.slice(0, idx + 1)
}

/**
 * 对象所在目录（不含尾斜杠）：与后端 /api/mount/move 的 to_dir 规范一致。
 * 'docs/team/a.txt' -> 'docs/team'；'a.txt' -> ''（挂载点根）
 */
export function getMountObjectDirPrefix(key) {
  const raw = String(key || '')
  const idx = raw.lastIndexOf('/')
  return idx >= 0 ? raw.slice(0, idx) : ''
}

/**
 * 组合移动/重命名目标 key：toDir 为空表示挂载点根。
 */
export function buildMountMoveTargetKey(toDir, fileName) {
  const dir = String(toDir || '')
    .trim()
    .replace(/\/+$/, '')
  const name = String(fileName || '').trim()
  if (!name) return ''
  return dir ? `${dir}/${name}` : name
}

/**
 * 目标与源是否相同（同目录同文件名的 no-op 移动）。
 */
export function isSameMountMoveTarget(sourceKey, toDir, fileName) {
  const targetKey = buildMountMoveTargetKey(toDir, fileName)
  return Boolean(targetKey) && targetKey === String(sourceKey || '')
}

/**
 * 从 listMountedObjects 结果提取目录树子节点（仅文件夹行）。
 */
export function buildMountFolderNodes({ basePrefix = '', folders = [] } = {}) {
  return buildMountedObjectRows({ basePrefix, folders }).filter((row) => row.kind === 'folder')
}

export function isMountedObjectPreviewSupported(key) {
  return Boolean(getMountedPreviewKind(key))
}

export function buildMountDownloadUrl(configId, key) {
  const normalizedConfigId = String(configId || '').trim()
  const objectKey = String(key || '').trim()
  if (!normalizedConfigId || !objectKey) return ''

  const query = `config_id=${encodeURIComponent(normalizedConfigId)}&key=${encodeURIComponent(objectKey)}`
  return `/api/mount/download?${query}`
}

export function buildMountedObjectRows({ basePrefix = '', folders = [], objects = [] } = {}) {
  const normalizedBasePrefix = String(basePrefix || '')
  const folderRows = (Array.isArray(folders) ? folders : []).map((folderPrefix) => {
    const fullKey = String(folderPrefix || '')
    const relative = fullKey.startsWith(normalizedBasePrefix)
      ? fullKey.slice(normalizedBasePrefix.length)
      : fullKey
    const name = relative.endsWith('/') ? relative.slice(0, -1) : relative

    return {
      kind: 'folder',
      key: fullKey,
      name: name || fullKey,
    }
  })

  const objectRows = (Array.isArray(objects) ? objects : [])
    .map((obj) => {
      const fullKey = String(obj?.key || '')
      const relative = fullKey.startsWith(normalizedBasePrefix)
        ? fullKey.slice(normalizedBasePrefix.length)
        : fullKey
      return {
        kind: 'object',
        key: fullKey,
        name: relative || fullKey,
        size: obj?.size,
        last_modified: obj?.last_modified,
      }
    })
    .filter((row) => row.key && row.key !== normalizedBasePrefix)

  return [...folderRows, ...objectRows]
}
