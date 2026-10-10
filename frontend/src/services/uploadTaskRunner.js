import { resolveUploadErrorMessage } from '../utils/uploadErrors.js'
import {
  createCancelledError,
  formatBytes,
  isCancelledError,
  resolveDownloadUrl,
  resolveShortUrl,
} from '../utils/uploadPanel.js'
import {
  generateFileId,
  getUploadProgress,
  saveUploadProgress,
  updateUploadedParts,
  deleteUploadProgress,
} from '../utils/uploadResume.js'

const MULTIPART_THRESHOLD = 100 * 1024 * 1024
const PART_UPLOAD_RETRY_COUNT = 3

const createTaskState = () => ({
  uploadStartTime: Date.now(),
  activeMultipart: null,
  cancelRequested: false,
  // cancelTask 是否已经发出过 abort：用于让 catch 块判断需不需要补偿调用，
  // 避免同一个分片上传被 abort 两次
  abortIssued: false,
  inFlightControllers: new Set(),
})

const registerController = (taskState) => {
  const controller = new AbortController()
  taskState.inFlightControllers.add(controller)
  return controller
}

const abortInFlightRequests = (taskState) => {
  for (const controller of taskState.inFlightControllers) {
    try {
      controller.abort()
    } catch {
      // ignore
    }
  }
  taskState.inFlightControllers.clear()
}

const ensureTaskActive = (taskState, isCancelled) => {
  if (taskState.cancelRequested || isCancelled()) {
    throw createCancelledError()
  }
}

export function createUploadTaskRunner({ api, t, onUploaded }) {
  const formatDuration = (seconds) => {
    if (seconds < 60) return t('upload.seconds', { value: Number(seconds).toFixed(1) })
    if (seconds < 3600) {
      return t('upload.minutesSeconds', {
        minutes: Math.floor(seconds / 60),
        seconds: Math.round(seconds % 60),
      })
    }
    return t('upload.hoursMinutes', {
      hours: Math.floor(seconds / 3600),
      minutes: Math.round((seconds % 3600) / 60),
    })
  }

  const formatRemainingTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return t('upload.calculating')
    if (seconds < 60) return t('upload.secondsOnly', { value: Math.round(seconds) })
    if (seconds < 3600) return t('upload.minutesOnly', { value: Math.round(seconds / 60) })
    return t('upload.hoursOnly', { value: (seconds / 3600).toFixed(1) })
  }

  const cancelTask = async (taskState) => {
    if (taskState.cancelRequested) return
    taskState.cancelRequested = true
    abortInFlightRequests(taskState)

    const multipart = taskState.activeMultipart
    if (!multipart?.file_id) return
    // 置位放在 await 之前：请求一旦发出就算已处理，失败也不该由 catch 块重试
    taskState.abortIssued = true
    try {
      await api.abortMultipartUpload({ file_id: multipart.file_id })
    } catch {
      // ignore
    } finally {
      taskState.activeMultipart = null
    }
  }

  const updateUploadStats = (taskState, taskFile, updateItem, loaded, total) => {
    const totalBytes = Number(total || taskFile.size || 0)
    const uploadedBytes = Math.max(0, Number(loaded || 0))
    const elapsedSeconds = Math.max((Date.now() - taskState.uploadStartTime) / 1000, 0.001)
    const avgSpeed = uploadedBytes / elapsedSeconds
    updateItem({
      progress: totalBytes > 0 ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 0,
      uploadedBytes,
      totalBytes,
      speed: uploadedBytes > 0 ? `${formatBytes(avgSpeed)}/s` : t('upload.preparing'),
      remainingTime:
        uploadedBytes >= totalBytes
          ? t('upload.secondsOnly', { value: 0 })
          : formatRemainingTime(
              avgSpeed > 0 ? (totalBytes - uploadedBytes) / avgSpeed : Number.NaN
            ),
    })
  }

  const resolveTaskResult = (taskFile, response, completedResult, taskState) => {
    const durationSeconds = Math.max((Date.now() - taskState.uploadStartTime) / 1000, 0.001)
    const fallbackDownloadPath = response.file_id ? `/api/files/${response.file_id}/download` : ''
    return {
      success: true,
      filename: completedResult.filename || response.filename || taskFile.name,
      downloadUrl: resolveDownloadUrl(
        completedResult.download_url || response.download_url,
        fallbackDownloadPath
      ),
      shortUrl: resolveShortUrl(completedResult.short_url || response.short_url),
      fileSize: formatBytes(taskFile.size),
      avgSpeed: `${formatBytes(taskFile.size / durationSeconds)}/s`,
      duration: formatDuration(durationSeconds),
      expiresIn: taskFile.expiresIn,
    }
  }

  const uploadSmallFile = async (taskFile, taskState, updateItem, isCancelled) => {
    const response = await api.getUploadURL({
      filename: taskFile.name,
      content_type: taskFile.type || 'application/octet-stream',
      size: taskFile.size,
      expires_in: taskFile.expiresIn,
      require_login: taskFile.requireLogin,
      config_id: taskFile.configId || undefined,
      dir: taskFile.dir || undefined,
      custom_short_code: taskFile.customShortCode || undefined,
    })
    ensureTaskActive(taskState, isCancelled)

    const controller = registerController(taskState)
    try {
      await api.uploadToR2(
        response.upload_url,
        taskFile.rawFile,
        (_percent, loaded, total) =>
          updateUploadStats(taskState, taskFile, updateItem, loaded, total),
        { signal: controller.signal }
      )
    } finally {
      taskState.inFlightControllers.delete(controller)
    }

    ensureTaskActive(taskState, isCancelled)
    const confirmResult = await api.confirmUpload(response.file_id)
    ensureTaskActive(taskState, isCancelled)
    return resolveTaskResult(taskFile, response, confirmResult, taskState)
  }

  const uploadLargeFile = async (taskFile, taskState, updateItem, isCancelled, waitWhilePaused) => {
    const fileId = generateFileId(taskFile.rawFile)
    let serverFileId = ''
    let resumeProgress = null

    try {
      // 检查是否有断点续传进度
      resumeProgress = getUploadProgress(fileId)
      let initResponse
      let uploadedPartsSet = new Set()

      if (resumeProgress) {
        // 恢复上传：验证服务端状态
        try {
          const serverParts = await api.getMultipartUploadedParts(
            resumeProgress.serverFileId,
            resumeProgress.uploadId
          )
          // 服务端已有的分片
          serverParts.parts?.forEach((part) => uploadedPartsSet.add(part.PartNumber))

          initResponse = {
            file_id: resumeProgress.serverFileId,
            upload_id: resumeProgress.uploadId,
            part_size: resumeProgress.partSize,
            total_parts: resumeProgress.totalParts,
            parts:
              serverParts.parts?.map((p) => ({
                part_number: p.PartNumber,
                etag: p.ETag,
              })) || [],
          }
          serverFileId = resumeProgress.serverFileId
          console.log(
            `[Resume] 恢复上传: ${taskFile.name}, 已完成 ${uploadedPartsSet.size}/${resumeProgress.totalParts} 个分片`
          )
        } catch (error) {
          console.warn('[Resume] 恢复上传失败，将重新开始:', error)
          deleteUploadProgress(fileId)
          resumeProgress = null
        }
      }

      if (!resumeProgress) {
        // 新上传：初始化分片上传
        initResponse = await api.initMultipartUpload({
          filename: taskFile.name,
          content_type: taskFile.type || 'application/octet-stream',
          size: taskFile.size,
          expires_in: taskFile.expiresIn,
          require_login: taskFile.requireLogin,
          config_id: taskFile.configId || undefined,
          dir: taskFile.dir || undefined,
          custom_short_code: taskFile.customShortCode || undefined,
        })

        const { file_id, upload_id, part_size, total_parts } = initResponse
        serverFileId = file_id

        // 保存进度到 localStorage
        saveUploadProgress(fileId, {
          serverFileId: file_id,
          uploadId: upload_id,
          filename: taskFile.name,
          size: taskFile.size,
          partSize: part_size,
          totalParts: total_parts,
          uploadedParts: [],
        })
      }

      taskState.activeMultipart = {
        file_id: serverFileId,
        upload_id: initResponse.upload_id,
      }

      // 上传所有分片（跳过已上传的）
      const { part_size, total_parts } = initResponse

      for (let partIndex = 0; partIndex < total_parts; partIndex += 1) {
        ensureTaskActive(taskState, isCancelled)
        // 暂停闸门：跑完当前分片后、取下一分片前挂起（分片级暂停）。
        // 暂停期间不中止已发出的分片请求；恢复 / 取消 / 销毁时放行。
        if (typeof waitWhilePaused === 'function') {
          await waitWhilePaused()
          ensureTaskActive(taskState, isCancelled)
        }
        const partNumber = partIndex + 1

        // 跳过已上传的分片
        if (uploadedPartsSet.has(partNumber)) {
          const end = Math.min((partIndex + 1) * part_size, taskFile.size)
          updateUploadStats(taskState, taskFile, updateItem, end, taskFile.size)
          continue
        }

        const start = partIndex * part_size
        const end = Math.min(start + part_size, taskFile.size)
        const chunk = taskFile.rawFile.slice(start, end)
        let lastError = null

        for (let attempt = 1; attempt <= PART_UPLOAD_RETRY_COUNT; attempt += 1) {
          try {
            ensureTaskActive(taskState, isCancelled)
            const presignResponse = await api.getMultipartUploadURL({
              file_id: serverFileId,
              upload_id: initResponse.upload_id,
              part_number: partNumber,
            })
            ensureTaskActive(taskState, isCancelled)

            const controller = registerController(taskState)
            try {
              const uploadResponse = await api.uploadToR2(
                presignResponse.upload_url,
                chunk,
                (_percent, loaded) =>
                  updateUploadStats(taskState, taskFile, updateItem, start + loaded, taskFile.size),
                { signal: controller.signal }
              )
              let etag = uploadResponse.headers?.etag || ''
              if (!etag) throw new Error(t('upload.errors.partMissingEtag', { partNumber }))
              if (!etag.startsWith('"')) etag = `"${etag}"`

              updateUploadStats(taskState, taskFile, updateItem, end, taskFile.size)
              initResponse.parts = [
                ...(initResponse.parts || []),
                { part_number: partNumber, etag },
              ]

              // 保存进度
              updateUploadedParts(fileId, partNumber)
              uploadedPartsSet.add(partNumber)

              lastError = null
              break
            } finally {
              taskState.inFlightControllers.delete(controller)
            }
          } catch (error) {
            if (isCancelledError(error) || taskState.cancelRequested || isCancelled()) {
              throw createCancelledError()
            }
            lastError = error
            if (attempt < PART_UPLOAD_RETRY_COUNT) {
              await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
            }
          }
        }
        if (lastError) throw lastError
      }

      ensureTaskActive(taskState, isCancelled)
      const completeResult = await api.completeMultipartUpload({
        file_id: serverFileId,
        upload_id: initResponse.upload_id,
        parts: initResponse.parts || [],
      })

      // 上传成功，清理进度
      deleteUploadProgress(fileId)

      ensureTaskActive(taskState, isCancelled)
      return resolveTaskResult(taskFile, initResponse, completeResult, taskState)
    } catch (error) {
      const cancelled = isCancelledError(error) || taskState.cancelRequested || isCancelled()

      if (cancelled) {
        // 取消 = 放弃：清本地记录，避免续传任务被取消后留下僵尸进度
        //（续传列表会把它显示成假条目）
        deleteUploadProgress(fileId)

        // 取消落在 init / parts 往返窗口内时，activeMultipart 还没赋值，
        // cancelTask 会 early return 不发 abort，此处补偿一次，否则服务端会留下
        // 无人回收的分片上传（永不过期的文件连 cleanupExpired 都兜不住）
        if (serverFileId && !taskState.abortIssued) {
          taskState.abortIssued = true
          try {
            await api.abortMultipartUpload({ file_id: serverFileId })
          } catch {
            // ignore：取消语义不因回收失败而改变
          }
        }
      } else if (serverFileId && !resumeProgress) {
        // 新上传失败才 abort，恢复上传失败保留进度
        try {
          await api.abortMultipartUpload({ file_id: serverFileId })
          deleteUploadProgress(fileId)
        } catch {
          // ignore
        } finally {
          if (taskState.activeMultipart?.file_id === serverFileId) {
            taskState.activeMultipart = null
          }
        }
      }
      throw error
    } finally {
      if (serverFileId && taskState.activeMultipart?.file_id === serverFileId) {
        taskState.activeMultipart = null
      }
    }
  }

  const uploadServerFile = async (taskFile, taskState, updateItem) => {
    updateItem({
      progress: 0,
      uploadedBytes: 0,
      totalBytes: taskFile.size,
      speed: t('upload.preparing'),
      remainingTime: t('upload.calculating'),
    })
    const result = await api.serverUpload({
      configId: taskFile.configId,
      file: taskFile.rawFile,
      filename: taskFile.name,
      expiresIn: taskFile.expiresIn,
      requireLogin: taskFile.requireLogin,
      dir: taskFile.dir || undefined,
      customShortCode: taskFile.customShortCode || undefined,
      onProgress: (_percent, loaded, total) =>
        updateUploadStats(taskState, taskFile, updateItem, loaded, total),
    })
    return resolveTaskResult(taskFile, result, result, taskState)
  }

  return async (
    item,
    { updateItem, setCancel, isCancelled, waitWhilePaused = () => Promise.resolve() }
  ) => {
    const taskFile = item.file
    const taskState = createTaskState()
    updateItem({
      progress: 0,
      uploadedBytes: 0,
      totalBytes: taskFile.size,
      speed: t('upload.preparing'),
      remainingTime: t('upload.calculating'),
    })
    setCancel(() => void cancelTask(taskState))

    try {
      const result =
        taskFile.configType !== 'r2'
          ? await uploadServerFile(taskFile, taskState, updateItem)
          : taskFile.size < MULTIPART_THRESHOLD
            ? await uploadSmallFile(taskFile, taskState, updateItem, isCancelled)
            : await uploadLargeFile(taskFile, taskState, updateItem, isCancelled, waitWhilePaused)
      onUploaded(taskFile)
      return result
    } catch (error) {
      if (isCancelledError(error) || taskState.cancelRequested || isCancelled()) {
        throw createCancelledError()
      }
      throw new Error(resolveUploadErrorMessage(error, t('upload.uploadFailed')))
    } finally {
      abortInFlightRequests(taskState)
    }
  }
}
