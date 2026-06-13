import { computed, ref } from 'vue'

export function useMountConfigs({ api, t, message }) {
  const configsLoading = ref(false)
  const configs = ref([])
  const selectedConfigId = ref('')

  const configOptions = computed(() =>
    configs.value.map((row) => {
      const typeLabel =
        row.configType === 'r2' ? 'R2' : row.configType === 'koofr' ? 'Koofr' : 'WebDAV'
      const detailLabel =
        row.configType === 'r2'
          ? row.bucket_name || row.id
          : row.configType === 'koofr'
            ? row.remote_path && row.remote_path !== '/'
              ? row.remote_path
              : 'Koofr'
            : row.endpoint || row.id
      return {
        label: `${row.name || row.id} (${typeLabel}: ${detailLabel})`,
        value: row.id,
      }
    })
  )

  const loadConfigs = async () => {
    configsLoading.value = true
    try {
      const result = await api.getStorageConfigs()
      configs.value = (result.configs || []).map((row) => ({
        ...row,
        configType: row.type,
      }))
      if (!selectedConfigId.value) {
        selectedConfigId.value =
          String(result.default_config_id || '').trim() ||
          String(configs.value?.[0]?.id || '').trim()
      }
    } catch (error) {
      message.error(error.response?.data?.error || t('mount.messages.loadConfigsFailed'))
    } finally {
      configsLoading.value = false
    }
  }

  return {
    configsLoading,
    configs,
    selectedConfigId,
    configOptions,
    loadConfigs,
  }
}
