import { computed, ref } from 'vue'

export function useUploadConfigOptions({ api, t, message }) {
  const selectedConfigId = ref('')
  const uploadConfigOptions = ref([])
  const configOptionsLoading = ref(false)

  const hasAvailableUploadConfig = computed(() => uploadConfigOptions.value.length > 0)
  const selectedConfig = computed(
    () =>
      uploadConfigOptions.value.find((option) => option.value === selectedConfigId.value) || null
  )
  const selectedConfigType = computed(() => selectedConfig.value?.type || 'r2')
  const selectedConfigLabel = computed(() => selectedConfig.value?.label || '')
  const resolvedUploadConfigId = computed(() => selectedConfig.value?.value || '')
  const isUploadEntryDisabled = computed(
    () => configOptionsLoading.value || !hasAvailableUploadConfig.value
  )
  const uploadHintText = computed(() =>
    selectedConfigType.value === 'r2' ? t('upload.hint5gb') : t('upload.hint100mb')
  )
  // 兜底文案统一走 i18n errors 命名空间，避免英文界面弹中文提示
  const uploadConfigAlertMessage = computed(() => {
    if (configOptionsLoading.value || hasAvailableUploadConfig.value) return ''
    return t('errors.uploadConfigUnavailable')
  })
  const uploadConfigLoadingMessage = computed(() => t('errors.uploadConfigLoading'))

  const loadUploadConfigOptions = async () => {
    try {
      configOptionsLoading.value = true
      const result = await api.getUploadOptions()
      const options = Array.isArray(result.options) ? result.options : []
      uploadConfigOptions.value = options.map((option) => {
        const typeLabel =
          option.type === 'koofr' ? 'Koofr' : option.type === 'webdav' ? 'WebDAV' : 'R2'
        return {
          label: `${option.name} (${typeLabel})`,
          value: option.id,
          type: option.type || 'r2',
        }
      })

      const defaultConfigId =
        typeof result.default_config_id === 'string' &&
        options.some((option) => option.id === result.default_config_id)
          ? result.default_config_id
          : ''
      selectedConfigId.value = defaultConfigId || options[0]?.id || ''
    } catch (error) {
      uploadConfigOptions.value = []
      selectedConfigId.value = ''
      console.error('加载上传配置选项失败:', error)
      message.error(t('upload.loadUploadOptionsFailed'))
    } finally {
      configOptionsLoading.value = false
    }
  }

  return {
    selectedConfigId,
    uploadConfigOptions,
    configOptionsLoading,
    hasAvailableUploadConfig,
    selectedConfigType,
    selectedConfigLabel,
    resolvedUploadConfigId,
    isUploadEntryDisabled,
    uploadHintText,
    uploadConfigAlertMessage,
    uploadConfigLoadingMessage,
    loadUploadConfigOptions,
  }
}
