<template>
  <Modal
    :show="show"
    :title="t('mount.crossCopy.title')"
    width="480px"
    @update:show="handleShowUpdate"
  >
    <div class="mount-cross-copy-form">
      <div class="mount-cross-copy-field">
        <label class="mount-cross-copy-label">{{ t('mount.move.currentDir') }}</label>
        <div class="mount-cross-copy-current">{{ currentDirText }}</div>
      </div>

      <div class="mount-cross-copy-field">
        <label class="mount-cross-copy-label" for="mount-cross-copy-config">
          {{ t('mount.crossCopy.destConfig') }}
        </label>
        <Select
          id="mount-cross-copy-config"
          :model-value="destConfigId"
          :options="destConfigOptions"
          :placeholder="t('mount.crossCopy.destConfig')"
          @update:model-value="destConfigId = String($event || '')"
        />
      </div>

      <div class="mount-cross-copy-field">
        <label class="mount-cross-copy-label" for="mount-cross-copy-dir">
          {{ t('mount.crossCopy.destDir') }}
        </label>
        <Input
          id="mount-cross-copy-dir"
          :model-value="destDir"
          :placeholder="t('mount.crossCopy.destDirPlaceholder')"
          @update:model-value="destDir = String($event || '')"
          @keyup.enter="handleConfirm"
        />
      </div>

      <div class="mount-cross-copy-field">
        <Switch
          v-model="deleteSource"
          :checked-text="t('mount.crossCopy.deleteSource')"
          :unchecked-text="t('mount.crossCopy.keepSource')"
        />
      </div>

      <p class="mount-cross-copy-hint">{{ t('mount.crossCopy.sizeHint') }}</p>
    </div>

    <template #footer>
      <Button type="default" :disabled="loading" @click="handleCancel">
        {{ t('common.cancel') }}
      </Button>
      <Button type="primary" :loading="loading" :disabled="!canSubmit" @click="handleConfirm">
        {{ t('mount.crossCopy.action') }}
      </Button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from '../ui/button/Button.vue'
import Input from '../ui/input/Input.vue'
import Modal from '../ui/modal/Modal.vue'
import Select from '../ui/select/Select.vue'
import Switch from '../ui/switch/Switch.vue'

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  sourceKey: {
    type: String,
    default: '',
  },
  sourceName: {
    type: String,
    default: '',
  },
  sourceDir: {
    type: String,
    default: '',
  },
  sourceConfigId: {
    type: String,
    default: '',
  },
  configOptions: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:show', 'cancel', 'confirm'])
const { t } = useI18n({ useScope: 'global' })

const destConfigId = ref('')
const destDir = ref('')
// 默认保留源（纯复制）；勾选后为迁移语义（复制成功后删源）
const deleteSource = ref(false)

const currentDirText = computed(() => String(props.sourceDir || '') || t('mount.move.rootDir'))

// 目标配置下拉排除源配置（同配置复制无意义，服务端同样 400 拦截）
const destConfigOptions = computed(() =>
  (props.configOptions || []).filter((option) => option.value !== props.sourceConfigId)
)

const canSubmit = computed(() => Boolean(destConfigId.value.trim()))

const resetState = () => {
  destConfigId.value = ''
  destDir.value = ''
  deleteSource.value = false
}

const handleConfirm = () => {
  if (!canSubmit.value || props.loading) return
  emit('confirm', {
    destConfigId: destConfigId.value.trim(),
    destDir: destDir.value.trim(),
    deleteSourceAfterCopy: deleteSource.value,
  })
}

const handleCancel = () => {
  if (props.loading) return
  emit('cancel')
}

const handleShowUpdate = (nextValue) => {
  if (props.loading) return
  if (!nextValue) {
    emit('cancel')
    return
  }
  emit('update:show', true)
}

// v-if 挂载 + watch(show, immediate)：每次打开重置
watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    resetState()
  },
  { immediate: true }
)
</script>

<style scoped>
.mount-cross-copy-form {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-md);
}

.mount-cross-copy-field {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-xs);
}

.mount-cross-copy-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--nb-ink);
}

.mount-cross-copy-current {
  font-size: 0.875rem;
  color: var(--nb-muted-foreground, var(--nb-gray-600));
  word-break: break-all;
}

.mount-cross-copy-hint {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--nb-muted-foreground, var(--nb-gray-600));
}
</style>
