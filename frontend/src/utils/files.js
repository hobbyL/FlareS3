export function isFileDeleted(row = {}) {
  return String(row?.upload_status ?? '').trim() === 'deleted'
}

export function getFileStatusState(row = {}, nowMs = Date.now()) {
  const deleted = isFileDeleted(row)
  const expiresAtMs = row?.expires_at ? new Date(row.expires_at).getTime() : Number.NaN
  const expired = !deleted && Number.isFinite(expiresAtMs) && nowMs > expiresAtMs

  return { deleted, expired }
}

export function canManageFileShare(row = {}, nowMs = Date.now()) {
  const { deleted, expired } = getFileStatusState(row, nowMs)
  return !deleted && !expired
}

function normalizeText(value) {
  return String(value ?? '').trim()
}

export function formatFileBytes(bytes) {
  if (bytes === 0) return '0 B'

  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(value) / Math.log(k)))
  return `${Math.round((value / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`
}

export function formatFileDateTime(isoString, locale) {
  if (!isoString) return '-'
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString(locale)
}

export function getFileExpiresText(row = {}, t = (key) => key) {
  const expiresIn = Number(row?.expires_in)
  if (!Number.isFinite(expiresIn)) return '-'
  return expiresIn === -30
    ? t('files.expires.seconds', { value: 30 })
    : t('files.expires.days', { days: expiresIn })
}

export function getFileRemainingText(row = {}, { isTrashMode = false } = {}) {
  if (isFileDeleted(row) || isTrashMode) return '-'
  const text = normalizeText(row?.remaining_time)
  return text || '-'
}

export function getFileDisplayStatus(row = {}, t = (key) => key, nowMs = Date.now()) {
  const { deleted, expired } = getFileStatusState(row, nowMs)
  const text = deleted
    ? t('files.status.invalid')
    : expired
      ? t('files.status.expired')
      : t('files.status.valid')
  const tagType = deleted ? 'danger' : expired ? 'warning' : 'success'

  return { deleted, expired, text, tagType }
}

export function toIsoStartOfDay(dateValue) {
  const normalized = normalizeText(dateValue)
  if (!normalized) return null

  const local = new Date(`${normalized}T00:00:00`)
  if (Number.isNaN(local.getTime())) return null
  return local.toISOString()
}

export function addOneDayIso(isoString) {
  const normalized = normalizeText(isoString)
  if (!normalized) return null

  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() + 1)
  return date.toISOString()
}

function applyFileDateRangeParams(params, filters = {}, { isTrash = false } = {}) {
  const createdFromDate = filters.created_from_date
  const createdToDate = filters.created_to_date

  if (!createdFromDate && !createdToDate) return

  let fromDate = createdFromDate
  let toDate = createdToDate

  if (fromDate && toDate && fromDate > toDate) {
    const earlierDate = toDate
    toDate = fromDate
    fromDate = earlierDate
  }

  const fromIso = fromDate ? toIsoStartOfDay(fromDate) : null
  const toBaseIso = toDate ? toIsoStartOfDay(toDate) : null
  const toIso = toBaseIso ? addOneDayIso(toBaseIso) : null

  const fromKey = isTrash ? 'deleted_from' : 'created_from'
  const toKey = isTrash ? 'deleted_to' : 'created_to'

  if (fromIso && toIso) {
    params[fromKey] = fromIso
    params[toKey] = toIso
    return
  }

  if (fromIso) {
    const singleTo = addOneDayIso(fromIso)
    if (singleTo) {
      params[fromKey] = fromIso
      params[toKey] = singleTo
    }
    return
  }

  if (toIso && toBaseIso) {
    params[fromKey] = toBaseIso
    params[toKey] = toIso
  }
}

export function buildFilesQueryParams(filters = {}, { mode = 'normal', isAdmin = false } = {}) {
  const params = {}
  const isTrash = mode === 'trash'

  const sortKey = filters.sort_key || (isTrash ? 'deleted_at__desc' : 'created_at__desc')
  const [sortBy, sortOrder] = String(sortKey).split('__')
  if (sortBy) params.sort_by = sortBy
  if (sortOrder) params.sort_order = sortOrder

  const filename = normalizeText(filters.filename)
  if (filename) params.filename = filename

  // 目录过滤仅在活动模式生效（回收站不按目录浏览）
  if (!isTrash) {
    const dir = normalizeText(filters.dir)
    if (dir) params.dir = dir
  }

  if (isAdmin && filters.owner_id) {
    params.owner_id = filters.owner_id
  }

  if (!isTrash && filters.upload_status) {
    params.upload_status = filters.upload_status
  }

  applyFileDateRangeParams(params, filters, { isTrash })

  return params
}

// ── 批量选择纯函数（镜像 utils/shares.js 的选择范式）──

/** 从文件行取选择主键（文件 id）；无 id 返回空串（视图层据此跳过）。 */
export function toFileSelectionKey(record = {}) {
  return normalizeText(record?.id)
}

/** 构造已选 id 的 Set（去空、去重），供 O(1) 命中判断。 */
export function buildFileSelectedIdSet(selectedIds = []) {
  return new Set((selectedIds || []).map((id) => normalizeText(id)).filter(Boolean))
}

/** 按已选 id 集合过滤出当前页中被选中的文件行。 */
export function collectSelectedFiles(items = [], selectedIds = []) {
  const selectedKeySet = buildFileSelectedIdSet(selectedIds)
  if (!selectedKeySet.size) {
    return []
  }
  return (items || []).filter((item) => {
    const key = toFileSelectionKey(item)
    return key ? selectedKeySet.has(key) : false
  })
}

/** 勾选 / 取消勾选单行，返回新的 id 数组（不可变更新）。 */
export function updateFileSelection(selectedIds = [], rowId = '', checked = false) {
  const id = normalizeText(rowId)
  if (!id) {
    return selectedIds
  }
  const next = buildFileSelectedIdSet(selectedIds)
  if (checked) {
    next.add(id)
  } else {
    next.delete(id)
  }
  return Array.from(next)
}

// ── 目录导航纯函数（文件页目录化视图；镜像 r2Dir 的目录口径）──

/** 归一目录字符串：转正斜杠、折叠/去首尾 `/`。空/畸形返回 ''（根）。 */
export function normalizeDir(dir) {
  const clean = String(dir ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
  return clean
}

// 已知存储前缀：目录藏于 `<prefix>/<configId>/<dir...>/<filename>`（镜像 worker/utils/r2Dir）
const FILE_DIR_KNOWN_PREFIXES = new Set(['flares3', 'storage'])

/**
 * 从 r2_key 推导文件所在目录（根返回 ''）。
 * 与后端 extractDirFromR2Key 同口径：剥 `<prefix>/<configId>/` 两段后去掉末段文件名。
 * legacy / 未知前缀 → 根。
 */
export function extractFileDir(r2Key) {
  const parts = String(r2Key ?? '')
    .split('/')
    .filter(Boolean)
  if (parts.length < 3) return ''
  if (!FILE_DIR_KNOWN_PREFIXES.has(parts[0])) return ''
  const rest = parts.slice(2)
  if (rest.length <= 1) return ''
  return rest.slice(0, -1).join('/')
}

/** 当前目录的面包屑：'a/b' → [{label:'a',prefix:'a'},{label:'b',prefix:'a/b'}]。根返回 []。 */
export function buildDirBreadcrumb(dir) {
  const segments = normalizeDir(dir).split('/').filter(Boolean)
  const items = []
  let prefix = ''
  for (const segment of segments) {
    prefix = prefix ? `${prefix}/${segment}` : segment
    items.push({ label: segment, prefix })
  }
  return items
}

/** 父目录路径；根（无父）返回 ''。 */
export function getParentDir(dir) {
  const normalized = normalizeDir(dir)
  if (!normalized) return ''
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash === -1 ? '' : normalized.slice(0, lastSlash)
}

/**
 * 从全部目录列表中取 `dir` 的直接子目录（去重、升序）。
 * 'a' 的子目录 = 恰比 'a' 多一段且前缀为 'a/' 的路径；根（dir='')取顶层单段目录。
 */
export function collectChildDirs(dir, allDirs = []) {
  const parent = normalizeDir(dir)
  const depth = parent ? parent.split('/').length : 0
  const children = new Set()
  for (const raw of allDirs || []) {
    const path = normalizeDir(raw)
    if (!path) continue
    const segments = path.split('/')
    if (segments.length !== depth + 1) continue
    if (parent) {
      if (!path.startsWith(`${parent}/`)) continue
    }
    children.add(path)
  }
  return Array.from(children)
    .sort((a, b) => a.localeCompare(b))
    .map((prefix) => ({ label: prefix.split('/').pop(), prefix }))
}
