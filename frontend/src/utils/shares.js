function normalizeType(type) {
  return String(type ?? '').trim()
}

function normalizeStatus(status) {
  return String(status ?? '').trim()
}

function normalizeText(value) {
  return String(value ?? '').trim()
}

export { normalizeText as normalizeShareText }

function normalizeSearchText(value) {
  return normalizeText(value).toLowerCase()
}

function toIsoStartOfDay(dateValue) {
  const normalized = normalizeText(dateValue)
  if (!normalized) return null

  const local = new Date(`${normalized}T00:00:00`)
  if (Number.isNaN(local.getTime())) return null
  return local.toISOString()
}

function addOneDayIso(isoString) {
  const normalized = normalizeText(isoString)
  if (!normalized) return null

  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() + 1)
  return date.toISOString()
}

function applyDateRangeParams(params, startDateValue, endDateValue, fromKey, toKey) {
  let fromDate = normalizeText(startDateValue)
  let toDate = normalizeText(endDateValue)

  if (!fromDate && !toDate) {
    return
  }

  if (fromDate && toDate && fromDate > toDate) {
    const earlierDate = toDate
    toDate = fromDate
    fromDate = earlierDate
  }

  const fromIso = fromDate ? toIsoStartOfDay(fromDate) : null
  const toBaseIso = toDate ? toIsoStartOfDay(toDate) : null
  const toIso = toBaseIso ? addOneDayIso(toBaseIso) : null

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

  if (toBaseIso && toIso) {
    params[fromKey] = toBaseIso
    params[toKey] = toIso
  }
}

export const DEFAULT_SHARE_SORT_KEY = 'updated_at__desc'
export const EXPIRED_GOVERNANCE_SORT_KEY = 'expires_at__asc'
export const SHARE_FILTERS_STORAGE_KEY = 'flares3:shares:filters'
export const BATCH_DISABLE_SHARE_ACTION_KEY = 'batch_disable'
const DEFAULT_SHARE_FILTERS = Object.freeze({
  q: '',
  type: '',
  status: '',
  sort_key: DEFAULT_SHARE_SORT_KEY,
  expires_from_date: '',
  expires_to_date: '',
  owner_id: '',
})

const ALLOWED_SHARE_SORT_KEYS = new Set([
  DEFAULT_SHARE_SORT_KEY,
  EXPIRED_GOVERNANCE_SORT_KEY,
  'expires_at__desc',
])

function normalizeShareSortKey(sortKey) {
  const normalizedSortKey = normalizeText(sortKey)
  if (!normalizedSortKey) {
    return DEFAULT_SHARE_SORT_KEY
  }
  return ALLOWED_SHARE_SORT_KEYS.has(normalizedSortKey) ? normalizedSortKey : DEFAULT_SHARE_SORT_KEY
}

function normalizeShareFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    return { ...DEFAULT_SHARE_FILTERS }
  }

  return {
    q: normalizeText(filters.q),
    type: normalizeType(filters.type),
    status: normalizeStatus(filters.status),
    sort_key: normalizeShareSortKey(filters.sort_key),
    expires_from_date: normalizeText(filters.expires_from_date),
    expires_to_date: normalizeText(filters.expires_to_date),
    owner_id: normalizeText(filters.owner_id),
  }
}

function applySortParams(params, sortKey) {
  const normalizedSortKey = normalizeText(sortKey)
  if (!normalizedSortKey) {
    return
  }

  const safeSortKey = normalizeShareSortKey(normalizedSortKey)
  const [sortBy, sortOrder] = safeSortKey.split('__')

  if (sortBy) {
    params.sort_by = sortBy
  }

  if (sortOrder) {
    params.sort_order = sortOrder
  }
}

export function toShareTypeLabelKey(type) {
  const normalized = normalizeType(type)
  if (normalized === 'file') return 'shares.types.file'
  if (normalized === 'text') return 'shares.types.text'
  if (normalized === 'text_one_time') return 'shares.types.textOneTime'
  if (normalized === 'folder') return 'shares.types.folder'
  return 'shares.types.unknown'
}

export function toShareStatusLabelKey(status) {
  const normalized = normalizeStatus(status)
  if (normalized === 'active') return 'shares.status.active'
  if (normalized === 'expired') return 'shares.status.expired'
  if (normalized === 'exhausted') return 'shares.status.exhausted'
  if (normalized === 'consumed') return 'shares.status.consumed'
  return 'shares.status.unknown'
}

export function toShareStatusVariant(status) {
  const normalized = normalizeStatus(status)
  if (normalized === 'active') return 'success'
  if (normalized === 'expired') return 'warning'
  if (normalized === 'exhausted') return 'danger'
  if (normalized === 'consumed') return 'info'
  return 'default'
}

export function formatShareVisits(record = {}, t = (key) => key) {
  if (normalizeType(record.type) === 'text_one_time') {
    return '-'
  }

  const views = Number(record.views ?? 0)
  const maxViews = Number(record.max_views ?? 0)
  const safeViews = Number.isFinite(views) && views >= 0 ? views : 0
  const safeMaxViews = Number.isFinite(maxViews) && maxViews > 0 ? maxViews : null

  return `${safeViews}/${safeMaxViews ?? t('shares.visits.unlimited')}`
}

export function hasEditableConfig(record = {}) {
  const type = normalizeType(record.type)
  return type === 'file' || type === 'text'
}

/**
 * 是否可查看访问记录：file / text / folder 三类在服务端落 share_access_logs，
 * text_one_time 不落库（无记录入口）。resource_id 口径与 /api/shares 一致。
 */
export function hasAccessLogConfig(record = {}) {
  const type = normalizeType(record.type)
  const resourceId = normalizeText(record.resource_id)
  return Boolean(resourceId) && (type === 'file' || type === 'text' || type === 'folder')
}

export function canOpenShare(record = {}) {
  return normalizeStatus(record.status) === 'active'
}

export function createDefaultShareFilters() {
  return { ...DEFAULT_SHARE_FILTERS }
}

export function toPersistedShareFilters(filters = {}) {
  return normalizeShareFilters(filters)
}

export function restorePersistedShareFilters(raw) {
  return normalizeShareFilters(raw)
}

export function buildSharesQueryParams(filters = {}, { isAdmin = false } = {}) {
  const params = {}

  const q = normalizeText(filters.q)
  if (q) {
    params.q = q
  }

  const type = normalizeType(filters.type)
  if (type) {
    params.type = type
  }

  const status = normalizeStatus(filters.status)
  if (status) {
    params.status = status
  }

  if (isAdmin) {
    const ownerId = normalizeText(filters.owner_id)
    if (ownerId) {
      params.owner_id = ownerId
    }
  }

  applyDateRangeParams(
    params,
    filters.expires_from_date,
    filters.expires_to_date,
    'expires_from',
    'expires_to'
  )

  applySortParams(params, filters.sort_key)

  return params
}

export function buildExpiredGovernanceFilters(filters = {}) {
  const normalizedFilters = normalizeShareFilters(filters)
  return {
    ...normalizedFilters,
    status: 'expired',
    sort_key: EXPIRED_GOVERNANCE_SORT_KEY,
    expires_from_date: '',
    expires_to_date: '',
  }
}

export function buildExpiringGovernanceFilters(filters = {}) {
  const normalizedFilters = normalizeShareFilters(filters)
  return {
    ...normalizedFilters,
    status: 'active',
    sort_key: EXPIRED_GOVERNANCE_SORT_KEY,
    expires_from_date: '',
    expires_to_date: '',
  }
}

export function hasActiveShareFilters(filters = {}, { isAdmin = false } = {}) {
  const normalizedFilters = normalizeShareFilters(filters)
  const queryActive = Boolean(normalizedFilters.q)
  const ownerActive = isAdmin && Boolean(normalizedFilters.owner_id)
  const expiresRangeActive = Boolean(
    normalizedFilters.expires_from_date || normalizedFilters.expires_to_date
  )

  return Boolean(
    queryActive ||
    normalizedFilters.type ||
    normalizedFilters.status ||
    expiresRangeActive ||
    ownerActive
  )
}

export function isExpiredShareGovernanceActive(filters = {}) {
  const normalizedFilters = normalizeShareFilters(filters)
  return (
    normalizedFilters.status === 'expired' &&
    normalizedFilters.sort_key === EXPIRED_GOVERNANCE_SORT_KEY &&
    !normalizedFilters.expires_from_date &&
    !normalizedFilters.expires_to_date
  )
}

export function isExpiringShareGovernanceActive(filters = {}) {
  const normalizedFilters = normalizeShareFilters(filters)
  return (
    normalizedFilters.status === 'active' &&
    normalizedFilters.sort_key === EXPIRED_GOVERNANCE_SORT_KEY &&
    !normalizedFilters.expires_from_date &&
    !normalizedFilters.expires_to_date
  )
}

export function getShareConfirmMeta(action, record = {}) {
  const resourceName = normalizeText(record.resource_name)
  const typeLabelKey = toShareTypeLabelKey(record.type)
  const count = Number(record.count ?? 0)

  if (action === 'disable') {
    return {
      titleKey: 'shares.confirm.disableTitle',
      messageKey: 'shares.confirm.disableMessage',
      confirmButtonKey: 'shares.actions.disable',
      confirmButtonType: 'danger',
      resourceName,
      typeLabelKey,
    }
  }

  if (action === 'regenerate') {
    return {
      titleKey: 'shares.confirm.regenerateTitle',
      messageKey: 'shares.confirm.regenerateMessage',
      confirmButtonKey: 'shares.actions.regenerate',
      confirmButtonType: 'primary',
      resourceName,
      typeLabelKey,
    }
  }

  if (action === 'batch_disable') {
    return {
      titleKey: 'shares.confirm.batchDisableTitle',
      messageKey: 'shares.confirm.batchDisableMessage',
      confirmButtonKey: 'shares.actions.disableSelected',
      confirmButtonType: 'danger',
      count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
      resourceName: '',
      typeLabelKey: '',
    }
  }

  return null
}

export function toShareSelectionKey(record = {}) {
  const type = normalizeType(record.type)
  const resourceId = normalizeText(record.resource_id)
  if (!type || !resourceId) {
    return ''
  }
  return `${type}:${resourceId}`
}

export function collectSelectedShares(items = [], selectedIds = []) {
  const selectedKeySet = new Set(
    (selectedIds || []).map((value) => normalizeText(value)).filter(Boolean)
  )
  if (!selectedKeySet.size) {
    return []
  }

  return (items || []).filter((item) => {
    const selectionKey = toShareSelectionKey(item)
    if (!selectionKey) {
      return false
    }
    return selectedKeySet.has(selectionKey)
  })
}

export function buildShareSelectedIdSet(selectedIds = []) {
  return new Set((selectedIds || []).map((id) => normalizeText(id)).filter(Boolean))
}

export function updateShareSelection(selectedIds = [], rowId = '', checked = false) {
  const id = normalizeText(rowId)
  if (!id) {
    return selectedIds
  }

  const next = buildShareSelectedIdSet(selectedIds)
  if (checked) {
    next.add(id)
  } else {
    next.delete(id)
  }
  return Array.from(next)
}

export function getBatchDisableFeedbackMeta({ total = 0, successCount = 0, failedCount = 0 } = {}) {
  const safeTotal = Number.isFinite(Number(total)) ? Math.max(0, Number(total)) : 0
  const safeSuccessCount = Number.isFinite(Number(successCount))
    ? Math.max(0, Number(successCount))
    : 0
  const safeFailedCount = Number.isFinite(Number(failedCount))
    ? Math.max(0, Number(failedCount))
    : 0

  if (safeSuccessCount > 0 && safeFailedCount === 0) {
    return {
      messageKey: 'shares.messages.batchDisableSuccess',
      params: { count: safeSuccessCount },
    }
  }

  if (safeSuccessCount > 0 && safeFailedCount > 0) {
    return {
      messageKey: 'shares.messages.batchDisablePartial',
      params: {
        successCount: safeSuccessCount,
        failedCount: safeFailedCount,
        total: safeTotal,
      },
    }
  }

  return {
    messageKey: 'shares.messages.batchDisableFailed',
    params: { count: safeFailedCount || safeTotal },
  }
}

export function filterShareOwners(owners = [], query = '', selectedOwnerId = '') {
  const normalizedQuery = normalizeSearchText(query)
  const normalizedSelectedOwnerId = normalizeText(selectedOwnerId)

  if (!normalizedQuery) {
    return owners
  }

  const matches = owners.filter((owner) => {
    const ownerId = normalizeText(owner?.id)
    const username = normalizeText(owner?.username)
    return (
      normalizeSearchText(ownerId).includes(normalizedQuery) ||
      normalizeSearchText(username).includes(normalizedQuery)
    )
  })

  if (!normalizedSelectedOwnerId) {
    return matches
  }

  const selectedOwner = owners.find(
    (owner) => normalizeText(owner?.id) === normalizedSelectedOwnerId
  )
  if (!selectedOwner) {
    return matches
  }

  const alreadyIncluded = matches.some(
    (owner) => normalizeText(owner?.id) === normalizeText(selectedOwner?.id)
  )
  if (alreadyIncluded) {
    return matches
  }

  return [selectedOwner, ...matches]
}

export function buildAbsoluteShareUrl(path, origin) {
  const normalizedPath = normalizeText(path)
  if (!normalizedPath) return ''

  const baseOrigin =
    origin ?? (typeof window !== 'undefined' ? normalizeText(window.location?.origin) : '')
  if (!baseOrigin) return normalizedPath
  return `${baseOrigin}${normalizedPath}`
}

export function formatShareDateTime(isoString, locale) {
  const value = normalizeText(isoString)
  if (!value) return '-'

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString(locale || undefined)
}

export function getSharePasswordText(record = {}, t = (key) => key) {
  if (normalizeType(record?.type) === 'text_one_time') {
    return '-'
  }
  return record?.has_password ? t('shares.password.set') : t('shares.password.unset')
}

export function getShareActionKey(action, record = {}) {
  const actionName = String(action ?? '')
  if (actionName === BATCH_DISABLE_SHARE_ACTION_KEY) {
    return BATCH_DISABLE_SHARE_ACTION_KEY
  }
  return `${actionName}:${normalizeType(record?.type)}:${normalizeText(record?.resource_id)}`
}

export function isShareActionLoading(activeAction, action, record = {}) {
  return normalizeText(activeAction) === getShareActionKey(action, record)
}

function getBrowserLocalStorage() {
  if (typeof window === 'undefined') {
    return null
  }
  return window.localStorage || null
}

export function restoreShareFiltersFromStorage(
  storage = getBrowserLocalStorage(),
  key = SHARE_FILTERS_STORAGE_KEY
) {
  const fallback = createDefaultShareFilters()
  if (!storage || typeof storage.getItem !== 'function') {
    return fallback
  }

  const stored = storage.getItem(key)
  if (!stored) {
    return fallback
  }

  try {
    return restorePersistedShareFilters(JSON.parse(stored))
  } catch (_error) {
    if (typeof storage.removeItem === 'function') {
      storage.removeItem(key)
    }
    return fallback
  }
}

export function persistShareFiltersToStorage(
  value,
  storage = getBrowserLocalStorage(),
  key = SHARE_FILTERS_STORAGE_KEY
) {
  if (!storage || typeof storage.setItem !== 'function') {
    return
  }

  storage.setItem(key, JSON.stringify(toPersistedShareFilters(value)))
}
