<template>
  <AppLayout>
    <div class="files-page">
      <header class="files-header">
        <div class="files-title-group">
          <div class="files-title-row">
            <h1 class="files-title">{{ t('files.title') }}</h1>
            <Button
              type="ghost"
              size="small"
              class="files-upload-btn"
              :aria-label="t('files.uploadFile')"
              @click="showUploadModal = true"
            >
              <Upload :size="18" />
            </Button>
          </div>
          <p class="files-subtitle">
            {{ t('files.subtitle') }}
          </p>
        </div>

        <div class="files-actions">
          <div class="filter-row main">
            <div class="filter-item filename">
              <Input
                v-model="filters.filename"
                :placeholder="t('files.filters.filename')"
                size="small"
                clearable
                @keyup.enter="handleSearch"
              />
            </div>

            <div class="filter-item mode-toggle">
              <div class="files-mode-toggle" role="group" :aria-label="t('files.filters.mode')">
                <Button
                  type="ghost"
                  size="small"
                  class="files-mode-btn"
                  :class="{ 'is-active': !isTrashMode }"
                  :disabled="filesStore.loading || deleting"
                  :aria-label="t('files.filters.activeFiles')"
                  @click="setFilesMode('active')"
                >
                  {{ t('files.filters.activeFiles') }}
                </Button>
                <Button
                  type="ghost"
                  size="small"
                  class="files-mode-btn"
                  :class="{ 'is-active': isTrashMode }"
                  :disabled="filesStore.loading || deleting"
                  :aria-label="t('files.filters.trashFiles')"
                  @click="setFilesMode('trash')"
                >
                  {{ t('files.filters.trashFiles') }}
                </Button>
              </div>
            </div>

            <div class="filter-item created-range">
              <DateRangePicker
                v-model:startValue="filters.created_from_date"
                v-model:endValue="filters.created_to_date"
                size="small"
                clearable
              />
            </div>

            <Button
              type="default"
              size="small"
              class="files-search-btn"
              :block="isMobile"
              :loading="filesStore.loading && activeAction === 'search'"
              :disabled="filesStore.loading || deleting"
              @click="handleSearch"
            >
              <Search :size="16" style="margin-right: 6px" />
              {{ t('common.search') }}
            </Button>
            <Button
              type="default"
              size="small"
              class="files-refresh-btn"
              :block="isMobile"
              :loading="filesStore.loading && activeAction === 'refresh'"
              :disabled="filesStore.loading || deleting"
              @click="handleRefresh"
            >
              <RefreshCw :size="16" style="margin-right: 6px" />
              {{ t('common.refresh') }}
            </Button>

            <Button
              v-if="isTrashMode"
              type="danger"
              size="small"
              class="files-clear-trash-btn"
              :block="isMobile"
              :loading="deleting && pendingDeleteMode === 'clearTrash'"
              :disabled="filesStore.loading || deleting || filesStore.total <= 0"
              @click="handleClearTrash"
            >
              <Trash :size="16" style="margin-right: 6px" />
              {{ t('files.actions.clearTrash') }}
            </Button>

            <Tooltip
              :content="
                showAdvancedFilters
                  ? t('files.filters.lessFilters')
                  : t('files.filters.moreFilters')
              "
            >
              <Button
                type="ghost"
                size="small"
                class="advanced-filters-btn"
                :block="isMobile"
                :class="{ 'is-active': showAdvancedFilters || hasAdvancedFiltersActive }"
                :disabled="filesStore.loading || deleting"
                :aria-label="
                  showAdvancedFilters
                    ? t('files.filters.lessFilters')
                    : t('files.filters.moreFilters')
                "
                @click="toggleAdvancedFilters"
              >
                <SlidersHorizontal :size="18" />
              </Button>
            </Tooltip>

            <div v-if="!isMobile" class="filter-item view-mode">
              <div class="view-mode-toggle" role="group" aria-label="View mode">
                <Tooltip :content="t('files.viewMode.table')">
                  <Button
                    type="ghost"
                    size="small"
                    class="view-mode-btn"
                    :class="{ 'is-active': viewMode === 'table' }"
                    :disabled="filesStore.loading || deleting"
                    :aria-label="t('files.viewMode.table')"
                    @click="setViewMode('table')"
                  >
                    <Table2 :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('files.viewMode.card')">
                  <Button
                    type="ghost"
                    size="small"
                    class="view-mode-btn"
                    :class="{ 'is-active': viewMode === 'card' }"
                    :disabled="filesStore.loading || deleting"
                    :aria-label="t('files.viewMode.card')"
                    @click="setViewMode('card')"
                  >
                    <LayoutGrid :size="18" />
                  </Button>
                </Tooltip>
              </div>
            </div>
          </div>

          <div v-if="showAdvancedFilters" class="filter-row advanced">
            <div v-if="authStore.isAdmin" class="filter-item owner">
              <Select
                v-model="filters.owner_id"
                :options="ownerOptions"
                size="small"
                :disabled="usersLoading"
              />
            </div>

            <div v-if="!isTrashMode" class="filter-item status">
              <Select v-model="filters.upload_status" :options="statusOptions" size="small" />
            </div>

            <div class="filter-item sort">
              <Select v-model="filters.sort_key" :options="sortOptions" size="small" />
            </div>
          </div>
        </div>
      </header>

      <section class="files-content">
        <PageSkeleton
          v-if="tableLoading"
          :variant="viewMode === 'table' ? 'table' : 'cards'"
          :columns="columns.length"
          :cards="6"
        />

        <template v-else>
          <FilesTableView
            v-if="viewMode === 'table'"
            :columns="columns"
            :data="filesStore.files"
            :loading="tableLoading"
            :total="filesStore.total"
            :page="pagination.page"
            :page-size="pagination.pageSize"
            :disabled="filesStore.loading || deleting"
            @update:page="changePage"
            @update:page-size="changePageSize"
          />

          <FilesCardView
            v-else
            :files="filesStore.files"
            :loading="filesStore.loading || deleting"
            :initial-loading="tableLoading"
            :has-more="hasMore"
            :active-action="activeAction"
            :is-admin="authStore.isAdmin"
            :is-trash-mode="isTrashMode"
            @show-info="showFileInfo"
            @share="showFileShare"
            @delete="handleDelete"
            @restore="handleRestore"
            @delete-permanent="handleDeletePermanent"
            @load-more="loadMore"
          />
        </template>
      </section>

      <FileInfoModal v-model:show="showInfoModal" :file="selectedFile" />

      <FileUploadModal v-model:show="showUploadModal" @uploaded="handleUploaded" />

      <FileShareModal
        v-model:show="showShareModal"
        :file-id="sharingFileId"
        :filename="sharingFilename"
      />

      <Modal
        :show="showDeleteModal"
        :title="deleteModalTitle"
        width="420px"
        @update:show="handleDeleteModalUpdate"
      >
        <p class="files-delete-confirm">
          {{ deleteConfirmText }}
        </p>

        <template #footer>
          <Button type="default" :disabled="deleting" @click="handleDeleteCancel">
            {{ t('common.cancel') }}
          </Button>
          <Button type="danger" :loading="deleting" @click="handleDeleteConfirm">
            {{ deleteActionLabel }}
          </Button>
        </template>
      </Modal>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, h, onMounted, computed, watch } from 'vue'
import {
  Info,
  Trash2,
  RefreshCw,
  Search,
  Upload,
  LayoutGrid,
  Table2,
  Share2,
  RotateCcw,
  Trash,
  SlidersHorizontal,
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import { useFilesStore } from '../stores/files'
import { useThemeStore } from '../stores/theme'
import api from '../services/api'
import AppLayout from '../components/layout/AppLayout.vue'
import FilesTableView from '../components/files/FilesTableView.vue'
import FilesCardView from '../components/files/FilesCardView.vue'
import FileInfoModal from '../components/files/FileInfoModal.vue'
import FileUploadModal from '../components/files/FileUploadModal.vue'
import FileShareModal from '../components/files/FileShareModal.vue'
import Button from '../components/ui/button/Button.vue'
import Modal from '../components/ui/modal/Modal.vue'
import Select from '../components/ui/select/Select.vue'
import Input from '../components/ui/input/Input.vue'
import DateRangePicker from '../components/ui/date-range-picker/DateRangePicker.vue'
import Tag from '../components/ui/tag/Tag.vue'
import Tooltip from '../components/ui/tooltip/Tooltip.vue'
import TableCellText from '../components/ui/table/TableCellText.vue'
import PageSkeleton from '../components/ui/skeleton/PageSkeleton.vue'
import { useMessage } from '../composables/useMessage'
import { useResponsiveViewMode } from '../composables/useResponsiveViewMode.js'
import { canManageFileShare, getFileStatusState, isFileDeleted } from '../utils/files.js'

const authStore = useAuthStore()
const filesStore = useFilesStore()
const themeStore = useThemeStore()
const message = useMessage()
const { t, locale } = useI18n({ useScope: 'global' })

const showInfoModal = ref(false)
const selectedFile = ref(null)
const showUploadModal = ref(false)
const showShareModal = ref(false)
const sharingFileId = ref('')
const sharingFilename = ref('')

const showDeleteModal = ref(false)
const deleting = ref(false)
const pendingDeleteId = ref('')
const pendingDeleteMode = ref('soft')

const filters = ref({
  filename: '',
  owner_id: '',
  upload_status: '',
  created_from_date: '',
  created_to_date: '',
  sort_key: 'created_at__desc',
})

const isTrashMode = computed(() => filesStore.mode === 'trash')
const showAdvancedFilters = ref(false)
const hasAdvancedFiltersActive = computed(() => {
  const ownerActive = authStore.isAdmin && Boolean(filters.value.owner_id)
  const statusActive = !isTrashMode.value && Boolean(filters.value.upload_status)
  const defaultSortKey = isTrashMode.value ? 'deleted_at__desc' : 'created_at__desc'
  const sortActive = Boolean(filters.value.sort_key && filters.value.sort_key !== defaultSortKey)

  return ownerActive || statusActive || sortActive
})

const toggleAdvancedFilters = () => {
  showAdvancedFilters.value = !showAdvancedFilters.value
}
const deleteModalTitle = computed(() => {
  if (pendingDeleteMode.value === 'clearTrash') return t('files.modals.clearTrashTitle')
  return pendingDeleteMode.value === 'permanent'
    ? t('files.modals.deletePermanentTitle')
    : t('files.modals.deleteTitle')
})
const deleteActionLabel = computed(() => {
  if (pendingDeleteMode.value === 'clearTrash') return t('files.actions.clearTrash')
  return pendingDeleteMode.value === 'permanent'
    ? t('files.actions.deletePermanent')
    : t('files.actions.delete')
})
const deleteConfirmText = computed(() => {
  if (pendingDeleteMode.value === 'clearTrash') return t('files.confirmClearTrash')
  return pendingDeleteMode.value === 'permanent'
    ? t('files.confirmDeletePermanent')
    : t('files.confirmDelete')
})

const { isMobile, viewMode, setViewMode } = useResponsiveViewMode({
  storageKey: 'flares3:files-view-mode',
  desktopDefault: 'table',
  mobileDefault: 'card',
})

const usersLoading = ref(false)
const users = ref([])
const ownerOptions = computed(() => [
  { label: t('files.filters.allOwners'), value: '' },
  ...users.value.map((u) => ({ label: u.username, value: u.id })),
])

const statusOptions = computed(() => {
  if (isTrashMode.value) {
    return [{ label: t('files.filters.allStatus'), value: 'deleted' }]
  }
  return [
    { label: t('files.filters.allStatus'), value: '' },
    { label: t('files.status.valid'), value: 'completed' },
    { label: t('files.status.invalid'), value: 'deleted' },
  ]
})

const sortOptions = computed(() => {
  const base = [
    { label: t('files.filters.sortCreatedDesc'), value: 'created_at__desc' },
    { label: t('files.filters.sortCreatedAsc'), value: 'created_at__asc' },
    { label: t('files.filters.sortFilenameAsc'), value: 'filename__asc' },
    { label: t('files.filters.sortFilenameDesc'), value: 'filename__desc' },
    { label: t('files.filters.sortSizeDesc'), value: 'size__desc' },
    { label: t('files.filters.sortSizeAsc'), value: 'size__asc' },
  ]
  if (isTrashMode.value) {
    base.unshift(
      { label: t('files.filters.sortDeletedDesc'), value: 'deleted_at__desc' },
      { label: t('files.filters.sortDeletedAsc'), value: 'deleted_at__asc' }
    )
  }
  return base
})

const activeAction = ref('')
const hasLoadedOnce = ref(false)
const tableLoading = computed(() => filesStore.loading && !hasLoadedOnce.value)

const pagination = ref({ page: 1, pageSize: 20 })

const hasMore = computed(() => filesStore.files.length < Number(filesStore.total || 0))

const formatDateTime = (isoString) => {
  if (!isoString) return '-'
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString(locale.value)
}

const getExpiresText = (row) => {
  const expiresIn = Number(row?.expires_in)
  if (!Number.isFinite(expiresIn)) return '-'
  return expiresIn === -30
    ? t('files.expires.seconds', { value: 30 })
    : t('files.expires.days', { days: expiresIn })
}

const getRemainingText = (row) => {
  if (isFileDeleted(row) || isTrashMode.value) return '-'
  const text = String(row?.remaining_time ?? '').trim()
  return text ? text : '-'
}

const getFileStatus = (row) => {
  const { deleted, expired } = getFileStatusState(row)

  const text = deleted
    ? t('files.status.invalid')
    : expired
      ? t('files.status.expired')
      : t('files.status.valid')
  const tagType = deleted ? 'danger' : expired ? 'warning' : 'success'

  return { deleted, expired, text, tagType }
}

const columns = computed(() => [
  {
    title: t('files.columns.filename'),
    key: 'filename',
    align: 'left',
    ellipsis: true,
    render: (row) => h(TableCellText, { value: row.filename }),
  },
  {
    title: t('files.columns.size'),
    key: 'size',
    width: 100,
    align: 'center',
    ellipsis: true,
    render: (row) => h(TableCellText, { value: formatBytes(row.size) }),
  },
  {
    title: t('files.columns.expires'),
    key: 'expires_in',
    width: 100,
    align: 'center',
    ellipsis: true,
    render: (row) => h(TableCellText, { value: getExpiresText(row) }),
  },
  {
    title: t('files.columns.status'),
    key: 'status',
    width: 80,
    align: 'center',
    ellipsis: false,
    render: (row) => {
      const { text, tagType } = getFileStatus(row)
      return h(
        Tag,
        {
          type: tagType,
          size: 'small',
        },
        () => text
      )
    },
  },
  {
    title: t('files.columns.remaining'),
    key: 'remaining_time',
    width: 160,
    align: 'center',
    ellipsis: true,
    render: (row) => h(TableCellText, { value: getRemainingText(row) }),
  },
  {
    title: isTrashMode.value ? t('files.columns.deletedAt') : t('files.columns.uploadedAt'),
    key: isTrashMode.value ? 'deleted_at' : 'created_at',
    width: 160,
    align: 'center',
    ellipsis: true,
    render: (row) =>
      h(TableCellText, {
        value: formatDateTime(isTrashMode.value ? row.deleted_at : row.created_at),
      }),
  },
  ...(authStore.isAdmin
    ? [
        {
          title: t('files.columns.owner'),
          key: 'owner',
          width: 120,
          align: 'center',
          ellipsis: true,
          render: (row) => h(TableCellText, { value: row.owner_username || row.owner_id }),
        },
      ]
    : []),
  {
    title: t('files.columns.actions'),
    key: 'actions',
    width:
      locale.value === 'zh-CN'
        ? themeStore.uiTheme === 'shadcn'
          ? 280
          : 330
        : themeStore.uiTheme === 'shadcn'
          ? 330
          : 380,
    align: 'center',
    ellipsis: false,
    render: (row) => {
      const disabled = filesStore.loading || deleting.value
      if (isTrashMode.value) {
        return h('div', { class: 'action-buttons' }, [
          h(
            Button,
            {
              size: 'small',
              type: 'default',
              disabled,
              onClick: () => handleRestore(row.id),
            },
            () => [
              h(RotateCcw, { size: 16, style: 'margin-right: 4px' }),
              t('files.actions.restore'),
            ]
          ),
          h(
            Button,
            {
              size: 'small',
              type: 'danger',
              disabled,
              onClick: () => handleDeletePermanent(row.id),
            },
            () => [
              h(Trash, { size: 16, style: 'margin-right: 4px' }),
              t('files.actions.deletePermanent'),
            ]
          ),
        ])
      }

      const rowDisabled = disabled || isFileDeleted(row)
      const shareDisabled = disabled || !canManageFileShare(row)
      return h('div', { class: 'action-buttons' }, [
        h(
          Button,
          {
            size: 'small',
            type: 'default',
            disabled: rowDisabled,
            onClick: () => showFileInfo(row),
          },
          () => [h(Info, { size: 16, style: 'margin-right: 4px' }), t('common.details')]
        ),
        h(
          Button,
          {
            size: 'small',
            type: 'default',
            disabled: shareDisabled,
            onClick: () => showFileShare(row),
          },
          () => [h(Share2, { size: 16, style: 'margin-right: 4px' }), t('files.actions.share')]
        ),
        h(
          Button,
          {
            size: 'small',
            type: 'danger',
            disabled: rowDisabled,
            onClick: () => handleDelete(row.id),
          },
          () => [h(Trash2, { size: 16, style: 'margin-right: 4px' }), t('files.actions.delete')]
        ),
      ])
    },
  },
])

const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
}

const showFileInfo = (row) => {
  if (!row) return
  if (isFileDeleted(row)) return
  selectedFile.value = row
  showInfoModal.value = true
}

const showFileShare = (row) => {
  if (!row) return
  if (!canManageFileShare(row)) return
  sharingFileId.value = String(row.id ?? '')
  sharingFilename.value = String(row.filename ?? '')
  showShareModal.value = true
}

const toIsoStartOfDay = (dateValue) => {
  const local = new Date(`${dateValue}T00:00:00`)
  if (Number.isNaN(local.getTime())) return null
  return local.toISOString()
}

const addOneDayIso = (isoString) => {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() + 1)
  return date.toISOString()
}

const buildQueryParams = (mode = filesStore.mode) => {
  const params = {}
  const isTrash = mode === 'trash'

  const sortKey = filters.value.sort_key || (isTrash ? 'deleted_at__desc' : 'created_at__desc')
  const [sortBy, sortOrder] = sortKey.split('__')
  if (sortBy) params.sort_by = sortBy
  if (sortOrder) params.sort_order = sortOrder

  const filename = filters.value.filename?.trim()
  if (filename) params.filename = filename

  if (authStore.isAdmin && filters.value.owner_id) {
    params.owner_id = filters.value.owner_id
  }

  if (!isTrash && filters.value.upload_status) {
    params.upload_status = filters.value.upload_status
  }

  const createdFromDate = filters.value.created_from_date
  const createdToDate = filters.value.created_to_date

  if (createdFromDate || createdToDate) {
    let fromDate = createdFromDate
    let toDate = createdToDate

    if (fromDate && toDate && fromDate > toDate) {
      ;[fromDate, toDate] = [toDate, fromDate]
    }

    const fromIso = fromDate ? toIsoStartOfDay(fromDate) : null
    const toBaseIso = toDate ? toIsoStartOfDay(toDate) : null
    const toIso = toBaseIso ? addOneDayIso(toBaseIso) : null

    const fromKey = isTrash ? 'deleted_from' : 'created_from'
    const toKey = isTrash ? 'deleted_to' : 'created_to'

    if (fromIso && toIso) {
      params[fromKey] = fromIso
      params[toKey] = toIso
    } else if (fromIso) {
      const singleTo = addOneDayIso(fromIso)
      if (singleTo) {
        params[fromKey] = fromIso
        params[toKey] = singleTo
      }
    } else if (toIso && toBaseIso) {
      params[fromKey] = toBaseIso
      params[toKey] = toIso
    }
  }

  return params
}

const loadUsers = async () => {
  if (!authStore.isAdmin) return
  if (users.value.length) return
  usersLoading.value = true
  try {
    const result = await api.getUsers({ page: 1, limit: 100 })
    users.value = (result.users || []).filter((u) => u.status !== 'deleted')
  } catch (error) {
    message.error(t('files.messages.loadUsersFailed'))
  } finally {
    usersLoading.value = false
  }
}

const loadFiles = async ({
  page = pagination.value.page,
  append = false,
  mode = filesStore.mode,
} = {}) => {
  try {
    await filesStore.fetchFiles(page, pagination.value.pageSize, buildQueryParams(mode), {
      append,
      mode,
    })
    hasLoadedOnce.value = true
    pagination.value.page = page
  } catch (error) {
    message.error(t('files.messages.loadFilesFailed'))
  } finally {
    activeAction.value = ''
  }
}

const handleSearch = () => {
  if (filesStore.loading || deleting.value) return
  activeAction.value = 'search'
  pagination.value.page = 1
  loadFiles()
}

const handleRefresh = () => {
  if (filesStore.loading || deleting.value) return
  activeAction.value = 'refresh'
  if (viewMode.value === 'card') {
    pagination.value.page = 1
  }
  loadFiles()
}

const changePage = (page) => {
  if (deleting.value) return
  pagination.value.page = page
  loadFiles()
}

const changePageSize = (pageSize) => {
  if (deleting.value) return
  const nextSize = Number(pageSize)
  if (!Number.isFinite(nextSize) || nextSize <= 0) return
  pagination.value.pageSize = nextSize
  pagination.value.page = 1
  loadFiles()
}

const loadMore = async () => {
  if (filesStore.loading || deleting.value) return
  if (!hasMore.value) return

  activeAction.value = 'loadMore'
  const nextPage = pagination.value.page + 1
  await loadFiles({ page: nextPage, append: true })
}

const openDeleteModal = (fileId) => {
  const id = String(fileId ?? '').trim()
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

  const fileId = pendingDeleteId.value
  if (!fileId && pendingDeleteMode.value !== 'clearTrash') return

  deleting.value = true

  try {
    if (pendingDeleteMode.value === 'clearTrash') {
      const result = await api.permanentlyDeleteTrashFiles()
      message.success(
        t('files.messages.clearTrashSuccess', {
          deleted: Number(result?.deleted || 0),
          queued: Number(result?.queued || 0),
          total: Number(result?.total || 0),
        })
      )
      closeDeleteModal()
      pagination.value.page = 1
      await loadFiles({ page: 1, mode: 'trash' })
      return
    }

    if (pendingDeleteMode.value === 'permanent') {
      const result = await api.permanentlyDeleteFile(fileId)
      message.success(
        result?.queued
          ? t('files.messages.deletePermanentQueued')
          : t('files.messages.deletePermanentSuccess')
      )
    } else {
      await api.deleteFile(fileId)
      message.success(t('files.messages.deleteSuccess'))
    }

    closeDeleteModal()

    if (viewMode.value === 'card') {
      pagination.value.page = 1
      await loadFiles({ page: 1, mode: filesStore.mode })
    } else {
      if (filesStore.files.length <= 1 && pagination.value.page > 1) {
        pagination.value.page -= 1
      }
      await loadFiles()
    }
  } catch (error) {
    const messageKey =
      pendingDeleteMode.value === 'clearTrash'
        ? 'files.messages.clearTrashFailed'
        : pendingDeleteMode.value === 'permanent'
          ? 'files.messages.deletePermanentFailed'
          : 'files.messages.deleteFailed'
    message.error(t(messageKey))
  } finally {
    deleting.value = false
  }
}

const handleDelete = (fileId) => {
  pendingDeleteMode.value = 'soft'
  openDeleteModal(fileId)
}

const handleDeletePermanent = (fileId) => {
  pendingDeleteMode.value = 'permanent'
  openDeleteModal(fileId)
}

const handleClearTrash = () => {
  if (!isTrashMode.value || deleting.value || filesStore.total <= 0) return
  pendingDeleteMode.value = 'clearTrash'
  openDeleteModal('trash')
}

const handleRestore = async (fileId) => {
  if (deleting.value) return
  const id = String(fileId ?? '').trim()
  if (!id) return

  deleting.value = true
  try {
    await api.restoreFile(id)
    message.success(t('files.messages.restoreSuccess'))

    if (viewMode.value === 'card') {
      pagination.value.page = 1
      await loadFiles({ page: 1, mode: 'trash' })
    } else {
      if (filesStore.files.length <= 1 && pagination.value.page > 1) {
        pagination.value.page -= 1
      }
      await loadFiles({ mode: 'trash' })
    }
  } catch (error) {
    message.error(t('files.messages.restoreFailed'))
  } finally {
    deleting.value = false
  }
}

const setFilesMode = async (mode) => {
  const nextMode = mode === 'trash' ? 'trash' : 'active'
  if (filesStore.mode === nextMode && pagination.value.page === 1) return

  if (nextMode === 'trash') {
    filters.value.upload_status = ''
    filters.value.sort_key = 'deleted_at__desc'
  } else {
    if (filters.value.upload_status === 'deleted') {
      filters.value.upload_status = ''
    }
    // 从回收站切回活动模式时，若排序字段为 deleted_at 则重置
    if (filters.value.sort_key.startsWith('deleted_at')) {
      filters.value.sort_key = 'created_at__desc'
    }
  }

  pagination.value.page = 1
  await loadFiles({ page: 1, mode: nextMode })
}

const handleUploaded = () => {
  if (filesStore.mode === 'trash') {
    return
  }
  if (viewMode.value === 'card') {
    pagination.value.page = 1
  }
  loadFiles({ mode: 'active' })
}

onMounted(() => {
  loadFiles({ mode: 'active' })
  loadUsers()
})

watch(
  () => filesStore.mode,
  (mode) => {
    if (mode === 'trash') {
      filters.value.upload_status = ''
    }
  },
  { immediate: true }
)

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
.files-page {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.files-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--nb-space-lg);
}

.files-title-group {
  min-width: 0;
}

.files-title-row {
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
}

.files-title {
  margin: 0;
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-weight: var(--nb-heading-font-weight, 900);
  font-size: var(--nb-font-size-2xl);
  line-height: 1.2;
}

.files-upload-btn {
  padding: 0 10px;
  height: 32px;
}

.files-upload-btn :deep(svg) {
  width: 18px;
  height: 18px;
}

.files-subtitle {
  margin: var(--nb-space-sm) 0 0;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: var(--nb-font-size-sm);
}

.files-actions {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
  align-items: flex-end;
}

.filter-row {
  display: flex;
  gap: var(--nb-space-sm);
  align-items: center;
  justify-content: flex-end;
}

.filter-row.main {
  align-self: stretch;
  justify-content: flex-start;
  flex-wrap: nowrap;
  max-width: 100%;
  overflow-x: auto;
}

.filter-row.advanced {
  align-self: stretch;
  justify-content: flex-start;
  flex-wrap: wrap;
}

.filter-item.filename {
  width: 160px;
}

.filter-item.owner {
  width: 140px;
}

.filter-item.status {
  width: 120px;
}

.filter-item.sort {
  width: 140px;
}

.filter-item.created-range {
  width: 280px;
}

.filter-item.mode-toggle,
.filter-item.view-mode {
  display: flex;
  align-items: center;
}

.files-mode-toggle,
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

:root[data-ui-theme='shadcn'] .files-mode-toggle,
:root[data-ui-theme='shadcn'] .view-mode-toggle {
  border: 1px solid var(--border);
  background: var(--background);
}

.files-mode-btn {
  height: 32px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
}

.view-mode-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.files-mode-btn.is-active,
.view-mode-btn.is-active {
  background: var(--nb-secondary);
  border-color: var(--nb-border-color);
}

.advanced-filters-btn {
  width: 36px;
  height: 36px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.advanced-filters-btn.is-active {
  background: var(--nb-secondary);
  border-color: var(--nb-border-color);
}

:root[data-ui-theme='shadcn'] .view-mode-btn.is-active {
  background: var(--accent);
}

:root[data-ui-theme='shadcn'] .advanced-filters-btn.is-active {
  background: var(--accent);
}

.files-content {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.files-delete-confirm {
  margin: 0;
  color: var(--nb-muted-foreground, var(--nb-gray-600));
}

@media (max-width: 768px) {
  .files-page {
    overflow-x: hidden;
    overflow-x: clip;
  }

  .files-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .files-title-group,
  .files-title-row,
  .files-subtitle,
  .files-actions,
  .files-content,
  .files-header,
  .filter-row,
  .filter-row.main,
  .filter-row.advanced {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .files-actions {
    justify-content: flex-start;
    align-items: stretch;
  }

  .files-title-row {
    flex-wrap: wrap;
  }

  .filter-row {
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .filter-row.main {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    align-items: stretch;
    gap: var(--nb-space-sm);
    overflow-x: hidden;
  }

  .filter-row.advanced {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    align-items: stretch;
    gap: var(--nb-space-sm);
  }

  .filter-row.main > * {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .filter-item.filename,
  .filter-item.mode-toggle,
  .filter-item.created-range {
    grid-column: 1 / -1;
  }

  .filter-row.advanced > *,
  .filter-item.owner,
  .filter-item.status,
  .filter-item.sort,
  .filter-item.view-mode,
  .files-search-btn,
  .files-refresh-btn {
    width: 100%;
  }

  .files-mode-toggle,
  .view-mode-toggle,
  .advanced-filters-btn {
    width: 100%;
  }

  .filter-item.view-mode {
    display: none !important;
  }

  .files-mode-btn,
  .view-mode-btn {
    flex: 1 1 0;
    min-width: 0;
  }

  .filter-row.main :deep(.tooltip-trigger),
  .filter-row.main :deep(.brutal-tooltip-trigger) {
    grid-column: 3;
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .filter-row.main :deep(.brutal-input-wrapper),
  .filter-row.main :deep(.shadcn-input-wrapper),
  .filter-row.main :deep(.brutal-select-wrapper),
  .filter-row.main :deep(.shadcn-select-wrapper),
  .filter-row.main :deep(.date-range-picker),
  .filter-row.main :deep(.brutal-input-control),
  .filter-row.main :deep(.shadcn-input-control),
  .filter-row.main :deep(.brutal-select-trigger),
  .filter-row.main :deep(.shadcn-select-trigger),
  .filter-row.main :deep(.date-range-trigger),
  .filter-row.advanced :deep(.brutal-select-wrapper),
  .filter-row.advanced :deep(.shadcn-select-wrapper),
  .filter-row.advanced :deep(.brutal-select-trigger),
  .filter-row.advanced :deep(.shadcn-select-trigger) {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }
}
</style>
