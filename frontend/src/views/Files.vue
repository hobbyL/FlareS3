<template>
  <AppLayout>
    <div class="files-page">
      <FilesHeaderToolbar
        :filters="filters"
        :is-mobile="isMobile"
        :is-trash-mode="isTrashMode"
        :is-admin="authStore.isAdmin"
        :loading="filesStore.loading"
        :deleting="deleting"
        :active-action="activeAction"
        :pending-delete-mode="pendingDeleteMode"
        :total="filesStore.total"
        :show-advanced-filters="showAdvancedFilters"
        :has-advanced-filters-active="hasAdvancedFiltersActive"
        :users-loading="usersLoading"
        :owner-options="ownerOptions"
        :status-options="statusOptions"
        :sort-options="sortOptions"
        :view-mode="viewMode"
        @upload="showUploadModal = true"
        @search="handleSearch"
        @refresh="handleRefresh"
        @clear-trash="handleClearTrash"
        @toggle-advanced-filters="toggleAdvancedFilters"
        @set-files-mode="setFilesMode"
        @set-view-mode="setViewMode"
        @update-filter="handleFilterUpdate"
      />

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

      <FileInfoModal v-if="showInfoModal" v-model:show="showInfoModal" :file="selectedFile" />

      <FileUploadModal
        v-if="showUploadModal"
        v-model:show="showUploadModal"
        @uploaded="handleUploaded"
      />

      <FileShareModal
        v-if="showShareModal"
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
import { ref, onMounted, computed, watch, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import { useFilesStore } from '../stores/files'
import { useThemeStore } from '../stores/theme'
import { useUserOptionsStore } from '../stores/userOptions'
import api from '../services/api'
import AppLayout from '../components/layout/AppLayout.vue'
import FilesHeaderToolbar from '../components/files/FilesHeaderToolbar.vue'
import { buildFilesTableColumns } from '../components/files/fileTableColumns.js'
import FilesTableView from '../components/files/FilesTableView.vue'
import Button from '../components/ui/button/Button.vue'
import Modal from '../components/ui/modal/Modal.vue'
import PageSkeleton from '../components/ui/skeleton/PageSkeleton.vue'
import { useMessage } from '../composables/useMessage'
import { useResponsiveViewMode } from '../composables/useResponsiveViewMode.js'
import { buildFilesQueryParams, canManageFileShare, isFileDeleted } from '../utils/files.js'

const FilesCardView = defineAsyncComponent(() => import('../components/files/FilesCardView.vue'))
const FileInfoModal = defineAsyncComponent(() => import('../components/files/FileInfoModal.vue'))
const FileUploadModal = defineAsyncComponent(
  () => import('../components/files/FileUploadModal.vue')
)
const FileShareModal = defineAsyncComponent(() => import('../components/files/FileShareModal.vue'))

const authStore = useAuthStore()
const filesStore = useFilesStore()
const themeStore = useThemeStore()
const userOptionsStore = useUserOptionsStore()
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

const handleFilterUpdate = ({ key, value } = {}) => {
  if (!key) return
  filters.value = {
    ...filters.value,
    [key]: value,
  }
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

const usersLoading = computed(() => userOptionsStore.loading)
const users = computed(() => userOptionsStore.users)
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

const columns = computed(() =>
  buildFilesTableColumns({
    t,
    locale: locale.value,
    uiTheme: themeStore.uiTheme,
    isTrashMode: isTrashMode.value,
    isAdmin: authStore.isAdmin,
    loading: filesStore.loading,
    deleting: deleting.value,
    onShowFileInfo: showFileInfo,
    onShowFileShare: showFileShare,
    onDeleteFile: handleDelete,
    onRestoreFile: handleRestore,
    onDeletePermanent: handleDeletePermanent,
  })
)

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

const buildQueryParams = (mode = filesStore.mode) => {
  return buildFilesQueryParams(filters.value, { mode, isAdmin: authStore.isAdmin })
}

const loadUsers = async () => {
  if (!authStore.isAdmin) return
  try {
    await userOptionsStore.fetchActiveUsers()
  } catch (error) {
    message.error(t('files.messages.loadUsersFailed'))
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

  .files-content {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }
}
</style>
