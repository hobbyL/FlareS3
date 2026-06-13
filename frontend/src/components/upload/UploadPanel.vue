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
import { computed, onMounted, onUnmounted, ref } from 'vue'
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
import { useMessage } from '../../composables/useMessage'
import { useUploadConfigOptions } from '../../composables/useUploadConfigOptions.js'
import { useUploadQueue } from '../../composables/useUploadQueue.js'
import { createUploadTaskRunner } from '../../services/uploadTaskRunner.js'

const emit = defineEmits(['uploaded'])

const message = useMessage()
const { t, locale } = useI18n({ useScope: 'global' })

const uploadRef = ref(null)
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
} = useUploadConfigOptions({ api, t, locale, message })

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

onMounted(loadUploadConfigOptions)

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

.upload-queue-block {
  margin-top: var(--nb-space-lg);
}
</style>
