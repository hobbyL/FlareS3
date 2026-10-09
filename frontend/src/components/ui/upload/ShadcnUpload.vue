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
    class="shadcn-upload"
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
      <div class="upload-icon">📁</div>
      <div class="upload-text">
        <p class="upload-hint">{{ t('uiUpload.dropHint') }}</p>
        <p class="upload-desc">{{ t('uiUpload.dropDesc') }}</p>
      </div>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.shadcn-upload {
  border: 2px dashed var(--input);
  border-radius: var(--nb-radius-lg);
  padding: 32px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s ease;
  background: var(--background);
}

.shadcn-upload:hover {
  border-color: var(--ring);
  background: color-mix(in oklab, var(--accent) 50%, var(--background));
}

.shadcn-upload.dragging {
  border-color: var(--primary);
  background: color-mix(in oklab, var(--accent) 65%, var(--background));
}

.upload-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.upload-icon {
  font-size: 48px;
  opacity: 0.6;
}

.upload-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.upload-hint {
  font-size: 14px;
  font-weight: var(--nb-font-weight-medium);
  color: var(--foreground);
  margin: 0;
}

.upload-desc {
  font-size: 12px;
  color: var(--muted-foreground);
  margin: 0;
}
</style>
