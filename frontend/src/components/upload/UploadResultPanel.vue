<template>
  <div class="upload-result">
    <Alert type="success">
      <div class="file-info">
        <strong>📄 {{ result.filename }}</strong>
      </div>
      <div class="upload-summary">
        <Tag type="info">{{ result.fileSize }}</Tag>
        <Tag type="success">{{ result.avgSpeed }}</Tag>
        <Tag type="warning">{{ result.duration }}</Tag>
      </div>
      <p class="expire-note">{{ expireText }}</p>

      <div class="link-group">
        <label class="link-label">{{ t('upload.shortLink') }}</label>
        <div class="link-row">
          <Input :model-value="result.shortUrl" readonly size="small" />
          <Button type="primary" size="small" @click="emit('copy-short-url')">
            {{ t('upload.copy') }}
          </Button>
        </div>
      </div>

      <div class="link-group">
        <label class="link-label">{{ t('upload.directLink') }}</label>
        <div class="link-row">
          <Input :model-value="result.downloadUrl" readonly size="small" />
          <Button type="default" size="small" @click="emit('copy-download-url')">
            {{ t('upload.copy') }}
          </Button>
        </div>
      </div>
    </Alert>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import Alert from '../ui/alert/Alert.vue'
import Button from '../ui/button/Button.vue'
import Input from '../ui/input/Input.vue'
import Tag from '../ui/tag/Tag.vue'

defineProps({
  result: { type: Object, required: true },
  expireText: { type: String, required: true },
})

const emit = defineEmits(['copy-short-url', 'copy-download-url'])
const { t } = useI18n({ useScope: 'global' })
</script>

<style scoped>
.upload-result {
  margin-top: var(--nb-space-lg);
}

.file-info {
  margin-bottom: var(--nb-space-md);
  font-size: 15px;
  word-break: break-all;
}

.upload-summary {
  display: flex;
  gap: var(--nb-space-sm);
  flex-wrap: wrap;
  margin-bottom: var(--nb-space-md);
}

.expire-note {
  font-size: 14px;
  color: var(--nb-gray-500);
  margin-bottom: var(--nb-space-md);
}

.link-group {
  margin-bottom: var(--nb-space-md);
}

.link-label {
  display: block;
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-size: 12px;
  text-transform: var(--nb-ui-text-transform, uppercase);
  letter-spacing: var(--nb-ui-letter-spacing, 0.02em);
  color: var(--nb-gray-500);
  margin-bottom: 4px;
}

.link-row {
  display: flex;
  gap: var(--nb-space-sm);
}

.link-row > :first-child {
  flex: 1;
}
</style>
