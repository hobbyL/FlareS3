<template>
  <AppLayout>
    <div class="mount-page">
      <MountHeaderToolbar
        v-model:selected-config-id="selectedConfigId"
        v-model:prefix-input="prefixInput"
        :config-options="configOptions"
        :configs-loading="configsLoading"
        :loading="loading"
        :active-action="activeAction"
        :uploading="uploading"
        :is-mobile="isMobile"
        :view-mode="viewMode"
        @apply-prefix="handleApplyPrefix"
        @refresh="handleRefresh"
        @upload-file-change="handleUploadFileChange"
        @show-new-folder="showNewFolderModal"
        @set-view-mode="setViewMode"
      />

      <MountBrowserPanel
        :initial-page-loading="initialPageLoading"
        :view-mode="viewMode"
        :columns="columns"
        :rows="tableData"
        :loading="loading"
        :deleting="deleting"
        :configs-loading="configsLoading"
        :configs="configs"
        :selected-config-id="selectedConfigId"
        :prefix="prefix"
        :breadcrumb-items="breadcrumbItems"
        :page-number="pageNumber"
        :page-size="limit"
        :pagination-total="paginationTotal"
        :pagination-display-total="paginationDisplayTotal"
        :page-size-options="pageSizeOptions"
        :can-next="canNext"
        :active-action="activeAction"
        :deleting-key="deletingKey"
        :is-preview-supported="isPreviewSupported"
        :format-bytes="formatBytes"
        :format-date-time="formatDateTime"
        @go-root="goRoot"
        @go-up="goUp"
        @navigate="navigateToPrefix"
        @update:page="handlePaginationPageChange"
        @update:page-size="handlePaginationPageSizeChange"
        @open-folder="openFolder"
        @preview="openPreview"
        @download="downloadObject"
        @delete="handleDeleteObject"
        @load-more="nextPage"
      />

      <MountedObjectPreviewModal
        v-if="previewModalVisible"
        v-model:show="previewModalVisible"
        :config-id="selectedConfigId"
        :object-key="previewKey"
      />

      <MountDeleteConfirmModal
        :show="showDeleteModal"
        :title="deleteModalTitle"
        :confirm-text="deleteConfirmText"
        :deleting="deleting"
        @update:show="handleDeleteModalUpdate"
        @cancel="handleDeleteCancel"
        @confirm="handleDeleteConfirm"
      />

      <MountFolderModal
        :show="showFolderModal"
        v-model:folder-name="newFolderName"
        :creating="creatingFolder"
        @update:show="handleFolderModalUpdate"
        @cancel="closeFolderModal"
        @create="handleCreateFolder"
      />

      <MountUploadProgressModal
        :show="showUploadProgressModal"
        :uploading="uploading"
        :progress="uploadProgress"
        @update:show="handleUploadProgressModalUpdate"
      />
    </div>
  </AppLayout>
</template>

<script setup>
import { computed, onMounted, ref, watch, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '../services/api'
import AppLayout from '../components/layout/AppLayout.vue'
import { useMessage } from '../composables/useMessage'
import { useMountBrowser } from '../composables/useMountBrowser.js'
import { useMountConfigs } from '../composables/useMountConfigs.js'
import { useResponsiveViewMode } from '../composables/useResponsiveViewMode.js'
import MountBrowserPanel from '../components/mount/MountBrowserPanel.vue'
import MountDeleteConfirmModal from '../components/mount/MountDeleteConfirmModal.vue'
import MountFolderModal from '../components/mount/MountFolderModal.vue'
import MountHeaderToolbar from '../components/mount/MountHeaderToolbar.vue'
import MountUploadProgressModal from '../components/mount/MountUploadProgressModal.vue'
import { buildMountTableColumns } from '../components/mount/mountTableColumns.js'
import {
  buildMountDownloadUrl,
  formatMountBytes,
  formatMountDateTime,
  getMountObjectBasename,
  isMountedObjectPreviewSupported,
  normalizeMountPrefix,
} from '../utils/mountObjects.js'

const MountedObjectPreviewModal = defineAsyncComponent(
  () => import('../components/mount/MountedObjectPreviewModal.vue')
)

const { t, locale } = useI18n({ useScope: 'global' })
const message = useMessage()

const { configsLoading, configs, selectedConfigId, configOptions, loadConfigs } = useMountConfigs({
  api,
  t,
  message,
})
const {
  hasLoadedOnce,
  prefix,
  prefixInput,
  limit,
  pageSizeOptions,
  tokenStack,
  loading,
  activeAction,
  pageNumber,
  canNext,
  paginationTotal,
  paginationDisplayTotal,
  breadcrumbItems,
  tableData,
  loadObjects,
  navigateToPrefix,
  goRoot,
  goUp,
  openFolder,
  handleApplyPrefix,
  handleRefresh,
  nextPage,
  handlePaginationPageChange,
  handlePaginationPageSizeChange,
  resetForConfig,
} = useMountBrowser({ api, t, message, selectedConfigId })

const viewModeKey = 'flares3:mount-view-mode'
const { isMobile, viewMode, setViewMode } = useResponsiveViewMode({
  storageKey: viewModeKey,
  desktopDefault: 'table',
  mobileDefault: 'card',
})

const previewModalVisible = ref(false)
const previewKey = ref('')
const deleting = ref(false)
const deletingKey = ref('')

const showFolderModal = ref(false)
const newFolderName = ref('')
const creatingFolder = ref(false)

const uploading = ref(false)
const uploadProgress = ref(-1)
const showUploadProgressModal = ref(false)

const showDeleteModal = ref(false)
const pendingDeleteConfigId = ref('')
const pendingDeleteKey = ref('')
const pendingDeleteName = ref('')
const pendingDeleteIsFolder = ref(false)

const deleteModalTitle = computed(() =>
  pendingDeleteIsFolder.value ? t('mount.modals.deleteFolderTitle') : t('mount.modals.deleteTitle')
)

const deleteConfirmText = computed(() => {
  const key = pendingDeleteIsFolder.value ? 'mount.confirmDeleteFolder' : 'mount.confirmDelete'
  return t(key, { name: pendingDeleteName.value })
})

const initialPageLoading = computed(
  () => !hasLoadedOnce.value && (configsLoading.value || loading.value)
)
const isPreviewSupported = isMountedObjectPreviewSupported
const formatBytes = formatMountBytes
const formatDateTime = (isoString) => formatMountDateTime(isoString, locale.value)

const openPreview = (key) => {
  if (!isMountedObjectPreviewSupported(key)) {
    message.error(t('mount.preview.unsupported'))
    return
  }

  previewKey.value = String(key || '')
  previewModalVisible.value = true
}

const downloadObject = (key) => {
  const url = buildMountDownloadUrl(selectedConfigId.value, key)
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

const closeDeleteModal = () => {
  showDeleteModal.value = false
  pendingDeleteConfigId.value = ''
  pendingDeleteKey.value = ''
  pendingDeleteName.value = ''
  pendingDeleteIsFolder.value = false
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

const handleDeleteObject = (key) => {
  const configId = String(selectedConfigId.value || '').trim()
  const objectKey = String(key || '').trim()

  if (!configId || !objectKey) return
  if (loading.value || deleting.value) return

  const isFolder = objectKey.endsWith('/')
  const folderKey = isFolder ? objectKey.slice(0, -1) : objectKey
  const displayNameBase = getMountObjectBasename(folderKey) || folderKey || objectKey
  const displayName = isFolder ? `${displayNameBase}/` : displayNameBase

  pendingDeleteConfigId.value = configId
  pendingDeleteKey.value = objectKey
  pendingDeleteName.value = displayName
  pendingDeleteIsFolder.value = isFolder
  showDeleteModal.value = true
}

const handleDeleteConfirm = async () => {
  if (deleting.value) return

  const configId = String(pendingDeleteConfigId.value || '').trim()
  const objectKey = String(pendingDeleteKey.value || '').trim()
  const isFolder = pendingDeleteIsFolder.value

  if (!configId || !objectKey) return

  deleting.value = true
  deletingKey.value = objectKey

  try {
    const result = await api.deleteMountedObject({ configId, key: objectKey })

    if (previewModalVisible.value && previewKey.value === objectKey) {
      previewModalVisible.value = false
      previewKey.value = ''
    }

    const previousStack = [...tokenStack.value]
    if (tokenStack.value.length > 1 && tableData.value.length <= 1) {
      tokenStack.value.pop()
    }

    const ok = await loadObjects()
    if (!ok) {
      tokenStack.value = previousStack
    }

    if (isFolder) {
      const deletedCount = Number(result?.deleted_count || 0)
      message.success(t('mount.messages.deleteFolderSuccess', { count: deletedCount }))
    } else {
      message.success(t('mount.messages.deleteSuccess'))
    }

    closeDeleteModal()
  } catch (error) {
    const fallbackKey = isFolder
      ? 'mount.messages.deleteFolderFailed'
      : 'mount.messages.deleteFailed'
    message.error(error.response?.data?.error || t(fallbackKey))
  } finally {
    deleting.value = false
    deletingKey.value = ''
  }
}

// ── 新建目录 ──

const showNewFolderModal = () => {
  if (loading.value || !selectedConfigId.value) return
  newFolderName.value = ''
  showFolderModal.value = true
}

const closeFolderModal = () => {
  if (creatingFolder.value) return
  showFolderModal.value = false
  newFolderName.value = ''
}

const handleFolderModalUpdate = (nextValue) => {
  if (creatingFolder.value) return
  if (!nextValue) {
    closeFolderModal()
    return
  }
  showFolderModal.value = true
}

const handleCreateFolder = async () => {
  const name = String(newFolderName.value || '').trim()
  if (!name) return
  if (creatingFolder.value) return

  const configId = String(selectedConfigId.value || '').trim()
  if (!configId) return

  // 构造 key: 当前 prefix + folder name
  const currentPrefix = String(prefix.value || '')
  const folderKey = `${currentPrefix}${name}/`

  creatingFolder.value = true
  try {
    await api.createMountedFolder({ configId, key: folderKey })
    message.success(t('mount.messages.folderCreateSuccess'))
    closeFolderModal()
    await handleRefresh()
  } catch (error) {
    message.error(error.response?.data?.error || t('mount.messages.folderCreateFailed'))
  } finally {
    creatingFolder.value = false
  }
}

// ── 上传文件 ──

const handleUploadFileChange = async (event) => {
  const files = event.target?.files
  if (!files || files.length === 0) return

  const file = files[0]
  const configId = String(selectedConfigId.value || '').trim()
  if (!configId) return

  // 检查文件大小 (100MB)
  const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
  if (file.size > MAX_UPLOAD_BYTES) {
    message.error(t('mount.messages.uploadTooLarge'))
    return
  }

  uploading.value = true
  uploadProgress.value = -1
  showUploadProgressModal.value = true

  try {
    const result = await api.uploadMountedObject({
      configId,
      path: prefix.value || '',
      file,
      onProgress: (percent) => {
        uploadProgress.value = percent
      },
    })

    // 如果后端返回 presigned URL (R2)，需要前端直传
    if (result.upload_url) {
      try {
        await api.uploadToR2(result.upload_url, file, (percent) => {
          uploadProgress.value = percent
        })
      } catch (uploadError) {
        message.error(t('mount.messages.uploadFailed'))
        return
      }
    }

    message.success(t('mount.messages.uploadSuccess'))
    uploadProgress.value = 100
    await handleRefresh()
  } catch (error) {
    message.error(error.response?.data?.error || t('mount.messages.uploadFailed'))
  } finally {
    uploading.value = false
    // 短暂延迟后关闭进度弹窗
    setTimeout(() => {
      if (!uploading.value) {
        showUploadProgressModal.value = false
        uploadProgress.value = -1
      }
    }, 800)
  }
}

const handleUploadProgressModalUpdate = (nextValue) => {
  if (uploading.value) return
  showUploadProgressModal.value = nextValue
}

const columns = computed(() =>
  buildMountTableColumns({
    t,
    locale: locale.value,
    loading: loading.value,
    deleting: deleting.value,
    deletingKey: deletingKey.value,
    onOpenFolder: openFolder,
    onOpenPreview: openPreview,
    onDownloadObject: downloadObject,
    onDeleteObject: handleDeleteObject,
  })
)

watch(
  () => selectedConfigId.value,
  async (value) => {
    previewModalVisible.value = false
    previewKey.value = ''
    closeDeleteModal()

    await resetForConfig(value)
  }
)

watch(
  () => prefixInput.value,
  async (value, previousValue) => {
    if (loading.value) return

    const normalizedValue = normalizeMountPrefix(value)
    const normalizedPreviousValue = normalizeMountPrefix(previousValue)

    if (normalizedValue) return
    if (!normalizedPreviousValue) return
    if (!prefix.value) return

    await navigateToPrefix('')
  }
)

watch(
  () => limit.value,
  async () => {
    if (!selectedConfigId.value) return
    tokenStack.value = [null]
    await loadObjects()
  }
)

onMounted(async () => {
  prefixInput.value = prefix.value
  await loadConfigs()
})
</script>

<style scoped>
.mount-page {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}
@media (max-width: 768px) {
  .mount-page {
    overflow-x: hidden;
    overflow-x: clip;
  }
}
</style>
