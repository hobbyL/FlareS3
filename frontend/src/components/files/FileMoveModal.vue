<template>
  <Modal :show="show" :title="t('files.move.title')" width="480px" @update:show="handleShowUpdate">
    <div class="file-move-form">
      <div class="file-move-field">
        <label class="file-move-label">{{ t('files.move.fileName') }}</label>
        <div class="file-move-filename">{{ sourceName || '-' }}</div>
      </div>

      <div class="file-move-field">
        <label class="file-move-label">{{ t('files.move.currentDir') }}</label>
        <div class="file-move-current">{{ currentDirText }}</div>
      </div>

      <div class="file-move-field">
        <label class="file-move-label">{{ t('files.move.targetDir') }}</label>
        <MountMoveTree
          :nodes="rootNodes"
          :selected-dir="selectedDir"
          :children-map="childrenMap"
          :loading-dirs="loadingDirs"
          :root-label="t('files.move.rootDir')"
          @select="handleTreeSelect"
          @toggle="handleToggle"
        />
      </div>

      <div class="file-move-field">
        <label class="file-move-label" for="file-move-dir">{{
          t('files.move.customDirLabel')
        }}</label>
        <Input
          id="file-move-dir"
          :model-value="targetDir"
          :placeholder="t('files.move.customDirPlaceholder')"
          size="small"
          @update:model-value="targetDir = String($event || '')"
          @keyup.enter="handleConfirm"
        />
      </div>

      <p v-if="isSameTarget" class="file-move-warning">
        {{ t('files.move.sameDir') }}
      </p>
    </div>

    <template #footer>
      <Button type="default" :disabled="loading" @click="handleCancel">
        {{ t('common.cancel') }}
      </Button>
      <Button type="primary" :loading="loading" :disabled="!canSubmit" @click="handleConfirm">
        {{ t('files.move.action') }}
      </Button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from '../ui/button/Button.vue'
import Input from '../ui/input/Input.vue'
import Modal from '../ui/modal/Modal.vue'
import MountMoveTree from '../mount/MountMoveTree.vue'
import { collectChildDirs, normalizeDir } from '../../utils/files.js'

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  sourceName: {
    type: String,
    default: '',
  },
  sourceDir: {
    type: String,
    default: '',
  },
  // Files 页已加载的全部目录（扁平、含祖先），用于本地构建目录树
  dirs: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:show', 'cancel', 'confirm'])
const { t } = useI18n({ useScope: 'global' })

// targetDir 是唯一真源：树选择写入它，用户也可手动编辑/清空（空=根）
const targetDir = ref('')
const rootNodes = ref([])
const childrenMap = reactive({})
const loadingDirs = reactive({})

const currentSourceDir = computed(() => normalizeDir(props.sourceDir))
const currentDirText = computed(() => currentSourceDir.value || t('files.move.rootDir'))
const normalizedTarget = computed(() => normalizeDir(targetDir.value))
// 树高亮跟随归一后的目标目录
const selectedDir = computed(() => normalizedTarget.value)
const isSameTarget = computed(() => normalizedTarget.value === currentSourceDir.value)
const canSubmit = computed(() => !isSameTarget.value && !props.loading)

// prefix 带尾斜杠（根为 ''）→ 直接子目录节点 [{key: 'a/b/', name: 'b'}]
const buildChildNodes = (dirPrefix) => {
  const prefix = String(dirPrefix || '')
  const parent = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return collectChildDirs(parent, props.dirs).map((child) => ({
    key: `${child.prefix}/`,
    name: child.label,
  }))
}

const loadDir = (dirPrefix) => {
  const prefix = String(dirPrefix || '')
  const nodes = buildChildNodes(prefix)
  if (!prefix) {
    rootNodes.value = nodes
  } else {
    childrenMap[prefix] = nodes
  }
}

const resetState = () => {
  targetDir.value = currentSourceDir.value
  rootNodes.value = []
  Object.keys(childrenMap).forEach((key) => delete childrenMap[key])
  Object.keys(loadingDirs).forEach((key) => delete loadingDirs[key])
}

// 打开时沿 sourceDir 逐层展开，让当前目录在树中可见
const expandToSourceDir = () => {
  const parts = currentSourceDir.value.split('/').filter(Boolean)
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}/${part}/` : `${part}/`
    loadDir(acc)
  }
}

const handleToggle = (folderKey) => {
  const key = String(folderKey || '')
  if (childrenMap[key]) {
    delete childrenMap[key]
    return
  }
  loadDir(key)
}

const handleTreeSelect = (dir) => {
  targetDir.value = String(dir || '')
}

const handleConfirm = () => {
  if (!canSubmit.value || props.loading) return
  emit('confirm', { toDir: normalizedTarget.value })
}

const handleCancel = () => {
  if (props.loading) return
  emit('cancel')
}

const handleShowUpdate = (nextValue) => {
  if (props.loading) return
  if (!nextValue) {
    emit('cancel')
    return
  }
  emit('update:show', true)
}

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    resetState()
    loadDir('')
    expandToSourceDir()
  },
  { immediate: true }
)
</script>

<style scoped>
.file-move-form {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-md);
}

.file-move-field {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-xs);
}

.file-move-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--nb-ink);
}

.file-move-filename,
.file-move-current {
  font-size: 0.875rem;
  color: var(--nb-muted-foreground, var(--nb-gray-600));
  word-break: break-all;
}

.file-move-warning {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--nb-warning, #b45309);
}
</style>
