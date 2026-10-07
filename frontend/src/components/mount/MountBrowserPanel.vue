<template>
  <section class="mount-content">
    <PageSkeleton
      v-if="initialPageLoading"
      :variant="viewMode === 'table' ? 'table' : 'cards'"
      :columns="columns.length"
      :cards="6"
      min-card-width="220px"
    />

    <template v-else>
      <Alert
        v-if="!configsLoading && configs.length === 0"
        type="info"
        :title="t('mount.state.noConfigsTitle')"
      >
        {{ t('mount.state.noConfigsContent') }}
      </Alert>

      <Alert
        v-else-if="!configsLoading && !selectedConfigId"
        type="info"
        :title="t('mount.state.noConfigSelectedTitle')"
      >
        {{ t('mount.state.noConfigSelectedContent') }}
      </Alert>

      <template v-else>
        <Card v-if="viewMode === 'table'" class="mount-browser-card">
          <template #header>
            <MountPathToolbar
              :prefix="prefix"
              :loading="loading"
              :breadcrumb-items="breadcrumbItems"
              @go-root="emit('go-root')"
              @go-up="emit('go-up')"
              @navigate="emit('navigate', $event)"
            />
          </template>

          <MountTableView :columns="columns" :data="rows" :loading="loading || deleting" />

          <Pagination
            :page="pageNumber"
            :page-size="pageSize"
            :total="paginationTotal"
            :display-total="paginationDisplayTotal"
            :page-size-options="pageSizeOptions"
            :disabled="loading || deleting || !selectedConfigId"
            @update:page="emit('update:page', $event)"
            @update:page-size="emit('update:page-size', $event)"
          />
        </Card>

        <div v-else class="mount-browser-panel">
          <MountPathToolbar
            :prefix="prefix"
            :loading="loading"
            :breadcrumb-items="breadcrumbItems"
            @go-root="emit('go-root')"
            @go-up="emit('go-up')"
            @navigate="emit('navigate', $event)"
          />

          <MountCardView
            :rows="rows"
            :loading="loading"
            :initial-loading="initialPageLoading"
            :has-more="canNext"
            :active-action="activeAction"
            :deleting="deleting"
            :deleting-key="deletingKey"
            :is-preview-supported="isPreviewSupported"
            :format-bytes="formatBytes"
            :format-date-time="formatDateTime"
            @open-folder="emit('open-folder', $event)"
            @preview="emit('preview', $event)"
            @download="emit('download', $event)"
            @rename="emit('rename', $event)"
            @move="emit('move', $event)"
            @delete="emit('delete', $event)"
            @load-more="emit('load-more')"
          />
        </div>
      </template>
    </template>
  </section>
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import Alert from '../ui/alert/Alert.vue'
import Card from '../ui/card/Card.vue'
import PageSkeleton from '../ui/skeleton/PageSkeleton.vue'
import Pagination from '../ui/pagination/Pagination.vue'
import MountPathToolbar from './MountPathToolbar.vue'
import MountTableView from './MountTableView.vue'

const MountCardView = defineAsyncComponent(() => import('./MountCardView.vue'))

defineProps({
  initialPageLoading: {
    type: Boolean,
    default: false,
  },
  viewMode: {
    type: String,
    default: 'table',
  },
  columns: {
    type: Array,
    default: () => [],
  },
  rows: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
  deleting: {
    type: Boolean,
    default: false,
  },
  configsLoading: {
    type: Boolean,
    default: false,
  },
  configs: {
    type: Array,
    default: () => [],
  },
  selectedConfigId: {
    type: String,
    default: '',
  },
  prefix: {
    type: String,
    default: '',
  },
  breadcrumbItems: {
    type: Array,
    default: () => [],
  },
  pageNumber: {
    type: Number,
    default: 1,
  },
  pageSize: {
    type: Number,
    default: 20,
  },
  paginationTotal: {
    type: Number,
    default: 0,
  },
  paginationDisplayTotal: {
    type: [Number, String],
    default: 0,
  },
  pageSizeOptions: {
    type: Array,
    default: () => [],
  },
  canNext: {
    type: Boolean,
    default: false,
  },
  activeAction: {
    type: String,
    default: '',
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
  'go-root',
  'go-up',
  'navigate',
  'update:page',
  'update:page-size',
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
.mount-browser-panel {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-md);
}

@media (max-width: 768px) {
  .mount-content,
  .mount-browser-panel {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }
}
</style>
