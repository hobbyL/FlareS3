function normalizeDefaultConfigId(value) {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

function toDisplayValue(value, fallback) {
  const normalized = String(value ?? '').trim()
  return normalized || fallback
}

export function buildSetupStatusModel({ configs = [], r2Options = {} } = {}) {
  const normalizedConfigs = Array.isArray(configs) ? configs : []
  const configCount = normalizedConfigs.length
  const defaultConfigId = normalizeDefaultConfigId(r2Options?.default_config_id)
  const hasUploadConfig = configCount > 0
  const hasDefaultConfig = Boolean(defaultConfigId)
  const configIdSet = new Set(
    normalizedConfigs.map((item) => String(item?.id ?? '').trim()).filter(Boolean)
  )
  const defaultConfigInvalid = hasDefaultConfig && !configIdSet.has(defaultConfigId)
  const defaultConfigMissing = hasUploadConfig && !hasDefaultConfig

  let notices
  if (!hasUploadConfig) {
    notices = [{ code: 'missing_upload_config', type: 'warning' }]
  } else if (defaultConfigInvalid) {
    notices = [{ code: 'invalid_default_upload_config', type: 'error' }]
  } else if (defaultConfigMissing) {
    notices = [{ code: 'missing_default_upload_config', type: 'warning' }]
  } else {
    notices = [{ code: 'upload_ready', type: 'success' }]
  }

  return {
    configCount,
    defaultConfigId,
    hasUploadConfig,
    hasDefaultConfig,
    defaultConfigMissing,
    defaultConfigInvalid,
    notices,
  }
}

export function buildSetupStatusItems(model, { labels = {}, values = {} } = {}) {
  const normalizedModel = model || {}

  return [
    {
      key: 'configCount',
      label: labels.configCount || 'Config count',
      value: String(Number(normalizedModel.configCount || 0)),
    },
    {
      key: 'defaultConfig',
      label: labels.defaultConfig || 'Default config',
      value: toDisplayValue(normalizedModel.defaultConfigId, values.notSet || 'Not set'),
    },
    {
      key: 'uploadReady',
      label: labels.uploadReady || 'Upload ready',
      value:
        normalizedModel.hasUploadConfig &&
        normalizedModel.hasDefaultConfig &&
        !normalizedModel.defaultConfigInvalid
          ? values.yes || 'Yes'
          : values.no || 'No',
    },
  ]
}

export function buildSetupStatusAlerts(model, { notices = {} } = {}) {
  const items = Array.isArray(model?.notices) ? model.notices : []

  return items.map((item) => {
    if (item?.code === 'missing_upload_config') {
      return {
        code: 'missing_upload_config',
        type: item.type || 'warning',
        title: notices.missingUploadConfigTitle || 'No upload target configured',
        content: notices.missingUploadConfigContent || '',
      }
    }

    if (item?.code === 'missing_default_upload_config') {
      return {
        code: 'missing_default_upload_config',
        type: item.type || 'warning',
        title: notices.missingDefaultConfigTitle || 'Default upload config is missing',
        content: notices.missingDefaultConfigContent || '',
      }
    }

    if (item?.code === 'invalid_default_upload_config') {
      return {
        code: 'invalid_default_upload_config',
        type: item.type || 'error',
        title: notices.invalidDefaultConfigTitle || 'Default config reference is invalid',
        content: notices.invalidDefaultConfigContent || '',
      }
    }

    return {
      code: item?.code || 'upload_ready',
      type: item?.type || 'success',
      title: notices.readyTitle || 'Upload configuration is ready',
      content: notices.readyContent || '',
    }
  })
}
