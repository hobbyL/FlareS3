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
