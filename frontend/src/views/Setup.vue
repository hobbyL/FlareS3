<template>
  <AppLayout>
    <div class="setup-page">
      <header class="setup-header">
        <div class="setup-title-group">
          <div class="setup-title-row">
            <h1 class="setup-title">{{ t('setup.title') }}</h1>
            <Button
              type="ghost"
              size="small"
              class="setup-help-btn"
              :aria-label="t('setup.help')"
              @click="usageTipsVisible = true"
            >
              <AlertTriangle :size="18" />
            </Button>
          </div>
          <p class="setup-subtitle">
            {{ t('setup.subtitle') }}
          </p>
        </div>

        <div class="setup-actions">
          <Button type="primary" size="large" @click="openCreate">
            <Plus :size="18" style="margin-right: 6px" />
            {{ t('setup.actions.addConfig') }}
          </Button>
          <Button type="default" size="large" :loading="loading" @click="refresh">
            <RefreshCw :size="18" style="margin-right: 6px" />
            {{ t('setup.actions.refreshList') }}
          </Button>
        </div>
      </header>

      <section class="config-list">
        <div v-if="loading" class="config-state">{{ t('setup.state.loading') }}</div>

        <Alert v-else-if="allConfigs.length === 0" type="info" :title="t('setup.state.emptyTitle')">
          {{ t('setup.state.emptyContent') }}
        </Alert>

        <div v-else class="config-cards">
          <Card
            v-for="row in allConfigs"
            :key="row.id"
            header-bg="var(--nb-surface)"
            header-color="var(--nb-ink)"
            class="config-card-item"
          >
            <template #header>
              <div class="config-card-header">
                <span class="config-card-icon">
                  <Database :size="18" />
                </span>

                <div class="config-card-title">
                  <span class="config-card-name">{{ toDisplayText(row.name) }}</span>
                </div>
              </div>
            </template>

            <template #header-extra>
              <div class="config-card-tags">
                <Tag :type="getConfigTypeTagType(row.configType)" size="small">
                  {{ formatConfigType(row.configType) }}
                </Tag>
                <Tag v-if="row.configType === 'r2'" :type="getSourceTagType(row.source)" size="small">
                  {{ formatSource(row.source) }}
                </Tag>

                <Tag v-if="row.configType === 'r2' && row.id === r2Options.default_config_id" type="success" size="small">
                  {{ t('setup.state.defaultTag') }}
                </Tag>
              </div>
            </template>

            <div class="config-detail">
              <div class="kv-group">
                <!-- R2 specific fields -->
                <template v-if="row.configType === 'r2'">
                  <div class="kv-row">
                    <div class="kv-label">{{ t('setup.labels.bucket') }}</div>
                    <div class="kv-value">
                      <span class="text-ellipsis">
                        {{ toDisplayText(row.bucket_name) }}
                      </span>
                    </div>
                  </div>
                </template>

                <!-- WebDAV / Koofr specific fields -->
                <template v-else>
                  <div v-if="row.remote_path && row.remote_path !== '/'" class="kv-row">
                    <div class="kv-label">{{ t('setup.labels.remotePath') }}</div>
                    <div class="kv-value">
                      <span class="text-ellipsis">
                        {{ row.remote_path }}
                      </span>
                    </div>
                  </div>
                </template>

                <div class="kv-row">
                  <div class="kv-label">Endpoint</div>
                  <div class="kv-value kv-mono">
                    <code class="mono-chip">{{ toDisplayText(row.endpoint) }}</code>
                  </div>
                </div>
              </div>

              <div v-if="row.totalSpaceFormatted && row.usedSpaceFormatted" class="usage-panel">
                <div class="usage-metrics">
                  <div class="usage-metric">
                    <div class="usage-label">{{ t('setup.labels.totalSpace') }}</div>
                    <div class="usage-value">{{ row.totalSpaceFormatted }}</div>
                  </div>
                  <div class="usage-metric">
                    <div class="usage-label">{{ t('setup.labels.usedSpace') }}</div>
                    <div class="usage-value">{{ row.usedSpaceFormatted }}</div>
                  </div>
                  <div class="usage-metric">
                    <div class="usage-label">{{ t('setup.labels.usagePercent') }}</div>
                    <div class="usage-value" :style="{ color: getUsageColor(row.usagePercent) }">
                      {{ formatUsagePercent(row.usagePercent) }}
                    </div>
                  </div>
                </div>

                <Progress
                  :percentage="clampProgressPercent(row.usagePercent)"
                  :color="getUsageColor(row.usagePercent)"
                  :height="10"
                  :show-indicator="false"
                />
              </div>

              <div class="kv-divider" />

              <div class="kv-group kv-group-compact">
                <div class="kv-row">
                  <div class="kv-label">{{ t('setup.labels.configId') }}</div>
                  <div class="kv-value kv-mono">
                    <code class="mono-chip">{{ toDisplayText(row.id) }}</code>
                  </div>
                </div>
              </div>
            </div>

            <template #footer>
              <div class="config-actions">
                <Button
                  type="default"
                  size="small"
                  :loading="testingId === row.id"
                  :disabled="loading || testingId === row.id"
                  :aria-label="t('setup.aria.testConnection')"
                  @click="handleTest(row)"
                >
                  <Network :size="14" />
                </Button>

                <template v-if="row.configType === 'r2'">
                  <div class="action-divider"></div>

                  <Button
                    type="default"
                    size="small"
                    :loading="savingDefault && settingDefaultId === row.id"
                    :disabled="loading || savingDefault || row.id === r2Options.default_config_id"
                    :aria-label="t('setup.aria.setDefault')"
                    @click="handleSetDefault(row.id)"
                  >
                    <Star
                      :size="14"
                      :fill="row.id === r2Options.default_config_id ? 'currentColor' : 'none'"
                    />
                  </Button>
                </template>

                <div class="action-divider"></div>

                <Button
                  type="default"
                  size="small"
                  :disabled="row.configType === 'r2' && row.source !== 'db'"
                  :aria-label="
                    row.configType === 'r2' && row.source !== 'db'
                      ? t('setup.aria.notEditable')
                      : t('setup.aria.edit')
                  "
                  @click="openEdit(row)"
                >
                  <Pencil :size="14" />
                </Button>

                <Button
                  type="danger"
                  size="small"
                  :aria-label="t('setup.aria.delete')"
                  @click="handleDelete(row)"
                >
                  <Trash2 :size="14" />
                </Button>
              </div>
            </template>
          </Card>
        </div>
      </section>

      <StorageConfigModal
        v-model:show="modalVisible"
        :mode="modalMode"
        :submitting="modalSubmitting"
        :initial-value="modalInitialValue"
        @submit="handleSubmit"
      />

      <UsageTipsModal v-model:show="usageTipsVisible" />
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import {
  AlertTriangle,
  Database,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Network,
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import api from '../services/api'
import AppLayout from '../components/layout/AppLayout.vue'
import StorageConfigModal from '../components/setup/StorageConfigModal.vue'
import UsageTipsModal from '../components/setup/UsageTipsModal.vue'
import Card from '../components/ui/card/Card.vue'
import Button from '../components/ui/button/Button.vue'
import Alert from '../components/ui/alert/Alert.vue'
import Tag from '../components/ui/tag/Tag.vue'
import Progress from '../components/ui/progress/Progress.vue'
import { useMessage } from '../composables/useMessage'

const message = useMessage()
const { t } = useI18n({ useScope: 'global' })

const loading = ref(false)
const savingDefault = ref(false)

const testingId = ref('')
const settingDefaultId = ref('')

const r2Options = ref({
  default_config_id: null,
  legacy_files_config_id: null,
  options: [],
})

const storageConfigs = ref([])

const allConfigs = computed(() => {
  return storageConfigs.value.map((row) => ({
    ...row,
    configType: row.type, // 'r2' | 'webdav' | 'koofr'
  }))
})

const modalVisible = ref(false)
const modalMode = ref('create')
const modalSubmitting = ref(false)
const editingId = ref('')
const editingConfigType = ref('r2')
const usageTipsVisible = ref(false)

const defaultModalInitialValue = () => ({
  type: 'r2',
  name: '',
  endpoint: '',
  bucket_name: '',
  quota_gb: '10',
  access_key_id: '',
  secret_access_key: '',
  remote_path: '/',
  username: '',
  password: '',
})
const modalInitialValue = ref(defaultModalInitialValue())
const editingCredentials = ref({
  access_key_id: '',
  secret_access_key: '',
  username: '',
  password: '',
})

const resetEditingCredentials = () => {
  editingCredentials.value = {
    access_key_id: '',
    secret_access_key: '',
    username: '',
    password: '',
  }
}

const formatConfigType = (type) => {
  if (type === 'r2') return 'R2'
  if (type === 'koofr') return 'Koofr'
  if (type === 'webdav') return 'WebDAV'
  return type
}

const getConfigTypeTagType = (type) => {
  if (type === 'r2') return 'info'
  if (type === 'koofr') return 'warning'
  if (type === 'webdav') return 'default'
  return 'default'
}

const formatSource = (source) => {
  if (source === 'legacy') return 'LEGACY'
  return 'DB'
}

const getSourceTagType = (source) => {
  if (source === 'legacy') return 'warning'
  return 'default'
}

const toDisplayText = (value) => {
  if (value === null || value === undefined || value === '') return '-'
  return String(value)
}

const formatUsagePercent = (percent) => {
  const value = Number(percent)
  if (!Number.isFinite(value) || value <= 0) return '0%'
  return `${Math.round(value)}%`
}

const clampProgressPercent = (percent) => {
  const value = Number(percent)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.max(0, Math.min(100, value))
}

const getUsageColor = (percent) => {
  const value = Number(percent)
  if (!Number.isFinite(value)) return undefined
  if (value > 90) return 'var(--nb-danger)'
  if (value > 70) return 'var(--nb-warning)'
  return 'var(--nb-success)'
}

const refresh = async () => {
  loading.value = true
  try {
    const storageResult = await api.getStorageConfigs()
    const configs = storageResult.configs || []

    r2Options.value = {
      default_config_id: storageResult.default_config_id || null,
      legacy_files_config_id: storageResult.legacy_files_config_id || null,
      options: configs
        .filter((row) => row.type === 'r2')
        .map((row) => ({ id: row.id, name: row.name, source: row.source })),
    }
    storageConfigs.value = configs
  } catch (error) {
    message.error(error.response?.data?.error || t('setup.messages.loadFailed'))
  } finally {
    loading.value = false
  }
}

const handleSetDefault = async (id) => {
  if (!id) return

  try {
    savingDefault.value = true
    settingDefaultId.value = id
    await api.setDefaultR2Config(id)
    message.success(t('setup.messages.defaultUpdated'))
    await refresh()
  } catch (error) {
    message.error(error.response?.data?.error || t('setup.messages.setDefaultFailed'))
  } finally {
    savingDefault.value = false
    settingDefaultId.value = ''
  }
}

const handleTest = async (row) => {
  try {
    testingId.value = row.id
    let result
    if (row.configType === 'r2') {
      result = await api.testR2Config(row.id)
    } else {
      result = await api.testWebDAVConfig(row.id)
    }
    if (result?.success) message.success(result.message || t('setup.messages.testSuccess'))
    else message.error(result?.message || t('setup.messages.testFailed'))
  } catch (error) {
    message.error(error.response?.data?.message || t('setup.messages.testFailed'))
  } finally {
    testingId.value = ''
  }
}

const openCreate = () => {
  modalMode.value = 'create'
  editingId.value = ''
  editingConfigType.value = 'r2'
  resetEditingCredentials()
  modalInitialValue.value = defaultModalInitialValue()
  modalVisible.value = true
}

const openEdit = async (row) => {
  modalMode.value = 'edit'
  editingId.value = row.id
  editingConfigType.value = row.configType
  let credentials = null

  try {
    credentials = await api.getStorageConfigSecrets(row.id, row.configType)
  } catch (error) {
    message.error(error.response?.data?.error || t('setup.messages.loadSecretsFailed'))
  }

  resetEditingCredentials()

  if (row.configType === 'r2') {
    const accessKeyId = credentials?.access_key_id || row.access_key_id || ''
    const secretAccessKey = credentials?.secret_access_key || row.secret_access_key || ''
    editingCredentials.value = {
      access_key_id: accessKeyId,
      secret_access_key: secretAccessKey,
      username: '',
      password: '',
    }
    modalInitialValue.value = {
      type: 'r2',
      name: row.name || '',
      endpoint: row.endpoint || '',
      bucket_name: row.bucket_name || '',
      quota_gb: row.totalSpace ? formatQuotaGb(row.totalSpace) : '10',
      access_key_id: accessKeyId,
      secret_access_key: secretAccessKey,
      remote_path: '/',
      username: '',
      password: '',
    }
  } else {
    const username = credentials?.username || row.username || ''
    const password = credentials?.password || row.password || ''
    editingCredentials.value = {
      access_key_id: '',
      secret_access_key: '',
      username,
      password,
    }
    modalInitialValue.value = {
      type: row.configType,
      name: row.name || '',
      endpoint: row.endpoint || '',
      bucket_name: '',
      quota_gb: row.totalSpace ? formatQuotaGb(row.totalSpace) : '10',
      access_key_id: '',
      secret_access_key: '',
      remote_path: row.remote_path || '/',
      username,
      password,
    }
  }

  modalVisible.value = true
}

const formatQuotaGb = (bytesValue) => {
  const bytes = Number(bytesValue)
  if (!Number.isFinite(bytes) || bytes <= 0) return '10'
  const gb = bytes / (1024 * 1024 * 1024)
  const rounded = Math.round(gb * 100) / 100
  return String(rounded)
}

const handleSubmit = async (submittedForm) => {
  const formType = submittedForm?.type || 'r2'

  // Common validation
  if (!submittedForm?.name || !submittedForm?.endpoint) {
    message.error(t('setup.validation.required'))
    return
  }

  const quotaGb = Number(String(submittedForm.quota_gb ?? '').trim())
  if (!Number.isFinite(quotaGb) || quotaGb <= 0) {
    message.error(t('setup.validation.quotaInvalid'))
    return
  }
  const quotaBytes = Math.round(quotaGb * 1024 * 1024 * 1024)
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) {
    message.error(t('setup.validation.quotaInvalid'))
    return
  }

  // R2 specific validation
  if (formType === 'r2') {
    if (!submittedForm.bucket_name) {
      message.error(t('setup.validation.required'))
      return
    }
    if (modalMode.value === 'create') {
      if (!submittedForm.access_key_id || !submittedForm.secret_access_key) {
        message.error(t('setup.validation.createNeedKeys'))
        return
      }
    }
  }

  // mount_id auto-detect, remote_path optional

  // WebDAV / Koofr credential validation on create
  if ((formType === 'webdav' || formType === 'koofr') && modalMode.value === 'create') {
    if (!submittedForm.username || !submittedForm.password) {
      message.error(t('setup.validation.createNeedCredentials'))
      return
    }
  }

  try {
    modalSubmitting.value = true

    if (formType === 'r2') {
      if (modalMode.value === 'create') {
        await api.createR2Config({
          name: submittedForm.name,
          endpoint: submittedForm.endpoint,
          access_key_id: submittedForm.access_key_id,
          secret_access_key: submittedForm.secret_access_key,
          bucket_name: submittedForm.bucket_name,
          quota_bytes: quotaBytes,
        })
        message.success(t('setup.messages.createSuccess'))
      } else {
        const payload = {
          name: submittedForm.name,
          endpoint: submittedForm.endpoint,
          bucket_name: submittedForm.bucket_name,
          quota_bytes: quotaBytes,
        }

        if (
          submittedForm.access_key_id &&
          submittedForm.access_key_id !== editingCredentials.value.access_key_id
        ) {
          payload.access_key_id = submittedForm.access_key_id
        }
        if (
          submittedForm.secret_access_key &&
          submittedForm.secret_access_key !== editingCredentials.value.secret_access_key
        ) {
          payload.secret_access_key = submittedForm.secret_access_key
        }

        await api.updateR2Config(editingId.value, payload)
        message.success(t('setup.messages.updateSuccess'))
      }
    } else {
      // WebDAV / Koofr
      if (modalMode.value === 'create') {
        await api.createWebDAVConfig({
          name: submittedForm.name,
          type: formType,
          endpoint: submittedForm.endpoint,
          remote_path: submittedForm.remote_path || undefined,
          username: submittedForm.username,
          password: submittedForm.password,
          quota_bytes: quotaBytes,
        })
        message.success(t('setup.messages.createSuccess'))
      } else {
        const payload = {
          name: submittedForm.name,
          endpoint: submittedForm.endpoint,
          quota_bytes: quotaBytes,
        }

        if (formType === 'koofr' || formType === 'webdav') {
          payload.remote_path = submittedForm.remote_path || '/'
        }

        if (
          submittedForm.username &&
          submittedForm.username !== editingCredentials.value.username
        ) {
          payload.username = submittedForm.username
        }
        if (
          submittedForm.password &&
          submittedForm.password !== editingCredentials.value.password
        ) {
          payload.password = submittedForm.password
        }

        await api.updateWebDAVConfig(editingId.value, payload)
        message.success(t('setup.messages.updateSuccess'))
      }
    }

    modalVisible.value = false
    await refresh()
  } catch (error) {
    message.error(error.response?.data?.error || t('setup.messages.saveFailed'))
  } finally {
    modalSubmitting.value = false
  }
}

const handleDelete = async (row) => {
  if (!confirm(t('setup.messages.deleteConfirm'))) return

  try {
    if (row.configType === 'r2') {
      await api.deleteR2Config(row.id)
    } else {
      await api.deleteWebDAVConfig(row.id)
    }
    message.success(t('setup.messages.deleteSuccess'))
    await refresh()
  } catch (error) {
    message.error(error.response?.data?.error || t('setup.messages.deleteFailed'))
  }
}

onMounted(() => refresh())
</script>

<style scoped>
.setup-page {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.setup-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--nb-space-lg);
}

.setup-title-group {
  min-width: 0;
}

.setup-title-row {
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
}

.setup-title {
  margin: 0;
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-weight: var(--nb-heading-font-weight, 900);
  font-size: var(--nb-font-size-2xl);
  line-height: 1.2;
}

.setup-help-btn {
  padding: 0 10px;
  height: 32px;
}

.setup-help-btn :deep(svg) {
  width: 18px;
  height: 18px;
}

.setup-subtitle {
  margin: var(--nb-space-sm) 0 0;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: var(--nb-font-size-sm);
}

.setup-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--nb-space-sm);
  flex-wrap: wrap;
}

.config-list {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.config-state {
  text-align: center;
  padding: var(--nb-space-2xl);
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-family: var(--nb-font-ui, var(--nb-font-mono));
}

.config-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--nb-space-lg);
}

.config-card-header {
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
  min-width: 0;
}

.config-card-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--nb-radius-md, var(--nb-radius));
  background: var(--nb-secondary);
  border: var(--nb-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--nb-warning);
  flex-shrink: 0;
}

:root[data-ui-theme='shadcn'] .config-card-icon {
  background: var(--nb-gray-50);
}

.config-card-title {
  min-width: 0;
  flex: 1;
}

.config-card-name {
  font-size: var(--nb-font-size-lg);
  font-weight: var(--nb-font-weight-semibold, 600);
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.config-card-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.config-detail {
  margin-top: var(--nb-space-sm);
}

.usage-panel {
  margin-top: var(--nb-space-sm);
  padding: var(--nb-space-sm);
  border: var(--nb-border);
  border-radius: var(--nb-radius);
  background: var(--nb-gray-100);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

:root[data-ui-theme='shadcn'] .usage-panel {
  background: var(--nb-gray-50);
}

:root[data-ui-theme='shadcn'] .usage-panel :deep(.progress-container) {
  border: 1px solid var(--border);
  box-sizing: border-box;
}

.usage-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.usage-label {
  color: var(--nb-gray-500);
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-size: 12px;
  font-weight: var(--nb-ui-font-weight, 700);
  text-transform: var(--nb-ui-text-transform, uppercase);
}

:root[data-ui-theme='shadcn'] .usage-label {
  text-transform: none;
  letter-spacing: 0;
}

.usage-value {
  margin-top: 2px;
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-weight: var(--nb-ui-font-weight-strong, 900);
  font-size: 13px;
  color: var(--nb-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kv-group {
  display: flex;
  flex-direction: column;
}

.kv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-sm);
  padding: 6px 0;
  border-bottom: var(--nb-border);
}

.kv-row:last-child {
  border-bottom: none;
}

.kv-label {
  color: var(--nb-gray-500);
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-size: 12px;
  font-weight: var(--nb-ui-font-weight, 700);
  text-transform: var(--nb-ui-text-transform, uppercase);
  flex-shrink: 0;
}

:root[data-ui-theme='shadcn'] .kv-label {
  text-transform: none;
  letter-spacing: 0;
}

.kv-value {
  text-align: right;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  color: var(--nb-ink);
}

.text-ellipsis {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kv-mono {
  text-align: right;
}

.mono-chip {
  font-family: var(--nb-font-mono);
  font-size: 12px;
  padding: 2px 6px;
  border-radius: var(--nb-radius-sm, var(--nb-radius));
  background: var(--nb-gray-100);
  border: var(--nb-border);
  display: inline-block;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}

:root[data-ui-theme='shadcn'] .mono-chip {
  background: var(--nb-gray-50);
}

.kv-divider {
  border-top: var(--nb-border);
  margin: var(--nb-space-xs) 0;
}

.kv-group-compact .kv-row {
  padding: 4px 0;
}

.config-actions {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: flex-end;
}

.action-divider {
  width: 1px;
  height: 16px;
  background-color: var(--nb-border-color);
  margin: 0 2px;
}

@media (max-width: 768px) {
  .setup-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .setup-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
  }

  .setup-actions > * {
    width: 100%;
    min-width: 0;
  }

  .config-cards {
    grid-template-columns: minmax(0, 1fr);
  }

  .config-card-tags {
    justify-content: flex-start;
  }

  .usage-metrics {
    grid-template-columns: minmax(0, 1fr);
  }

  .kv-row {
    flex-direction: column;
    align-items: flex-start;
  }

  .kv-value,
  .kv-mono {
    width: 100%;
    text-align: left;
  }

  .config-actions {
    width: 100%;
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}
</style>
