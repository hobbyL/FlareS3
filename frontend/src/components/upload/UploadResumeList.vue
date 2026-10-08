<script setup>
import { useI18n } from 'vue-i18n'
import Card from '../ui/card/Card.vue'
import Button from '../ui/button/Button.vue'
import Progress from '../ui/progress/Progress.vue'

defineProps({
  items: { type: Array, default: () => [] },
  formatBytes: { type: Function, required: true },
  formatDateTime: { type: Function, required: true },
})

const emit = defineEmits(['resume', 'discard'])
const { t } = useI18n({ useScope: 'global' })

// 本地估算值，点「继续上传」后由服务端 listParts 校正，仅用于展示
const resolvePercentage = (item) => {
  const total = Number(item?.totalParts || 0)
  if (total <= 0) return 0
  const uploaded = Array.isArray(item?.uploadedParts) ? item.uploadedParts.length : 0
  return Math.max(0, Math.min(100, Math.round((uploaded / total) * 100)))
}

const resolveUploadedParts = (item) =>
  Array.isArray(item?.uploadedParts) ? item.uploadedParts.length : 0
</script>

<template>
  <section class="upload-resume">
    <header class="upload-resume-header">
      <h3 class="upload-resume-title">{{ t('upload.resume.title') }}</h3>
      <span class="upload-resume-count">{{ items.length }}</span>
    </header>

    <p class="upload-resume-hint">{{ t('upload.resume.reselectHint') }}</p>

    <div class="upload-resume-items">
      <Card v-for="item in items" :key="item.fileId" class="upload-resume-item">
        <div class="upload-resume-item-main">
          <strong class="upload-resume-item-name">{{ item.filename }}</strong>
        </div>

        <Progress :percentage="resolvePercentage(item)" :height="10" :show-indicator="false" />

        <div class="upload-resume-item-meta">
          <span>{{ formatBytes(item.size) }}</span>
          <span>
            {{
              t('upload.resume.partsProgress', {
                uploaded: resolveUploadedParts(item),
                total: item.totalParts,
              })
            }}
          </span>
          <span>{{ resolvePercentage(item) }}%</span>
          <span>
            {{ t('upload.resume.lastUploadAt', { time: formatDateTime(item.lastUploadAt) }) }}
          </span>
        </div>

        <div class="upload-resume-item-actions">
          <Button
            size="small"
            type="default"
            :aria-label="`${t('upload.resume.actions.resume')} ${item.filename}`"
            @click="emit('resume', item.fileId)"
          >
            {{ t('upload.resume.actions.resume') }}
          </Button>
          <Button
            size="small"
            type="danger"
            :aria-label="`${t('upload.resume.actions.discard')} ${item.filename}`"
            @click="emit('discard', item.fileId)"
          >
            {{ t('upload.resume.actions.discard') }}
          </Button>
        </div>
      </Card>
    </div>
  </section>
</template>

<style scoped>
.upload-resume {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
  min-width: 0;
  max-width: 100%;
}

.upload-resume-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-sm);
}

.upload-resume-title {
  margin: 0;
  font-size: 16px;
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-weight: var(--nb-heading-font-weight, 900);
}

.upload-resume-count {
  min-width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--nb-border);
  border-radius: 999px;
  font-size: 12px;
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-weight: var(--nb-ui-font-weight-strong, 900);
  background: var(--nb-surface);
}

.upload-resume-hint {
  margin: 0;
  font-size: 12px;
  color: var(--nb-gray-500);
}

.upload-resume-items {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
}

.upload-resume-item {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
}

.upload-resume-item-main {
  min-width: 0;
  flex: 1;
}

.upload-resume-item-name {
  display: block;
  word-break: break-all;
}

.upload-resume-item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nb-space-sm);
  font-size: 12px;
  color: var(--nb-gray-500);
}

.upload-resume-item-actions {
  display: flex;
  gap: var(--nb-space-sm);
  justify-content: flex-end;
  flex-wrap: wrap;
}
</style>
