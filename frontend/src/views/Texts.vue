<template>
  <AppLayout>
    <div class="texts-page">
      <header class="texts-header">
        <div class="texts-title-group">
          <div class="texts-title-row">
            <h1 class="texts-title">{{ t('texts.title') }}</h1>
            <Button
              v-if="isMobile"
              type="ghost"
              size="small"
              class="texts-mobile-create-btn"
              :disabled="loading"
              :aria-label="t('texts.createText')"
              @click="openCreate"
            >
              <Plus :size="18" />
            </Button>
          </div>
          <p class="texts-subtitle">
            {{ t('texts.subtitle') }}
          </p>
        </div>

        <div class="texts-actions">
          <div class="filter-row" :class="{ 'has-owner-filter': authStore.isAdmin }">
            <div class="filter-item query">
              <Input
                v-model="filters.q"
                :placeholder="t('texts.filters.q')"
                size="small"
                clearable
                @keyup.enter="handleSearch"
              />
            </div>

            <div v-if="authStore.isAdmin" class="filter-item owner">
              <Select
                v-model="filters.owner_id"
                :options="ownerOptions"
                size="small"
                :disabled="usersLoading"
              />
            </div>

            <Button
              type="default"
              size="small"
              class="texts-search-btn"
              :block="isMobile"
              :loading="loading && activeAction === 'search'"
              :disabled="loading"
              @click="handleSearch"
            >
              <Search :size="16" style="margin-right: 6px" />
              {{ t('common.search') }}
            </Button>

            <Button
              type="default"
              size="small"
              class="texts-refresh-btn"
              :block="isMobile"
              :loading="loading && activeAction === 'refresh'"
              :disabled="loading"
              @click="handleRefresh"
            >
              <RefreshCw :size="16" style="margin-right: 6px" />
              {{ t('common.refresh') }}
            </Button>

            <div v-if="!isMobile" class="filter-item view-mode">
              <div class="view-mode-toggle" role="group" aria-label="View mode">
                <Tooltip :content="t('texts.viewMode.table')">
                  <Button
                    type="ghost"
                    size="small"
                    class="view-mode-btn"
                    :class="{ 'is-active': viewMode === 'table' }"
                    :disabled="loading"
                    :aria-label="t('texts.viewMode.table')"
                    @click="setViewMode('table')"
                  >
                    <Table2 :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('texts.viewMode.card')">
                  <Button
                    type="ghost"
                    size="small"
                    class="view-mode-btn"
                    :class="{ 'is-active': viewMode === 'card' }"
                    :disabled="loading"
                    :aria-label="t('texts.viewMode.card')"
                    @click="setViewMode('card')"
                  >
                    <LayoutGrid :size="18" />
                  </Button>
                </Tooltip>
              </div>
            </div>
          </div>

          <Button
            v-if="!isMobile"
            type="primary"
            size="small"
            :disabled="loading"
            @click="openCreate"
          >
            <Plus :size="16" style="margin-right: 6px" />
            {{ t('texts.createText') }}
          </Button>
        </div>
      </header>

      <section class="texts-content">
        <PageSkeleton
          v-if="initialPageLoading"
          :variant="viewMode === 'table' ? 'table' : 'cards'"
          :columns="columns.length"
          :cards="6"
        />

        <template v-else>
          <TextsTableView
            v-if="viewMode === 'table'"
            :columns="columns"
            :data="texts"
            :loading="loading"
            :total="pagination.itemCount"
            :page="pagination.page"
            :page-size="pagination.pageSize"
            :disabled="loading"
            @update:page="changePage"
            @update:page-size="changePageSize"
          />

          <TextsCardView
            v-else
            :texts="texts"
            :loading="loading"
            :initial-loading="initialPageLoading"
            :deleting="deleting"
            :deleting-id="deletingId"
            :has-more="hasMore"
            :active-action="activeAction"
            :normalize-id="normalizeId"
            :build-preview="buildPreview"
            :format-bytes="formatBytes"
            :format-date-time="formatDateTime"
            :detect-file-type="detectFileType"
            @view="openView"
            @qrcode="openQrCode"
            @share="openShare"
            @access-log="openAccessLog"
            @edit="openEdit"
            @delete="handleDelete"
            @load-more="loadMore"
          />
        </template>
      </section>

      <TextFormModal
        v-if="createModalVisible"
        v-model:show="createModalVisible"
        mode="create"
        @success="handleFormSuccess"
      />

      <TextFormModal
        v-if="editModalVisible"
        v-model:show="editModalVisible"
        mode="edit"
        :text-id="editingId"
        @success="handleFormSuccess"
      />

      <TextViewModal v-if="viewModalVisible" v-model:show="viewModalVisible" :text-id="viewingId" />

      <TextQrModal
        v-if="qrModalVisible"
        v-model:show="qrModalVisible"
        :text-id="qrTextId"
        :text-title="qrTextTitle"
      />

      <TextShareModal
        v-if="shareModalVisible"
        v-model:show="shareModalVisible"
        :text-id="sharingId"
        :text-title="sharingTitle"
      />

      <ShareAccessLogModal
        v-if="accessLogModalVisible"
        :show="accessLogModalVisible"
        :share-type="accessLogType"
        :share-id="accessLogId"
        :share-name="accessLogName"
        @update:show="handleAccessLogModalUpdate"
      />

      <Modal
        :show="showDeleteModal"
        :title="t('texts.modals.deleteTitle')"
        width="420px"
        @update:show="handleDeleteModalUpdate"
      >
        <p class="texts-confirm-text">
          {{ deleteConfirmText }}
        </p>

        <template #footer>
          <Button type="default" :disabled="deleting" @click="handleDeleteCancel">{{
            t('common.cancel')
          }}</Button>
          <Button type="danger" :loading="deleting" @click="handleDeleteConfirm">{{
            t('texts.actions.delete')
          }}</Button>
        </template>
      </Modal>
    </div>
  </AppLayout>
</template>

<script setup>
import { computed, h, onMounted, ref, watch, defineAsyncComponent } from 'vue'
import {
  Eye,
  FileText,
  History,
  LayoutGrid,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Table2,
  Trash2,
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import api from '../services/api'
import { useAuthStore } from '../stores/auth'
import { useThemeStore } from '../stores/theme'
import { useUserOptionsStore } from '../stores/userOptions'
import AppLayout from '../components/layout/AppLayout.vue'
import TextsTableView from '../components/texts/TextsTableView.vue'
import PageSkeleton from '../components/ui/skeleton/PageSkeleton.vue'
import Button from '../components/ui/button/Button.vue'
import Modal from '../components/ui/modal/Modal.vue'
import Input from '../components/ui/input/Input.vue'
import Select from '../components/ui/select/Select.vue'
import Tag from '../components/ui/tag/Tag.vue'
import Tooltip from '../components/ui/tooltip/Tooltip.vue'
import TableCellText from '../components/ui/table/TableCellText.vue'
import { useMessage } from '../composables/useMessage'
import { useResponsiveViewMode } from '../composables/useResponsiveViewMode.js'
import { isLikelyMarkdown } from '../utils/markdown.js'

const TextsCardView = defineAsyncComponent(() => import('../components/texts/TextsCardView.vue'))
const TextFormModal = defineAsyncComponent(() => import('../components/texts/TextFormModal.vue'))
const TextViewModal = defineAsyncComponent(() => import('../components/texts/TextViewModal.vue'))
const TextShareModal = defineAsyncComponent(() => import('../components/texts/TextShareModal.vue'))
const TextQrModal = defineAsyncComponent(() => import('../components/texts/TextQrModal.vue'))
const ShareAccessLogModal = defineAsyncComponent(
  () => import('../components/shares/ShareAccessLogModal.vue')
)

const authStore = useAuthStore()
const themeStore = useThemeStore()
const userOptionsStore = useUserOptionsStore()
const message = useMessage()
const { t, locale } = useI18n({ useScope: 'global' })

const texts = ref([])
const loading = ref(false)
const hasLoadedOnce = ref(false)
const activeAction = ref('')
const deletingId = ref('')

const showDeleteModal = ref(false)
const deleting = ref(false)
const pendingDeleteId = ref('')

const deleteConfirmText = computed(() => t('texts.confirmDelete'))

const pagination = ref({ page: 1, pageSize: 20, itemCount: 0 })

const filters = ref({ q: '', owner_id: '' })

const { isMobile, viewMode, setViewMode } = useResponsiveViewMode({
  storageKey: 'flares3:texts-view-mode',
  desktopDefault: 'table',
  mobileDefault: 'card',
})

const usersLoading = computed(() => userOptionsStore.loading)
const users = computed(() => userOptionsStore.users)

const ownerOptions = computed(() => [
  { label: t('texts.filters.allOwners'), value: '' },
  ...users.value.map((u) => ({ label: u.username, value: u.id })),
])

const normalizeId = (value) => String(value ?? '').trim()

const formatDateTime = (isoString) => {
  if (!isoString) return '-'
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString(locale.value)
}

const formatBytes = (bytes) => {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '-'
  if (value === 0) return '0 B'

  const unit = 1024
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(unit)))
  const size = Math.round((value / Math.pow(unit, index)) * 100) / 100
  return `${size} ${units[index]}`
}

const buildPreview = (row) => {
  const preview = String(row?.content_preview ?? '')
  const contentLength = Number(row?.content_length ?? preview.length)
  const suffix = contentLength > preview.length ? '…' : ''
  return preview ? `${preview}${suffix}` : '-'
}

const detectFileType = (row) => {
  const preview = String(row?.content_preview ?? '')
  return isLikelyMarkdown(preview) ? 'MD' : 'TEXT'
}

const hasMore = computed(() => texts.value.length < pagination.value.itemCount)
const initialPageLoading = computed(() => loading.value && !hasLoadedOnce.value)

const columns = computed(() => {
  const base = [
    {
      title: t('texts.columns.title'),
      key: 'title',
      align: 'left',
      width: 160,
      ellipsis: true,
      render: (row) => h(TableCellText, { value: row?.title }),
    },
    {
      title: t('texts.columns.preview'),
      key: 'content_preview',
      align: 'center',
      ellipsis: true,
      render: (row) => {
        const preview = buildPreview(row)
        const tooltip = preview === '-' ? '' : preview
        return h(Tooltip, { content: tooltip }, () => preview)
      },
    },
    {
      title: t('texts.columns.length'),
      key: 'content_length',
      width: 100,
      align: 'center',
      ellipsis: true,
      render: (row) => {
        const length = Number(row?.content_length ?? 0)
        const text = !Number.isFinite(length) || length < 0 ? '-' : formatBytes(length)
        return h(TableCellText, { value: text })
      },
    },
    {
      title: t('texts.columns.updatedAt'),
      key: 'updated_at',
      width: themeStore.uiTheme === 'shadcn' ? 190 : 220,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: formatDateTime(row?.updated_at) }),
    },
    {
      title: t('texts.columns.actions'),
      key: 'actions',
      width:
        locale.value === 'zh-CN'
          ? themeStore.uiTheme === 'shadcn'
            ? 420
            : 460
          : themeStore.uiTheme === 'shadcn'
            ? 440
            : 500,
      align: 'center',
      ellipsis: false,
      render: (row) => {
        const id = normalizeId(row?.id)
        const disabled = loading.value || deleting.value || !id
        const isDeleting = deletingId.value === id

        return h('div', { class: 'action-buttons' }, [
          h(
            Button,
            { size: 'small', type: 'default', disabled, onClick: () => openView(row) },
            () => [h(Eye, { size: 16, style: 'margin-right: 4px' }), t('texts.actions.view')]
          ),
          h(
            Button,
            { size: 'small', type: 'default', disabled, onClick: () => openEdit(row) },
            () => [h(Pencil, { size: 16, style: 'margin-right: 4px' }), t('texts.actions.edit')]
          ),
          h(
            Button,
            { size: 'small', type: 'default', disabled, onClick: () => openShare(row) },
            () => [h(Share2, { size: 16, style: 'margin-right: 4px' }), t('texts.actions.share')]
          ),
          h(
            Button,
            {
              size: 'small',
              type: 'default',
              disabled: loading.value || deleting.value || !id,
              onClick: () => openAccessLog(row),
            },
            () => [
              h(History, { size: 16, style: 'margin-right: 4px' }),
              t('texts.actions.accessLog'),
            ]
          ),
          h(
            Button,
            {
              size: 'small',
              type: 'danger',
              disabled: disabled || isDeleting,
              loading: isDeleting,
              onClick: () => handleDelete(row),
            },
            () => [h(Trash2, { size: 16, style: 'margin-right: 4px' }), t('texts.actions.delete')]
          ),
        ])
      },
    },
  ]

  if (authStore.isAdmin) {
    base.splice(4, 0, {
      title: t('texts.columns.owner'),
      key: 'owner',
      width: 140,
      align: 'center',
      ellipsis: true,
      render: (row) => h(TableCellText, { value: row?.owner_username || row?.owner_id }),
    })
  }

  return base
})

const buildQueryParams = () => {
  const params = {}
  const q = String(filters.value.q ?? '').trim()
  if (q) params.q = q

  if (authStore.isAdmin) {
    const ownerId = String(filters.value.owner_id ?? '').trim()
    if (ownerId) params.owner_id = ownerId
  }

  return params
}

const loadUsers = async () => {
  if (!authStore.isAdmin) return
  try {
    await userOptionsStore.fetchActiveUsers()
  } catch (error) {
    message.error(t('texts.messages.loadUsersFailed'))
  }
}

const loadTexts = async ({ page = pagination.value.page, append = false } = {}) => {
  loading.value = true
  try {
    const result = await api.getTexts(page, pagination.value.pageSize, buildQueryParams())
    const nextTexts = result.texts || []
    texts.value = append ? [...texts.value, ...nextTexts] : nextTexts
    pagination.value.itemCount = Number(result.total || 0)
    pagination.value.page = Number(result.page || page)
    pagination.value.pageSize = Number(result.limit || pagination.value.pageSize)
    hasLoadedOnce.value = true
  } catch (error) {
    message.error(t('texts.messages.loadFailed'))
  } finally {
    loading.value = false
    activeAction.value = ''
  }
}

const loadMore = async () => {
  if (loading.value) return
  if (!hasMore.value) return

  activeAction.value = 'loadMore'
  const nextPage = pagination.value.page + 1
  await loadTexts({ page: nextPage, append: true })
}

const handleSearch = () => {
  if (loading.value) return
  activeAction.value = 'search'
  pagination.value.page = 1
  loadTexts()
}

const handleRefresh = () => {
  if (loading.value) return
  activeAction.value = 'refresh'
  if (viewMode.value === 'card') {
    pagination.value.page = 1
  }
  loadTexts()
}

const changePage = (page) => {
  pagination.value.page = page
  loadTexts()
}

const changePageSize = (pageSize) => {
  const nextSize = Number(pageSize)
  if (!Number.isFinite(nextSize) || nextSize <= 0) return
  pagination.value.pageSize = nextSize
  pagination.value.page = 1
  loadTexts()
}

const createModalVisible = ref(false)
const editModalVisible = ref(false)
const editingId = ref('')

const openCreate = () => {
  createModalVisible.value = true
}

const openEdit = async (row) => {
  const id = normalizeId(row?.id)
  if (!id) return
  editingId.value = id
  editModalVisible.value = true
}

const handleFormSuccess = async () => {
  pagination.value.page = 1
  await loadTexts()
}

const viewModalVisible = ref(false)
const viewingId = ref('')

const openView = async (row) => {
  const id = normalizeId(row?.id)
  if (!id) return
  viewingId.value = id
  viewModalVisible.value = true
}

const shareModalVisible = ref(false)
const sharingId = ref('')
const sharingTitle = ref('')

const openShare = (row) => {
  const id = normalizeId(row?.id)
  if (!id) return
  sharingId.value = id
  sharingTitle.value = String(row?.title ?? '').trim()
  shareModalVisible.value = true
}

const qrModalVisible = ref(false)
const qrTextId = ref('')
const qrTextTitle = ref('')

const openQrCode = (row) => {
  const id = normalizeId(row?.id)
  if (!id) return
  qrTextId.value = id
  qrTextTitle.value = String(row?.title ?? '').trim()
  qrModalVisible.value = true
}

const accessLogModalVisible = ref(false)
const accessLogRecord = ref(null)
const accessLogType = computed(() => 'text')
const accessLogId = computed(() => normalizeId(accessLogRecord.value?.id))
const accessLogName = computed(() => String(accessLogRecord.value?.title ?? '').trim())

const openAccessLog = (row) => {
  const id = normalizeId(row?.id)
  if (!id) return
  if (loading.value || deleting.value) return

  accessLogRecord.value = row
  accessLogModalVisible.value = true
}

const handleAccessLogModalUpdate = (nextValue) => {
  if (nextValue) {
    accessLogModalVisible.value = true
    return
  }
  accessLogModalVisible.value = false
  accessLogRecord.value = null
}

const openDeleteModal = (row) => {
  const id = normalizeId(row?.id)
  if (!id) return
  if (deleting.value) return

  pendingDeleteId.value = id
  showDeleteModal.value = true
}

const closeDeleteModal = () => {
  showDeleteModal.value = false
  pendingDeleteId.value = ''
}

const handleDeleteModalUpdate = (nextValue) => {
  if (deleting.value) return
  if (!nextValue) {
    closeDeleteModal()
    return
  }
  showDeleteModal.value = true
}

const handleDeleteCancel = () => {
  if (deleting.value) return
  closeDeleteModal()
}

const handleDeleteConfirm = async () => {
  if (deleting.value) return

  const id = pendingDeleteId.value
  if (!id) return

  deleting.value = true
  deletingId.value = id

  try {
    await api.deleteText(id)
    message.success(t('texts.messages.deleteSuccess'))

    closeDeleteModal()

    if (viewMode.value === 'card') {
      pagination.value.page = 1
      await loadTexts()
    } else {
      if (texts.value.length <= 1 && pagination.value.page > 1) {
        pagination.value.page -= 1
      }
      await loadTexts()
    }
  } catch (error) {
    message.error(error.response?.data?.error || t('texts.messages.deleteFailed'))
  } finally {
    deleting.value = false
    deletingId.value = ''
  }
}

const handleDelete = (row) => {
  openDeleteModal(row)
}

onMounted(() => {
  loadTexts()
  loadUsers()
})

watch(
  [isMobile, viewMode],
  ([mobile, mode]) => {
    if (mobile && mode !== 'card') {
      setViewMode('card')
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.texts-page {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.texts-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--nb-space-lg);
}

.texts-title-group {
  min-width: 0;
}

.texts-title-row {
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
}

.texts-title {
  margin: 0;
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-weight: var(--nb-heading-font-weight, 900);
  font-size: var(--nb-font-size-2xl);
  line-height: 1.2;
}

.texts-mobile-create-btn {
  display: none;
  height: 32px;
  padding: 0 10px;
  align-items: center;
  justify-content: center;
}

.texts-mobile-create-btn :deep(svg) {
  width: 18px;
  height: 18px;
}

.texts-subtitle {
  margin: var(--nb-space-sm) 0 0;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: var(--nb-font-size-sm);
}

.texts-actions {
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

.filter-item.query {
  width: 180px;
}

.filter-item.owner {
  width: 160px;
}

.filter-item.view-mode {
  display: flex;
  align-items: center;
}

.view-mode-toggle {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: var(--nb-border);
  border-radius: var(--nb-radius-md, var(--nb-radius));
  background: var(--nb-surface);
  height: 36px;
  align-items: center;
}

:root[data-ui-theme='shadcn'] .view-mode-toggle {
  border: 1px solid var(--border);
  background: var(--background);
}

.view-mode-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.view-mode-btn.is-active {
  background: var(--nb-secondary);
  border-color: var(--nb-border-color);
}

:root[data-ui-theme='shadcn'] .view-mode-btn.is-active {
  background: var(--accent);
}

.texts-content {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.texts-state {
  padding: var(--nb-space-md);
  text-align: center;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

.texts-confirm-text {
  margin: 0;
  color: var(--nb-ink);
}

@media (max-width: 768px) {
  .texts-page {
    overflow-x: hidden;
    overflow-x: clip;
  }

  .texts-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .texts-title-group,
  .texts-title-row,
  .texts-subtitle,
  .texts-actions,
  .texts-content,
  .texts-header,
  .filter-row {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .texts-title-row {
    justify-content: flex-start;
  }

  .texts-mobile-create-btn {
    display: inline-flex;
    flex-shrink: 0;
  }

  .texts-actions {
    justify-content: flex-start;
    align-items: stretch;
  }

  .filter-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    justify-content: flex-start;
    align-items: stretch;
    gap: var(--nb-space-sm);
  }

  .filter-row.has-owner-filter .filter-item.query,
  .filter-row.has-owner-filter .filter-item.owner {
    grid-row: 1;
  }

  .filter-row:not(.has-owner-filter) .filter-item.query {
    grid-column: 1 / -1;
  }

  .filter-item.query,
  .filter-item.owner,
  .texts-search-btn,
  .texts-refresh-btn {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .filter-item.view-mode {
    display: none !important;
  }

  .filter-row :deep(.brutal-input-wrapper),
  .filter-row :deep(.shadcn-input-wrapper),
  .filter-row :deep(.brutal-select-wrapper),
  .filter-row :deep(.shadcn-select-wrapper),
  .filter-row :deep(.brutal-input-control),
  .filter-row :deep(.shadcn-input-control),
  .filter-row :deep(.brutal-select-trigger),
  .filter-row :deep(.shadcn-select-trigger) {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }
}
</style>
