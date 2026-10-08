<template>
  <Modal :show="show" :title="title" width="420px" @update:show="emit('update:show', $event)">
    <p class="upload-resume-discard-confirm">
      {{ confirmText }}
    </p>

    <template #footer>
      <Button type="default" :disabled="discarding" @click="emit('cancel')">
        {{ t('common.cancel') }}
      </Button>
      <Button type="danger" :loading="discarding" @click="emit('confirm')">
        {{ t('upload.resume.actions.discard') }}
      </Button>
    </template>
  </Modal>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import Button from '../ui/button/Button.vue'
import Modal from '../ui/modal/Modal.vue'

defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    required: true,
  },
  confirmText: {
    type: String,
    required: true,
  },
  discarding: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:show', 'cancel', 'confirm'])
const { t } = useI18n({ useScope: 'global' })
</script>

<style scoped>
.upload-resume-discard-confirm {
  margin: 0;
  line-height: 1.6;
  color: var(--nb-ink);
  word-break: break-word;
}
</style>
