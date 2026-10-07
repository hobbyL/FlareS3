<template>
  <Modal
    :show="show"
    :title="t('files.rename.title')"
    width="420px"
    @update:show="handleShowUpdate"
  >
    <div class="file-rename-form">
      <label class="file-rename-label" for="file-rename-input">
        {{ t('files.rename.label') }}
      </label>
      <Input
        id="file-rename-input"
        :model-value="filename"
        :placeholder="t('files.rename.placeholder')"
        size="small"
        @update:model-value="emit('update:filename', $event)"
        @keyup.enter="emit('confirm')"
      />
    </div>

    <template #footer>
      <Button type="default" :disabled="loading" @click="emit('cancel')">
        {{ t('common.cancel') }}
      </Button>
      <Button
        type="primary"
        :loading="loading"
        :disabled="!String(filename || '').trim()"
        @click="emit('confirm')"
      >
        {{ t('files.rename.action') }}
      </Button>
    </template>
  </Modal>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import Button from '../ui/button/Button.vue'
import Input from '../ui/input/Input.vue'
import Modal from '../ui/modal/Modal.vue'

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  filename: {
    type: String,
    default: '',
  },
  loading: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:show', 'update:filename', 'cancel', 'confirm'])
const { t } = useI18n({ useScope: 'global' })

const handleShowUpdate = (nextValue) => {
  if (props.loading) return
  if (!nextValue) {
    emit('cancel')
    return
  }
  emit('update:show', true)
}
</script>

<style scoped>
.file-rename-form {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
}

.file-rename-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--nb-ink);
}
</style>
