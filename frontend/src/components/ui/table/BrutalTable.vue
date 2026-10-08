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
  <div class="brutal-table-wrapper">
    <div v-if="loading && data.length === 0" class="loading-overlay">
      <div class="loader"></div>
    </div>
    <table class="brutal-table">
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
.brutal-table-wrapper {
  position: relative;
  overflow-x: auto;
  border: var(--nb-border);
  box-shadow: var(--nb-shadow);
  border-radius: var(--nb-radius);
  background: var(--nb-surface);
}

.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--nb-overlay-bg, rgba(0, 0, 0, 0.12));
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

.loader {
  width: 32px;
  height: 32px;
  border: 4px solid var(--nb-black);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.brutal-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  background: transparent;
}

.brutal-table th,
.brutal-table td {
  border: var(--nb-border);
  padding: 12px 16px;
  text-align: left;
}

/* Cell with ellipsis */
.cell-ellipsis {
  max-width: 0; /* Force ellipsis to work */
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
  cursor: help; /* Show help cursor on hover */
}

.cell-ellipsis :deep(.brutal-tooltip-trigger),
.cell-ellipsis :deep(.tooltip-trigger) {
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
  cursor: help;
}

.brutal-table th {
  background-color: var(--nb-primary);
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-weight: var(--nb-ui-font-weight-strong, 900);
  text-transform: var(--nb-ui-text-transform, uppercase);
  font-size: 13px;
  color: var(--nb-primary-foreground, var(--nb-ink));
  border-color: var(--nb-border-color);
}

.brutal-table tr:hover td {
  background-color: var(--nb-gray-100);
}

/* Sticky right column (e.g. row actions) */
.cell-fixed-right {
  position: sticky;
  right: 0;
  z-index: 2;
  background-color: var(--nb-surface);
}

.brutal-table th.cell-fixed-right {
  z-index: 3;
  background-color: var(--nb-primary);
}

.brutal-table tr:hover td.cell-fixed-right {
  background-color: var(--nb-gray-100);
}

.empty-cell {
  text-align: center;
  padding: 40px;
  color: var(--nb-gray-500);
  font-style: italic;
}
</style>
