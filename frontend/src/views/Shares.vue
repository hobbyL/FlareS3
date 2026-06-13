<template>
  <AppLayout>
    <div class="shares-page">
      <SharesHeaderToolbar
        :filters="filters"
        :owner-search-query="ownerSearchQuery"
        :is-admin="authStore.isAdmin"
        :owners-loading="ownersLoading"
        :loading="loading"
        :active-action="activeAction"
        :batch-disable-submitting="batchDisableSubmitting"
        :expired-governance-active="expiredGovernanceActive"
        :expiring-governance-active="expiringGovernanceActive"
        :selected-shares-count="selectedSharesCount"
        :type-options="typeOptions"
        :status-options="statusOptions"
        :sort-options="sortOptions"
        :owner-options="ownerOptions"
        @update-filter="handleFilterUpdate"
        @update-owner-search-query="handleOwnerSearchQueryUpdate"
        @search="handleSearch"
        @refresh="handleRefresh"
        @focus-expired="handleFocusExpired"
        @focus-expiring="handleFocusExpiring"
        @batch-disable="handleBatchDisable"
      />

      <SharesListPanel
        :initial-page-loading="initialPageLoading"
        :is-mobile="isMobile"
        :columns="columns"
        :items="items"
        :loading="loading"
        :active-action="activeAction"
        :selected-ids="selectedIds"
        :is-admin="authStore.isAdmin"
        :empty-state-text="emptyStateText"
        :pagination="pagination"
        @update:page="changePage"
        @update:page-size="changePageSize"
        @copy-link="copyShareLink"
        @open-link="openShareLink"
        @edit="openEditShare"
        @disable="openConfirmAction('disable', $event)"
        @regenerate="openConfirmAction('regenerate', $event)"
        @toggle-select="toggleRowSelection"
      />

      <FileShareModal
        v-if="fileShareModalVisible"
        :show="fileShareModalVisible"
        :file-id="activeFileId"
        :filename="activeResourceName"
        @update:show="handleFileShareModalUpdate"
      />

      <TextShareModal
        v-if="textShareModalVisible"
        :show="textShareModalVisible"
        :text-id="activeTextId"
        :text-title="activeResourceName"
        @update:show="handleTextShareModalUpdate"
      />

      <SharesConfirmModal
        :show="showConfirmModal"
        :title="confirmTitle"
        :message="confirmMessage"
        :button-label="confirmButtonLabel"
        :button-type="confirmButtonType"
        :submitting="confirmSubmitting"
        :disabled="!confirmMeta"
        @update:show="handleConfirmModalUpdate"
        @cancel="handleConfirmCancel"
        @submit="handleConfirmSubmit"
      />
    </div>
  </AppLayout>
</template>

<script setup>
import { computed, onMounted, ref, watch, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import { useUserOptionsStore } from '../stores/userOptions'
import api from '../services/api'
import AppLayout from '../components/layout/AppLayout.vue'
import { useMessage } from '../composables/useMessage'
import { useShareFilters } from '../composables/useShareFilters.js'
import { useShareSelection } from '../composables/useShareSelection.js'
import { useIsMobile } from '../composables/useViewport.js'
import SharesConfirmModal from '../components/shares/SharesConfirmModal.vue'
import SharesHeaderToolbar from '../components/shares/SharesHeaderToolbar.vue'
import SharesListPanel from '../components/shares/SharesListPanel.vue'
import { buildSharesTableColumns } from '../components/shares/shareTableColumns.js'
import {
  BATCH_DISABLE_SHARE_ACTION_KEY,
  buildAbsoluteShareUrl,
  canOpenShare,
  formatShareDateTime,
  getBatchDisableFeedbackMeta,
  getShareActionKey,
  getShareConfirmMeta,
  hasEditableConfig,
  isShareActionLoading,
  normalizeShareText as normalizeText,
} from '../utils/shares.js'

const FileShareModal = defineAsyncComponent(() => import('../components/files/FileShareModal.vue'))
const TextShareModal = defineAsyncComponent(() => import('../components/texts/TextShareModal.vue'))

const { t, locale } = useI18n({ useScope: 'global' })
const authStore = useAuthStore()
const userOptionsStore = useUserOptionsStore()
const message = useMessage()

const items = ref([])
const loading = ref(false)
const loadFailed = ref(false)
const hasLoadedOnce = ref(false)
const pagination = ref({ page: 1, pageSize: 20, itemCount: 0 })
const activeAction = ref('')

const isMobile = useIsMobile()

const ownersLoading = computed(() => userOptionsStore.loading)
const owners = computed(() => userOptionsStore.users)
const isAdmin = computed(() => authStore.isAdmin)
const {
  filters,
  ownerSearchQuery,
  typeOptions,
  statusOptions,
  sortOptions,
  ownerOptions,
  hasActiveFilters,
  expiredGovernanceActive,
  expiringGovernanceActive,
  handleFilterUpdate,
  handleOwnerSearchQueryUpdate,
  focusExpired,
  focusExpiring,
  buildQueryParams,
  restore: restoreFilters,
  persist: persistFilters,
} = useShareFilters({ t, isAdmin, owners })
const {
  selectedIds,
  pageRowIds,
  selectedIdSet,
  selectedShares,
  selectedSharesCount,
  allRowsSelected,
  selectAllIndeterminate,
  clearSelection,
  toggleSelectAll,
  toggleRowSelection,
} = useShareSelection(items)

const activeRecord = ref(null)
const fileShareModalVisible = ref(false)
const textShareModalVisible = ref(false)
const pendingConfirmAction = ref(null)
const batchDisableActionKey = BATCH_DISABLE_SHARE_ACTION_KEY

const activeFileId = computed(() =>
  activeRecord.value?.type === 'file' ? normalizeText(activeRecord.value?.resource_id) : ''
)
const activeTextId = computed(() =>
  activeRecord.value?.type === 'text' ? normalizeText(activeRecord.value?.resource_id) : ''
)
const activeResourceName = computed(() => normalizeText(activeRecord.value?.resource_name))

const emptyStateText = computed(() => {
  if (loadFailed.value) return t('shares.state.loadFailed')
  if (hasActiveFilters.value) return t('shares.state.filteredEmpty')
  return t('shares.state.empty')
})
const initialPageLoading = computed(
  () => !hasLoadedOnce.value && (loading.value || ownersLoading.value)
)
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

function formatDateTime(isoString) {
  return formatShareDateTime(isoString, locale.value)
}

function getActionKey(action, record) {
  return getShareActionKey(action, record)
}

function isActionLoading(action, record) {
  return isShareActionLoading(activeAction.value, action, record)
}

async function copyTextValue(value) {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    throw new Error('Clipboard API is not available')
  }
  await clipboard.writeText(value)
}

async function copyShareLink(record) {
  const url = buildAbsoluteShareUrl(record?.share_url)
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
  const url = buildAbsoluteShareUrl(record?.share_url)
  if (!url || typeof window === 'undefined') return
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function loadOwnerOptions() {
  if (!authStore.isAdmin) return

  try {
    await userOptionsStore.fetchActiveUsers()
  } catch (_error) {
    message.error(t('shares.messages.loadOwnersFailed'))
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
  focusExpired()
  activeAction.value = 'focus-expired'
  pagination.value.page = 1
  loadShares()
}

function handleFocusExpiring() {
  if (loading.value || batchDisableSubmitting.value) return
  focusExpiring()
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
    const nextUrl = shareCode ? buildAbsoluteShareUrl(`/s/${shareCode}`) : ''

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

const columns = computed(() =>
  buildSharesTableColumns({
    t,
    isAdmin: authStore.isAdmin,
    loading: loading.value,
    batchDisableSubmitting: batchDisableSubmitting.value,
    pageRowIds: pageRowIds.value,
    allRowsSelected: allRowsSelected.value,
    selectAllIndeterminate: selectAllIndeterminate.value,
    selectedIdSet: selectedIdSet.value,
    formatDateTime,
    isActionLoading,
    onToggleSelectAll: toggleSelectAll,
    onToggleRowSelection: toggleRowSelection,
    onCopyShareLink: copyShareLink,
    onOpenShareLink: openShareLink,
    onEditShare: openEditShare,
    onConfirmAction: openConfirmAction,
  })
)

onMounted(async () => {
  restoreFilters()
  await Promise.all([authStore.isAdmin ? loadOwnerOptions() : Promise.resolve(), loadShares()])
})

watch(filters, persistFilters, { deep: true })
</script>

<style scoped>
.shares-page {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

@media (max-width: 768px) {
  .shares-page {
    overflow-x: hidden;
    overflow-x: clip;
  }
}
</style>
