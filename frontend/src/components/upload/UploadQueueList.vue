<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UploadQueueItem from './UploadQueueItem.vue'
import Button from '../ui/button/Button.vue'

const props = defineProps({
  items: { type: Array, default: () => [] },
  paused: { type: Boolean, default: false },
})

const emit = defineEmits(['cancel', 'retry', 'remove', 'pause', 'resume'])
const { t } = useI18n({ useScope: 'global' })

// 仅当存在排队中 / 上传中的任务时才提供暂停/恢复入口；全部终态则无意义
const hasPendingWork = computed(() =>
  props.items.some((item) => item.status === 'queued' || item.status === 'uploading')
)
</script>

<template>
  <section class="upload-queue">
    <header class="upload-queue-header">
      <h3 class="upload-queue-title">{{ t('upload.queue.title') }}</h3>
      <div class="upload-queue-header-right">
        <span v-if="paused" class="upload-queue-paused-tag">{{ t('upload.queue.paused') }}</span>
        <Button
          v-if="hasPendingWork"
          size="small"
          type="default"
          @click="paused ? emit('resume') : emit('pause')"
        >
          {{ paused ? t('upload.queue.actions.resume') : t('upload.queue.actions.pause') }}
        </Button>
        <span class="upload-queue-count">{{ items.length }}</span>
      </div>
    </header>

    <div class="upload-queue-items">
      <UploadQueueItem
        v-for="item in items"
        :key="item.id"
        :item="item"
        @cancel="emit('cancel', $event)"
        @retry="emit('retry', $event)"
        @remove="emit('remove', $event)"
      />
    </div>
  </section>
</template>

<style scoped>
.upload-queue {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-md);
}

.upload-queue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-sm);
}

.upload-queue-header-right {
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
}

.upload-queue-paused-tag {
  font-size: 12px;
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-weight: var(--nb-ui-font-weight-strong, 900);
  color: var(--nb-warning, var(--nb-gray-500));
}

.upload-queue-title {
  margin: 0;
  font-size: 16px;
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-weight: var(--nb-heading-font-weight, 900);
}

.upload-queue-count {
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

.upload-queue-items {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
}
</style>
