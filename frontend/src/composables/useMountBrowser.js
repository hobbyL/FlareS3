import { computed, ref } from 'vue'
import {
  buildMountedObjectRows,
  getMountParentPrefix,
  normalizeMountPrefix,
} from '../utils/mountObjects.js'

export function useMountBrowser({ api, t, message, selectedConfigId }) {
  const hasLoadedOnce = ref(false)
  const prefix = ref('')
  const prefixInput = ref('')
  const limit = ref(20)
  const pageSizeOptions = [10, 20, 50]
  const tokenStack = ref([null])
  const listResult = ref(null)
  const loading = ref(false)
  const activeAction = ref('')
  const loadRequestSerial = ref(0)

  const currentToken = computed(() => tokenStack.value[tokenStack.value.length - 1] || '')
  const pageNumber = computed(() => tokenStack.value.length)
  const canPrev = computed(() => tokenStack.value.length > 1)
  const canNext = computed(() => Boolean(listResult.value?.next_continuation_token))
  const paginationTotal = computed(() => {
    const pageSize = Number(limit.value || 100)
    return pageSize * (pageNumber.value + (canNext.value ? 1 : 0))
  })
  const paginationDisplayTotal = computed(() => {
    const pageSize = Number(limit.value || 100)
    const count = Number(listResult.value?.key_count || 0)
    const seen = Math.max(0, (pageNumber.value - 1) * pageSize + count)
    return canNext.value ? `${seen}+` : seen
  })
  const breadcrumbItems = computed(() => {
    const raw = String(prefix.value || '')
    const parts = (raw.endsWith('/') ? raw.slice(0, -1) : raw).split('/').filter(Boolean)
    let acc = ''
    return parts.map((part) => {
      acc += `${part}/`
      return { label: part, prefix: acc }
    })
  })
  const tableData = computed(() =>
    buildMountedObjectRows({
      basePrefix: prefix.value,
      folders: listResult.value?.folders,
      objects: listResult.value?.objects,
    })
  )

  const loadObjects = async () => {
    const configId = String(selectedConfigId.value || '').trim()
    if (!configId) return false

    const requestSerial = ++loadRequestSerial.value
    loading.value = true
    try {
      const result = await api.listMountedObjects({
        configId,
        prefix: prefix.value,
        continuationToken: currentToken.value || undefined,
        limit: Number(limit.value || 100),
      })
      if (requestSerial !== loadRequestSerial.value) return false
      listResult.value = result
      hasLoadedOnce.value = true
      return true
    } catch (error) {
      if (requestSerial === loadRequestSerial.value) {
        message.error(error.response?.data?.error || t('mount.messages.loadObjectsFailed'))
      }
      return false
    } finally {
      if (requestSerial === loadRequestSerial.value) {
        loading.value = false
        activeAction.value = ''
      }
    }
  }

  const navigateToPrefix = async (value) => {
    if (loading.value) return
    prefix.value = normalizeMountPrefix(value)
    prefixInput.value = prefix.value
    tokenStack.value = [null]
    await loadObjects()
  }
  const goRoot = () => navigateToPrefix('')
  const goUp = () =>
    prefix.value ? navigateToPrefix(getMountParentPrefix(prefix.value)) : undefined
  const openFolder = (folderPrefix) => navigateToPrefix(String(folderPrefix || ''))
  const handleApplyPrefix = () => navigateToPrefix(prefixInput.value)
  const handleRefresh = async () => {
    if (loading.value) return
    activeAction.value = 'refresh'
    tokenStack.value = [tokenStack.value[0]]
    await loadObjects()
  }
  const prevPage = async () => {
    if (loading.value || !canPrev.value) return
    const removed = tokenStack.value.pop()
    if (!(await loadObjects())) tokenStack.value.push(removed)
  }
  const nextPage = async () => {
    if (loading.value) return
    const nextToken = String(listResult.value?.next_continuation_token || '').trim()
    if (!nextToken) return
    activeAction.value = 'loadMore'
    tokenStack.value.push(nextToken)
    if (!(await loadObjects())) tokenStack.value.pop()
  }
  const handlePaginationPageChange = async (targetPage) => {
    if (loading.value) return
    const nextPageNumber = Number(targetPage)
    if (!Number.isFinite(nextPageNumber) || nextPageNumber < 1) return
    const currentPageNumber = pageNumber.value
    if (nextPageNumber === currentPageNumber) return
    if (nextPageNumber === currentPageNumber - 1) return prevPage()
    if (nextPageNumber === currentPageNumber + 1) return nextPage()
    if (nextPageNumber < currentPageNumber) {
      const previousStack = [...tokenStack.value]
      tokenStack.value = tokenStack.value.slice(0, nextPageNumber)
      if (!(await loadObjects())) tokenStack.value = previousStack
    }
  }
  const handlePaginationPageSizeChange = (value) => {
    const nextSize = Number(value)
    if (!Number.isFinite(nextSize) || nextSize <= 0 || nextSize === Number(limit.value)) return
    limit.value = nextSize
  }
  const resetForConfig = async (configId) => {
    if (!configId) {
      listResult.value = null
      tokenStack.value = [null]
      return
    }
    prefix.value = ''
    prefixInput.value = ''
    tokenStack.value = [null]
    await loadObjects()
  }

  return {
    hasLoadedOnce,
    prefix,
    prefixInput,
    limit,
    pageSizeOptions,
    tokenStack,
    listResult,
    loading,
    activeAction,
    pageNumber,
    canNext,
    paginationTotal,
    paginationDisplayTotal,
    breadcrumbItems,
    tableData,
    loadObjects,
    navigateToPrefix,
    goRoot,
    goUp,
    openFolder,
    handleApplyPrefix,
    handleRefresh,
    nextPage,
    handlePaginationPageChange,
    handlePaginationPageSizeChange,
    resetForConfig,
  }
}
