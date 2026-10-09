import { computed, ref } from 'vue'
import {
  buildFileSelectedIdSet,
  collectSelectedFiles,
  toFileSelectionKey,
  updateFileSelection,
} from '../utils/files.js'

/**
 * 文件列表多选状态机（纯状态，无副作用）。
 *
 * 清空时机由视图层决定（翻页 / 改页大小 / 切 active↔trash / 改筛选 /
 * 批量操作完成后显式调用 clearSelection），composable 自身不 watch，
 * 以便单测（hook-guidelines：无副作用边界）。
 *
 * @param {import('vue').Ref<Array>} items - 当前页文件行（响应式）
 */
export function useFileSelection(items) {
  const selectedIds = ref([])

  const pageRowIds = computed(() =>
    (items.value || []).map((item) => toFileSelectionKey(item)).filter(Boolean)
  )
  const selectedIdSet = computed(() => buildFileSelectedIdSet(selectedIds.value))
  const selectedFiles = computed(() => collectSelectedFiles(items.value, selectedIds.value))
  const selectedFilesCount = computed(() => selectedFiles.value.length)

  const allRowsSelected = computed(
    () => pageRowIds.value.length > 0 && pageRowIds.value.every((id) => selectedIdSet.value.has(id))
  )
  const someRowsSelected = computed(
    () => pageRowIds.value.length > 0 && pageRowIds.value.some((id) => selectedIdSet.value.has(id))
  )
  const selectAllIndeterminate = computed(() => someRowsSelected.value && !allRowsSelected.value)

  const clearSelection = () => {
    selectedIds.value = []
  }
  const toggleSelectAll = (checked) => {
    selectedIds.value = checked ? [...pageRowIds.value] : []
  }
  const toggleRowSelection = (rowId, checked) => {
    selectedIds.value = updateFileSelection(selectedIds.value, rowId, checked)
  }

  return {
    selectedIds,
    pageRowIds,
    selectedIdSet,
    selectedFiles,
    selectedFilesCount,
    allRowsSelected,
    selectAllIndeterminate,
    clearSelection,
    toggleSelectAll,
    toggleRowSelection,
  }
}
