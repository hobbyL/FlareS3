<template>
  <div class="upload-panel">
    <div
      class="upload-entry"
      :class="{ 'is-disabled': isUploadEntryDisabled }"
      :aria-disabled="isUploadEntryDisabled ? 'true' : 'false'"
    >
      <Upload ref="uploadRef" multiple @file-selected="handleUpload" @before-upload="beforeUpload">
        <p class="upload-hint">{{ uploadHintText }}</p>
      </Upload>
    </div>

    <Alert v-if="uploadConfigAlertMessage" type="warning" class="upload-config-alert">
      {{ uploadConfigAlertMessage }}
    </Alert>

    <Divider />

    <div class="upload-options">
      <div class="upload-options-row">
        <FormItem
          v-if="uploadConfigOptions.length > 1"
          :label="t('upload.uploadConfig')"
          class="upload-options-row-item"
        >
          <Select
            v-model="selectedConfigId"
            :options="uploadConfigOptions"
            :disabled="configOptionsLoading"
          />
        </FormItem>
        <FormItem
          v-else-if="uploadConfigOptions.length === 1"
          :label="t('upload.uploadConfig')"
          class="upload-options-row-item"
        >
          <div class="selected-config-label">{{ selectedConfigLabel }}</div>
        </FormItem>

        <FormItem :label="t('upload.expiresIn')" class="upload-options-row-item">
          <Select v-model="expiresIn" :options="expiresOptions" />
        </FormItem>

        <FormItem :label="t('upload.uploadDir')" class="upload-options-row-item">
          <Input v-model="uploadDir" placeholder="e.g. images/" />
        </FormItem>
      </div>

      <FormItem :label="t('upload.downloadPermission')">
        <Switch
          v-model="requireLogin"
          :checked-text="t('upload.requireLogin')"
          :unchecked-text="t('upload.publicDownload')"
        />
      </FormItem>
    </div>

    <UploadResumeList
      v-if="visibleResumeEntries.length > 0"
      class="upload-resume-block"
      :items="visibleResumeEntries"
      :format-bytes="formatBytes"
      :format-date-time="formatDateTime"
      @resume="handleResumeRequest"
      @discard="requestDiscard"
    />

    <!-- 刷新后 File 对象已丢失，必须由用户重新选择同一文件才能继续上传 -->
    <input
      ref="resumeInputRef"
      type="file"
      hidden
      aria-hidden="true"
      tabindex="-1"
      @change="handleResumeFileChange"
    />

    <UploadResumeDiscardModal
      v-if="discardTarget"
      :show="Boolean(discardTarget)"
      :title="t('upload.resume.discardTitle')"
      :confirm-text="t('upload.resume.discardConfirm', { filename: discardTarget.filename })"
      :discarding="discarding"
      @update:show="handleDiscardVisibility"
      @cancel="cancelDiscard"
      @confirm="confirmDiscard"
    />

    <UploadQueueList
      v-if="queueItems.length > 0"
      class="upload-queue-block"
      :items="queueItems"
      @cancel="cancelQueueItem"
      @retry="retryQueueItem"
      @remove="removeQueueItem"
    />

    <UploadResultPanel
      v-if="latestSuccessResult"
      :result="latestSuccessResult"
      :expire-text="latestSuccessExpireText"
      @copy-short-url="copyShortUrl"
      @copy-download-url="copyDownloadUrl"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '../../services/api'
import Upload from '../ui/upload/Upload.vue'
import Divider from '../ui/divider/Divider.vue'
import FormItem from '../ui/form-item/FormItem.vue'
import Switch from '../ui/switch/Switch.vue'
import Select from '../ui/select/Select.vue'
import Alert from '../ui/alert/Alert.vue'
import Input from '../ui/input/Input.vue'
import UploadQueueList from './UploadQueueList.vue'
import UploadResultPanel from './UploadResultPanel.vue'
import UploadResumeList from './UploadResumeList.vue'
import UploadResumeDiscardModal from './UploadResumeDiscardModal.vue'
import { useMessage } from '../../composables/useMessage'
import { useUploadConfigOptions } from '../../composables/useUploadConfigOptions.js'
import { useUploadQueue } from '../../composables/useUploadQueue.js'
import { useUploadResumeEntries } from '../../composables/useUploadResumeEntries.js'
import { createUploadTaskRunner } from '../../services/uploadTaskRunner.js'
import { formatBytes } from '../../utils/uploadPanel.js'
import { generateFileId } from '../../utils/uploadResume.js'

const emit = defineEmits(['uploaded'])

const message = useMessage()
const { t, locale } = useI18n({ useScope: 'global' })

const uploadRef = ref(null)
const resumeInputRef = ref(null)
const pendingResumeFileId = ref('')
const expiresIn = ref(7)
const requireLogin = ref(true)
const uploadDir = ref('')

const {
  selectedConfigId,
  uploadConfigOptions,
  configOptionsLoading,
  hasAvailableUploadConfig,
  selectedConfigType,
  selectedConfigLabel,
  resolvedUploadConfigId,
  isUploadEntryDisabled,
  uploadHintText,
  uploadConfigAlertMessage,
  uploadConfigLoadingMessage,
  loadUploadConfigOptions,
} = useUploadConfigOptions({ api, t, message })

const {
  resumeEntries,
  discardTarget,
  discarding,
  refreshResumeEntries,
  requestDiscard,
  cancelDiscard,
  confirmDiscard,
  matchResumeFile,
} = useUploadResumeEntries({ api, t, message })

const formatDateTime = (value) => new Date(value).toLocaleString(locale.value)

const expiresOptions = computed(() =>
  [1, 3, 7, 30, 0].map((value) => ({
    label: value === 0 ? t('upload.expireNever') : t('upload.expireDays', { days: value }),
    value,
  }))
)

const latestSuccessExpireText = computed(() => {
  const expiresValue = Number(latestSuccessResult.value?.expiresIn ?? expiresIn.value)
  return expiresValue === 0
    ? t('upload.fileNeverExpire')
    : t('upload.fileExpire', { days: expiresValue })
})

const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024
const MAX_SERVER_UPLOAD_SIZE = 100 * 1024 * 1024
const uploadQueue = useUploadQueue({
  runTask: createUploadTaskRunner({
    api,
    t,
    onUploaded: (taskFile) => {
      message.success(t('upload.uploadSuccess'))
      emit('uploaded', { filename: taskFile.name })
    },
  }),
})

const queueItems = computed(() => uploadQueue.items.value)
const latestSuccessResult = computed(() => uploadQueue.latestSuccessItem.value?.result || null)

// 已在队列里排队/上传中的文件不重复出现在续传列表
const activeQueueFileIds = computed(() => {
  const ids = new Set()
  for (const item of queueItems.value) {
    if (item.status !== 'queued' && item.status !== 'uploading') continue
    const rawFile = item.file?.rawFile
    if (rawFile) ids.add(generateFileId(rawFile))
  }
  return ids
})

const visibleResumeEntries = computed(() =>
  resumeEntries.value.filter((entry) => !activeQueueFileIds.value.has(entry.fileId))
)

const beforeUpload = ({ files }) => {
  if (configOptionsLoading.value) {
    message.warning(uploadConfigLoadingMessage.value)
    return false
  }
  if (!hasAvailableUploadConfig.value || !resolvedUploadConfigId.value) {
    message.error(uploadConfigAlertMessage.value)
    return false
  }

  const isR2 = selectedConfigType.value === 'r2'
  const maxSize = isR2 ? MAX_FILE_SIZE : MAX_SERVER_UPLOAD_SIZE
  const invalidFile = files.find((item) => Number(item?.file?.size || 0) > maxSize)
  if (invalidFile) {
    message.error(
      isR2
        ? t('upload.fileTooLarge')
        : t('upload.fileTooLargeServer', { max: MAX_SERVER_UPLOAD_SIZE / 1024 / 1024 })
    )
    return false
  }

  return true
}

const buildQueuedFiles = (files = []) =>
  files.map((item) => ({
    rawFile: item.file,
    name: item.name,
    type: item.type || item.file?.type || 'application/octet-stream',
    size: Number(item.file?.size || 0),
    expiresIn: expiresIn.value,
    requireLogin: requireLogin.value,
    configId: resolvedUploadConfigId.value || undefined,
    configType: selectedConfigType.value,
    dir: uploadDir.value.trim() || undefined,
  }))

const handleUpload = ({ files }) => {
  if (!resolvedUploadConfigId.value) {
    message.error(uploadConfigAlertMessage.value)
    return
  }

  const queuedFiles = buildQueuedFiles(files)
  if (!queuedFiles.length) {
    return
  }

  uploadRef.value?.clear()
  uploadQueue.enqueueFiles(queuedFiles)
}

const handleResumeRequest = (fileId) => {
  pendingResumeFileId.value = fileId
  resumeInputRef.value?.click()
}

const handleResumeFileChange = (event) => {
  try {
    const file = event.target?.files?.[0]
    const entry = resumeEntries.value.find((item) => item.fileId === pendingResumeFileId.value)
    if (!file || !entry) return

    if (!matchResumeFile(entry, file)) {
      message.error(t('upload.resume.fileMismatch'))
      return
    }

    uploadQueue.enqueueFiles([
      {
        rawFile: file,
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: Number(file.size || 0),
        expiresIn: expiresIn.value,
        requireLogin: requireLogin.value,
        // 续传命中时 uploadLargeFile 不读这些字段；仅当服务端记录已失效、回退成
        // 新上传时才生效，此时与当前面板设置一致
        configId:
          selectedConfigType.value === 'r2' ? resolvedUploadConfigId.value || undefined : undefined,
        // 记录本身来自 R2 分片上传，必须走 uploadLargeFile 才能命中续传
        configType: 'r2',
        dir: uploadDir.value.trim() || undefined,
      },
    ])
    refreshResumeEntries()
    message.success(t('upload.resume.resumeStarted', { filename: entry.filename }))
  } finally {
    // 不复位则连续选择同一文件不会再次触发 change
    if (event.target) event.target.value = ''
    pendingResumeFileId.value = ''
  }
}

const handleDiscardVisibility = (visible) => {
  if (!visible) cancelDiscard()
}

const cancelQueueItem = (itemId) => {
  uploadQueue.cancelItem(itemId)
}

const retryQueueItem = (itemId) => {
  uploadQueue.retryItem(itemId)
}

const removeQueueItem = (itemId) => {
  uploadQueue.removeItem(itemId)
}

const copyShortUrl = () => {
  if (latestSuccessResult.value?.shortUrl) {
    navigator.clipboard.writeText(latestSuccessResult.value.shortUrl)
    message.success(t('upload.shortLinkCopied'))
  }
}

const copyDownloadUrl = () => {
  if (latestSuccessResult.value?.downloadUrl) {
    navigator.clipboard.writeText(latestSuccessResult.value.downloadUrl)
    message.success(t('upload.directLinkCopied'))
  }
}

// 队列条目进入终态后进度记录可能已被删除，重读一次。
// 触发源必须是 activeItemId 而不是条目状态：cancelItem 会同步把状态改成
// cancelled，此时 runner 的 catch 块还没删 localStorage 记录，按状态刷新会把
// 已放弃的记录重新读回列表（R4 的僵尸条目）。activeItemId 在队列的 finally 里
// 复位，严格晚于 deleteUploadProgress，刷新到的才是删后状态。
watch(uploadQueue.activeItemId, () => {
  refreshResumeEntries()
})

onMounted(() => {
  loadUploadConfigOptions()
  refreshResumeEntries()
})

onUnmounted(() => {
  uploadQueue.dispose()
})
</script>

<style scoped>
.upload-entry.is-disabled {
  opacity: 0.6;
  pointer-events: none;
}

.upload-hint {
  color: var(--nb-gray-500);
  font-size: 14px;
  margin-top: var(--nb-space-sm);
}

.upload-config-alert {
  margin-top: var(--nb-space-md);
}

.upload-options {
  display: grid;
  gap: var(--nb-space-md);
}

.upload-options-row {
  display: flex;
  gap: var(--nb-space-md);
}

.upload-options-row-item {
  flex: 1;
  min-width: 0;
}

.selected-config-label {
  min-height: 32px;
  display: flex;
  align-items: center;
  color: var(--nb-text, var(--foreground));
  word-break: break-all;
}

.upload-resume-block {
  margin-top: var(--nb-space-lg);
}

.upload-queue-block {
  margin-top: var(--nb-space-lg);
}
</style>
