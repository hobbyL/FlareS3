<template>
  <div class="mount-move-tree-node">
    <button
      type="button"
      class="mount-move-tree-row"
      :class="{ 'is-selected': selectedDir === dirPrefix }"
      :style="{ paddingLeft: `${depth * 14 + 6}px` }"
      @click="emit('select', dirPrefix)"
    >
      <span
        class="mount-move-tree-chevron"
        role="button"
        tabindex="0"
        :aria-expanded="expanded ? 'true' : 'false'"
        @click.stop="emit('toggle', node.key)"
        @keyup.enter.stop.prevent="emit('toggle', node.key)"
      >
        <ChevronDown v-if="expanded" :size="14" />
        <ChevronRight v-else :size="14" />
      </span>
      <span class="mount-move-tree-icon">
        <FolderOpen :size="15" />
      </span>
      <span class="mount-move-tree-name">{{ node.name }}</span>
      <span v-if="isLoading" class="mount-move-tree-loading" aria-hidden="true"></span>
    </button>

    <template v-if="expanded">
      <div v-if="isLoading" class="mount-move-tree-hint">
        {{ '...' }}
      </div>
      <div v-else-if="!childNodes.length" class="mount-move-tree-hint">
        {{ emptyLabel }}
      </div>
      <MountMoveTreeNode
        v-for="child in childNodes"
        :key="child.key"
        :node="child"
        :depth="depth + 1"
        :selected-dir="selectedDir"
        :children-map="childrenMap"
        :loading-dirs="loadingDirs"
        @select="emit('select', $event)"
        @toggle="emit('toggle', $event)"
      />
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, FolderOpen } from 'lucide-vue-next'

const props = defineProps({
  node: {
    type: Object,
    required: true,
  },
  depth: {
    type: Number,
    default: 1,
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
})

defineOptions({ name: 'MountMoveTreeNode' })

const emit = defineEmits(['select', 'toggle'])
const { t } = useI18n({ useScope: 'global' })

// 目录前缀（无尾斜杠）与后端 to_dir 规范一致
const dirPrefix = computed(() => {
  const key = String(props.node.key || '')
  return key.endsWith('/') ? key.slice(0, -1) : key
})

const children = computed(() => props.childrenMap[props.node.key] || null)
const expanded = computed(() => children.value !== null)
const isLoading = computed(() => Boolean(props.loadingDirs[props.node.key]))
const childNodes = computed(() => children.value || [])
const emptyLabel = computed(() => t('mount.move.noSubDirs'))
</script>

<style scoped>
.mount-move-tree-node {
  display: flex;
  flex-direction: column;
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex-shrink: 0;
  cursor: pointer;
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

.mount-move-tree-loading {
  width: 10px;
  height: 10px;
  margin-left: auto;
  border: 2px solid var(--nb-border);
  border-top-color: var(--nb-primary);
  border-radius: 50%;
  animation: mount-move-spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes mount-move-spin {
  to {
    transform: rotate(360deg);
  }
}

.mount-move-tree-hint {
  padding: 2px 6px 2px 36px;
  font-size: 0.75rem;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}
</style>
