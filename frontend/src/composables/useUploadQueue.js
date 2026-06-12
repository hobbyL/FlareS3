import { computed, ref } from 'vue'

let uploadQueueItemSeed = 0

function createUploadQueueItem(file) {
  uploadQueueItemSeed += 1

  return {
    id: `upload-${Date.now()}-${uploadQueueItemSeed}`,
    file,
    status: 'queued',
    progress: 0,
    uploadedBytes: 0,
    totalBytes: Number(file?.size || 0),
    speed: '',
    remainingTime: '',
    result: null,
    error: '',
    cancel: null,
  }
}

function createCancellationError() {
  return new Error('UPLOAD_CANCELLED')
}

export function useUploadQueue({ runTask }) {
  const items = ref([])
  const activeItemId = ref('')
  const latestSuccessItem = ref(null)
  const isProcessing = ref(false)

  let disposed = false
  let drainPromise = null

  const activeItem = computed(
    () => items.value.find((item) => item.id === activeItemId.value) || null
  )

  const patchItem = (itemId, patch) => {
    const target = items.value.find((item) => item.id === itemId)
    if (!target) return
    Object.assign(target, patch)
  }

  const runSingleItem = async (item) => {
    activeItemId.value = item.id
    isProcessing.value = true
    item.status = 'uploading'
    item.error = ''
    item.result = null

    let cancelHandler = null

    try {
      const result = await runTask(item, {
        updateItem: (patch = {}) => patchItem(item.id, patch),
        setCancel: (handler) => {
          cancelHandler = typeof handler === 'function' ? handler : null
          item.cancel = cancelHandler
        },
        isCancelled: () => item.status === 'cancelled' || disposed,
      })

      if (item.status !== 'cancelled') {
        item.status = 'success'
        item.progress = 100
        item.uploadedBytes = item.totalBytes
        item.result = result ?? null
        item.error = ''
        latestSuccessItem.value = item
      }
    } catch (error) {
      if (item.status === 'cancelled' || error?.message === 'UPLOAD_CANCELLED') {
        item.status = 'cancelled'
        item.error = ''
      } else {
        item.status = 'error'
        item.error = error?.message || 'Upload failed'
      }
    } finally {
      if (item.cancel === cancelHandler) {
        item.cancel = null
      }
      activeItemId.value = ''
      isProcessing.value = false
    }
  }

  const drainQueue = async () => {
    if (drainPromise) {
      return drainPromise
    }

    drainPromise = (async () => {
      while (!disposed) {
        const nextItem = items.value.find((item) => item.status === 'queued')
        if (!nextItem) {
          break
        }
        await runSingleItem(nextItem)
      }
    })()

    try {
      await drainPromise
    } finally {
      drainPromise = null
    }
  }

  const enqueueFiles = (files = []) => {
    const normalizedFiles = Array.isArray(files) ? files.filter(Boolean) : []
    if (!normalizedFiles.length) return

    items.value.push(...normalizedFiles.map((file) => createUploadQueueItem(file)))
    void drainQueue()
  }

  const cancelItem = (itemId) => {
    const item = items.value.find((entry) => entry.id === itemId)
    if (!item || item.status !== 'uploading') {
      return
    }

    item.status = 'cancelled'

    if (typeof item.cancel === 'function') {
      item.cancel()
      return
    }
  }

  const retryItem = (itemId) => {
    const item = items.value.find((entry) => entry.id === itemId)
    if (!item || !['error', 'cancelled'].includes(item.status)) {
      return
    }

    Object.assign(item, {
      status: 'queued',
      progress: 0,
      uploadedBytes: 0,
      speed: '',
      remainingTime: '',
      result: null,
      error: '',
      cancel: null,
    })

    void drainQueue()
  }

  const removeItem = (itemId) => {
    items.value = items.value.filter((item) => item.id !== itemId)
    if (latestSuccessItem.value?.id === itemId) {
      latestSuccessItem.value =
        [...items.value].reverse().find((item) => item.status === 'success' && item.result) || null
    }
  }

  const clearFinished = () => {
    const successIds = new Set(
      items.value.filter((item) => item.status === 'success').map((item) => item.id)
    )
    items.value = items.value.filter((item) => !successIds.has(item.id))
    if (latestSuccessItem.value && successIds.has(latestSuccessItem.value.id)) {
      latestSuccessItem.value =
        [...items.value].reverse().find((item) => item.status === 'success' && item.result) || null
    }
  }

  const whenIdle = async () => {
    await drainQueue()
  }

  const dispose = () => {
    disposed = true
    const current = activeItem.value
    if (current && current.status === 'uploading') {
      current.status = 'cancelled'
      current.cancel?.()
    }
  }

  return {
    items,
    activeItemId,
    activeItem,
    latestSuccessItem,
    isUploading: computed(() => isProcessing.value),
    enqueueFiles,
    cancelItem,
    retryItem,
    removeItem,
    clearFinished,
    whenIdle,
    dispose,
    createCancellationError,
  }
}
