import { computed, ref } from 'vue'
import { useStorageConfigsStore } from '../stores/storageConfigs.js'

export function useMountConfigs({ t, message, store }) {
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

  /**
   * 加载存储配置。
   *
   * 走 `storageConfigs` store 的 5 分钟缓存：重复进入挂载页时不会重复请求
   * `/api/storage/configs`。传 `{ force: true }` 可跳过缓存。
   *
   * @param {{ force?: boolean }} [options]
   */
  const loadConfigs = async (options = {}) => {
    const configsStore = store || useStorageConfigsStore()
    configsLoading.value = true
    try {
      const result = await configsStore.fetchConfigs({ force: Boolean(options.force) })
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
