import { computed, ref } from 'vue'
import {
  buildShareSelectedIdSet,
  collectSelectedShares,
  toShareSelectionKey,
  updateShareSelection,
} from '../utils/shares.js'

export function useShareSelection(items) {
  const selectedIds = ref([])
  const pageRowIds = computed(() =>
    items.value.map((item) => toShareSelectionKey(item)).filter(Boolean)
  )
  const selectedIdSet = computed(() => buildShareSelectedIdSet(selectedIds.value))
  const selectedShares = computed(() => collectSelectedShares(items.value, selectedIds.value))
  const selectedSharesCount = computed(() => selectedShares.value.length)
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
    selectedIds.value = updateShareSelection(selectedIds.value, rowId, checked)
  }

  return {
    selectedIds,
    pageRowIds,
    selectedIdSet,
    selectedShares,
    selectedSharesCount,
    allRowsSelected,
    selectAllIndeterminate,
    clearSelection,
    toggleSelectAll,
    toggleRowSelection,
  }
}
