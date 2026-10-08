import { computed, ref } from 'vue'
import { deleteUploadProgress, generateFileId, listUploadProgress } from '../utils/uploadResume.js'

/**
 * 未完成分片上传（断点续传）列表状态与动作
 *
 * api / t / message 由调用方注入，便于在无浏览器环境下单测（对标 useUploadConfigOptions）。
 */
export function useUploadResumeEntries({ api, t, message }) {
  const resumeEntries = ref([])
  const discardTarget = ref(null)
  const discarding = ref(false)

  const hasResumeEntries = computed(() => resumeEntries.value.length > 0)

  // listUploadProgress 已完成结构校验与过期过滤，这里拿到的就是可信数据
  const refreshResumeEntries = () => {
    resumeEntries.value = listUploadProgress()
  }

  const requestDiscard = (fileId) => {
    discardTarget.value = resumeEntries.value.find((entry) => entry.fileId === fileId) || null
  }

  const cancelDiscard = () => {
    discardTarget.value = null
  }

  const confirmDiscard = async () => {
    const entry = discardTarget.value
    if (!entry || discarding.value) return

    discarding.value = true
    try {
      try {
        await api.abortMultipartUpload({ file_id: entry.serverFileId })
      } catch (error) {
        // 服务端记录可能早已过期或被清理，abort 失败不应把本地死记录钉在列表上
        console.warn('放弃未完成上传时 abort 服务端分片失败:', error)
      }

      deleteUploadProgress(entry.fileId)
      refreshResumeEntries()
      discardTarget.value = null
      message.success(t('upload.resume.discarded'))
    } finally {
      discarding.value = false
    }
  }

  // 身份校验：name / size / lastModified 三要素必须完全一致，不做模糊匹配、不迁移记录
  const matchResumeFile = (entry, file) => {
    if (!entry?.fileId || !file) return false
    return generateFileId(file) === entry.fileId
  }

  return {
    resumeEntries,
    hasResumeEntries,
    discardTarget,
    discarding,
    refreshResumeEntries,
    requestDiscard,
    cancelDiscard,
    confirmDiscard,
    matchResumeFile,
  }
}
