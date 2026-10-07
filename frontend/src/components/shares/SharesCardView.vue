<template>
  <div>
    <div v-if="initialLoading && shares.length === 0" class="shares-state">
      {{ t('shares.state.loading') }}
    </div>
    <div v-else-if="shares.length === 0" class="shares-state">
      {{ emptyStateText }}
    </div>
    <div v-else class="shares-cards-section">
      <div class="shares-cards">
        <Card
          v-for="record in shares"
          :key="toShareSelectionKey(record)"
          header-bg="var(--nb-surface)"
          header-color="var(--nb-ink)"
          class="share-card"
        >
          <template #header>
            <label class="share-card-select">
              <input
                class="share-checkbox"
                type="checkbox"
                :checked="isSelected(record)"
                :disabled="loading || !toShareSelectionKey(record)"
                @change="toggleSelection(record, $event)"
              />
              <Tag type="info" size="small">{{ getTypeLabel(record) }}</Tag>
            </label>
          </template>

          <template #header-extra>
            <Tag :type="getStatusType(record)" size="small">{{ getStatusLabel(record) }}</Tag>
          </template>

          <div class="share-card-body">
            <div class="share-card-name">{{ getName(record) }}</div>

            <div class="share-card-link">
              <span class="share-card-label">{{ t('shares.columns.link') }}</span>
              <span class="share-card-link-path">{{ getShareUrl(record) }}</span>
            </div>

            <div class="share-card-lines">
              <div class="share-card-line">
                <span class="share-card-label">{{ t('shares.columns.expiresAt') }}</span>
                <span class="share-card-value">{{ formatDateTime(record?.expires_at) }}</span>
              </div>
              <div class="share-card-line">
                <span class="share-card-label">{{ t('shares.columns.visits') }}</span>
                <span class="share-card-value">{{ formatShareVisits(record, t) }}</span>
              </div>
              <div class="share-card-line">
                <span class="share-card-label">{{ t('shares.columns.password') }}</span>
                <span class="share-card-value">{{ getPasswordText(record) }}</span>
              </div>
              <div v-if="isAdmin" class="share-card-line">
                <span class="share-card-label">{{ t('shares.columns.owner') }}</span>
                <span class="share-card-value">{{ getOwnerText(record) }}</span>
              </div>
            </div>
          </div>

          <template #footer>
            <div class="share-card-footer">
              <span class="share-card-time">{{ formatDateTime(record?.updated_at) }}</span>

              <div class="share-card-actions">
                <Button
                  type="ghost"
                  size="small"
                  class="share-action-btn"
                  :disabled="loading || !hasShareUrl(record)"
                  @click.stop="emit('copy-link', record)"
                >
                  <Copy :size="16" />
                </Button>
                <Button
                  type="ghost"
                  size="small"
                  class="share-action-btn"
                  :disabled="loading || !canOpenShare(record)"
                  @click.stop="emit('open-link', record)"
                >
                  <ExternalLink :size="16" />
                </Button>
                <Button
                  v-if="hasEditableConfig(record)"
                  type="ghost"
                  size="small"
                  class="share-action-btn"
                  :disabled="loading"
                  @click.stop="emit('edit', record)"
                >
                  <Pencil :size="16" />
                </Button>
                <Button
                  v-else
                  type="ghost"
                  size="small"
                  class="share-action-btn"
                  :disabled="loading"
                  @click.stop="emit('regenerate', record)"
                >
                  <RefreshCw :size="16" />
                </Button>
                <Button
                  type="ghost"
                  size="small"
                  class="share-action-btn"
                  :disabled="loading || !hasAccessLogConfig(record)"
                  @click.stop="emit('access-log', record)"
                >
                  <History :size="16" />
                </Button>
                <Button
                  type="ghost"
                  size="small"
                  class="share-action-btn share-action-danger"
                  :disabled="loading"
                  @click.stop="emit('disable', record)"
                >
                  <Trash2 :size="16" />
                </Button>
              </div>
            </div>
          </template>
        </Card>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Copy, ExternalLink, History, Pencil, RefreshCw, Trash2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import Button from '../ui/button/Button.vue'
import Card from '../ui/card/Card.vue'
import Tag from '../ui/tag/Tag.vue'
import {
  canOpenShare,
  formatShareVisits,
  hasAccessLogConfig,
  hasEditableConfig,
  toShareSelectionKey,
  toShareStatusLabelKey,
  toShareStatusVariant,
  toShareTypeLabelKey,
} from '../../utils/shares.js'

const props = defineProps({
  shares: {
    type: Array,
    required: true,
  },
  selectedIds: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
  initialLoading: {
    type: Boolean,
    default: false,
  },
  isAdmin: {
    type: Boolean,
    default: false,
  },
  emptyStateText: {
    type: String,
    default: '',
  },
})

const emit = defineEmits([
  'copy-link',
  'open-link',
  'edit',
  'disable',
  'regenerate',
  'access-log',
  'toggle-select',
])

const { t, locale } = useI18n({ useScope: 'global' })

const selectedIdSet = computed(
  () => new Set(props.selectedIds.map((value) => String(value ?? '').trim()).filter(Boolean))
)

const normalizeText = (value) => String(value ?? '').trim()

const hasShareUrl = (record) => Boolean(normalizeText(record?.share_url))

const getName = (record) => normalizeText(record?.resource_name) || '-'
const getOwnerText = (record) =>
  normalizeText(record?.owner_username) || normalizeText(record?.owner_id) || '-'
const getShareUrl = (record) => normalizeText(record?.share_url) || '-'
const getTypeLabel = (record) => t(toShareTypeLabelKey(record?.type))
const getStatusLabel = (record) => t(toShareStatusLabelKey(record?.status))
const getStatusType = (record) => toShareStatusVariant(record?.status)

const getPasswordText = (record) => {
  if (normalizeText(record?.type) === 'text_one_time') {
    return '-'
  }
  return record?.has_password ? t('shares.password.set') : t('shares.password.unset')
}

const formatDateTime = (value) => {
  const text = normalizeText(value)
  if (!text) return '-'
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString(locale.value)
}

const isSelected = (record) => {
  const selectionKey = toShareSelectionKey(record)
  return selectionKey ? selectedIdSet.value.has(selectionKey) : false
}

const toggleSelection = (record, event) => {
  const selectionKey = toShareSelectionKey(record)
  if (!selectionKey) {
    return
  }
  emit('toggle-select', selectionKey, Boolean(event?.target?.checked))
}
</script>

<style scoped>
.shares-state {
  padding: var(--nb-space-md);
  text-align: center;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

.shares-cards-section {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.shares-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--nb-space-lg);
}

.share-card {
  min-width: 0;
}

.share-card-select {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.share-checkbox {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--nb-primary);
}

.share-card-body {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-md);
}

.share-card-name {
  font-size: var(--nb-font-size-lg);
  font-weight: var(--nb-font-weight-semibold, 700);
  line-height: 1.4;
  word-break: break-word;
}

.share-card-link,
.share-card-line {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.share-card-lines {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
}

.share-card-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  text-transform: uppercase;
}

.share-card-link-path,
.share-card-value {
  min-width: 0;
  word-break: break-word;
}

.share-card-link-path {
  color: var(--nb-muted-foreground, var(--nb-gray-600));
  font-family: var(--nb-font-mono);
  font-size: 12px;
}

.share-card-footer {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
}

.share-card-time {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
}

.share-card-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.share-action-btn {
  min-width: 36px;
  padding: 0 10px;
}

.share-action-danger {
  color: var(--nb-danger);
}

@media (max-width: 768px) {
  .shares-cards {
    grid-template-columns: minmax(0, 1fr);
  }

  .share-card-lines {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
