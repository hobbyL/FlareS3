<template>
  <section class="shares-content">
    <PageSkeleton
      v-if="initialPageLoading"
      :variant="isMobile ? 'cards' : 'table'"
      :columns="columns.length"
      :cards="6"
    />

    <template v-else>
      <Card v-if="!isMobile" class="shares-table-card">
        <Table
          v-if="loading || items.length"
          class="shares-table"
          :columns="columns"
          :data="items"
          :loading="loading"
        />

        <div v-else class="shares-state">
          {{ emptyStateText }}
        </div>

        <Pagination
          v-if="pagination.itemCount > 0"
          :page="pagination.page"
          :page-size="pagination.pageSize"
          :total="pagination.itemCount"
          @update:page="emit('update:page', $event)"
          @update:page-size="emit('update:page-size', $event)"
        />
      </Card>

      <Card v-else class="shares-table-card">
        <SharesCardView
          :shares="items"
          :selected-ids="selectedIds"
          :loading="loading || Boolean(activeAction)"
          :initial-loading="initialPageLoading"
          :is-admin="isAdmin"
          :empty-state-text="emptyStateText"
          @copy-link="emit('copy-link', $event)"
          @open-link="emit('open-link', $event)"
          @edit="emit('edit', $event)"
          @disable="emit('disable', $event)"
          @regenerate="emit('regenerate', $event)"
          @access-log="emit('access-log', $event)"
          @toggle-select="(rowId, checked) => emit('toggle-select', rowId, checked)"
        />

        <Pagination
          v-if="pagination.itemCount > 0"
          :page="pagination.page"
          :page-size="pagination.pageSize"
          :total="pagination.itemCount"
          @update:page="emit('update:page', $event)"
          @update:page-size="emit('update:page-size', $event)"
        />
      </Card>
    </template>
  </section>
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
import Card from '../ui/card/Card.vue'
import PageSkeleton from '../ui/skeleton/PageSkeleton.vue'
import Pagination from '../ui/pagination/Pagination.vue'
import Table from '../ui/table/Table.vue'

const SharesCardView = defineAsyncComponent(() => import('./SharesCardView.vue'))

defineProps({
  initialPageLoading: {
    type: Boolean,
    default: false,
  },
  isMobile: {
    type: Boolean,
    default: false,
  },
  columns: {
    type: Array,
    default: () => [],
  },
  items: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
  activeAction: {
    type: String,
    default: '',
  },
  selectedIds: {
    type: Array,
    default: () => [],
  },
  isAdmin: {
    type: Boolean,
    default: false,
  },
  emptyStateText: {
    type: String,
    default: '',
  },
  pagination: {
    type: Object,
    required: true,
  },
})

const emit = defineEmits([
  'update:page',
  'update:page-size',
  'copy-link',
  'open-link',
  'edit',
  'disable',
  'regenerate',
  'access-log',
  'toggle-select',
])
</script>

<style scoped>
.shares-content {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.shares-state {
  padding: var(--nb-space-xl);
  text-align: center;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

:deep(.shares-table .brutal-table),
:deep(.shares-table .shadcn-table) {
  table-layout: fixed;
}

:deep(.shares-table .brutal-table th),
:deep(.shares-table .brutal-table td),
:deep(.shares-table .shadcn-table th),
:deep(.shares-table .shadcn-table td) {
  white-space: nowrap;
}

:deep(.shares-checkbox) {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--nb-primary);
}

:deep(.share-link-cell) {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}

:deep(.share-link-text) {
  flex: 0 1 auto;
  min-width: 0;
  max-width: calc(100% - 88px);
}

:deep(.share-link-path) {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--nb-muted-foreground, var(--nb-gray-600));
  font-family: var(--nb-font-mono);
  font-size: 12px;
  white-space: nowrap;
}

:deep(.share-link-buttons),
:deep(.action-buttons) {
  display: flex;
  gap: 8px;
  justify-content: center;
  align-items: center;
  flex-wrap: nowrap;
}

:deep(.share-link-buttons) {
  flex-shrink: 0;
}

:deep(.share-link-icon-button) {
  min-width: 36px;
  padding: 0 8px;
}

@media (max-width: 768px) {
  .shares-content {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }
}
</style>
