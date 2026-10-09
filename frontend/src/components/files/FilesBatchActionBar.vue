<template>
  <div
    v-if="count > 0"
    class="files-batch-bar"
    role="region"
    :aria-label="t('files.batch.selected', { count })"
  >
    <span class="files-batch-count">{{ t('files.batch.selected', { count }) }}</span>

    <div class="files-batch-actions">
      <template v-if="isTrashMode">
        <Button
          type="default"
          size="small"
          :loading="submitting && pendingAction === 'restore'"
          :disabled="submitting"
          @click="emit('restore')"
        >
          <RotateCcw :size="16" style="margin-right: 4px" />
          {{ t('files.batch.restore') }}
        </Button>
        <Button
          type="danger"
          size="small"
          :loading="submitting && pendingAction === 'permanent-delete'"
          :disabled="submitting"
          @click="emit('permanent-delete')"
        >
          <Trash2 :size="16" style="margin-right: 4px" />
          {{ t('files.batch.permanentDelete') }}
        </Button>
      </template>
      <template v-else>
        <Button
          type="danger"
          size="small"
          :loading="submitting && pendingAction === 'delete'"
          :disabled="submitting"
          @click="emit('delete')"
        >
          <Trash2 :size="16" style="margin-right: 4px" />
          {{ t('files.batch.delete') }}
        </Button>
      </template>

      <Button type="ghost" size="small" :disabled="submitting" @click="emit('clear')">
        {{ t('files.batch.clear') }}
      </Button>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { RotateCcw, Trash2 } from 'lucide-vue-next'
import Button from '../ui/button/Button.vue'

defineProps({
  count: {
    type: Number,
    default: 0,
  },
  isTrashMode: {
    type: Boolean,
    default: false,
  },
  submitting: {
    type: Boolean,
    default: false,
  },
  pendingAction: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['delete', 'restore', 'permanent-delete', 'clear'])

const { t } = useI18n({ useScope: 'global' })
</script>

<style scoped>
.files-batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--nb-space-sm);
  padding: var(--nb-space-sm) var(--nb-space-md);
  margin-bottom: var(--nb-space-sm);
  border: var(--nb-border-width, 2px) solid var(--nb-border, var(--nb-ink));
  border-radius: var(--nb-radius-sm, 6px);
  background: var(--nb-surface, var(--nb-card-bg, #fff));
}

.files-batch-count {
  font-weight: 700;
}

.files-batch-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--nb-space-sm);
}
</style>
