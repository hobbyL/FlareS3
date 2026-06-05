<template>
  <Modal v-model:show="showProxy" :title="modalTitle" width="560px">
    <div class="form-grid">
      <FormItem :label="t('setup.labels.configType')">
        <Select
          v-model="form.type"
          :options="typeOptions"
          :disabled="normalizedMode === 'edit'"
          size="medium"
        />
      </FormItem>

      <FormItem :label="t('setup.labels.name')">
        <Input v-model="form.name" :placeholder="t('setup.placeholders.name')" />
      </FormItem>

      <FormItem :label="t('setup.labels.endpoint')">
        <Input v-model="form.endpoint" :placeholder="endpointPlaceholder" />
      </FormItem>

      <template v-if="form.type === 'r2'">
        <FormItem :label="t('setup.labels.bucketName')">
          <Input v-model="form.bucket_name" :placeholder="t('setup.placeholders.bucketName')" />
        </FormItem>

        <FormItem :label="t('setup.labels.quotaGb')">
          <Input
            v-model="form.quota_gb"
            type="number"
            :placeholder="t('setup.placeholders.quotaGb')"
          />
        </FormItem>

        <FormItem :label="t('setup.labels.accessKeyId')">
          <Input v-model="form.access_key_id" :placeholder="t('setup.placeholders.accessKeyId')" />
        </FormItem>

        <FormItem :label="t('setup.labels.secretAccessKey')">
          <Input
            v-model="form.secret_access_key"
            type="password"
            password-toggle
            :placeholder="t('setup.placeholders.secretAccessKey')"
          />
        </FormItem>

        <Alert type="info" :title="t('setup.hint.title')">
          <ul class="help-list">
            <li>
              {{ t('setup.hint.endpointFormatPrefix') }}
              <code>https://&lt;account_id&gt;.r2.cloudflarestorage.com</code>
            </li>
            <li>
              {{ t('setup.hint.tokenCreatePrefix') }}
              <strong>R2 &rarr; Manage R2 API Tokens</strong>
              {{ t('setup.hint.tokenCreateSuffix') }}
            </li>
          </ul>
        </Alert>
      </template>

      <template v-else-if="form.type === 'koofr'">
        <FormItem :label="t('setup.labels.remotePath')">
          <Input v-model="form.remote_path" :placeholder="t('setup.placeholders.remotePath')" />
        </FormItem>

        <FormItem :label="t('setup.labels.quotaGb')">
          <Input
            v-model="form.quota_gb"
            type="number"
            :placeholder="t('setup.placeholders.quotaGb')"
          />
        </FormItem>

        <FormItem :label="t('setup.labels.username')">
          <Input v-model="form.username" :placeholder="usernamePlaceholder" />
        </FormItem>

        <FormItem :label="t('setup.labels.password')">
          <Input
            v-model="form.password"
            type="password"
            password-toggle
            :placeholder="t('setup.placeholders.webdavPassword')"
          />
        </FormItem>

        <Alert type="info" :title="t('setup.hint.title')">
          <ul class="help-list">
            <li>
              {{ t('setup.hint.koofrEndpointPrefix') }}
              <code>https://app.koofr.net/dav/Koofr</code>
            </li>
            <li>{{ t('setup.hint.koofrAppPassword') }}</li>
          </ul>
        </Alert>
      </template>

      <template v-else-if="form.type === 'webdav'">
        <FormItem :label="t('setup.labels.remotePath')">
          <Input v-model="form.remote_path" :placeholder="t('setup.placeholders.remotePath')" />
        </FormItem>

        <FormItem :label="t('setup.labels.quotaGb')">
          <Input
            v-model="form.quota_gb"
            type="number"
            :placeholder="t('setup.placeholders.quotaGb')"
          />
        </FormItem>

        <FormItem :label="t('setup.labels.username')">
          <Input v-model="form.username" :placeholder="usernamePlaceholder" />
        </FormItem>

        <FormItem :label="t('setup.labels.password')">
          <Input
            v-model="form.password"
            type="password"
            password-toggle
            :placeholder="t('setup.placeholders.webdavPassword')"
          />
        </FormItem>

        <Alert type="info" :title="t('setup.hint.title')">
          <ul class="help-list">
            <li>{{ t('setup.hint.webdavEndpointHint') }}</li>
          </ul>
        </Alert>
      </template>
    </div>

    <template #footer>
      <Button type="default" @click="showProxy = false">
        {{ t('common.cancel') }}
      </Button>
      <Button type="primary" :loading="submitting" @click="emitSubmit">
        {{ t('setup.modal.save') }}
      </Button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '../ui/modal/Modal.vue'
import FormItem from '../ui/form-item/FormItem.vue'
import Input from '../ui/input/Input.vue'
import Select from '../ui/select/Select.vue'
import Alert from '../ui/alert/Alert.vue'
import Button from '../ui/button/Button.vue'

const props = defineProps({
  show: Boolean,
  mode: { type: String, default: 'create' },
  submitting: Boolean,
  initialValue: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['update:show', 'submit'])

const { t } = useI18n({ useScope: 'global' })

const normalizedMode = computed(() => (props.mode === 'edit' ? 'edit' : 'create'))

const typeOptions = computed(() => [
  { label: 'R2 (S3)', value: 'r2' },
  { label: 'WebDAV', value: 'webdav' },
  { label: 'Koofr', value: 'koofr' },
])

const modalTitle = computed(() => {
  const modeKey = normalizedMode.value === 'create' ? 'createTitle' : 'editTitle'
  return t(`setup.modal.${modeKey}`)
})

const KOOFR_ENDPOINT = 'https://app.koofr.net/dav/Koofr'

const endpointPlaceholder = computed(() => {
  if (form.type === 'koofr') return t('setup.placeholders.koofrEndpoint')
  if (form.type === 'webdav') return t('setup.placeholders.webdavEndpoint')
  return t('setup.placeholders.endpoint')
})

const usernamePlaceholder = computed(() => {
  if (form.type === 'koofr') return t('setup.placeholders.koofrUsername')
  return t('setup.placeholders.webdavUsername')
})

const showProxy = computed({
  get: () => props.show,
  set: (value) => emit('update:show', value),
})

const defaultFormValue = () => ({
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

const form = reactive(defaultFormValue())

const resetForm = () => {
  const next = { ...defaultFormValue(), ...(props.initialValue || {}) }
  Object.assign(form, next)
}

watch(
  () => props.show,
  (show) => {
    if (show) resetForm()
  }
)

watch(
  () => props.mode,
  () => {
    if (props.show) resetForm()
  }
)

watch(
  () => props.initialValue,
  () => {
    if (props.show) resetForm()
  },
  { deep: true }
)

watch(
  () => form.type,
  (type) => {
    if (type === 'koofr' && !form.endpoint) {
      form.endpoint = KOOFR_ENDPOINT
    }
  }
)

const emitSubmit = () => {
  emit('submit', { ...form })
}
</script>

<style scoped>
.form-grid {
  display: grid;
  gap: 8px;
}

.form-grid :deep(.brutal-form-item),
.form-grid :deep(.shadcn-form-item) {
  display: flex;
  align-items: center;
  gap: var(--nb-space-md);
  margin-bottom: 0;
}

.form-grid :deep(.form-label) {
  flex-shrink: 0;
  min-width: 120px;
  margin-bottom: 0;
  white-space: nowrap;
}

.form-grid :deep(.form-content) {
  flex: 1;
  min-width: 0;
}

.help-list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.6;
}

.help-list code {
  background: var(--nb-gray-200);
  padding: 2px 6px;
  font-family: var(--nb-font-mono);
  font-size: 13px;
}
</style>
