<template>
  <div>
    <div v-if="initialLoading && rows.length === 0" class="mount-state">
      {{ t('mount.state.loading') }}
    </div>
    <div v-else-if="rows.length === 0" class="mount-state">
      {{ t('mount.state.empty') }}
    </div>
    <div v-else class="mount-cards-section">
      <div class="mount-cards">
        <Card
          v-for="row in rows"
          :key="`${row.kind}:${row.key}`"
          header-bg="var(--nb-surface)"
          header-color="var(--nb-ink)"
          class="mount-card"
        >
          <template #header>
            <div class="mount-card-header">
              <span class="mount-card-icon">
                <FolderOpen v-if="row.kind === 'folder'" :size="18" />
                <File v-else :size="18" />
              </span>

              <div class="mount-card-title-wrap">
                <Tooltip :content="row.key">
                  <button
                    v-if="row.kind === 'folder'"
                    type="button"
                    class="mount-card-title mount-card-title-btn"
                    :disabled="loading || deleting"
                    @click.stop="emit('open-folder', row.key)"
                  >
                    {{ `${row.name}/` }}
                  </button>
                  <span v-else class="mount-card-title">{{ row.name }}</span>
                </Tooltip>
              </div>
            </div>
          </template>

          <template #header-extra>
            <div class="mount-card-actions">
              <template v-if="row.kind === 'folder'">
                <Tooltip :content="t('mount.actions.open')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn"
                    :disabled="loading || deleting"
                    @click.stop="emit('open-folder', row.key)"
                  >
                    <FolderOpen :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('mount.actions.delete')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn danger-icon-btn"
                    :disabled="loading || deleting"
                    :loading="deleting && deletingKey === row.key"
                    @click.stop="emit('delete', row.key)"
                  >
                    <Trash2 :size="18" />
                  </Button>
                </Tooltip>
              </template>

              <template v-else>
                <Tooltip :content="t('mount.actions.preview')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn"
                    :disabled="loading || deleting || !isPreviewSupported(row.key)"
                    @click.stop="emit('preview', row.key)"
                  >
                    <Eye :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('mount.actions.download')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn"
                    :disabled="loading || deleting"
                    @click.stop="emit('download', row.key)"
                  >
                    <Download :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('mount.move.actionRename')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn"
                    :disabled="loading || deleting"
                    @click.stop="emit('rename', row.key)"
                  >
                    <Pencil :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('mount.move.actionMove')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn"
                    :disabled="loading || deleting"
                    @click.stop="emit('move', row.key)"
                  >
                    <FolderInput :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('mount.actions.delete')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn danger-icon-btn"
                    :disabled="loading || deleting"
                    :loading="deleting && deletingKey === row.key"
                    @click.stop="emit('delete', row.key)"
                  >
                    <Trash2 :size="18" />
                  </Button>
                </Tooltip>
              </template>
            </div>
          </template>

          <div class="mount-card-body">
            <div class="mount-card-line">
              <span class="mount-card-label">{{ t('mount.table.size') }}</span>
              <span class="mount-card-value">
                {{ row.kind === 'object' ? formatBytes(row.size) : '-' }}
              </span>
            </div>
            <div class="mount-card-line">
              <span class="mount-card-label">{{ t('mount.table.lastModified') }}</span>
              <Tooltip :content="row.kind === 'object' ? formatDateTime(row.last_modified) : '-'">
                <span class="mount-card-value">
                  {{ row.kind === 'object' ? formatDateTime(row.last_modified) : '-' }}
                </span>
              </Tooltip>
            </div>
          </div>
        </Card>
      </div>

      <div v-if="hasMore" class="mount-load-more">
        <Button
          type="default"
          size="small"
          class="load-more-btn"
          :loading="loading && activeAction === 'loadMore'"
          :disabled="loading || deleting"
          @click="emit('load-more')"
        >
          {{ t('common.loadMore') }}
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { Download, Eye, File, FolderInput, FolderOpen, Pencil, Trash2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import Button from '../ui/button/Button.vue'
import Card from '../ui/card/Card.vue'
import Tooltip from '../ui/tooltip/Tooltip.vue'

defineProps({
  rows: {
    type: Array,
    required: true,
  },
  loading: {
    type: Boolean,
    default: false,
  },
  initialLoading: {
    type: Boolean,
    default: false,
  },
  hasMore: {
    type: Boolean,
    default: false,
  },
  activeAction: {
    type: String,
    default: '',
  },
  deleting: {
    type: Boolean,
    default: false,
  },
  deletingKey: {
    type: String,
    default: '',
  },
  isPreviewSupported: {
    type: Function,
    required: true,
  },
  formatBytes: {
    type: Function,
    required: true,
  },
  formatDateTime: {
    type: Function,
    required: true,
  },
})

const emit = defineEmits([
  'open-folder',
  'preview',
  'download',
  'rename',
  'move',
  'delete',
  'load-more',
])
const { t } = useI18n({ useScope: 'global' })
</script>

<style scoped>
.mount-state {
  padding: var(--nb-space-md);
  text-align: center;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

.mount-cards-section {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.mount-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--nb-space-lg);
}

.mount-load-more {
  display: flex;
  justify-content: center;
  padding: var(--nb-space-md) 0;
  width: 100%;
}

.load-more-btn {
  min-width: 120px;
}

.mount-card {
  transition: all 0.2s ease;
}

.mount-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.mount-card :deep(.card-header) {
  gap: 0;
}

.mount-card :deep(.header-extra) {
  max-width: 0;
  margin-left: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transition:
    max-width 0.2s ease,
    margin-left 0.2s ease,
    opacity 0.2s ease;
}

.mount-card:hover :deep(.header-extra),
.mount-card:focus-within :deep(.header-extra) {
  max-width: 88px;
  margin-left: var(--nb-space-xs);
  opacity: 1;
  pointer-events: auto;
}

/* 对象卡（≥3 个操作按钮）需要更宽的悬浮操作区 */
.mount-card:has(.mount-card-actions > :nth-child(3)):hover :deep(.header-extra),
.mount-card:has(.mount-card-actions > :nth-child(3)):focus-within :deep(.header-extra) {
  max-width: 224px;
}

.mount-card-header {
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
  flex: 1;
  min-width: 0;
}

.mount-card-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--nb-radius-md, var(--nb-radius));
  background: var(--nb-secondary);
  border: var(--nb-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--nb-ink);
  flex-shrink: 0;
}

:root[data-ui-theme='shadcn'] .mount-card-icon {
  background: var(--nb-gray-50);
}

.mount-card-title-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}

.mount-card-title-wrap :deep(.tooltip-trigger),
.mount-card-title-wrap :deep(.brutal-tooltip-trigger) {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
}

.mount-card-title {
  display: block;
  flex: 1;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--nb-ink);
}

.mount-card-title-btn {
  border: none;
  background: transparent;
  padding: 0;
  margin: 0;
  width: 100%;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.mount-card-title-btn:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.mount-card-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  width: max-content;
  min-width: 0;
}

.icon-btn {
  width: 36px;
  padding: 0;
}

.danger-icon-btn {
  color: var(--destructive, var(--nb-danger));
}

.danger-icon-btn:hover:not(:disabled),
.danger-icon-btn:focus-visible:not(:disabled) {
  color: var(--destructive, var(--nb-danger));
}

.mount-card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: var(--nb-space-sm);
  border-radius: var(--nb-radius);
  background: var(--nb-gray-100);
}

.mount-card-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-sm);
  font-size: 12px;
}

.mount-card-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  flex-shrink: 0;
}

.mount-card-line :deep(.tooltip-trigger),
.mount-card-line :deep(.brutal-tooltip-trigger) {
  display: flex;
  justify-content: flex-end;
  flex: 1;
  min-width: 0;
  max-width: 100%;
}

.mount-card-value {
  display: block;
  flex: 1;
  min-width: 0;
  max-width: 100%;
  color: var(--nb-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

@media (max-width: 768px) {
  .mount-cards {
    grid-template-columns: 1fr;
  }

  .mount-card :deep(.header-extra) {
    max-width: 224px;
    margin-left: var(--nb-space-xs);
    opacity: 1;
    pointer-events: auto;
  }
}
</style>
