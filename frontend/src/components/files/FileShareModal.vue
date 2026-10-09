<template>
  <Modal
    :show="show"
    :title="t('files.modals.shareTitle')"
    width="600px"
    @update:show="handleUpdateShow"
  >
    <template v-if="loading">
      <div class="modal-state">{{ t('files.state.loading') }}</div>
    </template>

    <template v-else>
      <p v-if="!share" class="share-empty">{{ t('files.share.notCreated') }}</p>

      <div class="share-stats">
        <div class="share-stat-card">
          <div class="share-stat-row">
            <span class="share-stat-label">{{ t('files.share.statsVisits') }}：</span>
            <span class="share-stat-value">{{ statsVisits }}</span>
          </div>
        </div>
        <div class="share-stat-card">
          <div class="share-stat-row">
            <span class="share-stat-label">{{ t('files.share.statsValidity') }}：</span>
            <span class="share-stat-value">{{ statsValidity }}</span>
          </div>
        </div>
        <div class="share-stat-card">
          <div class="share-stat-row">
            <span class="share-stat-label">{{ t('files.share.passwordStatus') }}：</span>
            <span class="share-stat-value">{{ passwordStatus }}</span>
          </div>
        </div>
      </div>

      <div class="share-form-grid">
        <div class="share-field">
          <label class="share-field-label">{{ t('files.share.fieldsValidity') }}</label>
          <Select
            v-model="form.expiresPreset"
            size="small"
            :options="expiresPresetOptions"
            :disabled="saving"
          />
          <div v-if="form.expiresPreset === 'custom'" class="share-field-extra">
            <Input v-model="form.expiresAt" type="datetime-local" size="small" :disabled="saving" />
          </div>
        </div>

        <div class="share-field">
          <label class="share-field-label">{{ t('files.share.fieldsAccessCount') }}</label>
          <Input
            v-model="form.maxViews"
            type="number"
            size="small"
            :placeholder="t('files.share.optional')"
            :disabled="saving"
          />
        </div>

        <div class="share-field">
          <label class="share-field-label">{{ t('files.share.fieldsSharePassword') }}</label>
          <Input
            v-model="form.password"
            type="password"
            size="small"
            :placeholder="passwordPlaceholder"
            :disabled="saving"
          />
        </div>
      </div>

      <div class="link-group">
        <label class="link-label">{{ t('files.share.link') }}</label>
        <div class="link-row">
          <Input :model-value="shareUrl" readonly size="small" />
          <Button type="primary" size="small" :disabled="!shareUrl || saving" @click="copyShareUrl">
            {{ t('upload.copy') }}
          </Button>
          <Button
            type="default"
            size="small"
            :disabled="!shareUrl || saving"
            :aria-label="t('files.share.qrShow')"
            @click="showQr"
          >
            {{ t('files.share.qrShow') }}
          </Button>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="share-footer">
        <div class="share-footer-left">
          <Button
            v-if="share"
            type="default"
            :disabled="saving"
            @click="saveShare({ regenerate: true })"
          >
            {{ t('files.share.regenerate') }}
          </Button>

          <Button v-if="share" type="danger" :disabled="saving" @click="disableShare">
            {{ t('files.share.disable') }}
          </Button>
        </div>

        <Button
          type="primary"
          :loading="saving"
          :disabled="loading || !resolvedFileId"
          @click="saveShareAndClose"
        >
          {{ t('files.share.saveAndClose') }}
        </Button>
      </div>
    </template>
  </Modal>

  <Modal :show="qrVisible" :title="qrTitle" width="360px" @update:show="handleQrVisibility">
    <div v-if="qrLoading" class="modal-state">{{ t('files.state.loading') }}</div>
    <div v-else-if="qrError" class="modal-state">{{ qrError }}</div>
    <template v-else>
      <div class="qr-image-wrap">
        <img v-if="qrDataUrl" class="qr-image" :src="qrDataUrl" alt="" />
      </div>
      <p v-if="share" class="qr-hint">
        {{ t('files.share.statsValidity') }}：{{ statsValidity }} ·
        {{ t('files.share.statsVisits') }}：{{ statsVisits }}
      </p>
    </template>
    <template #footer>
      <Button type="default" @click="handleQrVisibility(false)">{{ t('common.close') }}</Button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import Modal from '../ui/modal/Modal.vue'
import Input from '../ui/input/Input.vue'
import Select from '../ui/select/Select.vue'
import Button from '../ui/button/Button.vue'
import api from '../../services/api'
import { useMessage } from '../../composables/useMessage'

const props = defineProps({
  show: Boolean,
  fileId: String,
  filename: String,
})

const emit = defineEmits(['update:show'])

const { t, locale } = useI18n({ useScope: 'global' })
const message = useMessage()

const loading = ref(false)
const saving = ref(false)
const share = ref(null)

const form = ref({
  maxViews: '',
  expiresPreset: 'never',
  expiresAt: '',
  password: '',
})

const resolvedFileId = computed(() => String(props.fileId ?? '').trim())

const resetForm = () => {
  form.value = {
    maxViews: '',
    expiresPreset: 'never',
    expiresAt: '',
    password: '',
  }
}

const formatDateTime = (isoString) => {
  if (!isoString) return ''
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale.value)
}

const toDatetimeLocalValue = (isoString) => {
  if (!isoString) return ''
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return ''

  const pad = (n) => String(n).padStart(2, '0')
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const hh = pad(date.getHours())
  const mm = pad(date.getMinutes())
  return `${y}-${m}-${d}T${hh}:${mm}`
}

const fromDatetimeLocalValue = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

const applyShareToForm = (record) => {
  if (!record) {
    resetForm()
    return
  }

  const maxViews = Number(record.max_views ?? 0)
  form.value.maxViews = Number.isFinite(maxViews) && maxViews > 0 ? String(maxViews) : ''

  const expiresAt = String(record.expires_at ?? '').trim()
  form.value.expiresPreset = expiresAt ? 'custom' : 'never'
  form.value.expiresAt = expiresAt ? toDatetimeLocalValue(expiresAt) : ''

  form.value.password = ''
}

const shareUrl = computed(() => {
  const code = String(share.value?.share_code ?? '').trim()
  if (!code) return ''
  if (typeof window === 'undefined') return `/f/${code}`
  return `${window.location.origin}/f/${code}`
})

const expiresPresetOptions = computed(() => [
  { value: 'never', label: t('files.share.neverExpires') },
  { value: '1d', label: t('files.share.expire1d') },
  { value: '7d', label: t('files.share.expire7d') },
  { value: '30d', label: t('files.share.expire30d') },
  { value: 'custom', label: t('files.share.expireCustom') },
])

const statsVisits = computed(() => {
  if (!share.value) return '-'
  const views = Number(share.value.views ?? 0)
  const maxViews = Number(share.value.max_views ?? 0)
  const safeViews = Number.isFinite(views) ? views : 0

  if (Number.isFinite(maxViews) && maxViews > 0) {
    return `${safeViews}/${Math.floor(maxViews)}`
  }

  return `${safeViews}/${t('files.share.unlimited')}`
})

const statsValidity = computed(() => {
  if (!share.value) return '-'

  const expiresAt = String(share.value.expires_at ?? '').trim()
  if (!expiresAt) return t('files.share.neverExpires')

  const formatted = formatDateTime(expiresAt)
  return formatted || '-'
})

const passwordPlaceholder = computed(() => {
  if (share.value?.has_password) {
    return t('files.share.passwordKeepPlaceholder')
  }
  return t('files.share.optional')
})

const passwordStatus = computed(() => {
  if (share.value?.has_password) return t('files.share.passwordSet')
  return t('files.share.passwordUnset')
})

const loadShare = async () => {
  const id = resolvedFileId.value
  if (!id) return

  loading.value = true
  try {
    const result = await api.getFileShare(id)
    share.value = result?.share || null
    applyShareToForm(share.value)
  } catch (error) {
    message.error(error.response?.data?.error || t('files.messages.shareLoadFailed'))
  } finally {
    loading.value = false
  }
}

const buildPayload = ({ regenerate = false } = {}) => {
  const maxViewsRaw = String(form.value.maxViews ?? '').trim()
  const maxViews = maxViewsRaw ? Number(maxViewsRaw) : 0
  if (!Number.isFinite(maxViews) || maxViews < 0) {
    message.error(t('files.share.maxViewsInvalid'))
    return null
  }

  const payload = {
    max_views: Math.floor(maxViews),
    expires_at: null,
  }

  const preset = String(form.value.expiresPreset ?? 'never')
  if (preset === 'custom') {
    const expiresAt = fromDatetimeLocalValue(form.value.expiresAt)
    if (!expiresAt) {
      message.error(t('files.share.expiresRequired'))
      return null
    }
    payload.expires_at = expiresAt
  } else if (preset !== 'never') {
    const days = Number.parseInt(preset.replace('d', ''), 10)
    if (!Number.isFinite(days) || days <= 0) {
      message.error(t('files.share.expiresRequired'))
      return null
    }
    payload.expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
  }

  const password = String(form.value.password ?? '').trim()
  if (password) {
    payload.password = password
  }

  if (regenerate) {
    payload.regenerate = true
  }

  return payload
}

const saveShare = async ({ regenerate = false, silentSuccess = false } = {}) => {
  const id = resolvedFileId.value
  if (!id) return false
  if (saving.value) return false

  const payload = buildPayload({ regenerate })
  if (!payload) return false

  saving.value = true
  try {
    const result = await api.upsertFileShare(id, payload)
    share.value = result?.share || null
    applyShareToForm(share.value)
    form.value.password = ''
    if (!silentSuccess) {
      message.success(t('files.messages.shareSaveSuccess'))
    }
    return true
  } catch (error) {
    message.error(error.response?.data?.error || t('files.messages.shareSaveFailed'))
    return false
  } finally {
    saving.value = false
  }
}

const queueCopyShareUrlAfterSave = (
  savePromise,
  { silentSuccess = false, silentFailure = false } = {}
) => {
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
    if (!clipboard) return null

    const clipboardItem = typeof ClipboardItem !== 'undefined' ? ClipboardItem : null

    let shouldSkipFailure = false
    const blobPromise = Promise.resolve(savePromise).then((saved) => {
      if (!saved) {
        shouldSkipFailure = true
        throw new Error('skip')
      }

      const url = shareUrl.value
      if (!url) {
        shouldSkipFailure = true
        throw new Error('missing share url')
      }

      if (typeof Blob === 'undefined') {
        shouldSkipFailure = true
        throw new Error('Blob is not available')
      }

      return new Blob([url], { type: 'text/plain' })
    })

    if (clipboardItem && typeof clipboard.write === 'function') {
      const item = new clipboardItem({ 'text/plain': blobPromise })
      return clipboard
        .write([item])
        .then(() => {
          if (!silentSuccess) {
            message.success(t('common.copied'))
          }
          return true
        })
        .catch(() => {
          if (shouldSkipFailure) return
          if (!silentFailure) {
            message.error(t('files.messages.shareCopyFailed'))
          }
          return false
        })
    }

    const urlNow = shareUrl.value
    if (urlNow && typeof clipboard.writeText === 'function') {
      return clipboard
        .writeText(urlNow)
        .then(() => {
          if (!silentSuccess) {
            message.success(t('common.copied'))
          }
          return true
        })
        .catch(() => {
          if (!silentFailure) {
            message.error(t('files.messages.shareCopyFailed'))
          }
          return false
        })
    }

    if (typeof clipboard.writeText !== 'function') {
      return null
    }

    return blobPromise
      .then(async (blob) => {
        const text = await blob.text()
        if (!text) {
          shouldSkipFailure = true
          throw new Error('missing share url')
        }
        await clipboard.writeText(text)
      })
      .then(() => {
        if (!silentSuccess) {
          message.success(t('common.copied'))
        }
        return true
      })
      .catch(() => {
        if (shouldSkipFailure) return
        if (!silentFailure) {
          message.error(t('files.messages.shareCopyFailed'))
        }
        return false
      })
  } catch {
    // ignore
  }

  return null
}

const saveShareAndClose = async () => {
  const savePromise = saveShare({ silentSuccess: true })
  const copyPromise = queueCopyShareUrlAfterSave(savePromise, {
    silentSuccess: true,
    silentFailure: true,
  })
  const saved = await savePromise
  if (saved) {
    emit('update:show', false)
    const copied = (await copyPromise) ?? false
    if (copied) {
      message.success(t('files.messages.shareSaveCopied'))
    } else {
      message.success(t('files.messages.shareSaveSuccess'))
    }
  }
}

const disableShare = async () => {
  const id = resolvedFileId.value
  if (!id) return
  if (saving.value) return

  saving.value = true
  try {
    await api.deleteFileShare(id)
    share.value = null
    resetForm()
    message.success(t('files.messages.shareDisableSuccess'))
  } catch (error) {
    message.error(error.response?.data?.error || t('files.messages.shareDisableFailed'))
  } finally {
    saving.value = false
  }
}

const copyShareUrl = async () => {
  const url = shareUrl.value
  if (!url) return

  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
    if (!clipboard) {
      throw new Error('Clipboard API is not available')
    }
    await clipboard.writeText(url)
    message.success(t('common.copied'))
  } catch (error) {
    message.error(error.response?.data?.error || t('files.messages.shareCopyFailed'))
  }
}

const handleUpdateShow = (value) => {
  emit('update:show', value)
}

// ── 分享链接二维码 ──
// 复用 TextQrModal 的 QRCode.toDataURL 参数风格（errorCorrectionLevel: 'M',
// margin: 1, width: 280），对常规 /f/:code 分享链接出码；一次性二维码是
// texts 专属能力，文件分享不引入。
const qrVisible = ref(false)
const qrLoading = ref(false)
const qrError = ref('')
const qrDataUrl = ref('')

const qrTitle = computed(() => {
  const base = t('files.share.qrTitle')
  const name = String(props.filename ?? '').trim()
  return name ? `${base} - ${name}` : base
})

const showQr = async () => {
  const url = shareUrl.value
  if (!url) return

  qrVisible.value = true
  qrLoading.value = true
  qrError.value = ''
  qrDataUrl.value = ''

  try {
    qrDataUrl.value = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 280,
    })
  } catch (error) {
    const rawMessage = error?.message ? String(error.message) : ''
    const looksLikeTooLarge = /too (big|large|long)|data.*(too (big|large|long))/i.test(rawMessage)
    qrError.value = looksLikeTooLarge ? t('files.share.qrTooLarge') : t('files.share.qrFailed')
  } finally {
    qrLoading.value = false
  }
}

const handleQrVisibility = (value) => {
  qrVisible.value = value
}

watch(
  () => props.show,
  (visible) => {
    if (visible) {
      loadShare()
    } else {
      share.value = null
      resetForm()
      loading.value = false
      saving.value = false
    }
  },
  { immediate: true }
)

watch(
  () => props.fileId,
  () => {
    if (props.show) {
      loadShare()
    }
  }
)
</script>

<style scoped>
.qr-image-wrap {
  display: flex;
  justify-content: center;
  padding: var(--nb-space-md);
}

.qr-image {
  width: 280px;
  height: 280px;
  image-rendering: pixelated;
}

.qr-hint {
  margin: 0;
  text-align: center;
  font-size: 12px;
  color: var(--nb-muted-foreground, var(--muted-foreground, var(--nb-gray-500)));
}

.modal-state {
  padding: var(--nb-space-md);
  text-align: center;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

.share-empty {
  margin: 0 0 var(--nb-space-md);
  font-size: 12px;
  color: var(--nb-muted-foreground, var(--muted-foreground, var(--nb-gray-500)));
}

.share-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--nb-space-sm);
  margin-bottom: var(--nb-space-md);
}

.share-stat-card {
  border: var(--nb-border, 1px solid var(--border, rgba(0, 0, 0, 0.12)));
  background: var(--nb-gray-100, var(--muted, rgba(0, 0, 0, 0.04)));
  border-radius: var(--nb-radius-md);
  padding: var(--nb-space-sm);
}

.share-stat-row {
  display: flex;
  align-items: baseline;
  gap: var(--nb-space-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.share-stat-label {
  font-size: 13px;
  color: var(--nb-muted-foreground, var(--muted-foreground, var(--nb-gray-600)));
  flex: 0 0 auto;
}

.share-stat-value {
  font-size: 16px;
  font-weight: 700;
  color: var(--nb-ink, var(--foreground, #111));
  flex: 0 0 auto;
}

.share-form-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--nb-space-lg);
  margin-bottom: var(--nb-space-lg);
}

.share-field-label {
  display: block;
  margin-bottom: var(--nb-space-xs);
  font-size: 14px;
  font-weight: 600;
  color: var(--nb-ink, var(--foreground, #111));
}

.share-field-extra {
  margin-top: var(--nb-space-sm);
}

.link-group {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-xs);
}

.link-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--nb-ink);
}

.link-row {
  display: flex;
  gap: var(--nb-space-sm);
  align-items: center;
}

@media (max-width: 768px) {
  .share-form-grid {
    grid-template-columns: 1fr;
  }

  .link-row {
    flex-direction: column;
    align-items: stretch;
  }
}

.share-footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-md);
}

.share-footer-left {
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
}
</style>
