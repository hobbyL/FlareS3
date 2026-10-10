<template>
  <Modal
    :show="show"
    :title="t('files.modals.uploadTitle')"
    width="760px"
    @update:show="handleUpdateShow"
  >
    <UploadPanel v-if="show" :initial-dir="initialDir" @uploaded="handleUploaded" />
  </Modal>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import Modal from '../ui/modal/Modal.vue'
import UploadPanel from '../upload/UploadPanel.vue'

defineProps({
  show: Boolean,
  // Files 当前目录，透传给 UploadPanel 预填上传目录输入框
  initialDir: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['update:show', 'uploaded'])

const { t } = useI18n({ useScope: 'global' })

const handleUpdateShow = (value) => {
  emit('update:show', value)
}

const handleUploaded = (payload) => {
  emit('uploaded', payload)
}
</script>
