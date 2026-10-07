<template>
  <div>
    <div v-if="initialLoading && texts.length === 0" class="texts-state">
      {{ t('texts.state.loading') }}
    </div>
    <div v-else-if="texts.length === 0" class="texts-state">
      {{ t('texts.state.empty') }}
    </div>
    <div v-else class="texts-cards-section">
      <div class="texts-cards">
        <Card
          v-for="row in texts"
          :key="row.id"
          header-bg="var(--nb-surface)"
          header-color="var(--nb-ink)"
          class="text-card"
          @click="emit('view', row)"
        >
          <template #header>
            <div class="text-card-header">
              <span class="text-card-icon">
                <FileText :size="18" />
              </span>
              <Tag type="info" size="small">{{ detectFileType(row) }}</Tag>
            </div>
          </template>

          <template #header-extra>
            <div class="text-card-actions">
              <Tooltip :content="t('texts.actions.qrcode')">
                <Button
                  type="ghost"
                  size="small"
                  class="icon-btn"
                  :aria-label="t('texts.actions.qrcode')"
                  :disabled="loading || deleting"
                  @click.stop="emit('qrcode', row)"
                >
                  <QrCode :size="18" />
                </Button>
              </Tooltip>
              <Tooltip :content="t('texts.actions.share')">
                <Button
                  type="ghost"
                  size="small"
                  class="icon-btn"
                  :aria-label="t('texts.actions.share')"
                  :disabled="loading || deleting"
                  @click.stop="emit('share', row)"
                >
                  <Share2 :size="18" />
                </Button>
              </Tooltip>
              <Tooltip :content="t('texts.actions.accessLog')">
                <Button
                  type="ghost"
                  size="small"
                  class="icon-btn"
                  :aria-label="t('texts.actions.accessLog')"
                  :disabled="loading || deleting"
                  @click.stop="emit('access-log', row)"
                >
                  <History :size="18" />
                </Button>
              </Tooltip>
              <Tooltip :content="t('texts.actions.copy')">
                <Button
                  type="ghost"
                  size="small"
                  class="icon-btn"
                  :aria-label="t('texts.actions.copy')"
                  :disabled="loading || deleting || !!copyingId"
                  :loading="copyingId === normalizeId(row?.id)"
                  @click.stop="copyTextContent(row)"
                >
                  <Copy :size="18" />
                </Button>
              </Tooltip>
              <Tooltip :content="t('texts.actions.edit')">
                <Button
                  type="ghost"
                  size="small"
                  class="icon-btn"
                  :disabled="loading || deleting"
                  @click.stop="emit('edit', row)"
                >
                  <Pencil :size="18" />
                </Button>
              </Tooltip>
              <Tooltip :content="t('texts.actions.delete')">
                <Button
                  type="ghost"
                  size="small"
                  class="icon-btn icon-danger"
                  :disabled="loading || deleting || deletingId === normalizeId(row?.id)"
                  :loading="deletingId === normalizeId(row?.id)"
                  @click.stop="emit('delete', row)"
                >
                  <Trash2 :size="18" />
                </Button>
              </Tooltip>
            </div>
          </template>

          <div class="text-card-body">
            <div class="text-card-preview">{{ buildPreview(row) }}</div>
          </div>

          <template #footer>
            <div class="text-card-footer">
              <span class="text-card-size">{{ formatBytes(row?.content_length ?? 0) }}</span>
              <span class="text-card-time">{{ formatDateTime(row?.updated_at) }}</span>
            </div>
          </template>
        </Card>
      </div>

      <div v-if="hasMore" class="texts-load-more">
        <Button
          type="default"
          size="small"
          class="load-more-btn"
          :loading="loading && activeAction === 'loadMore'"
          :disabled="loading"
          @click="emit('load-more')"
        >
          {{ t('texts.actions.loadMore') }}
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, FileText, History, Pencil, QrCode, Share2, Trash2 } from 'lucide-vue-next'
import api from '../../services/api'
import { useMessage } from '../../composables/useMessage'
import Card from '../ui/card/Card.vue'
import Button from '../ui/button/Button.vue'
import Tag from '../ui/tag/Tag.vue'
import Tooltip from '../ui/tooltip/Tooltip.vue'

const props = defineProps({
  texts: {
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
  deleting: {
    type: Boolean,
    default: false,
  },
  deletingId: {
    type: String,
    default: '',
  },
  hasMore: {
    type: Boolean,
    required: true,
  },
  activeAction: {
    type: String,
    default: '',
  },
  normalizeId: {
    type: Function,
    required: true,
  },
  buildPreview: {
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
  detectFileType: {
    type: Function,
    required: true,
  },
})

const emit = defineEmits(['view', 'qrcode', 'share', 'access-log', 'edit', 'delete', 'load-more'])

const { t } = useI18n({ useScope: 'global' })
const message = useMessage()

const copyingId = ref('')

const copyTextContent = async (row) => {
  const id = props.normalizeId(row?.id)
  if (!id) return
  if (props.loading || props.deleting || copyingId.value) return

  copyingId.value = id
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
    if (!clipboard) {
      throw new Error('Clipboard API is not available')
    }

    if (clipboard.write && typeof window !== 'undefined' && window.ClipboardItem) {
      const blobPromise = api.getText(id).then((result) => {
        const content = String(result?.text?.content ?? '')
        return new Blob([content], { type: 'text/plain' })
      })
      await clipboard.write([new window.ClipboardItem({ 'text/plain': blobPromise })])
    } else {
      const result = await api.getText(id)
      const content = String(result?.text?.content ?? '')
      await clipboard.writeText(content)
    }

    message.success(t('texts.messages.copySuccess'))
  } catch (error) {
    message.error(error.response?.data?.error || t('texts.messages.copyFailed'))
  } finally {
    copyingId.value = ''
  }
}
</script>

<style scoped>
.texts-state {
  padding: var(--nb-space-md);
  text-align: center;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

.texts-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--nb-space-lg);
}

.texts-cards-section {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.texts-load-more {
  display: flex;
  justify-content: center;
  padding: var(--nb-space-md) 0;
  width: 100%;
}

.load-more-btn {
  min-width: 120px;
}

.text-card {
  cursor: pointer;
  transition: all 0.2s ease;
}

.text-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.text-card-header {
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
  min-width: 0;
}

.text-card-icon {
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

:root[data-ui-theme='shadcn'] .text-card-icon {
  background: var(--nb-gray-50);
}

.text-card-actions {
  display: flex;
  align-items: center;
  gap: -2px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.text-card:hover .text-card-actions {
  opacity: 1;
}

.icon-btn {
  width: 36px;
  padding: 0;
}

.icon-danger {
  color: var(--destructive, var(--nb-danger));
}

.text-card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 120px;
  padding: var(--nb-space-sm);
  border-radius: var(--nb-radius);
  background: var(--nb-gray-100);
}

.text-card-preview {
  color: var(--nb-ink);
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 5;
  line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
}

.text-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-sm);
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  width: 100%;
}

.text-card-size {
  flex-shrink: 0;
}

.text-card-time {
  flex-shrink: 0;
}

@media (max-width: 768px) {
  .texts-cards {
    grid-template-columns: 1fr;
  }

  .text-card-actions {
    opacity: 1;
  }
}
</style>
