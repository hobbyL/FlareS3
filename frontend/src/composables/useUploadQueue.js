import { computed, ref } from 'vue'

const DEFAULT_UPLOAD_CONCURRENCY = 2

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

function normalizeConcurrency(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_UPLOAD_CONCURRENCY
  return Math.floor(parsed)
}

export function useUploadQueue({ runTask, concurrency = DEFAULT_UPLOAD_CONCURRENCY } = {}) {
  const items = ref([])
  const activeItemId = ref('')
  const latestSuccessItem = ref(null)
  const runningCount = ref(0)
  const paused = ref(false)

  const concurrencyLimit = normalizeConcurrency(concurrency)

  let disposed = false
  let drainPromise = null
  let drainResolve = null
  // 暂停闸门：进行中的分片任务在相邻分片之间 await waitWhilePaused()，暂停时挂起
  // （不中止已发出的分片请求），恢复 / 取消 / 销毁时放行。
  const pauseGate = new Set()

  const activeItem = computed(
    () => items.value.find((item) => item.id === activeItemId.value) || null
  )

  const patchItem = (itemId, patch) => {
    const target = items.value.find((item) => item.id === itemId)
    if (!target) return
    Object.assign(target, patch)
  }

  const flushPauseGate = () => {
    const waiters = [...pauseGate]
    pauseGate.clear()
    waiters.forEach((check) => check())
  }

  // shouldStop 命中（任务被取消 / 队列销毁）时即使仍是暂停态也立即放行，否则被取消的
  // 在飞任务会一直卡在闸门里，无法进入 abort 补偿路径。
  const waitWhilePaused = (shouldStop) =>
    new Promise((resolve) => {
      const check = () => {
        if (disposed || !paused.value || (typeof shouldStop === 'function' && shouldStop())) {
          pauseGate.delete(check)
          resolve()
          return
        }
        pauseGate.add(check)
      }
      check()
    })

  const runSingleItem = async (item) => {
    runningCount.value += 1
    activeItemId.value = item.id
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
        waitWhilePaused: () => waitWhilePaused(() => item.status === 'cancelled' || disposed),
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
      runningCount.value -= 1
      // activeItemId 是续传列表刷新的触发源，必须在任务 settle（含 runner 内部
      // deleteUploadProgress）之后复位。并发下它指向“当前代表的在跑任务”：代表结束时
      // 移交给另一个仍在上传的任务，全部结束时复位为 ''，保证最后一次 settle 之后必然
      // 触发一次刷新（见 state-management.md R4）。
      if (activeItemId.value === item.id) {
        const nextActive = items.value.find((entry) => entry.status === 'uploading')
        activeItemId.value = nextActive ? nextActive.id : ''
      }
    }
  }

  const canStartMore = () => !disposed && !paused.value && runningCount.value < concurrencyLimit

  const nextQueuedItem = () => items.value.find((item) => item.status === 'queued') || null

  const settleDrainIfIdle = () => {
    if (runningCount.value === 0 && drainResolve) {
      const resolve = drainResolve
      drainResolve = null
      drainPromise = null
      resolve()
    }
  }

  // 工作池：每轮尽量填满空闲并发槽。runSingleItem 同步置 uploading 并自增 runningCount，
  // 故同一轮 while 不会重复取到同一项；任务 settle 后再次 pump 补位。
  const pump = () => {
    if (disposed) {
      settleDrainIfIdle()
      return
    }
    let nextItem = canStartMore() ? nextQueuedItem() : null
    while (nextItem) {
      runSingleItem(nextItem).then(pump)
      nextItem = canStartMore() ? nextQueuedItem() : null
    }
    settleDrainIfIdle()
  }

  const drainQueue = () => {
    if (!drainPromise) {
      drainPromise = new Promise((resolve) => {
        drainResolve = resolve
      })
    }
    // pump 在空闲时会同步 resolve 并把 drainPromise 置空，先捕获当前引用再返回。
    const current = drainPromise
    pump()
    return current
  }

  const enqueueFiles = (files = []) => {
    const normalizedFiles = Array.isArray(files) ? files.filter(Boolean) : []
    if (!normalizedFiles.length) return

    items.value.push(...normalizedFiles.map((file) => createUploadQueueItem(file)))
    void drainQueue()
  }

  const pause = () => {
    if (paused.value) return
    paused.value = true
  }

  const resume = () => {
    if (!paused.value) return
    paused.value = false
    flushPauseGate()
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
    }

    // 若任务此刻卡在暂停闸门，唤醒它重新判定 shouldStop → 立即放行进入取消补偿。
    flushPauseGate()
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
    flushPauseGate()
    for (const item of items.value) {
      if (item.status === 'uploading') {
        item.status = 'cancelled'
        item.cancel?.()
      }
    }
  }

  return {
    items,
    activeItemId,
    activeItem,
    latestSuccessItem,
    paused: computed(() => paused.value),
    isUploading: computed(() => runningCount.value > 0),
    enqueueFiles,
    pause,
    resume,
    cancelItem,
    retryItem,
    removeItem,
    clearFinished,
    whenIdle,
    dispose,
    createCancellationError,
  }
}
