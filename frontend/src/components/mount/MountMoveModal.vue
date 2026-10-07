<template>
  <Modal
    :show="show"
    :title="isRenameMode ? t('mount.move.titleRename') : t('mount.move.titleMove')"
    width="480px"
    @update:show="handleShowUpdate"
  >
    <div class="mount-move-form">
      <div class="mount-move-field">
        <label class="mount-move-label">{{ t('mount.move.currentDir') }}</label>
        <div class="mount-move-current">{{ currentDirText }}</div>
      </div>

      <div class="mount-move-field">
        <label class="mount-move-label">{{ t('mount.move.targetDir') }}</label>
        <div v-if="dirsError" class="mount-move-error">
          {{ t('mount.move.loadDirsFailed') }}
          <button type="button" class="mount-move-retry" @click="loadDir('')">
            {{ t('common.retry') }}
          </button>
        </div>
        <MountMoveTree
          v-else
          :nodes="rootNodes"
          :selected-dir="selectedDir"
          :children-map="childrenMap"
          :loading-dirs="loadingDirs"
          :root-label="t('mount.move.rootDir')"
          @select="selectedDir = $event"
          @toggle="handleToggle"
        />
      </div>

      <div class="mount-move-field">
        <label class="mount-move-label" for="mount-move-filename">
          {{ t('mount.move.fileName') }}
        </label>
        <Input
          id="mount-move-filename"
          :model-value="fileName"
          :placeholder="sourceName"
          size="small"
          @update:model-value="fileName = String($event || '')"
          @keyup.enter="handleConfirm"
        />
      </div>

      <p v-if="isSameTarget" class="mount-move-warning">
        {{ t('mount.move.sameAsSource') }}
      </p>
    </div>

    <template #footer>
      <Button type="default" :disabled="loading" @click="handleCancel">
        {{ t('common.cancel') }}
      </Button>
      <Button type="primary" :loading="loading" :disabled="!canSubmit" @click="handleConfirm">
        {{ isRenameMode ? t('mount.move.actionRename') : t('mount.move.actionMove') }}
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
import MountMoveTree from './MountMoveTree.vue'
import { isSameMountMoveTarget } from '../../utils/mountObjects.js'

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  mode: {
    type: String,
    default: 'move',
  },
  sourceKey: {
    type: String,
    default: '',
  },
  sourceName: {
    type: String,
    default: '',
  },
  sourceDir: {
    type: String,
    default: '',
  },
  loading: {
    type: Boolean,
    default: false,
  },
  // 懒加载目录树：prefix（带尾斜杠）-> Promise<节点数组 [{key, name}]>
  loadFolders: {
    type: Function,
    required: true,
  },
})

const emit = defineEmits(['update:show', 'cancel', 'confirm'])
const { t } = useI18n({ useScope: 'global' })

const isRenameMode = computed(() => props.mode === 'rename')
const fileName = ref('')
const selectedDir = ref('')
const rootNodes = ref([])
const childrenMap = reactive({})
const loadingDirs = reactive({})
const dirsError = ref(false)

const currentSourceDir = computed(() => String(props.sourceDir || ''))
const currentDirText = computed(() => currentSourceDir.value || t('mount.move.rootDir'))
const isSameTarget = computed(() =>
  isSameMountMoveTarget(props.sourceKey, selectedDir.value, fileName.value)
)
const canSubmit = computed(
  () => Boolean(fileName.value.trim()) && !isSameTarget.value && !dirsError.value
)

const resetState = () => {
  fileName.value = String(props.sourceName || '')
  selectedDir.value = currentSourceDir.value
  rootNodes.value = []
  Object.keys(childrenMap).forEach((key) => delete childrenMap[key])
  Object.keys(loadingDirs).forEach((key) => delete loadingDirs[key])
  dirsError.value = false
}

const loadDir = async (dirPrefix) => {
  const prefix = String(dirPrefix || '')
  loadingDirs[prefix] = true
  dirsError.value = false
  try {
    const nodes = await props.loadFolders(prefix)
    if (!prefix) {
      rootNodes.value = Array.isArray(nodes) ? nodes : []
    } else {
      childrenMap[prefix] = Array.isArray(nodes) ? nodes : []
    }
  } catch (error) {
    dirsError.value = true
  } finally {
    delete loadingDirs[prefix]
  }
}

// 打开时沿 sourceDir 路径逐层懒加载，让当前目录在树中可见
const expandToSourceDir = async () => {
  const parts = String(props.sourceDir || '')
    .split('/')
    .filter(Boolean)
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}/${part}/` : `${part}/`
    await loadDir(acc)
  }
}

const handleToggle = (folderPrefix) => {
  const key = String(folderPrefix || '')
  if (childrenMap[key] || loadingDirs[key]) return
  loadDir(key)
}

const handleConfirm = () => {
  if (!canSubmit.value || props.loading) return
  emit('confirm', {
    toDir: selectedDir.value,
    newName: fileName.value.trim(),
  })
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

// v-if 挂载 + watch(show, immediate)：每次打开重置、从挂载根懒加载并展开到源目录
watch(
  () => props.show,
  async (visible) => {
    if (!visible) return
    resetState()
    await loadDir('')
    await expandToSourceDir()
  },
  { immediate: true }
)
</script>

<style scoped>
.mount-move-form {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-md);
}

.mount-move-field {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-xs);
}

.mount-move-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--nb-ink);
}

.mount-move-current {
  font-size: 0.875rem;
  color: var(--nb-muted-foreground, var(--nb-gray-600));
  word-break: break-all;
}

.mount-move-error {
  display: flex;
  align-items: center;
  gap: var(--nb-space-xs);
  font-size: 0.8125rem;
  color: var(--destructive, var(--nb-danger));
}

.mount-move-retry {
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  color: var(--nb-primary);
  cursor: pointer;
  text-decoration: underline;
}

.mount-move-warning {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--nb-warning, #b45309);
}
</style>
