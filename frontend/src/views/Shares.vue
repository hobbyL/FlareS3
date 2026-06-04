<template>
  <AppLayout>
    <div class="shares-page">
      <header class="shares-header">
        <div class="shares-title-group">
          <h1 class="shares-title">{{ t('shares.title') }}</h1>
          <p class="shares-subtitle">{{ t('shares.subtitle') }}</p>
        </div>

        <div class="shares-actions">
          <div class="filter-row" :class="{ 'has-owner-filter': authStore.isAdmin }">
            <div class="filter-item query">
              <Input
                v-model="filters.q"
                :placeholder="t('shares.filters.q')"
                size="small"
                clearable
                @keyup.enter="handleSearch"
              />
            </div>

            <div class="filter-item type">
              <Select v-model="filters.type" :options="typeOptions" size="small" />
            </div>

            <div class="filter-item status">
              <Select v-model="filters.status" :options="statusOptions" size="small" />
            </div>

            <div class="filter-item sort">
              <Select v-model="filters.sort_key" :options="sortOptions" size="small" />
            </div>

            <div class="filter-item expires-range">
              <DateRangePicker
                v-model:startValue="filters.expires_from_date"
                v-model:endValue="filters.expires_to_date"
                :placeholder="t('shares.filters.expiresAt')"
                size="small"
                clearable
              />
            </div>

            <div v-if="authStore.isAdmin" class="filter-item owner">
              <Input
                v-model="ownerSearchQuery"
                :placeholder="t('shares.filters.ownerSearch')"
                size="small"
                clearable
                :disabled="ownersLoading"
              />
            </div>

            <div v-if="authStore.isAdmin" class="filter-item owner-select">
              <Select
                v-model="filters.owner_id"
                :options="ownerOptions"
                size="small"
                :disabled="ownersLoading"
              />
            </div>

            <Button
              type="default"
              size="small"
              class="shares-search-btn"
              :loading="loading && activeAction === 'search'"
              :disabled="loading || batchDisableSubmitting"
              @click="handleSearch"
            >
              <Search :size="16" style="margin-right: 6px" />
              {{ t('common.search') }}
            </Button>

            <Button
              type="default"
              size="small"
              class="shares-refresh-btn"
              :loading="loading && activeAction === 'refresh'"
              :disabled="loading || batchDisableSubmitting"
              @click="handleRefresh"
            >
              <RefreshCw :size="16" style="margin-right: 6px" />
              {{ t('common.refresh') }}
            </Button>

            <Button
              type="ghost"
              size="small"
              class="shares-quick-btn shares-expired-btn"
              :class="{ 'is-active': expiredGovernanceActive }"
              :loading="loading && activeAction === 'focus-expired'"
              :disabled="loading || batchDisableSubmitting"
              @click="handleFocusExpired"
            >
              {{ t('shares.actions.focusExpired') }}
            </Button>

            <Button
              type="ghost"
              size="small"
              class="shares-quick-btn shares-expiring-btn"
              :class="{ 'is-active': expiringGovernanceActive }"
              :loading="loading && activeAction === 'focus-expiring'"
              :disabled="loading || batchDisableSubmitting"
              @click="handleFocusExpiring"
            >
              {{ t('shares.actions.focusExpiring') }}
            </Button>

            <Button
              type="danger"
              size="small"
              class="shares-batch-disable-btn"
              :loading="batchDisableSubmitting"
              :disabled="loading || batchDisableSubmitting || selectedSharesCount === 0"
              @click="handleBatchDisable"
            >
              <Trash2 :size="16" style="margin-right: 6px" />
              {{ t('shares.actions.disableSelected', { count: selectedSharesCount }) }}
            </Button>
          </div>
        </div>
      </header>

      <section class="shares-content">
        <PageSkeleton
          v-if="initialPageLoading"
          :variant="isMobile ? 'cards' : 'table'"
          :columns="columns.length"
          :cards="6"
        />

        <template v-else>
          <Card v-if="!isMobile" class="shares-table-card">
            <Table
              v-if="loading || items.length"
              class="shares-table"
              :columns="columns"
              :data="items"
              :loading="loading"
            />

            <div v-else class="shares-state">
              {{ emptyStateText }}
            </div>

            <Pagination
              v-if="pagination.itemCount > 0"
              :page="pagination.page"
              :page-size="pagination.pageSize"
              :total="pagination.itemCount"
              @update:page="changePage"
              @update:page-size="changePageSize"
            />
          </Card>

          <Card v-else class="shares-table-card">
            <SharesCardView
              :shares="items"
              :selected-ids="selectedIds"
              :loading="loading || Boolean(activeAction)"
              :initial-loading="initialPageLoading"
              :is-admin="authStore.isAdmin"
              :empty-state-text="emptyStateText"
              @copy-link="copyShareLink"
              @open-link="openShareLink"
              @edit="openEditShare"
              @disable="openConfirmAction('disable', $event)"
              @regenerate="openConfirmAction('regenerate', $event)"
              @toggle-select="toggleRowSelection"
            />

            <Pagination
              v-if="pagination.itemCount > 0"
              :page="pagination.page"
              :page-size="pagination.pageSize"
              :total="pagination.itemCount"
              @update:page="changePage"
              @update:page-size="changePageSize"
            />
          </Card>
        </template>
      </section>

      <FileShareModal
        :show="fileShareModalVisible"
        :file-id="activeFileId"
        :filename="activeResourceName"
        @update:show="handleFileShareModalUpdate"
      />

      <TextShareModal
        :show="textShareModalVisible"
        :text-id="activeTextId"
        :text-title="activeResourceName"
        @update:show="handleTextShareModalUpdate"
      />

      <Modal
        :show="showConfirmModal"
        :title="confirmTitle"
        width="420px"
        @update:show="handleConfirmModalUpdate"
      >
        <p class="shares-confirm-text">
          {{ confirmMessage }}
        </p>

        <template #footer>
          <Button type="default" :disabled="confirmSubmitting" @click="handleConfirmCancel">
            {{ t('common.cancel') }}
          </Button>
          <Button
            :type="confirmButtonType"
            :loading="confirmSubmitting"
            :disabled="!confirmMeta"
            @click="handleConfirmSubmit"
          >
            {{ confirmButtonLabel }}
          </Button>
        </template>
      </Modal>
    </div>
  </AppLayout>
</template>

<script setup>
import { computed, h, onMounted, ref, watch } from 'vue'
import { Copy, ExternalLink, Pencil, RefreshCw, Search, Trash2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import api from '../services/api'
import AppLayout from '../components/layout/AppLayout.vue'
import Card from '../components/ui/card/Card.vue'
import Button from '../components/ui/button/Button.vue'
import PageSkeleton from '../components/ui/skeleton/PageSkeleton.vue'
import DateRangePicker from '../components/ui/date-range-picker/DateRangePicker.vue'
import Input from '../components/ui/input/Input.vue'
import Modal from '../components/ui/modal/Modal.vue'
import Table from '../components/ui/table/Table.vue'
import Select from '../components/ui/select/Select.vue'
import Pagination from '../components/ui/pagination/Pagination.vue'
import Tag from '../components/ui/tag/Tag.vue'
import Tooltip from '../components/ui/tooltip/Tooltip.vue'
import TableCellText from '../components/ui/table/TableCellText.vue'
import FileShareModal from '../components/files/FileShareModal.vue'
import SharesCardView from '../components/shares/SharesCardView.vue'
import TextShareModal from '../components/texts/TextShareModal.vue'
import { useMessage } from '../composables/useMessage'
import { useIsMobile } from '../composables/useViewport.js'
import {
  createDefaultShareFilters,
  DEFAULT_SHARE_SORT_KEY,
  EXPIRED_GOVERNANCE_SORT_KEY,
  buildExpiredGovernanceFilters,
  buildExpiringGovernanceFilters,
  buildSharesQueryParams,
  canOpenShare,
  collectSelectedShares,
  filterShareOwners,
  formatShareVisits,
  getBatchDisableFeedbackMeta,
  getShareConfirmMeta,
  hasEditableConfig,
  restorePersistedShareFilters,
  toShareSelectionKey,
  toPersistedShareFilters,
  toShareStatusLabelKey,
  toShareStatusVariant,
  toShareTypeLabelKey,
} from '../utils/shares.js'

const { t, locale } = useI18n({ useScope: 'global' })
const authStore = useAuthStore()
const message = useMessage()

const items = ref([])
const loading = ref(false)
const loadFailed = ref(false)
const hasLoadedOnce = ref(false)
const pagination = ref({ page: 1, pageSize: 20, itemCount: 0 })
const activeAction = ref('')
const shareFiltersStorageKey = 'flares3:shares:filters'

const filters = ref(createDefaultShareFilters())
const isMobile = useIsMobile()

const ownersLoading = ref(false)
const owners = ref([])
const ownerSearchQuery = ref('')
const selectedIds = ref([])

const activeRecord = ref(null)
const fileShareModalVisible = ref(false)
const textShareModalVisible = ref(false)
const pendingConfirmAction = ref(null)
const batchDisableActionKey = 'batch_disable'

const activeFileId = computed(() =>
  activeRecord.value?.type === 'file' ? normalizeText(activeRecord.value?.resource_id) : ''
)
const activeTextId = computed(() =>
  activeRecord.value?.type === 'text' ? normalizeText(activeRecord.value?.resource_id) : ''
)
const activeResourceName = computed(() => normalizeText(activeRecord.value?.resource_name))

const typeOptions = computed(() => [
  { label: t('shares.filters.allTypes'), value: '' },
  { label: t('shares.types.file'), value: 'file' },
  { label: t('shares.types.text'), value: 'text' },
  { label: t('shares.types.textOneTime'), value: 'text_one_time' },
])

const statusOptions = computed(() => [
  { label: t('shares.filters.allStatuses'), value: '' },
  { label: t('shares.status.active'), value: 'active' },
  { label: t('shares.status.expired'), value: 'expired' },
  { label: t('shares.status.exhausted'), value: 'exhausted' },
  { label: t('shares.status.consumed'), value: 'consumed' },
])

const sortOptions = computed(() => [
  { label: t('shares.filters.sortUpdatedDesc'), value: 'updated_at__desc' },
  { label: t('shares.filters.sortExpiresAsc'), value: 'expires_at__asc' },
  { label: t('shares.filters.sortExpiresDesc'), value: 'expires_at__desc' },
])

const ownerOptions = computed(() => [
  { label: t('shares.filters.allOwners'), value: '' },
  ...filterShareOwners(owners.value, ownerSearchQuery.value, filters.value.owner_id).map(
    (user) => ({
      label: String(user.username ?? ''),
      value: String(user.id ?? ''),
    })
  ),
])

const hasActiveFilters = computed(() => {
  const queryActive = Boolean(normalizeText(filters.value.q))
  const ownerActive = authStore.isAdmin && Boolean(normalizeText(filters.value.owner_id))
  const expiresRangeActive = Boolean(
    normalizeText(filters.value.expires_from_date) || normalizeText(filters.value.expires_to_date)
  )
  return Boolean(
    queryActive ||
    normalizeText(filters.value.type) ||
    normalizeText(filters.value.status) ||
    expiresRangeActive ||
    ownerActive
  )
})

const expiredGovernanceActive = computed(() => {
  return (
    normalizeText(filters.value.status) === 'expired' &&
    normalizeText(filters.value.sort_key || DEFAULT_SHARE_SORT_KEY) ===
      EXPIRED_GOVERNANCE_SORT_KEY &&
    !normalizeText(filters.value.expires_from_date) &&
    !normalizeText(filters.value.expires_to_date)
  )
})

const expiringGovernanceActive = computed(() => {
  return (
    normalizeText(filters.value.status) === 'active' &&
    normalizeText(filters.value.sort_key || DEFAULT_SHARE_SORT_KEY) ===
      EXPIRED_GOVERNANCE_SORT_KEY &&
    !normalizeText(filters.value.expires_from_date) &&
    !normalizeText(filters.value.expires_to_date)
  )
})

const emptyStateText = computed(() => {
  if (loadFailed.value) return t('shares.state.loadFailed')
  if (hasActiveFilters.value) return t('shares.state.filteredEmpty')
  return t('shares.state.empty')
})
const initialPageLoading = computed(
  () => !hasLoadedOnce.value && (loading.value || ownersLoading.value)
)
const pageRowIds = computed(() =>
  items.value.map((item) => toShareSelectionKey(item)).filter(Boolean)
)
const selectedIdSet = computed(
  () => new Set(selectedIds.value.map((id) => normalizeText(id)).filter(Boolean))
)
const selectedShares = computed(() => collectSelectedShares(items.value, selectedIds.value))
const selectedSharesCount = computed(() => selectedShares.value.length)
const allRowsSelected = computed(() => {
  const ids = pageRowIds.value
  if (!ids.length) return false
  const set = selectedIdSet.value
  return ids.every((id) => set.has(id))
})
const someRowsSelected = computed(() => {
  const ids = pageRowIds.value
  if (!ids.length) return false
  const set = selectedIdSet.value
  return ids.some((id) => set.has(id))
})
const selectAllIndeterminate = computed(() => someRowsSelected.value && !allRowsSelected.value)
const batchDisableSubmitting = computed(() => activeAction.value === batchDisableActionKey)

const confirmMeta = computed(() =>
  getShareConfirmMeta(pendingConfirmAction.value?.kind, pendingConfirmAction.value?.record)
)
const showConfirmModal = computed(() => Boolean(confirmMeta.value))
const confirmSubmitting = computed(() => {
  const action = pendingConfirmAction.value
  if (!action) return false
  return activeAction.value === getActionKey(action.kind, action.record)
})
const confirmTitle = computed(() => {
  if (!confirmMeta.value) return ''
  return t(confirmMeta.value.titleKey)
})
const confirmMessage = computed(() => {
  if (!confirmMeta.value) return ''
  const typeLabel = confirmMeta.value.typeLabelKey ? t(confirmMeta.value.typeLabelKey) : ''
  return t(confirmMeta.value.messageKey, {
    type: typeLabel,
    name: confirmMeta.value.resourceName || '-',
    count: confirmMeta.value.count || 0,
  })
})
const confirmButtonLabel = computed(() => {
  if (!confirmMeta.value) return ''
  return t(confirmMeta.value.confirmButtonKey)
})
const confirmButtonType = computed(() => confirmMeta.value?.confirmButtonType || 'default')

function normalizeText(value) {
  return String(value ?? '').trim()
}

function buildAbsoluteUrl(path) {
  const normalizedPath = normalizeText(path)
  if (!normalizedPath) return ''
  if (typeof window === 'undefined') return normalizedPath
  return `${window.location.origin}${normalizedPath}`
}

function formatDateTime(isoString) {
  const value = normalizeText(isoString)
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString(locale.value)
}

function getPasswordText(record) {
  if (normalizeText(record?.type) === 'text_one_time') {
    return '-'
  }
  return record?.has_password ? t('shares.password.set') : t('shares.password.unset')
}

function getActionKey(action, record) {
  if (action === batchDisableActionKey) {
    return batchDisableActionKey
  }
  return `${action}:${normalizeText(record?.type)}:${normalizeText(record?.resource_id)}`
}

function isActionLoading(action, record) {
  return activeAction.value === getActionKey(action, record)
}

function buildQueryParams() {
  return buildSharesQueryParams(filters.value, { isAdmin: authStore.isAdmin })
}

function restoreFiltersFromStorage() {
  const fallback = createDefaultShareFilters()
  if (typeof window === 'undefined') {
    return fallback
  }

  const stored = window.localStorage.getItem(shareFiltersStorageKey)
  if (!stored) {
    return fallback
  }

  try {
    return restorePersistedShareFilters(JSON.parse(stored))
  } catch (_error) {
    window.localStorage.removeItem(shareFiltersStorageKey)
    return fallback
  }
}

function persistFiltersToStorage(value) {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(
    shareFiltersStorageKey,
    JSON.stringify(toPersistedShareFilters(value))
  )
}

async function copyTextValue(value) {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    throw new Error('Clipboard API is not available')
  }
  await clipboard.writeText(value)
}

async function copyShareLink(record) {
  const url = buildAbsoluteUrl(record?.share_url)
  if (!url) return

  try {
    await copyTextValue(url)
    message.success(t('common.copied'))
  } catch (_error) {
    message.error(t('shares.messages.copyFailed'))
  }
}

function openShareLink(record) {
  if (!canOpenShare(record)) return
  const url = buildAbsoluteUrl(record?.share_url)
  if (!url || typeof window === 'undefined') return
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function loadOwnerOptions() {
  if (!authStore.isAdmin || owners.value.length) return

  ownersLoading.value = true
  try {
    const result = await api.getUsers({ page: 1, limit: 100 })
    owners.value = (result.users || []).filter((user) => user.status !== 'deleted')
  } catch (_error) {
    message.error(t('shares.messages.loadOwnersFailed'))
  } finally {
    ownersLoading.value = false
  }
}

async function loadShares() {
  clearSelection()
  loading.value = true
  loadFailed.value = false

  try {
    const result = await api.listShares({
      page: pagination.value.page,
      limit: pagination.value.pageSize,
      ...buildQueryParams(),
    })

    const total = Number(result.total || 0)
    const maxPage = Math.max(1, Math.ceil(total / pagination.value.pageSize))
    if (total > 0 && pagination.value.page > maxPage) {
      pagination.value.page = maxPage
      await loadShares()
      return
    }

    items.value = result.items || []
    pagination.value.itemCount = total
    hasLoadedOnce.value = true
  } catch (error) {
    loadFailed.value = true
    items.value = []
    pagination.value.itemCount = 0
    message.error(error.response?.data?.error || t('shares.messages.loadFailed'))
  } finally {
    loading.value = false
    activeAction.value = ''
  }
}

function handleSearch() {
  if (loading.value || batchDisableSubmitting.value) return
  activeAction.value = 'search'
  pagination.value.page = 1
  loadShares()
}

function handleRefresh() {
  if (loading.value || batchDisableSubmitting.value) return
  activeAction.value = 'refresh'
  loadShares()
}

function handleFocusExpired() {
  if (loading.value || batchDisableSubmitting.value) return
  filters.value = buildExpiredGovernanceFilters(filters.value)
  activeAction.value = 'focus-expired'
  pagination.value.page = 1
  loadShares()
}

function handleFocusExpiring() {
  if (loading.value || batchDisableSubmitting.value) return
  filters.value = buildExpiringGovernanceFilters(filters.value)
  activeAction.value = 'focus-expiring'
  pagination.value.page = 1
  loadShares()
}

function changePage(page) {
  if (batchDisableSubmitting.value) return
  pagination.value.page = page
  loadShares()
}

function changePageSize(pageSize) {
  if (batchDisableSubmitting.value) return
  const nextSize = Number(pageSize)
  if (!Number.isFinite(nextSize) || nextSize <= 0) return
  pagination.value.pageSize = nextSize
  pagination.value.page = 1
  loadShares()
}

function openEditShare(record) {
  if (!hasEditableConfig(record)) return

  activeRecord.value = record
  if (record.type === 'file') {
    fileShareModalVisible.value = true
    return
  }

  textShareModalVisible.value = true
}

async function refreshAfterModalClose() {
  const hadActiveRecord = Boolean(activeRecord.value)
  activeRecord.value = null
  if (!hadActiveRecord) return
  await loadShares()
}

async function handleFileShareModalUpdate(value) {
  fileShareModalVisible.value = value
  if (!value) {
    await refreshAfterModalClose()
  }
}

async function handleTextShareModalUpdate(value) {
  textShareModalVisible.value = value
  if (!value) {
    await refreshAfterModalClose()
  }
}

function openConfirmAction(kind, record) {
  if (!record || loading.value || batchDisableSubmitting.value) return
  pendingConfirmAction.value = { kind, record }
}

function closeConfirmModal() {
  pendingConfirmAction.value = null
}

function clearSelection() {
  selectedIds.value = []
}

function toggleSelectAll(checked) {
  if (checked) {
    selectedIds.value = [...pageRowIds.value]
    return
  }
  clearSelection()
}

function toggleRowSelection(rowId, checked) {
  const id = normalizeText(rowId)
  if (!id) return

  const next = new Set(selectedIds.value.map((value) => normalizeText(value)).filter(Boolean))
  if (checked) {
    next.add(id)
  } else {
    next.delete(id)
  }
  selectedIds.value = Array.from(next)
}

function handleBatchDisable() {
  if (loading.value || batchDisableSubmitting.value || selectedSharesCount.value === 0) return
  openConfirmAction(batchDisableActionKey, { count: selectedSharesCount.value })
}

function handleConfirmModalUpdate(value) {
  if (confirmSubmitting.value) return
  if (!value) {
    closeConfirmModal()
  }
}

function handleConfirmCancel() {
  if (confirmSubmitting.value) return
  closeConfirmModal()
}

async function performDisableShare(record) {
  const resourceId = normalizeText(record?.resource_id)
  if (!resourceId) return

  activeAction.value = getActionKey('disable', record)
  try {
    await requestDisableShare(record)

    message.success(t('shares.messages.deleteSuccess'))
    closeConfirmModal()
    await loadShares()
  } catch (error) {
    activeAction.value = ''
    message.error(error.response?.data?.error || t('shares.messages.deleteFailed'))
  }
}

async function requestDisableShare(record) {
  const resourceId = normalizeText(record?.resource_id)
  if (!resourceId) {
    throw new Error('resource_id is required')
  }

  if (record?.type === 'file') {
    await api.deleteFileShare(resourceId)
    return
  }

  if (record?.type === 'text') {
    await api.deleteTextShare(resourceId)
    return
  }

  if (record?.type === 'text_one_time') {
    await api.deleteTextOneTimeShare(resourceId)
    return
  }

  throw new Error('unsupported share type')
}

async function performRegenerateOneTimeShare(record) {
  const resourceId = normalizeText(record?.resource_id)
  if (!resourceId) return

  activeAction.value = getActionKey('regenerate', record)
  try {
    const result = await api.createTextOneTimeShare(resourceId)
    const shareCode = normalizeText(result?.share?.share_code)
    const nextUrl = shareCode ? buildAbsoluteUrl(`/s/${shareCode}`) : ''

    let copied = false
    if (nextUrl) {
      try {
        await copyTextValue(nextUrl)
        copied = true
      } catch (_error) {
        copied = false
      }
    }

    message.success(
      copied ? t('shares.messages.regenerateCopied') : t('shares.messages.regenerateSuccess')
    )
    closeConfirmModal()
    await loadShares()
  } catch (error) {
    activeAction.value = ''
    message.error(error.response?.data?.error || t('shares.messages.regenerateFailed'))
  }
}

async function performBatchDisableShares() {
  const records = selectedShares.value
  if (!records.length) {
    clearSelection()
    closeConfirmModal()
    return
  }

  activeAction.value = batchDisableActionKey

  const results = await Promise.allSettled(records.map((record) => requestDisableShare(record)))
  const successCount = results.filter((result) => result.status === 'fulfilled').length
  const failedCount = results.length - successCount
  const feedbackMeta = getBatchDisableFeedbackMeta({
    total: results.length,
    successCount,
    failedCount,
  })

  if (successCount > 0 && failedCount === 0) {
    message.success(t(feedbackMeta.messageKey, feedbackMeta.params))
  } else if (successCount > 0) {
    message.warning(t(feedbackMeta.messageKey, feedbackMeta.params))
  } else {
    message.error(t(feedbackMeta.messageKey, feedbackMeta.params))
  }

  closeConfirmModal()
  clearSelection()
  await loadShares()
}

async function handleConfirmSubmit() {
  if (confirmSubmitting.value) return

  const action = pendingConfirmAction.value
  if (!action) return

  if (action.kind === 'disable') {
    await performDisableShare(action.record)
    return
  }

  if (action.kind === batchDisableActionKey) {
    await performBatchDisableShares()
    return
  }

  if (action.kind === 'regenerate') {
    await performRegenerateOneTimeShare(action.record)
  }
}

const columns = computed(() => {
  const base = [
    {
      title: '',
      key: 'select',
      width: 48,
      align: 'center',
      ellipsis: false,
      titleRender: () =>
        h('input', {
          class: 'shares-checkbox',
          type: 'checkbox',
          disabled: loading.value || batchDisableSubmitting.value || pageRowIds.value.length === 0,
          checked: allRowsSelected.value,
          indeterminate: selectAllIndeterminate.value,
          onChange: (event) => toggleSelectAll(Boolean(event?.target?.checked)),
        }),
      render: (row) => {
        const id = toShareSelectionKey(row)
        return h('input', {
          class: 'shares-checkbox',
          type: 'checkbox',
          disabled: loading.value || batchDisableSubmitting.value || !id,
          checked: selectedIdSet.value.has(id),
          onChange: (event) => toggleRowSelection(id, Boolean(event?.target?.checked)),
        })
      },
    },
    {
      title: t('shares.columns.type'),
      key: 'type',
      width: 140,
      align: 'center',
      ellipsis: false,
      render: (row) =>
        h(Tag, { type: 'info', size: 'small' }, () => t(toShareTypeLabelKey(row?.type))),
    },
    {
      title: t('shares.columns.name'),
      key: 'name',
      width: 180,
      ellipsis: true,
      render: (row) => h(TableCellText, { value: normalizeText(row?.resource_name) }),
    },
    {
      title: t('shares.columns.link'),
      key: 'link',
      width: 220,
      align: 'center',
      ellipsis: false,
      render: (row) => {
        const shareUrl = normalizeText(row?.share_url) || '-'
        return h('div', { class: 'share-link-cell' }, [
          h('div', { class: 'share-link-text' }, [
            h(Tooltip, { content: shareUrl === '-' ? '' : shareUrl }, () =>
              h('span', { class: 'share-link-path' }, shareUrl)
            ),
          ]),
          h('div', { class: 'share-link-buttons' }, [
            h(
              Tooltip,
              { content: t('shares.actions.copyLink'), disabled: !normalizeText(row?.share_url) },
              () =>
                h(
                  Button,
                  {
                    class: 'share-link-icon-button',
                    size: 'small',
                    type: 'default',
                    'aria-label': t('shares.actions.copyLink'),
                    disabled: !normalizeText(row?.share_url) || loading.value,
                    onClick: () => copyShareLink(row),
                  },
                  () => h(Copy, { size: 16 })
                )
            ),
            h(
              Tooltip,
              {
                content: t('shares.actions.openLink'),
                disabled: !normalizeText(row?.share_url) || !canOpenShare(row),
              },
              () =>
                h(
                  Button,
                  {
                    class: 'share-link-icon-button',
                    size: 'small',
                    type: 'default',
                    'aria-label': t('shares.actions.openLink'),
                    disabled: !normalizeText(row?.share_url) || !canOpenShare(row) || loading.value,
                    onClick: () => openShareLink(row),
                  },
                  () => h(ExternalLink, { size: 16 })
                )
            ),
          ]),
        ])
      },
    },
    {
      title: t('shares.columns.status'),
      key: 'status',
      width: 110,
      align: 'center',
      ellipsis: false,
      render: (row) =>
        h(Tag, { type: toShareStatusVariant(row?.status), size: 'small' }, () =>
          t(toShareStatusLabelKey(row?.status))
        ),
    },
    {
      title: t('shares.columns.visits'),
      key: 'visits',
      width: 110,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: formatShareVisits(row, t) }),
    },
    {
      title: t('shares.columns.expiresAt'),
      key: 'expiresAt',
      width: 180,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: formatDateTime(row?.expires_at) }),
    },
    {
      title: t('shares.columns.password'),
      key: 'password',
      width: 90,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: getPasswordText(row) }),
    },
    {
      title: t('shares.columns.updatedAt'),
      key: 'updatedAt',
      width: 180,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: formatDateTime(row?.updated_at) }),
    },
    {
      title: t('shares.columns.actions'),
      key: 'actions',
      width: 220,
      align: 'center',
      ellipsis: false,
      render: (row) => {
        const buttons = []

        if (hasEditableConfig(row)) {
          buttons.push(
            h(
              Button,
              {
                size: 'small',
                type: 'default',
                disabled: loading.value || batchDisableSubmitting.value,
                onClick: () => openEditShare(row),
              },
              () => [h(Pencil, { size: 16, style: 'margin-right: 4px' }), t('shares.actions.edit')]
            )
          )
        } else {
          buttons.push(
            h(
              Button,
              {
                size: 'small',
                type: 'default',
                loading: isActionLoading('regenerate', row),
                disabled:
                  loading.value || batchDisableSubmitting.value || isActionLoading('disable', row),
                onClick: () => openConfirmAction('regenerate', row),
              },
              () => [
                h(RefreshCw, { size: 16, style: 'margin-right: 4px' }),
                t('shares.actions.regenerate'),
              ]
            )
          )
        }

        buttons.push(
          h(
            Button,
            {
              size: 'small',
              type: 'danger',
              loading: isActionLoading('disable', row),
              disabled:
                loading.value || batchDisableSubmitting.value || isActionLoading('regenerate', row),
              onClick: () => openConfirmAction('disable', row),
            },
            () => [h(Trash2, { size: 16, style: 'margin-right: 4px' }), t('shares.actions.disable')]
          )
        )

        return h('div', { class: 'action-buttons' }, buttons)
      },
    },
  ]

  if (authStore.isAdmin) {
    base.splice(8, 0, {
      title: t('shares.columns.owner'),
      key: 'owner',
      width: 140,
      align: 'center',
      ellipsis: true,
      render: (row) =>
        h(TableCellText, {
          value: normalizeText(row?.owner_username) || normalizeText(row?.owner_id),
        }),
    })
  }

  return base
})

onMounted(async () => {
  filters.value = restoreFiltersFromStorage()
  await Promise.all([authStore.isAdmin ? loadOwnerOptions() : Promise.resolve(), loadShares()])
})

watch(
  filters,
  (value) => {
    persistFiltersToStorage(value)
  },
  { deep: true }
)
</script>

<style scoped>
.shares-page {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.shares-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--nb-space-lg);
}

.shares-title-group {
  min-width: 0;
}

.shares-title {
  margin: 0;
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-weight: var(--nb-heading-font-weight, 900);
  font-size: var(--nb-font-size-2xl);
  line-height: 1.2;
}

.shares-subtitle {
  margin: var(--nb-space-sm) 0 0;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: var(--nb-font-size-sm);
}

.shares-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--nb-space-sm);
  flex-wrap: wrap;
}

.filter-row {
  display: flex;
  gap: var(--nb-space-sm);
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.filter-item.type {
  width: 150px;
}

.filter-item.query {
  width: 220px;
}

.filter-item.status {
  width: 120px;
}

.filter-item.sort {
  width: 160px;
}

.filter-item.expires-range {
  width: 240px;
}

.filter-item.owner {
  width: 180px;
}

.filter-item.owner-select {
  width: 160px;
}

.shares-quick-btn.is-active {
  background: var(--nb-secondary);
  border-color: var(--nb-border-color);
}

:root[data-ui-theme='shadcn'] .shares-quick-btn.is-active {
  background: var(--accent);
}

.shares-content {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.shares-state {
  padding: var(--nb-space-xl);
  text-align: center;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

:deep(.shares-table .brutal-table),
:deep(.shares-table .shadcn-table) {
  table-layout: fixed;
}

:deep(.shares-table .brutal-table th),
:deep(.shares-table .brutal-table td),
:deep(.shares-table .shadcn-table th),
:deep(.shares-table .shadcn-table td) {
  white-space: nowrap;
}

:deep(.shares-checkbox) {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--nb-primary);
}

:deep(.share-link-cell) {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}

:deep(.share-link-text) {
  flex: 0 1 auto;
  min-width: 0;
  max-width: calc(100% - 88px);
}

:deep(.share-link-path) {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--nb-muted-foreground, var(--nb-gray-600));
  font-family: var(--nb-font-mono);
  font-size: 12px;
  white-space: nowrap;
}

:deep(.share-link-buttons),
:deep(.action-buttons) {
  display: flex;
  gap: 8px;
  justify-content: center;
  align-items: center;
  flex-wrap: nowrap;
}

:deep(.share-link-buttons) {
  flex-shrink: 0;
}

:deep(.share-link-icon-button) {
  min-width: 36px;
  padding: 0 8px;
}

.shares-confirm-text {
  margin: 0;
  line-height: 1.6;
  color: var(--nb-foreground, inherit);
  word-break: break-word;
}

@media (max-width: 768px) {
  .shares-page {
    overflow-x: hidden;
    overflow-x: clip;
  }

  .shares-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .shares-title-group,
  .shares-subtitle,
  .shares-actions,
  .shares-content,
  .shares-header,
  .filter-row {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .shares-actions {
    justify-content: flex-start;
    align-items: stretch;
  }

  .filter-row {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    grid-auto-flow: row;
    justify-content: flex-start;
    align-items: stretch;
    gap: var(--nb-space-sm);
  }

  .filter-item.query,
  .filter-item.owner,
  .filter-item.type,
  .filter-item.status,
  .filter-item.owner-select,
  .filter-item.sort,
  .filter-item.expires-range,
  .shares-search-btn,
  .shares-refresh-btn,
  .shares-expired-btn,
  .shares-expiring-btn,
  .shares-batch-disable-btn {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .filter-item.query {
    grid-column: 1 / span 2;
    grid-row: 1;
  }

  .filter-item.owner {
    grid-column: 3 / span 2;
    grid-row: 1;
  }

  .filter-row:not(.has-owner-filter) .filter-item.query {
    grid-column: 1 / -1;
  }

  .filter-item.type {
    grid-column: 1;
    grid-row: 2;
  }

  .filter-item.status {
    grid-column: 2;
    grid-row: 2;
  }

  .filter-item.owner-select {
    grid-column: 3;
    grid-row: 2;
  }

  .filter-item.sort {
    grid-column: 4;
    grid-row: 2;
  }

  .filter-row:not(.has-owner-filter) .filter-item.sort {
    grid-column: 3 / -1;
  }

  .filter-item.expires-range {
    grid-column: 1 / -1;
    grid-row: 3;
  }

  .shares-expired-btn {
    grid-column: 1 / span 2;
    grid-row: 4;
  }

  .shares-expiring-btn {
    grid-column: 3 / span 2;
    grid-row: 4;
  }

  .shares-search-btn {
    grid-column: 1;
    grid-row: 5;
  }

  .shares-refresh-btn {
    grid-column: 2;
    grid-row: 5;
  }

  .shares-batch-disable-btn {
    grid-column: 3 / -1;
    grid-row: 5;
  }

  .shares-search-btn,
  .shares-refresh-btn,
  .shares-expired-btn,
  .shares-expiring-btn,
  .shares-batch-disable-btn {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .filter-row :deep(.brutal-input-wrapper),
  .filter-row :deep(.shadcn-input-wrapper),
  .filter-row :deep(.brutal-select-wrapper),
  .filter-row :deep(.shadcn-select-wrapper),
  .filter-row :deep(.date-range-picker),
  .filter-row :deep(.brutal-input-control),
  .filter-row :deep(.shadcn-input-control),
  .filter-row :deep(.brutal-select-trigger),
  .filter-row :deep(.shadcn-select-trigger),
  .filter-row :deep(.date-range-trigger) {
    width: 100%;
    min-width: 0;
    min-inline-size: 0;
    max-width: 100%;
    overflow: hidden;
  }
}
</style>
