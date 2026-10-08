<script setup>
import { useI18n } from 'vue-i18n'

const { t } = useI18n({ useScope: 'global' })

defineProps({
  columns: { type: Array, default: () => [] },
  data: { type: Array, default: () => [] },
  loading: Boolean,
})
</script>

<template>
  <div class="shadcn-table-wrapper">
    <div v-if="loading && data.length === 0" class="loading-overlay">
      <div class="loader"></div>
    </div>
    <table class="shadcn-table">
      <thead>
        <tr>
          <th
            v-for="col in columns"
            :key="col.key"
            :style="{
              width: col.width ? `${col.width}px` : 'auto',
              textAlign: col.align || 'left',
            }"
            :class="{ 'cell-fixed-right': col.fixed === 'right' }"
          >
            <template v-if="col.titleRender">
              <component :is="col.titleRender()" />
            </template>
            <template v-else>
              {{ col.title }}
            </template>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="data.length === 0">
          <td :colspan="columns.length" class="empty-cell">
            {{ t('table.empty') }}
          </td>
        </tr>
        <tr v-for="(row, index) in data" :key="index">
          <td
            v-for="col in columns"
            :key="col.key"
            :style="{ textAlign: col.align || 'left' }"
            :class="{
              'cell-ellipsis': col.ellipsis !== false,
              'cell-fixed-right': col.fixed === 'right',
            }"
          >
            <template v-if="col.render">
              <component :is="col.render(row)" />
            </template>
            <template v-else>
              <span>{{ row[col.key] }}</span>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.shadcn-table-wrapper {
  position: relative;
  overflow-x: auto;
}

.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: color-mix(in oklab, var(--background) 80%, transparent);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

.loader {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spinner 0.8s linear infinite;
}

.shadcn-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 0.875rem;
}

.shadcn-table thead tr {
  border-bottom: 1px solid var(--border);
}

.shadcn-table th {
  height: 48px;
  padding: 0 16px;
  font-weight: var(--nb-font-weight-medium);
  color: var(--muted-foreground);
  text-align: left;
  white-space: nowrap;
  vertical-align: middle;
}

.shadcn-table tbody tr {
  border-bottom: 1px solid var(--border);
  transition: background-color 0.15s ease;
}

.shadcn-table tbody tr:hover {
  background-color: color-mix(in oklab, var(--muted) 50%, var(--background));
}

.shadcn-table tbody tr:last-child {
  border-bottom: none;
}

.shadcn-table td {
  padding: 16px;
  color: var(--foreground);
  vertical-align: middle;
}

/* Sticky right column (e.g. row actions) */
.cell-fixed-right {
  position: sticky;
  right: 0;
  z-index: 2;
  background-color: var(--card);
}

.shadcn-table th.cell-fixed-right {
  z-index: 3;
  background-color: var(--card);
}

.cell-ellipsis {
  max-width: 0; /* Force ellipsis to work with fixed table layout */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-ellipsis > span {
  display: block;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

.cell-ellipsis :deep(.tooltip-trigger),
.cell-ellipsis :deep(.brutal-tooltip-trigger) {
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

.empty-cell {
  text-align: center;
  padding: 32px;
  color: var(--muted-foreground);
}
</style>
