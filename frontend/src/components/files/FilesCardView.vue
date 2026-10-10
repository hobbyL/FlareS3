<template>
  <div>
    <div v-if="initialLoading && files.length === 0" class="files-state">
      {{ t('files.state.loading') }}
    </div>
    <div v-else-if="files.length === 0" class="files-state">
      {{ t('files.state.empty') }}
    </div>
    <div v-else class="files-cards-section">
      <div class="files-cards">
        <Card
          v-for="row in files"
          :key="row.id"
          header-bg="var(--nb-surface)"
          header-color="var(--nb-ink)"
          :class="[
            'file-card',
            {
              'is-disabled': isFileCardDisabled(row),
              'is-selected': selectionEnabled && selectedIdSet.has(String(row.id ?? '')),
            },
          ]"
          @click="handleCardClick(row)"
        >
          <template #header>
            <div class="file-card-header">
              <input
                v-if="selectionEnabled"
                class="file-card-checkbox"
                type="checkbox"
                :checked="selectedIdSet.has(String(row.id ?? ''))"
                :disabled="loading"
                @click.stop
                @change="
                  emit('toggle-selection', String(row.id ?? ''), Boolean($event?.target?.checked))
                "
              />
              <span class="file-card-icon">
                <File :size="18" />
              </span>
              <Tooltip :content="row.filename">
                <span class="file-card-title">{{ formatFilename(row.filename) }}</span>
              </Tooltip>
            </div>
          </template>

          <template #header-extra>
            <div class="file-card-actions">
              <template v-if="isTrashMode">
                <Tooltip :content="t('files.actions.restore')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn"
                    :disabled="loading"
                    @click.stop="emit('restore', row.id)"
                  >
                    <RotateCcw :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('files.actions.deletePermanent')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn icon-danger"
                    :disabled="loading"
                    @click.stop="emit('delete-permanent', row.id)"
                  >
                    <Trash :size="18" />
                  </Button>
                </Tooltip>
              </template>
              <template v-else>
                <Tooltip :content="t('files.rename.action')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn"
                    :disabled="loading || isFileDeleted(row) || row.upload_status !== 'completed'"
                    @click.stop="emit('rename', row)"
                  >
                    <Pencil :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('files.move.action')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn"
                    :disabled="loading || isFileDeleted(row) || row.upload_status !== 'completed'"
                    @click.stop="emit('move', row)"
                  >
                    <FolderInput :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('files.actions.share')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn"
                    :disabled="loading || !canManageFileShare(row)"
                    @click.stop="emit('share', row)"
                  >
                    <Share2 :size="18" />
                  </Button>
                </Tooltip>
                <Tooltip :content="t('files.actions.delete')">
                  <Button
                    type="ghost"
                    size="small"
                    class="icon-btn icon-danger"
                    :disabled="loading || isFileDeleted(row)"
                    @click.stop="emit('delete', row.id)"
                  >
                    <Trash2 :size="18" />
                  </Button>
                </Tooltip>
              </template>
            </div>
          </template>

          <div class="file-card-body">
            <div class="file-card-meta">
              <Tag :type="getFileStatus(row).tagType" size="small">{{
                getFileStatus(row).text
              }}</Tag>
              <span class="file-card-size">{{ formatBytes(row.size) }}</span>
            </div>

            <div class="file-card-lines">
              <div class="file-card-line">
                <span class="file-card-label">{{ t('files.columns.expires') }}</span>
                <span class="file-card-value">{{ getExpiresText(row) }}</span>
              </div>
              <div class="file-card-line">
                <span class="file-card-label">{{ t('files.columns.remaining') }}</span>
                <Tooltip :content="getRemainingText(row)">
                  <span class="file-card-value">{{ getRemainingText(row) }}</span>
                </Tooltip>
              </div>
              <div v-if="isAdmin" class="file-card-line">
                <span class="file-card-label">{{ t('files.columns.owner') }}</span>
                <span class="file-card-value">{{ row.owner_username || row.owner_id || '-' }}</span>
              </div>
            </div>
          </div>

          <template #footer>
            <div class="file-card-footer">
              <span class="file-card-footer-time">{{
                formatDateTime(isTrashMode ? row.deleted_at : row.created_at)
              }}</span>
              <span class="file-card-footer-code">{{ row.short_code || '-' }}</span>
            </div>
          </template>
        </Card>
      </div>

      <div v-if="hasMore" class="files-load-more">
        <Button
          type="default"
          size="small"
          class="load-more-btn"
          :loading="loading && activeAction === 'loadMore'"
          :disabled="loading"
          @click="emit('load-more')"
        >
          {{ t('files.actions.loadMore') }}
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Trash2, Trash, File, Pencil, Share2, RotateCcw, FolderInput } from 'lucide-vue-next'
import Card from '../ui/card/Card.vue'
import Button from '../ui/button/Button.vue'
import Tooltip from '../ui/tooltip/Tooltip.vue'
import Tag from '../ui/tag/Tag.vue'
import { canManageFileShare, getFileStatusState, isFileDeleted } from '../../utils/files.js'

const props = defineProps({
  files: {
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
    required: true,
  },
  activeAction: {
    type: String,
    default: '',
  },
  isAdmin: {
    type: Boolean,
    default: false,
  },
  isTrashMode: {
    type: Boolean,
    default: false,
  },
  selectionEnabled: {
    type: Boolean,
    default: false,
  },
  selectedIdSet: {
    type: Set,
    default: () => new Set(),
  },
})

const emit = defineEmits([
  'show-info',
  'share',
  'rename',
  'move',
  'delete',
  'restore',
  'delete-permanent',
  'toggle-selection',
  'load-more',
])

const { t, locale } = useI18n({ useScope: 'global' })
const isFileCardDisabled = (row) => props.isTrashMode || isFileDeleted(row)

const isCjkChar = (ch) => {
  try {
    return /\p{Script=Han}/u.test(ch)
  } catch {
    return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(ch)
  }
}

const formatFilename = (filename, maxUnits = 24) => {
  const text = String(filename ?? '').trim()
  if (!text) return '-'

  let units = 0
  const result = []
  for (const ch of Array.from(text)) {
    const weight = isCjkChar(ch) ? 2 : 1
    if (units + weight > maxUnits) {
      return `${result.join('')}...`
    }
    result.push(ch)
    units += weight
  }

  return text
}

const getExpiresText = (row) => {
  const expiresIn = Number(row?.expires_in)
  if (!Number.isFinite(expiresIn)) return '-'
  return expiresIn === -30
    ? t('files.expires.seconds', { value: 30 })
    : t('files.expires.days', { days: expiresIn })
}

const getRemainingText = (row) => {
  if (isFileDeleted(row)) return '-'
  const text = String(row?.remaining_time ?? '').trim()
  return text ? text : '-'
}

const getFileStatus = (row) => {
  const { deleted, expired } = getFileStatusState(row)

  const text = deleted
    ? t('files.status.invalid')
    : expired
      ? t('files.status.expired')
      : t('files.status.valid')
  const tagType = deleted ? 'danger' : expired ? 'warning' : 'success'

  return { deleted, expired, text, tagType }
}

const formatDateTime = (isoString) => {
  if (!isoString) return '-'
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString(locale.value)
}

const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
}

const handleCardClick = (row) => {
  if (props.loading) return
  if (isFileCardDisabled(row)) return
  emit('show-info', row)
}
</script>

<style scoped>
.files-state {
  padding: var(--nb-space-md);
  text-align: center;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

.files-cards-section {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.files-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--nb-space-lg);
}

.files-load-more {
  display: flex;
  justify-content: center;
  padding: var(--nb-space-md) 0;
  width: 100%;
}

.load-more-btn {
  min-width: 120px;
}

.file-card {
  cursor: pointer;
  transition: all 0.2s ease;
}

.file-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.file-card.is-disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.file-card.is-disabled:hover {
  transform: none;
  box-shadow: none;
}

.file-card.is-selected {
  outline: var(--nb-border-width, 2px) solid var(--nb-primary, #2563eb);
  outline-offset: -2px;
}

.file-card-checkbox {
  flex-shrink: 0;
  margin-right: var(--nb-space-xs, 4px);
  cursor: pointer;
}

.file-card-header {
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
  flex: 1;
  min-width: 0;
}

.file-card-icon {
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

:root[data-ui-theme='shadcn'] .file-card-icon {
  background: var(--nb-gray-50);
}

.file-card-title {
  display: block;
  flex: 1;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--nb-ink);
}

.file-card-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.file-card:hover .file-card-actions {
  opacity: 1;
}

.icon-btn {
  width: 36px;
  padding: 0;
}

.icon-danger {
  color: var(--destructive, var(--nb-danger));
}

.file-card-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: var(--nb-space-sm);
  border-radius: var(--nb-radius);
  background: var(--nb-gray-100);
}

.file-card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-sm);
}

.file-card-size {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  white-space: nowrap;
}

.file-card-lines {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.file-card-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-sm);
  font-size: 12px;
}

.file-card-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  flex-shrink: 0;
}

.file-card-value {
  color: var(--nb-ink);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.file-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-sm);
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  width: 100%;
}

.file-card-footer-time {
  white-space: nowrap;
}

.file-card-footer-code {
  font-family: var(--nb-font-mono);
}

@media (max-width: 768px) {
  .files-cards {
    grid-template-columns: minmax(0, 1fr);
    width: 100%;
    min-width: 0;
    overflow-x: hidden;
  }

  .files-cards-section,
  .file-card {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .file-card :deep(.card-header),
  .file-card :deep(.card-body),
  .file-card :deep(.card-footer),
  .file-card :deep(.header-extra) {
    width: 100%;
    max-width: 100%;
    min-width: 0;
  }

  .file-card :deep(.card-header) {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }

  .file-card :deep(.header-extra) {
    width: 100%;
    justify-content: flex-start;
  }

  .file-card :deep(.card-header) > * {
    width: 100%;
    max-width: 100%;
    min-width: 0;
  }

  .file-card-actions {
    opacity: 1;
    gap: 4px;
    width: 100%;
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .icon-btn {
    flex-shrink: 0;
  }

  .file-card-header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: flex-start;
    width: 100%;
  }

  .file-card-title {
    width: 100%;
    white-space: normal;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .file-card-meta {
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
  }

  .file-card-body,
  .file-card-lines,
  .file-card-line,
  .file-card-value,
  .file-card-footer,
  .file-card-footer-code {
    min-width: 0;
  }

  .file-card-size {
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .file-card-line {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: 2px;
  }

  .file-card-value {
    max-width: none;
    white-space: normal;
    overflow: visible;
    text-overflow: initial;
    overflow-wrap: anywhere;
    word-break: break-word;
    text-align: left;
  }

  .file-card-footer {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }

  .file-card-footer-time {
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .file-card-footer-code {
    text-align: left;
    word-break: break-word;
  }
}
</style>
