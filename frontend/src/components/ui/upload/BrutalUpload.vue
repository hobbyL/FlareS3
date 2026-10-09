<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  multiple: Boolean,
  directory: Boolean,
})

const emit = defineEmits(['file-selected', 'before-upload'])

const isDragging = ref(false)
const fileInput = ref(null)
const { t } = useI18n({ useScope: 'global' })

// webkitdirectory 需作为真实 HTML 属性存在才生效；用 v-bind 对象按需挂载
const directoryAttrs = props.directory ? { webkitdirectory: '', directory: '' } : {}

const onDragOver = (e) => {
  e.preventDefault()
  isDragging.value = true
}

const onDragLeave = () => {
  isDragging.value = false
}

const onDrop = (e) => {
  e.preventDefault()
  isDragging.value = false
  const files = Array.from(e.dataTransfer.files || [])
  if (files.length) {
    handleFiles(files)
  }
}

const onChange = (e) => {
  const files = Array.from(e.target.files || [])
  if (files.length) {
    handleFiles(files)
  }
}

const handleFiles = (files) => {
  const normalizedFiles = (props.multiple ? files : files.slice(0, 1)).map((file) => ({
    file,
    name: file.name,
    type: file.type,
    relativePath: file.webkitRelativePath || '',
  }))

  const shouldContinue = emit('before-upload', { files: normalizedFiles })
  if (shouldContinue !== false) {
    emit('file-selected', { files: normalizedFiles })
  }
}

const clear = () => {
  if (fileInput.value) {
    fileInput.value.value = ''
  }
}

defineExpose({ clear })
</script>

<template>
  <div
    class="brutal-upload"
    :class="{ dragging: isDragging }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @click="fileInput?.click()"
  >
    <input
      ref="fileInput"
      type="file"
      hidden
      :multiple="multiple"
      v-bind="directoryAttrs"
      @change="onChange"
    />
    <div class="upload-content">
      <div class="upload-icon">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
          <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z" />
        </svg>
      </div>
      <div class="upload-text">
        <strong>{{ t('uiUpload.brutalDrag') }}</strong>
        <span>{{ t('uiUpload.brutalOrClick') }}</span>
      </div>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.brutal-upload {
  border: var(--nb-border-width) dashed var(--nb-border-color);
  background: var(--nb-surface);
  padding: var(--nb-space-2xl);
  text-align: center;
  cursor: pointer;
  transition: var(--nb-transition-fast);
  border-radius: var(--nb-radius);
  box-shadow: var(--nb-shadow);
}

.brutal-upload:hover,
.brutal-upload.dragging {
  background: var(--nb-accent);
  border-style: solid;
}

.upload-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--nb-space-md);
}

.upload-icon {
  color: var(--nb-gray-500);
}

.brutal-upload:hover .upload-icon,
.brutal-upload.dragging .upload-icon {
  color: var(--nb-black);
}

.upload-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: var(--nb-font-ui, var(--nb-font-mono));
}

.upload-text strong {
  font-size: 18px;
  text-transform: var(--nb-ui-text-transform, uppercase);
}

.upload-text span {
  color: var(--nb-gray-500);
  font-size: 14px;
}
</style>
