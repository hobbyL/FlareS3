<template>
  <Modal
    :show="show"
    :title="t('mount.shareFolder.title')"
    width="600px"
    @update:show="handleUpdateShow"
  >
    <p class="folder-share-scope">
      {{ t('mount.shareFolder.scopeLabel') }}
      <code class="folder-share-scope-value">{{ displayPrefix }}</code>
    </p>

    <template v-if="loading">
      <div class="modal-state">{{ t('mount.shareFolder.loading') }}</div>
    </template>

    <template v-else>
      <div v-if="share" class="share-stats">
        <div class="share-stat-card">
          <div class="share-stat-row">
            <span class="share-stat-label">{{ t('mount.shareFolder.statsVisits') }}：</span>
            <span class="share-stat-value">{{ statsVisits }}</span>
          </div>
        </div>
        <div class="share-stat-card">
          <div class="share-stat-row">
            <span class="share-stat-label">{{ t('mount.shareFolder.statsValidity') }}：</span>
            <span class="share-stat-value">{{ statsValidity }}</span>
          </div>
        </div>
        <div class="share-stat-card">
          <div class="share-stat-row">
            <span class="share-stat-label">{{ t('mount.shareFolder.passwordStatus') }}：</span>
            <span class="share-stat-value">{{ passwordStatus }}</span>
          </div>
        </div>
      </div>

      <div v-else class="share-form-grid">
        <div class="share-field">
          <label class="share-field-label">{{ t('mount.shareFolder.fieldsValidity') }}</label>
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
          <label class="share-field-label">{{ t('mount.shareFolder.fieldsAccessCount') }}</label>
          <Input
            v-model="form.maxViews"
            type="number"
            size="small"
            :placeholder="t('mount.shareFolder.optional')"
            :disabled="saving"
          />
        </div>

        <div class="share-field">
          <label class="share-field-label">{{ t('mount.shareFolder.fieldsSharePassword') }}</label>
          <Input
            v-model="form.password"
            type="password"
            size="small"
            :placeholder="t('mount.shareFolder.optional')"
            :disabled="saving"
          />
        </div>
      </div>

      <div v-if="share" class="link-group">
        <label class="link-label">{{ t('mount.shareFolder.link') }}</label>
        <div class="link-row">
          <Input :model-value="shareUrl" readonly size="small" />
          <Button type="primary" size="small" :disabled="!shareUrl || saving" @click="copyShareUrl">
            {{ t('upload.copy') }}
          </Button>
          <Button
            type="default"
            size="small"
            :disabled="!shareUrl || saving"
            :aria-label="t('mount.shareFolder.qrShow')"
            @click="showQr"
          >
            {{ t('mount.shareFolder.qrShow') }}
          </Button>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="share-footer">
        <div class="share-footer-left">
          <Button v-if="share" type="danger" :disabled="saving" @click="disableShare">
            {{ t('mount.shareFolder.disable') }}
          </Button>
        </div>

        <Button
          v-if="!share"
          type="primary"
          :loading="saving"
          :disabled="loading || !resolvedConfigId"
          @click="createShare"
        >
          {{ t('mount.shareFolder.create') }}
        </Button>
        <Button v-else type="default" :disabled="saving" @click="handleUpdateShow(false)">
          {{ t('common.close') }}
        </Button>
      </div>
    </template>
  </Modal>

  <Modal :show="qrVisible" :title="qrTitle" width="360px" @update:show="handleQrVisibility">
    <div v-if="qrLoading" class="modal-state">{{ t('mount.shareFolder.loading') }}</div>
    <div v-else-if="qrError" class="modal-state">{{ qrError }}</div>
    <template v-else>
      <div class="qr-image-wrap">
        <img v-if="qrDataUrl" class="qr-image" :src="qrDataUrl" alt="" />
      </div>
      <p v-if="share" class="qr-hint">
        {{ t('mount.shareFolder.statsValidity') }}：{{ statsValidity }} ·
        {{ t('mount.shareFolder.statsVisits') }}：{{ statsVisits }}
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
  configId: String,
  prefix: String,
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

const resolvedConfigId = computed(() => String(props.configId ?? '').trim())
const normalizedPrefix = computed(() => String(props.prefix ?? '').trim())
const displayPrefix = computed(() => normalizedPrefix.value || '/')

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

const shareUrl = computed(() => {
  const code = String(share.value?.share_code ?? '').trim()
  if (!code) return ''
  if (typeof window === 'undefined') return `/f/${code}`
  return `${window.location.origin}/f/${code}`
})

const expiresPresetOptions = computed(() => [
  { value: 'never', label: t('mount.shareFolder.neverExpires') },
  { value: '1d', label: t('mount.shareFolder.expire1d') },
  { value: '7d', label: t('mount.shareFolder.expire7d') },
  { value: '30d', label: t('mount.shareFolder.expire30d') },
  { value: 'custom', label: t('mount.shareFolder.expireCustom') },
])

const statsVisits = computed(() => {
  if (!share.value) return '-'
  const views = Number(share.value.views ?? 0)
  const maxViews = Number(share.value.max_views ?? 0)
  const safeViews = Number.isFinite(views) ? views : 0

  if (Number.isFinite(maxViews) && maxViews > 0) {
    return `${safeViews}/${Math.floor(maxViews)}`
  }

  return `${safeViews}/${t('mount.shareFolder.unlimited')}`
})

const statsValidity = computed(() => {
  if (!share.value) return '-'

  const expiresAt = String(share.value.expires_at ?? '').trim()
  if (!expiresAt) return t('mount.shareFolder.neverExpires')

  const formatted = formatDateTime(expiresAt)
  return formatted || '-'
})

const passwordStatus = computed(() => {
  if (share.value?.has_password) return t('mount.shareFolder.passwordSet')
  return t('mount.shareFolder.passwordUnset')
})

const loadShare = async () => {
  const configId = resolvedConfigId.value
  if (!configId) return

  loading.value = true
  try {
    const result = await api.getFolderShare({
      config_id: configId,
      prefix: normalizedPrefix.value,
    })
    share.value = result?.share || null
  } catch (error) {
    message.error(error.response?.data?.error || t('mount.shareFolder.loadFailed'))
  } finally {
    loading.value = false
  }
}

const buildPayload = () => {
  const maxViewsRaw = String(form.value.maxViews ?? '').trim()
  const maxViews = maxViewsRaw ? Number(maxViewsRaw) : 0
  if (!Number.isFinite(maxViews) || maxViews < 0) {
    message.error(t('mount.shareFolder.maxViewsInvalid'))
    return null
  }

  const payload = {
    config_id: resolvedConfigId.value,
    prefix: normalizedPrefix.value,
    max_views: Math.floor(maxViews),
    expires_at: null,
  }

  const preset = String(form.value.expiresPreset ?? 'never')
  if (preset === 'custom') {
    const expiresAt = fromDatetimeLocalValue(form.value.expiresAt)
    if (!expiresAt) {
      message.error(t('mount.shareFolder.expiresRequired'))
      return null
    }
    payload.expires_at = expiresAt
  } else if (preset !== 'never') {
    const days = Number.parseInt(preset.replace('d', ''), 10)
    if (!Number.isFinite(days) || days <= 0) {
      message.error(t('mount.shareFolder.expiresRequired'))
      return null
    }
    payload.expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
  }

  const password = String(form.value.password ?? '').trim()
  if (password) {
    payload.password = password
  }

  return payload
}

const createShare = async () => {
  const configId = resolvedConfigId.value
  if (!configId) return
  if (saving.value) return

  const payload = buildPayload()
  if (!payload) return

  saving.value = true
  try {
    const result = await api.createFolderShare(payload)
    share.value = result?.share || null
    resetForm()
    message.success(t('mount.shareFolder.createSuccess'))
  } catch (error) {
    message.error(error.response?.data?.error || t('mount.shareFolder.createFailed'))
  } finally {
    saving.value = false
  }
}

const disableShare = async () => {
  const configId = resolvedConfigId.value
  if (!configId) return
  if (saving.value) return

  saving.value = true
  try {
    await api.deleteFolderShare({
      config_id: configId,
      prefix: normalizedPrefix.value,
    })
    share.value = null
    resetForm()
    message.success(t('mount.shareFolder.disableSuccess'))
  } catch (error) {
    message.error(error.response?.data?.error || t('mount.shareFolder.disableFailed'))
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
  } catch (_error) {
    message.error(t('mount.shareFolder.copyFailed'))
  }
}

const handleUpdateShow = (value) => {
  emit('update:show', value)
}

// ── 分享链接二维码 ──
// 复用 FileShareModal 的 QRCode.toDataURL 参数风格（errorCorrectionLevel: 'M',
// margin: 1, width: 280），对常规 /f/:code 文件夹分享链接出码。
const qrVisible = ref(false)
const qrLoading = ref(false)
const qrError = ref('')
const qrDataUrl = ref('')

const qrTitle = computed(() => {
  const base = t('mount.shareFolder.qrTitle')
  const scope = displayPrefix.value
  return scope ? `${base} - ${scope}` : base
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
    qrError.value = looksLikeTooLarge
      ? t('mount.shareFolder.qrTooLarge')
      : t('mount.shareFolder.qrFailed')
  } finally {
    qrLoading.value = false
  }
}

const handleQrVisibility = (value) => {
  qrVisible.value = value
}

const resetQrState = () => {
  qrVisible.value = false
  qrLoading.value = false
  qrError.value = ''
  qrDataUrl.value = ''
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
      resetQrState()
    }
  },
  { immediate: true }
)

watch(
  () => [props.configId, props.prefix],
  () => {
    if (props.show) {
      loadShare()
    }
  }
)
</script>

<style scoped>
.modal-state {
  padding: var(--nb-space-md);
  text-align: center;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

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

.folder-share-scope {
  margin: 0 0 var(--nb-space-md);
  font-size: 12px;
  color: var(--nb-muted-foreground, var(--muted-foreground, var(--nb-gray-500)));
  word-break: break-all;
}

.folder-share-scope-value {
  font-family: var(--nb-font-mono, monospace);
  color: var(--nb-ink, var(--foreground, #111));
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
