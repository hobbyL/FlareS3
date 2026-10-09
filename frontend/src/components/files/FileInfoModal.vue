<template>
  <Modal
    :show="show"
    :title="t('files.modals.infoTitle')"
    width="600px"
    @update:show="handleUpdateShow"
  >
    <template v-if="file">
      <div class="file-info">
        <div
          v-for="row in fileInfoRows"
          :key="row.key"
          class="file-info-row"
          :style="{ '--columns': row.columns }"
        >
          <div v-for="item in row.items" :key="item.key" class="file-info-item">
            <span class="file-info-label">{{ item.label }}:</span>
            <span class="file-info-value">
              <template v-if="item.key === 'fileInfo'">
                <span class="file-info-filename">{{ item.value.filename }}</span>
                <span v-if="item.value.sizeText" class="file-info-filesize">
                  ({{ item.value.sizeText }})</span
                >
              </template>
              <template v-else>{{ item.value }}</template>
            </span>
          </div>
        </div>

        <div v-if="previewKind" class="file-preview">
          <div class="file-preview-body">
            <img
              v-if="previewKind === 'image'"
              class="file-preview-media"
              :src="previewUrl"
              alt=""
              loading="lazy"
            />
            <iframe
              v-else-if="previewKind === 'pdf'"
              class="file-preview-media"
              :src="previewUrl"
              title="pdf-preview"
            />
            <video
              v-else-if="previewKind === 'video'"
              class="file-preview-media"
              :src="previewUrl"
              controls
              preload="metadata"
            />
            <audio
              v-else-if="previewKind === 'audio'"
              class="file-preview-audio"
              :src="previewUrl"
              controls
              preload="metadata"
            />
            <div v-else-if="previewKind === 'markdown'" class="file-preview-pane">
              <div v-if="previewLoading" class="file-preview-placeholder">
                {{ t('files.state.loading') }}
              </div>
              <div v-else-if="previewError" class="file-preview-placeholder">
                {{ previewError }}
              </div>
              <div
                v-else
                class="file-preview-markdown markdown-content"
                v-html="previewMarkdownHtml"
              />
            </div>
            <pre v-else-if="previewKind === 'text'" class="file-preview-pane file-preview-pre">{{
              previewTextDisplay
            }}</pre>
          </div>
        </div>
      </div>

      <Divider />

      <div class="link-group">
        <label class="link-label">{{ t('upload.shortLink') }}</label>
        <div class="link-row">
          <Input :model-value="shortUrl" readonly size="small" />
          <Button type="primary" size="small" :disabled="!shortUrl" @click="copyUrl(shortUrl)">
            {{ t('upload.copy') }}
          </Button>
        </div>
      </div>

      <div class="link-group">
        <label class="link-label">{{ t('upload.directLink') }}</label>
        <div class="link-row">
          <Input :model-value="downloadUrl" readonly size="small" />
          <Button
            type="default"
            size="small"
            :disabled="!downloadUrl"
            @click="copyUrl(downloadUrl)"
          >
            {{ t('upload.copy') }}
          </Button>
        </div>
      </div>
    </template>

    <template #footer>
      <Button type="default" @click="handleUpdateShow(false)">{{ t('common.close') }}</Button>
      <Button type="primary" :disabled="!downloadUrl" @click="downloadFile">
        {{ t('files.downloadFile') }}
      </Button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '../ui/modal/Modal.vue'
import Divider from '../ui/divider/Divider.vue'
import Input from '../ui/input/Input.vue'
import Button from '../ui/button/Button.vue'
import { useMessage } from '../../composables/useMessage'
import { renderMarkdown } from '../../utils/markdown.js'

const props = defineProps({
  show: Boolean,
  file: Object,
})

const emit = defineEmits(['update:show'])

const { t, locale } = useI18n({ useScope: 'global' })
const message = useMessage()

const formatDateTime = (isoString) => {
  if (!isoString) return '-'
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString(locale.value)
}

const formatMegabytes = (bytes) => {
  const size = Number(bytes)
  if (!Number.isFinite(size) || size < 0) return '-'
  const mb = size / (1024 * 1024)
  return `${mb.toFixed(2)}MB`
}

const formatFileInfo = (file) => {
  const filename = String(file?.filename ?? '').trim()
  if (!filename) return { filename: '-', sizeText: '' }
  const size = formatMegabytes(file?.size)
  if (size === '-') return { filename, sizeText: '' }
  return { filename, sizeText: size }
}

const normalizeContentType = (value) =>
  String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase()

const getFilenameExtension = (filename) => {
  const name = String(filename || '').trim()
  const index = name.lastIndexOf('.')
  if (index <= 0 || index === name.length - 1) return ''
  return name.slice(index + 1).toLowerCase()
}

const ARCHIVE_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-bzip2',
  'application/x-xz',
])

const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'])

const previewKind = computed(() => {
  const file = props.file
  if (!file) return null

  const contentType = normalizeContentType(file.content_type)
  const extension = getFilenameExtension(file.filename)

  if (ARCHIVE_MIME_TYPES.has(contentType) || ARCHIVE_EXTENSIONS.has(extension)) {
    return null
  }

  if (contentType === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (contentType.startsWith('image/')) return 'image'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension)) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  if (['mp4', 'm4v', 'webm', 'ogg', 'ogv', 'mov', 'mkv'].includes(extension)) return 'video'
  if (contentType.startsWith('audio/')) return 'audio'
  if (['mp3', 'm4a', 'wav', 'flac', 'aac', 'opus'].includes(extension)) return 'audio'

  if (
    contentType === 'text/markdown' ||
    contentType === 'text/x-markdown' ||
    extension === 'md' ||
    extension === 'markdown'
  ) {
    return 'markdown'
  }

  if (
    contentType.startsWith('text/') ||
    ['txt', 'log', 'csv', 'json', 'yml', 'yaml', 'ini', 'conf'].includes(extension)
  ) {
    return 'text'
  }

  return null
})

const previewUrl = computed(() => {
  const file = props.file
  const id = String(file?.id || '').trim()
  if (!id) return ''
  if (typeof window === 'undefined') return `/api/files/${id}/preview`
  return `${window.location.origin}/api/files/${id}/preview`
})

const previewText = ref('')
const previewLoading = ref(false)
const previewError = ref('')

const MAX_PREVIEW_CACHE_ENTRIES = 30
const previewTextCache = new Map()

const getPreviewCacheKey = (fileId, kind) =>
  `${String(fileId || '').trim()}:${String(kind || '').trim()}`

const setPreviewCache = (key, value) => {
  if (!key) return
  if (previewTextCache.size >= MAX_PREVIEW_CACHE_ENTRIES && !previewTextCache.has(key)) {
    const firstKey = previewTextCache.keys().next().value
    if (firstKey) previewTextCache.delete(firstKey)
  }
  previewTextCache.set(key, value)
}

const previewMarkdownHtml = computed(() =>
  previewKind.value === 'markdown'
    ? renderMarkdown(previewText.value || '', { linkify: false })
    : ''
)
const previewTextDisplay = computed(() => {
  if (previewLoading.value) return t('files.state.loading')
  if (previewError.value) return previewError.value
  return previewText.value
})

const readPreviewError = async (response) => {
  if (!response) return t('files.info.previewLoadFailed')
  const contentType = String(response.headers?.get?.('Content-Type') || '').toLowerCase()
  if (contentType.includes('application/json')) {
    try {
      const payload = await response.json()
      const message = String(payload?.error || '').trim()
      if (message) return message
    } catch {
      // ignore
    }
  }

  try {
    const text = String(await response.text()).trim()
    if (text) return text
  } catch {
    // ignore
  }
  return t('files.info.previewLoadFailed')
}

watch(
  [() => props.show, previewKind, previewUrl],
  async ([show, kind, url], _prev, onCleanup) => {
    previewError.value = ''
    previewLoading.value = false

    const shouldFetch = kind === 'text' || kind === 'markdown'
    if (!show || !shouldFetch || !url) return

    const fileId = String(props.file?.id || '').trim()
    const cacheKey = getPreviewCacheKey(fileId, kind)
    if (previewTextCache.has(cacheKey)) {
      previewText.value = previewTextCache.get(cacheKey) || ''
      return
    }

    previewText.value = ''
    const controller = new AbortController()
    onCleanup(() => controller.abort())

    previewLoading.value = true
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        previewError.value = await readPreviewError(response)
        return
      }
      previewText.value = await response.text()
      setPreviewCache(cacheKey, previewText.value)
    } catch (error) {
      if (error?.name !== 'AbortError') {
        previewError.value = t('files.info.previewLoadFailed')
      }
    } finally {
      previewLoading.value = false
    }
  },
  { immediate: true }
)

const fileInfoRows = computed(() => {
  const file = props.file
  if (!file) return []

  const permission = file.require_login
    ? t('files.permission.requireLogin')
    : t('files.permission.public')
  return [
    {
      key: 'primary',
      columns: 2,
      items: [
        { key: 'fileInfo', label: t('files.info.fileInfo'), value: formatFileInfo(file) },
        { key: 'permission', label: t('files.info.permission'), value: permission },
      ],
    },
    {
      key: 'secondary',
      columns: 2,
      items: [
        {
          key: 'uploadedAt',
          label: t('files.info.uploadedAt'),
          value: formatDateTime(file.created_at),
        },
        { key: 'remaining', label: t('files.info.remaining'), value: file.remaining_time || '-' },
      ],
    },
  ]
})

const shortUrl = computed(() => {
  const file = props.file
  const code = String(file?.short_code || '').trim()
  if (!code) return ''
  if (typeof window === 'undefined') return `/s/${code}`
  return `${window.location.origin}/s/${code}`
})

const downloadUrl = computed(() => {
  const file = props.file
  if (!file) return ''
  const direct = String(file?.download_url || '').trim()
  if (direct) return direct
  const id = String(file?.id || '').trim()
  if (!id) return ''
  if (typeof window === 'undefined') return `/api/files/${id}/download`
  return `${window.location.origin}/api/files/${id}/download`
})

const copyUrl = (url) => {
  navigator.clipboard.writeText(url)
  message.success(t('common.copied'))
}

const downloadFile = () => {
  if (!downloadUrl.value) return
  window.open(downloadUrl.value, '_blank', 'noopener,noreferrer')
}

const handleUpdateShow = (value) => {
  emit('update:show', value)
}
</script>

<style scoped>
.file-info {
  display: grid;
  gap: 16px;
}

.file-info-row {
  display: grid;
  grid-template-columns: repeat(var(--columns), minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

.file-info-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.file-info-label {
  font-size: 0.875rem;
  font-weight: var(--nb-font-weight-medium);
  color: var(--muted-foreground, var(--nb-gray-500));
  flex-shrink: 0;
  white-space: nowrap;
}

.file-info-value {
  font-size: 0.875rem;
  color: var(--foreground, var(--nb-ink));
  overflow-wrap: anywhere;
  flex: 1;
  min-width: 0;
}

.file-info-filename {
  color: var(--foreground, var(--nb-ink));
  font-weight: var(--nb-font-weight-medium);
}

.file-info-filesize {
  color: var(--muted-foreground, var(--nb-gray-500));
  font-family: var(
    --nb-font-mono,
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace
  );
  white-space: nowrap;
}

.file-preview {
  display: grid;
  gap: 8px;
}

.file-preview-body {
  height: 240px;
  width: 100%;
  border: var(--nb-border, 1px solid var(--border, rgba(0, 0, 0, 0.12)));
  border-radius: var(--nb-radius-md);
  background: var(--background, #fff);
  overflow: hidden;
}

.file-preview-media {
  width: 100%;
  height: 100%;
  display: block;
  border: 0;
  object-fit: contain;
  background: var(--muted, rgba(0, 0, 0, 0.04));
}

.file-preview-audio {
  width: 100%;
  display: block;
  margin: auto;
}

.file-preview-pane {
  height: 100%;
  overflow: auto;
  padding: 12px;
  color: var(--foreground, var(--nb-ink));
}

.file-preview-pre {
  margin: 0;
  font-family: var(
    --nb-font-mono,
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace
  );
  font-size: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

.file-preview-placeholder {
  color: var(--muted-foreground, var(--nb-gray-500));
  font-size: 0.875rem;
}

.file-preview-markdown :deep(p) {
  margin: 0 0 0.75em;
}

.file-preview-markdown :deep(pre) {
  overflow: auto;
  padding: 10px;
  border-radius: 8px;
  background: var(--muted, rgba(0, 0, 0, 0.04));
}

.file-preview-markdown :deep(code) {
  font-family: var(
    --nb-font-mono,
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace
  );
}

.link-group {
  margin-bottom: var(--nb-space-md);
}

.link-label {
  display: block;
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-size: 12px;
  text-transform: var(--nb-ui-text-transform, uppercase);
  letter-spacing: var(--nb-ui-letter-spacing, 0.02em);
  color: var(--nb-gray-500);
  margin-bottom: 4px;
}

.link-row {
  display: flex;
  gap: var(--nb-space-sm);
}

@media (max-width: 768px) {
  .file-info-row {
    grid-template-columns: 1fr;
  }

  .link-row {
    flex-direction: column;
  }
}
</style>
