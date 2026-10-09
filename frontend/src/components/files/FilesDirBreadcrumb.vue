<template>
  <div class="files-dir-nav">
    <div class="files-dir-path">
      <Button type="ghost" size="small" :disabled="loading || !dir" @click="emit('go-root')">
        <Home :size="16" />
        <span class="btn-label">{{ t('files.dir.root') }}</span>
      </Button>

      <div class="breadcrumb">
        <span class="breadcrumb-root" :class="{ clickable: dir }" @click="dir && emit('go-root')"
          >/</span
        >
        <template v-for="(item, index) in breadcrumbItems" :key="item.prefix">
          <span v-if="index > 0" class="breadcrumb-sep">/</span>
          <span class="breadcrumb-item clickable" @click="emit('navigate', item.prefix)">
            {{ item.label }}
          </span>
        </template>
      </div>

      <Button type="ghost" size="small" :disabled="loading || !dir" @click="emit('go-up')">
        <ArrowUp :size="16" />
        <span class="btn-label">{{ t('files.dir.upFolder') }}</span>
      </Button>
    </div>

    <div v-if="childFolders.length > 0" class="files-dir-children">
      <button
        v-for="folder in childFolders"
        :key="folder.prefix"
        type="button"
        class="files-dir-folder"
        :disabled="loading"
        @click="emit('navigate', folder.prefix)"
      >
        <Folder :size="16" />
        <span class="files-dir-folder-label">{{ folder.label }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { ArrowUp, Folder, Home } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import Button from '../ui/button/Button.vue'
import { buildDirBreadcrumb, collectChildDirs } from '../../utils/files.js'

const props = defineProps({
  dir: {
    type: String,
    default: '',
  },
  dirs: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['go-root', 'go-up', 'navigate'])

const { t } = useI18n({ useScope: 'global' })

const breadcrumbItems = computed(() => buildDirBreadcrumb(props.dir))
const childFolders = computed(() => collectChildDirs(props.dir, props.dirs))
</script>

<style scoped>
.files-dir-nav {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
  min-width: 0;
}

.files-dir-path {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}

.btn-label {
  margin-left: 6px;
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex-wrap: wrap;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

.breadcrumb-root,
.breadcrumb-item {
  font-family: var(--nb-font-mono, ui-monospace);
  font-size: 0.875rem;
}

.clickable {
  cursor: pointer;
  color: var(--nb-link-color, var(--nb-primary));
}

.breadcrumb-sep {
  opacity: 0.6;
}

.files-dir-children {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nb-space-sm);
}

.files-dir-folder {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--nb-border, var(--nb-gray-300));
  border-radius: var(--nb-radius-sm, 6px);
  background: var(--nb-surface, transparent);
  color: var(--nb-text, var(--foreground));
  cursor: pointer;
  font-size: 0.875rem;
}

.files-dir-folder:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.files-dir-folder-label {
  word-break: break-all;
}

@media (max-width: 768px) {
  .files-dir-path {
    width: 100%;
    min-width: 0;
  }
}
</style>
