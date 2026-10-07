<template>
  <div class="mount-move-tree">
    <button
      type="button"
      class="mount-move-tree-row"
      :class="{ 'is-selected': selectedDir === '' }"
      @click="emit('select', '')"
    >
      <span class="mount-move-tree-chevron" aria-hidden="true"></span>
      <span class="mount-move-tree-icon">
        <HardDrive :size="15" />
      </span>
      <span class="mount-move-tree-name">{{ rootLabel }}</span>
    </button>

    <MountMoveTreeNode
      v-for="node in nodes"
      :key="node.key"
      :node="node"
      :depth="1"
      :selected-dir="selectedDir"
      :children-map="childrenMap"
      :loading-dirs="loadingDirs"
      @select="emit('select', $event)"
      @toggle="emit('toggle', $event)"
    />
  </div>
</template>

<script setup>
import { HardDrive } from 'lucide-vue-next'
import MountMoveTreeNode from './MountMoveTreeNode.vue'

defineProps({
  nodes: {
    type: Array,
    default: () => [],
  },
  selectedDir: {
    type: String,
    default: '',
  },
  childrenMap: {
    type: Object,
    default: () => ({}),
  },
  loadingDirs: {
    type: Object,
    default: () => ({}),
  },
  rootLabel: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['select', 'toggle'])
</script>

<style scoped>
.mount-move-tree {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  overflow-y: auto;
  border: var(--nb-border);
  border-radius: var(--nb-radius);
  padding: var(--nb-space-xs);
}

.mount-move-tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-height: 30px;
  padding: 2px 6px;
  border: none;
  background: transparent;
  border-radius: var(--nb-radius-sm, 4px);
  font: inherit;
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
  color: var(--nb-ink);
}

.mount-move-tree-row:hover {
  background: var(--nb-secondary);
}

.mount-move-tree-row.is-selected {
  background: var(--nb-primary);
  color: var(--nb-primary-foreground, #fff);
}

.mount-move-tree-chevron {
  width: 16px;
  flex-shrink: 0;
}

.mount-move-tree-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

.mount-move-tree-row.is-selected .mount-move-tree-icon {
  color: inherit;
}

.mount-move-tree-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
