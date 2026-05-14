<template>
  <AppLayout>
    <div class="mount-page">
      <header class="mount-header">
        <div class="mount-title-group">
          <div class="mount-title-row">
            <h1 class="mount-title">{{ t('mount.title') }}</h1>
          </div>
          <p class="mount-subtitle">{{ t('mount.subtitle') }}</p>
        </div>

        <div class="mount-actions">
          <div class="filter-row">
            <div class="filter-item owner">
              <Select
                v-model="selectedConfigId"
                :options="configOptions"
                size="small"
                :disabled="configsLoading || !configOptions.length"
                :placeholder="t('mount.state.noConfigSelectedTitle')"
              />
            </div>

            <div class="filter-item query">
              <Input
                v-model="prefixInput"
                :placeholder="t('mount.filters.prefix')"
                size="small"
                clearable
                :disabled="loading || !selectedConfigId"
                @keyup.enter="handleApplyPrefix"
              />
            </div>

            <Button
              type="default"
              size="small"
              class="mount-action-btn"
              :block="isMobile"
              :disabled="loading || !selectedConfigId"
              @click="handleApplyPrefix"
            >
              <Search :size="16" style="margin-right: 6px" />
              {{ t('mount.actions.go') }}
            </Button>

            <Button
              type="default"
              size="small"
              class="mount-action-btn"
              :block="isMobile"
              :loading="loading && activeAction === 'refresh'"
              :disabled="loading || !selectedConfigId"
              @click="handleRefresh"
            >
              <RefreshCw :size="16" style="margin-right: 6px" />
              {{ t('common.refresh') }}
            </Button>

            <Button
              type="primary"
              size="small"
              class="mount-action-btn"
              :block="isMobile"
              :disabled="loading || uploading || !selectedConfigId"
              @click="triggerUploadFile"
            >
              <Upload :size="16" style="margin-right: 6px" />
              {{ t('mount.actions.upload') }}
            </Button>
            <input
              ref="uploadFileInput"
              type="file"
              style="display: none"
              @change="handleUploadFileChange"
            />

            <Button
              type="default"
              size="small"
              class="mount-action-btn"
              :block="isMobile"
              :disabled="loading || !selectedConfigId"
              @click="showNewFolderModal"
            >
              <FolderPlus :size="16" style="margin-right: 6px" />
              {{ t('mount.actions.newFolder') }}
            </Button>

            <div v-if="!isMobile" class="filter-item view-mode">
              <div
                class="view-mode-toggle"
                role="group"
                :aria-label="t('mount.viewMode.ariaLabel')"
              >
                <Tooltip :content="t('mount.viewMode.table')">
                  <Button
                    type="ghost"
                    size="small"
                    class="view-mode-btn"
                    :class="{ 'is-active': viewMode === 'table' }"
                    :disabled="loading || !selectedConfigId"
                    :aria-label="t('mount.viewMode.table')"
                    @click="setViewMode('table')"
                  >
                    <Table2 :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('mount.viewMode.card')">
                  <Button
                    type="ghost"
                    size="small"
                    class="view-mode-btn"
                    :class="{ 'is-active': viewMode === 'card' }"
                    :disabled="loading || !selectedConfigId"
                    :aria-label="t('mount.viewMode.card')"
                    @click="setViewMode('card')"
                  >
                    <LayoutGrid :size="18" />
                  </Button>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section class="mount-content">
        <PageSkeleton
          v-if="initialPageLoading"
          :variant="viewMode === 'table' ? 'table' : 'cards'"
          :columns="columns.length"
          :cards="6"
          min-card-width="220px"
        />

        <template v-else>
          <Alert
            v-if="!configsLoading && configs.length === 0"
            type="info"
            :title="t('mount.state.noConfigsTitle')"
          >
            {{ t('mount.state.noConfigsContent') }}
          </Alert>

          <Alert
            v-else-if="!configsLoading && !selectedConfigId"
            type="info"
            :title="t('mount.state.noConfigSelectedTitle')"
          >
            {{ t('mount.state.noConfigSelectedContent') }}
          </Alert>

          <template v-else>
            <Card v-if="viewMode === 'table'" class="mount-browser-card">
              <template #header>
                <div class="mount-browser-header">
                  <div class="mount-path">
                    <Button type="ghost" size="small" :disabled="loading || !prefix" @click="goRoot">
                      <Home :size="16" />
                      <span class="btn-label">{{ t('mount.actions.root') }}</span>
                    </Button>

                    <div class="breadcrumb">
                      <span class="breadcrumb-root" :class="{ clickable: prefix }" @click="goRoot"
                        >/</span
                      >
                      <template v-for="(item, index) in breadcrumbItems" :key="item.prefix">
                        <span v-if="index > 0" class="breadcrumb-sep">/</span>
                        <span
                          class="breadcrumb-item clickable"
                          @click="navigateToPrefix(item.prefix)"
                        >
                          {{ item.label }}
                        </span>
                      </template>
                    </div>

                    <Button type="ghost" size="small" :disabled="loading || !prefix" @click="goUp">
                      <ArrowUp :size="16" />
                      <span class="btn-label">{{ t('mount.actions.up') }}</span>
                    </Button>
                  </div>
                </div>
              </template>

              <MountTableView :columns="columns" :data="tableData" :loading="loading || deleting" />

              <Pagination
                :page="pageNumber"
                :page-size="limit"
                :total="paginationTotal"
                :display-total="paginationDisplayTotal"
                :page-size-options="pageSizeOptions"
                :disabled="loading || deleting || !selectedConfigId"
                @update:page="handlePaginationPageChange"
                @update:page-size="handlePaginationPageSizeChange"
              />
            </Card>

            <div v-else class="mount-browser-panel">
              <div class="mount-browser-header">
                <div class="mount-path">
                  <Button type="ghost" size="small" :disabled="loading || !prefix" @click="goRoot">
                    <Home :size="16" />
                    <span class="btn-label">{{ t('mount.actions.root') }}</span>
                  </Button>

                  <div class="breadcrumb">
                    <span class="breadcrumb-root" :class="{ clickable: prefix }" @click="goRoot"
                      >/</span
                    >
                    <template v-for="(item, index) in breadcrumbItems" :key="item.prefix">
                      <span v-if="index > 0" class="breadcrumb-sep">/</span>
                      <span class="breadcrumb-item clickable" @click="navigateToPrefix(item.prefix)">
                        {{ item.label }}
                      </span>
                    </template>
                  </div>

                  <Button type="ghost" size="small" :disabled="loading || !prefix" @click="goUp">
                    <ArrowUp :size="16" />
                    <span class="btn-label">{{ t('mount.actions.up') }}</span>
                  </Button>
                </div>
              </div>

              <MountCardView
                :rows="tableData"
                :loading="loading"
                :initial-loading="initialPageLoading"
                :has-more="canNext"
                :active-action="activeAction"
                :deleting="deleting"
                :deleting-key="deletingKey"
                :is-preview-supported="isPreviewSupported"
                :format-bytes="formatBytes"
                :format-date-time="formatDateTime"
                @open-folder="openFolder"
                @preview="openPreview"
                @download="downloadObject"
                @delete="handleDeleteObject"
                @load-more="nextPage"
              />
            </div>
          </template>
        </template>
      </section>

      <MountedObjectPreviewModal
        v-model:show="previewModalVisible"
        :config-id="selectedConfigId"
        :object-key="previewKey"
      />

      <Modal
        :show="showDeleteModal"
        :title="deleteModalTitle"
        width="420px"
        @update:show="handleDeleteModalUpdate"
      >
        <p class="mount-delete-confirm">
          {{ deleteConfirmText }}
        </p>

        <template #footer>
          <Button type="default" :disabled="deleting" @click="handleDeleteCancel">
            {{ t('common.cancel') }}
          </Button>
          <Button type="danger" :loading="deleting" @click="handleDeleteConfirm">
            {{ t('mount.actions.delete') }}
          </Button>
        </template>
      </Modal>

      <Modal
        :show="showFolderModal"
        :title="t('mount.modals.newFolderTitle')"
        width="420px"
        @update:show="handleFolderModalUpdate"
      >
        <div class="mount-folder-form">
          <label class="mount-folder-label">{{ t('mount.newFolderLabel') }}</label>
          <Input
            v-model="newFolderName"
            :placeholder="t('mount.newFolderPlaceholder')"
            size="small"
            @keyup.enter="handleCreateFolder"
          />
        </div>

        <template #footer>
          <Button type="default" :disabled="creatingFolder" @click="closeFolderModal">
            {{ t('common.cancel') }}
          </Button>
          <Button type="primary" :loading="creatingFolder" :disabled="!newFolderName.trim()" @click="handleCreateFolder">
            {{ t('mount.actions.newFolder') }}
          </Button>
        </template>
      </Modal>

      <Modal
        :show="showUploadProgressModal"
        :title="t('mount.modals.uploadTitle')"
        width="420px"
        :closable="!uploading"
        @update:show="handleUploadProgressModalUpdate"
      >
        <div class="mount-upload-progress">
          <p v-if="uploading">{{ t('mount.upload.uploading') }}</p>
          <p v-if="uploading && uploadProgress >= 0">{{ t('mount.upload.progress', { percent: uploadProgress }) }}</p>
        </div>

        <template #footer>
          <Button v-if="!uploading" type="default" @click="showUploadProgressModal = false">
            {{ t('common.close') }}
          </Button>
        </template>
      </Modal>
    </div>
  </AppLayout>
</template>

<script setup>
import { computed, h, onMounted, ref, watch } from 'vue'
import {
  ArrowUp,
  Download,
  Eye,
  FolderOpen,
  Home,
  LayoutGrid,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  Upload,
  FolderPlus,
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import api from '../services/api'
import AppLayout from '../components/layout/AppLayout.vue'
import Card from '../components/ui/card/Card.vue'
import Pagination from '../components/ui/pagination/Pagination.vue'
import PageSkeleton from '../components/ui/skeleton/PageSkeleton.vue'
import Select from '../components/ui/select/Select.vue'
import Input from '../components/ui/input/Input.vue'
import Button from '../components/ui/button/Button.vue'
import Tooltip from '../components/ui/tooltip/Tooltip.vue'
import TableCellText from '../components/ui/table/TableCellText.vue'
import Alert from '../components/ui/alert/Alert.vue'
import Modal from '../components/ui/modal/Modal.vue'
import { useMessage } from '../composables/useMessage'
import { useResponsiveViewMode } from '../composables/useResponsiveViewMode.js'
import MountTableView from '../components/mount/MountTableView.vue'
import MountCardView from '../components/mount/MountCardView.vue'
import MountedObjectPreviewModal from '../components/mount/MountedObjectPreviewModal.vue'

const { t, locale } = useI18n({ useScope: 'global' })
const message = useMessage()

const configsLoading = ref(false)
const configs = ref([])
const selectedConfigId = ref('')
const hasLoadedOnce = ref(false)

const prefix = ref('')
const prefixInput = ref('')

const limit = ref(20)
const pageSizeOptions = [10, 20, 50]

const tokenStack = ref([null])
const listResult = ref(null)
const loading = ref(false)
const activeAction = ref('')
const loadRequestSerial = ref(0)

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
const uploadFileInput = ref(null)

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

const configOptions = computed(() =>
  configs.value.map((row) => {
    const typeLabel = row.configType === 'r2' ? 'R2' : row.configType === 'koofr' ? 'Koofr' : 'WebDAV'
    const detailLabel = row.configType === 'r2'
      ? (row.bucket_name || row.id)
      : row.configType === 'koofr'
        ? (row.remote_path && row.remote_path !== '/' ? row.remote_path : 'Koofr')
        : (row.endpoint || row.id)
    return {
      label: `${row.name || row.id} (${typeLabel}: ${detailLabel})`,
      value: row.id,
    }
  })
)

const currentToken = computed(() => tokenStack.value[tokenStack.value.length - 1] || '')
const pageNumber = computed(() => tokenStack.value.length)
const canPrev = computed(() => tokenStack.value.length > 1)
const canNext = computed(() => Boolean(listResult.value?.next_continuation_token))

const paginationTotal = computed(() => {
  const pageSize = Number(limit.value || 100)
  const pages = pageNumber.value + (canNext.value ? 1 : 0)
  return pageSize * pages
})

const paginationDisplayTotal = computed(() => {
  const pageSize = Number(limit.value || 100)
  const page = pageNumber.value
  const count = Number(listResult.value?.key_count || 0)
  const seen = Math.max(0, (page - 1) * pageSize + count)
  return canNext.value ? `${seen}+` : seen
})
const initialPageLoading = computed(() => !hasLoadedOnce.value && (configsLoading.value || loading.value))

const normalizePrefix = (value) => {
  const raw = String(value || '').trim()
  if (!raw || raw === '/') return ''

  let next = raw
  if (next.startsWith('/')) next = next.slice(1)
  if (next && !next.endsWith('/')) next += '/'
  return next
}

const formatBytes = (bytes) => {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '-'
  if (value === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(value) / Math.log(k)))
  const sized = Math.round((value / Math.pow(k, i)) * 100) / 100
  return `${sized} ${sizes[i]}`
}

const formatDateTime = (isoString) => {
  if (!isoString) return '-'
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString(locale.value)
}

const getBasename = (key) => {
  const normalized = String(key || '')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

const getFilenameExtension = (filename) => {
  const name = String(filename || '').trim()
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) return ''
  return name.slice(index + 1).toLowerCase()
}

const isPreviewSupported = (key) => {
  const extension = getFilenameExtension(getBasename(key))
  if (!extension) return false
  if (extension === 'pdf') return true
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension)) return true
  if (extension === 'md' || extension === 'markdown') return true
  if (['txt', 'log', 'csv', 'json', 'yml', 'yaml', 'ini', 'conf'].includes(extension)) return true
  return false
}

const breadcrumbItems = computed(() => {
  const raw = String(prefix.value || '')
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw
  const parts = trimmed.split('/').filter(Boolean)
  const items = []
  let acc = ''
  for (const part of parts) {
    acc += `${part}/`
    items.push({ label: part, prefix: acc })
  }
  return items
})

const goRoot = async () => {
  await navigateToPrefix('')
}

const getParentPrefix = (value) => {
  const raw = String(value || '')
  if (!raw) return ''
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return ''
  return trimmed.slice(0, idx + 1)
}

const goUp = async () => {
  if (!prefix.value) return
  const parent = getParentPrefix(prefix.value)
  await navigateToPrefix(parent)
}

const openFolder = async (folderPrefix) => {
  await navigateToPrefix(String(folderPrefix || ''))
}

const buildDownloadUrl = (key) => {
  const configId = String(selectedConfigId.value || '').trim()
  const objectKey = String(key || '').trim()
  if (!configId || !objectKey) return ''
  const query = `config_id=${encodeURIComponent(configId)}&key=${encodeURIComponent(objectKey)}`
  return `/api/mount/download?${query}`
}

const loadObjects = async () => {
  const configId = String(selectedConfigId.value || '').trim()
  if (!configId) return false

  const requestSerial = ++loadRequestSerial.value
  loading.value = true

  try {
    const result = await api.listMountedObjects({
      configId,
      prefix: prefix.value,
      continuationToken: currentToken.value || undefined,
      limit: Number(limit.value || 100),
    })

    if (requestSerial !== loadRequestSerial.value) return false

    listResult.value = result
    hasLoadedOnce.value = true
    return true
  } catch (error) {
    if (requestSerial === loadRequestSerial.value) {
      message.error(error.response?.data?.error || t('mount.messages.loadObjectsFailed'))
    }
    return false
  } finally {
    if (requestSerial === loadRequestSerial.value) {
      loading.value = false
      activeAction.value = ''
    }
  }
}

const navigateToPrefix = async (value) => {
  if (loading.value) return

  prefix.value = normalizePrefix(value)
  prefixInput.value = prefix.value
  tokenStack.value = [null]
  await loadObjects()
}

const handleApplyPrefix = async () => {
  await navigateToPrefix(prefixInput.value)
}

const handleRefresh = async () => {
  if (loading.value) return
  activeAction.value = 'refresh'
  tokenStack.value = [tokenStack.value[0]]
  await loadObjects()
}

const prevPage = async () => {
  if (loading.value) return
  if (!canPrev.value) return

  const removed = tokenStack.value.pop()
  const ok = await loadObjects()
  if (!ok) {
    tokenStack.value.push(removed)
  }
}

const nextPage = async () => {
  if (loading.value) return
  const nextToken = String(listResult.value?.next_continuation_token || '').trim()
  if (!nextToken) return

  activeAction.value = 'loadMore'
  tokenStack.value.push(nextToken)
  const ok = await loadObjects()
  if (!ok) {
    tokenStack.value.pop()
  }
}

const handlePaginationPageChange = async (targetPage) => {
  if (loading.value) return

  const nextPageNumber = Number(targetPage)
  if (!Number.isFinite(nextPageNumber) || nextPageNumber < 1) return

  const currentPageNumber = pageNumber.value
  if (nextPageNumber === currentPageNumber) return

  if (nextPageNumber < currentPageNumber) {
    if (nextPageNumber === currentPageNumber - 1) {
      await prevPage()
      return
    }

    const previousStack = [...tokenStack.value]
    tokenStack.value = tokenStack.value.slice(0, nextPageNumber)
    const ok = await loadObjects()
    if (!ok) {
      tokenStack.value = previousStack
    }
    return
  }

  if (nextPageNumber === currentPageNumber + 1) {
    await nextPage()
  }
}

const handlePaginationPageSizeChange = (value) => {
  const nextSize = Number(value)
  if (!Number.isFinite(nextSize) || nextSize <= 0) return
  if (nextSize === Number(limit.value)) return
  limit.value = nextSize
}

const openPreview = (key) => {
  if (!isPreviewSupported(key)) {
    message.error(t('mount.preview.unsupported'))
    return
  }

  previewKey.value = String(key || '')
  previewModalVisible.value = true
}

const downloadObject = (key) => {
  const url = buildDownloadUrl(key)
  if (!url) return
  window.open(url, '_blank')
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
  const displayNameBase = getBasename(folderKey) || folderKey || objectKey
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

const triggerUploadFile = () => {
  if (loading.value || uploading.value || !selectedConfigId.value) return
  const input = uploadFileInput.value
  if (input) {
    input.value = ''
    input.click()
  }
}

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

const tableData = computed(() => {
  const basePrefix = String(prefix.value || '')
  const folders = Array.isArray(listResult.value?.folders) ? listResult.value.folders : []
  const objects = Array.isArray(listResult.value?.objects) ? listResult.value.objects : []

  const folderRows = folders.map((folderPrefix) => {
    const fullKey = String(folderPrefix || '')
    const relative = fullKey.startsWith(basePrefix) ? fullKey.slice(basePrefix.length) : fullKey
    const name = relative.endsWith('/') ? relative.slice(0, -1) : relative

    return {
      kind: 'folder',
      key: fullKey,
      name: name || fullKey,
    }
  })

  const objectRows = objects
    .map((obj) => {
      const fullKey = String(obj?.key || '')
      const relative = fullKey.startsWith(basePrefix) ? fullKey.slice(basePrefix.length) : fullKey
      return {
        kind: 'object',
        key: fullKey,
        name: relative || fullKey,
        size: obj?.size,
        last_modified: obj?.last_modified,
      }
    })
    .filter((row) => row.key && row.key !== basePrefix)

  return [...folderRows, ...objectRows]
})

const columns = computed(() => [
  {
    title: t('mount.table.name'),
    key: 'name',
    align: 'left',
    ellipsis: true,
    render: (row) => {
      const isFolder = row.kind === 'folder'
      const displayName = isFolder ? `${row.name}/` : row.name

      const onClick = isFolder ? () => openFolder(row.key) : undefined
      return h(Tooltip, { content: row.key }, () =>
        h(
          'span',
          {
            class: ['mount-name', isFolder ? 'is-folder' : ''],
            onClick,
          },
          [
            isFolder
              ? h('span', { class: 'mount-name-icon' }, [h(FolderOpen, { size: 16 })])
              : null,
            h('span', { class: 'mount-name-text' }, displayName),
          ]
        )
      )
    },
  },
  {
    title: t('mount.table.size'),
    key: 'size',
    width: 120,
    align: 'center',
    ellipsis: true,
    render: (row) =>
      h(TableCellText, { value: row.kind === 'object' ? formatBytes(row.size) : '-' }),
  },
  {
    title: t('mount.table.lastModified'),
    key: 'last_modified',
    width: 190,
    align: 'center',
    ellipsis: true,
    render: (row) =>
      h(TableCellText, { value: row.kind === 'object' ? formatDateTime(row.last_modified) : '-' }),
  },
  {
    title: t('mount.table.actions'),
    key: 'actions',
    width: locale.value === 'zh-CN' ? 360 : 420,
    align: 'center',
    ellipsis: false,
    render: (row) => {
      const isFolder = row.kind === 'folder'
      const isDeleting = deleting.value && deletingKey.value === row.key

      if (isFolder) {
        return h('div', { class: 'action-buttons' }, [
          h(
            Button,
            {
              size: 'small',
              type: 'default',
              disabled: loading.value || deleting.value,
              onClick: () => openFolder(row.key),
            },
            () => [h(FolderOpen, { size: 16, style: 'margin-right: 4px' }), t('mount.actions.open')]
          ),
          h(
            Button,
            {
              size: 'small',
              type: 'danger',
              disabled: loading.value || deleting.value,
              loading: isDeleting,
              onClick: () => handleDeleteObject(row.key),
            },
            () => [h(Trash2, { size: 16, style: 'margin-right: 4px' }), t('mount.actions.delete')]
          ),
        ])
      }

      const canPreview = isPreviewSupported(row.key)

      return h('div', { class: 'action-buttons' }, [
        h(
          Button,
          {
            size: 'small',
            type: 'default',
            disabled: loading.value || deleting.value || !canPreview,
            onClick: () => openPreview(row.key),
          },
          () => [h(Eye, { size: 16, style: 'margin-right: 4px' }), t('mount.actions.preview')]
        ),
        h(
          Button,
          {
            size: 'small',
            type: 'primary',
            disabled: loading.value || deleting.value,
            onClick: () => downloadObject(row.key),
          },
          () => [h(Download, { size: 16, style: 'margin-right: 4px' }), t('mount.actions.download')]
        ),
        h(
          Button,
          {
            size: 'small',
            type: 'danger',
            disabled: loading.value || deleting.value,
            loading: isDeleting,
            onClick: () => handleDeleteObject(row.key),
          },
          () => [h(Trash2, { size: 16, style: 'margin-right: 4px' }), t('mount.actions.delete')]
        ),
      ])
    },
  },
])

const loadConfigs = async () => {
  configsLoading.value = true
  try {
    const result = await api.getStorageConfigs()

    configs.value = (result.configs || []).map((row) => ({
      ...row,
      configType: row.type, // 'r2' | 'webdav' | 'koofr'
    }))

    if (!selectedConfigId.value) {
      selectedConfigId.value =
        String(result.default_config_id || '').trim() || String(configs.value?.[0]?.id || '').trim()
    }
  } catch (error) {
    message.error(error.response?.data?.error || t('mount.messages.loadConfigsFailed'))
  } finally {
    configsLoading.value = false
  }
}

watch(
  () => selectedConfigId.value,
  async (value) => {
    previewModalVisible.value = false
    previewKey.value = ''
    closeDeleteModal()

    if (!value) {
      listResult.value = null
      tokenStack.value = [null]
      return
    }

    prefix.value = ''
    prefixInput.value = ''
    tokenStack.value = [null]
    await loadObjects()
  }
)

watch(
  () => prefixInput.value,
  async (value, previousValue) => {
    if (loading.value) return

    const normalizedValue = normalizePrefix(value)
    const normalizedPreviousValue = normalizePrefix(previousValue)

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

  if (selectedConfigId.value) {
    await loadObjects()
  }
})
</script>

<style scoped>
.mount-page {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.mount-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--nb-space-lg);
}

.mount-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--nb-space-sm);
  flex-wrap: wrap;
}

.mount-title {
  margin: 0;
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-weight: var(--nb-heading-font-weight, 900);
  font-size: var(--nb-font-size-2xl);
  line-height: 1.2;
}

.mount-subtitle {
  margin: 6px 0 0;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 0.95rem;
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

.mount-action-btn {
  flex-shrink: 0;
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

@media (max-width: 768px) {
  .mount-page {
    overflow-x: hidden;
    overflow-x: clip;
  }

  .mount-title-group,
  .mount-title-row,
  .mount-subtitle,
  .mount-header,
  .mount-actions,
  .mount-content,
  .mount-browser-panel,
  .filter-row {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .mount-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .mount-actions {
    justify-content: flex-start;
    align-items: stretch;
    width: 100%;
  }

  .filter-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: stretch;
    justify-content: flex-start;
  }

  .filter-item.query,
  .filter-item.owner,
  .mount-action-btn {
    width: 100%;
    min-width: 0;
  }
}

.mount-delete-confirm {
  margin: 0;
  line-height: 1.6;
  color: var(--nb-ink);
  word-break: break-word;
}

.mount-folder-form {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
}

.mount-folder-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--nb-ink);
}

.mount-upload-progress {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
  text-align: center;
  color: var(--nb-ink);
}

.mount-browser-panel {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-md);
}

.mount-browser-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--nb-space-md);
}

.mount-path {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.btn-label {
  margin-left: 6px;
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex-wrap: wrap;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

.breadcrumb-root,
.breadcrumb-item {
  font-family: var(--nb-font-mono, ui-monospace);
  font-size: 0.875rem;
}

.clickable {
  cursor: pointer;
  color: var(--nb-link-color, var(--nb-primary));
}

.breadcrumb-sep {
  opacity: 0.6;
}

@media (max-width: 768px) {
  .mount-browser-header,
  .mount-path {
    width: 100%;
    min-width: 0;
    flex-wrap: wrap;
  }

  .breadcrumb {
    width: 100%;
    min-width: 0;
  }
}
</style>
