<template>
  <Modal :show="show" :title="modalTitle" width="720px" @update:show="handleUpdateShow">
    <template v-if="!objectKey">
      <div class="modal-state">-</div>
    </template>

    <template v-else>
      <div class="preview-wrapper">
        <div class="preview-meta">
          <div class="meta-row">
            <span class="meta-label">Key</span>
            <code class="meta-value">{{ objectKey }}</code>
            <Button type="ghost" size="small" :disabled="!objectKey" @click="copyKey">
              {{ t('mount.actions.copyKey') }}
            </Button>
          </div>
        </div>

        <div v-if="previewKind" class="preview-body">
          <div v-if="loading" class="preview-pane preview-placeholder">
            {{ t('mount.state.loading') }}
          </div>
          <div v-else-if="error" class="preview-pane preview-placeholder">{{ error }}</div>
          <img
            v-else-if="previewKind === 'image'"
            class="preview-media"
            :src="previewUrl"
            alt=""
            loading="lazy"
          />
          <iframe
            v-else-if="previewKind === 'pdf'"
            class="preview-media"
            :src="previewUrl"
            title="pdf-preview"
          />
          <video
            v-else-if="previewKind === 'video'"
            class="preview-media"
            :src="previewUrl"
            controls
            preload="metadata"
          />
          <audio
            v-else-if="previewKind === 'audio'"
            class="preview-audio"
            :src="previewUrl"
            controls
            preload="metadata"
          />
          <div v-else-if="previewKind === 'markdown'" class="preview-pane">
            <div class="preview-markdown markdown-content" v-html="markdownHtml" />
          </div>
          <pre v-else-if="previewKind === 'text'" class="preview-pane preview-pre">{{
            textDisplay
          }}</pre>
        </div>

        <Alert v-else type="warning" :title="t('mount.preview.unsupportedTitle')">
          {{ t('mount.preview.unsupportedContent') }}
        </Alert>
      </div>
    </template>

    <template #footer>
      <Button type="default" @click="handleUpdateShow(false)">{{ t('common.close') }}</Button>
      <Button type="primary" :disabled="!downloadUrl" @click="download">
        {{ t('mount.actions.download') }}
      </Button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '../ui/modal/Modal.vue'
import Button from '../ui/button/Button.vue'
import Alert from '../ui/alert/Alert.vue'
import { useMessage } from '../../composables/useMessage'
import { renderMarkdown } from '../../utils/markdown.js'
import {
  getMountedPreviewKind,
  shouldProbeMountedPreviewAvailability,
} from '../../utils/mountPreview.js'

const props = defineProps({
  show: Boolean,
  configId: String,
  objectKey: String,
})

const emit = defineEmits(['update:show'])

const { t } = useI18n({ useScope: 'global' })
const message = useMessage()

const previewKind = computed(() => {
  return getMountedPreviewKind(props.objectKey)
})

const modalTitle = computed(() => {
  const key = String(props.objectKey || '').trim()
  const idx = key.lastIndexOf('/')
  const name = idx >= 0 ? key.slice(idx + 1) : key
  return name ? t('mount.preview.titleWithName', { name }) : t('mount.preview.title')
})

const previewUrl = computed(() => {
  const configId = String(props.configId || '').trim()
  const key = String(props.objectKey || '').trim()
  if (!configId || !key) return ''
  const query = `config_id=${encodeURIComponent(configId)}&key=${encodeURIComponent(key)}`
  if (typeof window === 'undefined') return `/api/mount/preview?${query}`
  return `${window.location.origin}/api/mount/preview?${query}`
})

const downloadUrl = computed(() => {
  const configId = String(props.configId || '').trim()
  const key = String(props.objectKey || '').trim()
  if (!configId || !key) return ''
  const query = `config_id=${encodeURIComponent(configId)}&key=${encodeURIComponent(key)}`
  if (typeof window === 'undefined') return `/api/mount/download?${query}`
  return `${window.location.origin}/api/mount/download?${query}`
})

const previewText = ref('')
const loading = ref(false)
const error = ref('')
const MAX_MEDIA_PREVIEW_PROBE_BYTES = 4096

const markdownHtml = computed(() =>
  previewKind.value === 'markdown'
    ? renderMarkdown(previewText.value || '', { linkify: false })
    : ''
)

const textDisplay = computed(() => {
  if (loading.value) return t('mount.state.loading')
  if (error.value) return error.value
  return previewText.value
})

const readPreviewError = async (response) => {
  if (!response) return t('mount.preview.loadFailed')

  const contentType = String(response.headers?.get?.('Content-Type') || '').toLowerCase()
  if (contentType.includes('application/json')) {
    try {
      const payload = await response.json()
      const messageText = String(payload?.error || '').trim()
      if (messageText) return messageText
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

  return t('mount.preview.loadFailed')
}

watch(
  [() => props.show, previewKind, previewUrl],
  async ([show, kind, url], _prev, onCleanup) => {
    error.value = ''
    loading.value = false
    previewText.value = ''

    const shouldFetchText = kind === 'text' || kind === 'markdown'
    const shouldProbe = shouldProbeMountedPreviewAvailability(kind)
    if (!show || (!shouldFetchText && !shouldProbe) || !url) return

    const controller = new AbortController()
    onCleanup(() => controller.abort())

    loading.value = true
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        ...(shouldProbe
          ? {
              headers: {
                Range: `bytes=0-${MAX_MEDIA_PREVIEW_PROBE_BYTES - 1}`,
              },
            }
          : {}),
      })
      if (!response.ok) {
        error.value = await readPreviewError(response)
        return
      }

      if (shouldProbe) {
        return
      }

      previewText.value = await response.text()
    } catch (err) {
      if (err?.name !== 'AbortError') {
        error.value = t('mount.preview.loadFailed')
      }
    } finally {
      loading.value = false
    }
  },
  { immediate: true }
)

const copyKey = () => {
  const key = String(props.objectKey || '').trim()
  if (!key) return
  navigator.clipboard.writeText(key)
  message.success(t('common.copied'))
}

const download = () => {
  if (!downloadUrl.value) return
  window.open(downloadUrl.value, '_blank', 'noopener,noreferrer')
}

const handleUpdateShow = (value) => {
  emit('update:show', value)
}
</script>

<style scoped>
.modal-state {
  padding: var(--nb-space-md);
  text-align: center;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

.preview-wrapper {
  display: grid;
  gap: 12px;
}

.preview-meta {
  border: var(--nb-border-thin);
  border-radius: var(--nb-radius);
  padding: 10px 12px;
  background: var(--nb-gray-100);
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.meta-label {
  font-size: 0.875rem;
  font-weight: var(--nb-font-weight-medium);
  color: var(--muted-foreground, var(--nb-gray-500));
  flex-shrink: 0;
}

.meta-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.preview-body {
  height: 420px;
  width: 100%;
  border: var(--nb-border-thin);
  border-radius: var(--nb-radius-md);
  background: var(--background, #fff);
  overflow: hidden;
}

.preview-media {
  width: 100%;
  height: 100%;
  display: block;
  border: 0;
  object-fit: contain;
  background: var(--muted, rgba(0, 0, 0, 0.04));
}

.preview-audio {
  width: 100%;
  display: block;
  margin: auto;
}

.preview-pane {
  height: 100%;
  overflow: auto;
  padding: 12px;
  color: var(--foreground, var(--nb-ink));
}

.preview-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(
    --nb-font-mono,
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace
  );
  font-size: 0.875rem;
  line-height: 1.6;
}

.preview-placeholder {
  padding: 12px;
  color: var(--muted-foreground, var(--nb-gray-500));
}

.preview-markdown :deep(p) {
  margin: 0 0 var(--nb-space-sm);
}

.preview-markdown :deep(h1),
.preview-markdown :deep(h2),
.preview-markdown :deep(h3),
.preview-markdown :deep(h4),
.preview-markdown :deep(h5),
.preview-markdown :deep(h6) {
  margin: var(--nb-space-md) 0 var(--nb-space-sm);
  font-family: var(--nb-heading-font-family, var(--nb-font-ui));
  font-weight: var(--nb-heading-font-weight, 700);
  line-height: 1.25;
}

.preview-markdown :deep(a) {
  color: var(--nb-link-color, var(--nb-primary));
  text-decoration: underline;
}

.preview-markdown :deep(blockquote) {
  margin: 0 0 var(--nb-space-sm);
  padding: 0.5rem 0.75rem;
  border-left: 4px solid var(--nb-border-color, var(--nb-black));
  background: color-mix(in oklab, var(--nb-gray-50) 70%, transparent);
}

.preview-markdown :deep(pre) {
  margin: 0 0 var(--nb-space-sm);
  padding: var(--nb-space-sm);
  overflow: auto;
  background: var(--nb-gray-200);
  border-radius: var(--nb-radius-sm);
}

.preview-markdown :deep(code) {
  font-family: var(--nb-font-mono);
}
</style>
