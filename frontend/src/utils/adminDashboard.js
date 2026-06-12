function normalizeNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function trimDecimal(value) {
  return value.replace(/\.0$/, '')
}

function normalizeCount(value) {
  return Math.max(0, Math.floor(normalizeNumber(value)))
}

export function getOverviewDisplayValue(value, { loading = false, fallback = '0' } = {}) {
  if (loading) return '—'
  if (value === null || value === undefined || value === '') return fallback
  return String(value)
}

export function getUploadConfigMetric(setup, { loading = false, t }) {
  const configCount = Number(setup?.configCount || 0)
  const defaultConfigId = String(setup?.defaultConfigId || '').trim()

  if (!setup?.hasUploadConfig) {
    return {
      key: 'uploadConfig',
      label: t('dashboard.cards.uploadConfig'),
      value: getOverviewDisplayValue(configCount, { loading }),
      tagType: 'warning',
      tagLabel: t('dashboard.cards.uploadConfigMissing'),
      hint: t('dashboard.cards.uploadConfigMissingHint'),
    }
  }

  if (!defaultConfigId) {
    return {
      key: 'uploadConfig',
      label: t('dashboard.cards.uploadConfig'),
      value: getOverviewDisplayValue(configCount, { loading }),
      tagType: 'warning',
      tagLabel: t('dashboard.cards.uploadConfigPendingDefault'),
      hint: t('dashboard.cards.uploadConfigPendingDefaultHint', { count: configCount }),
    }
  }

  return {
    key: 'uploadConfig',
    label: t('dashboard.cards.uploadConfig'),
    value: getOverviewDisplayValue(configCount, { loading }),
    tagType: 'success',
    tagLabel: t('dashboard.cards.uploadConfigReady'),
    hint: t('dashboard.cards.uploadConfigReadyHint', {
      count: configCount,
      defaultConfigId,
    }),
  }
}

function getUploadConfigStatusKey(setup) {
  const hasUploadConfig = Boolean(setup?.hasUploadConfig)
  const defaultConfigId = String(setup?.defaultConfigId || '').trim()

  if (!hasUploadConfig) return 'missing'
  if (!defaultConfigId) return 'pendingDefault'
  return 'ready'
}

function getShareStatusMetric(value, { key, label, shortLabel, tone, loading = false }) {
  const normalizedValue = normalizeCount(value)

  return {
    key,
    label,
    shortLabel,
    tone,
    value: normalizedValue,
    displayValue: getOverviewDisplayValue(normalizedValue, { loading }),
  }
}

export function buildDashboardInsightsModel({ metrics = {}, setup = {}, loading = false, t }) {
  const totalUsers = normalizeCount(metrics?.totalUsers)
  const activeUsers =
    totalUsers > 0 ? Math.min(normalizeCount(metrics?.activeUsers), totalUsers) : 0
  const disabledUsers =
    totalUsers > 0
      ? Math.min(normalizeCount(metrics?.disabledUsers), Math.max(totalUsers - activeUsers, 0))
      : 0
  const otherUsers = totalUsers > 0 ? Math.max(totalUsers - activeUsers - disabledUsers, 0) : 0
  const totalTexts = normalizeCount(metrics?.totalTexts)

  const uploadConfigMetric = getUploadConfigMetric(setup, { loading, t })
  const configHealthStatusKey = getUploadConfigStatusKey(setup)
  const shareStatusBars = [
    getShareStatusMetric(metrics?.activeShares, {
      key: 'activeShares',
      label: t('dashboard.insights.shareStatus.activeShares'),
      shortLabel: t('dashboard.insights.shareStatus.shortActive'),
      tone: 'default',
      loading,
    }),
    getShareStatusMetric(metrics?.expiredShares, {
      key: 'expiredShares',
      label: t('dashboard.insights.shareStatus.expiredShares'),
      shortLabel: t('dashboard.insights.shareStatus.shortExpired'),
      tone: 'warning',
      loading,
    }),
    getShareStatusMetric(metrics?.exhaustedShares, {
      key: 'exhaustedShares',
      label: t('dashboard.insights.shareStatus.exhaustedShares'),
      shortLabel: t('dashboard.insights.shareStatus.shortExhausted'),
      tone: 'muted',
      loading,
    }),
    getShareStatusMetric(metrics?.consumedShares, {
      key: 'consumedShares',
      label: t('dashboard.insights.shareStatus.consumedShares'),
      shortLabel: t('dashboard.insights.shareStatus.shortConsumed'),
      tone: 'success',
      loading,
    }),
  ]
  const maxShareValue = shareStatusBars.reduce(
    (maxValue, item) => Math.max(maxValue, item.value),
    0
  )
  const textFreshnessSegments = [
    {
      key: 'textsUpdated7d',
      label: t('dashboard.insights.textFreshness.textsUpdated7d'),
      tone: 'strong',
      value: normalizeCount(metrics?.textsUpdated7d),
      displayValue: getOverviewDisplayValue(metrics?.textsUpdated7d, { loading }),
    },
    {
      key: 'textsUpdated8To30d',
      label: t('dashboard.insights.textFreshness.textsUpdated8To30d'),
      tone: 'medium',
      value: normalizeCount(metrics?.textsUpdated8To30d),
      displayValue: getOverviewDisplayValue(metrics?.textsUpdated8To30d, { loading }),
    },
    {
      key: 'textsStaleOver30d',
      label: t('dashboard.insights.textFreshness.textsStaleOver30d'),
      tone: 'muted',
      value: normalizeCount(metrics?.textsStaleOver30d),
      displayValue: getOverviewDisplayValue(metrics?.textsStaleOver30d, { loading }),
    },
  ].map((segment) => ({
    ...segment,
    ratio: totalTexts > 0 ? segment.value / totalTexts : 0,
  }))
  const visibleTextFreshnessSegments = loading
    ? textFreshnessSegments
    : textFreshnessSegments.filter((segment) => segment.value > 0)

  return {
    userStatus: {
      title: t('dashboard.insights.userStatus.title'),
      totalLabel: t('dashboard.insights.userStatus.totalLabel'),
      totalValue: getOverviewDisplayValue(totalUsers, { loading }),
      empty: totalUsers === 0,
      segments: [
        {
          key: 'activeUsers',
          label: t('dashboard.insights.userStatus.activeUsers'),
          tone: 'success',
          value: activeUsers,
          displayValue: getOverviewDisplayValue(activeUsers, { loading }),
          ratio: totalUsers > 0 ? activeUsers / totalUsers : 0,
        },
        {
          key: 'disabledUsers',
          label: t('dashboard.insights.userStatus.disabledUsers'),
          tone: 'danger',
          value: disabledUsers,
          displayValue: getOverviewDisplayValue(disabledUsers, { loading }),
          ratio: totalUsers > 0 ? disabledUsers / totalUsers : 0,
        },
        {
          key: 'otherUsers',
          label: t('dashboard.insights.userStatus.otherUsers'),
          tone: 'muted',
          value: otherUsers,
          displayValue: getOverviewDisplayValue(otherUsers, { loading }),
          ratio: totalUsers > 0 ? otherUsers / totalUsers : 0,
        },
      ],
    },
    configHealth: {
      title: t('dashboard.insights.configHealth.title'),
      label: uploadConfigMetric.label,
      value: uploadConfigMetric.value,
      statusKey: configHealthStatusKey,
      statusLabel:
        configHealthStatusKey === 'ready'
          ? t('dashboard.insights.configHealth.ready')
          : configHealthStatusKey === 'pendingDefault'
            ? t('dashboard.insights.configHealth.pendingDefault')
            : t('dashboard.insights.configHealth.missing'),
      hint: uploadConfigMetric.hint,
      steps: [
        {
          key: 'missing',
          label: t('dashboard.insights.configHealth.steps.missing'),
          complete: configHealthStatusKey !== 'missing',
          active: configHealthStatusKey === 'missing',
        },
        {
          key: 'pendingDefault',
          label: t('dashboard.insights.configHealth.steps.pendingDefault'),
          complete: configHealthStatusKey === 'ready',
          active: configHealthStatusKey === 'pendingDefault',
        },
        {
          key: 'ready',
          label: t('dashboard.insights.configHealth.steps.ready'),
          complete: configHealthStatusKey === 'ready',
          active: configHealthStatusKey === 'ready',
        },
      ],
    },
    fileAlerts: {
      title: t('dashboard.insights.fileAlerts.title'),
      items: [
        {
          key: 'expiringThisWeek',
          label: t('dashboard.insights.fileAlerts.expiringThisWeek'),
          tone: 'warning',
          value: normalizeCount(metrics?.expiringThisWeek),
          displayValue: getOverviewDisplayValue(metrics?.expiringThisWeek, { loading }),
        },
        {
          key: 'pendingDeleteQueue',
          label: t('dashboard.insights.fileAlerts.pendingDeleteQueue'),
          tone: 'info',
          value: normalizeCount(metrics?.pendingDeleteQueue),
          displayValue: getOverviewDisplayValue(metrics?.pendingDeleteQueue, { loading }),
        },
      ],
    },
    shareStatus: {
      title: t('dashboard.insights.shareStatus.title'),
      bars: shareStatusBars.map((item) => ({
        ...item,
        barRatio: maxShareValue > 0 ? item.value / maxShareValue : 0,
      })),
    },
    textFreshness: {
      title: t('dashboard.insights.textFreshness.title'),
      totalLabel: t('dashboard.insights.textFreshness.totalLabel'),
      totalValue: getOverviewDisplayValue(totalTexts, { loading }),
      segments: visibleTextFreshnessSegments,
    },
  }
}

export function buildOverviewCardsModel({ metrics = {}, setup = {}, loading = false, t }) {
  const uploadConfigMetric = getUploadConfigMetric(setup, { loading, t })

  return [
    {
      key: 'users',
      label: t('dashboard.cards.users'),
      hint: t('dashboard.cards.usersHint'),
      metrics: [
        {
          key: 'totalUsers',
          label: t('dashboard.cards.totalUsers'),
          value: getOverviewDisplayValue(metrics?.totalUsers, { loading }),
        },
        {
          key: 'activeUsers',
          label: t('dashboard.cards.activeUsers'),
          value: getOverviewDisplayValue(metrics?.activeUsers, { loading }),
        },
      ],
    },
    {
      key: 'files',
      label: t('dashboard.cards.files'),
      hint: t('dashboard.cards.filesHint'),
      metrics: [
        {
          key: 'totalFiles',
          label: t('dashboard.cards.totalFiles'),
          value: getOverviewDisplayValue(metrics?.totalFiles, { loading }),
        },
        {
          key: 'expiringThisWeek',
          label: t('dashboard.cards.expiringThisWeek'),
          value: getOverviewDisplayValue(metrics?.expiringThisWeek, { loading }),
        },
      ],
    },
    {
      key: 'docsShares',
      label: t('dashboard.cards.docsShares'),
      hint: t('dashboard.cards.docsSharesHint'),
      metrics: [
        {
          key: 'totalTexts',
          label: t('dashboard.cards.totalTexts'),
          value: getOverviewDisplayValue(metrics?.totalTexts, { loading }),
        },
        {
          key: 'activeShares',
          label: t('dashboard.cards.activeShares'),
          value: getOverviewDisplayValue(metrics?.activeShares, { loading }),
        },
      ],
    },
    {
      key: 'storage',
      label: t('dashboard.cards.storage'),
      hint: uploadConfigMetric.hint,
      metrics: [
        {
          key: 'usedSpace',
          label: t('dashboard.cards.usedSpace'),
          value: getOverviewDisplayValue(metrics?.usedSpaceFormatted, {
            loading,
            fallback: '0 B',
          }),
        },
        {
          key: uploadConfigMetric.key,
          label: uploadConfigMetric.label,
          value: uploadConfigMetric.value,
        },
      ],
    },
    {
      key: 'pendingDeleteQueue',
      label: t('dashboard.cards.pendingDeleteQueue'),
      value: getOverviewDisplayValue(metrics?.pendingDeleteQueue, { loading }),
      hint: t('dashboard.cards.pendingDeleteQueueHint'),
    },
  ]
}

export function getJobRunStatusTagType(status) {
  if (status === 'success') return 'success'
  if (status === 'partial') return 'warning'
  if (status === 'failed') return 'danger'
  if (status === 'running') return 'info'
  return 'default'
}

export function formatJobRunDuration(durationMs) {
  const duration = Math.max(0, normalizeNumber(durationMs))

  if (duration < 1000) {
    return `${Math.round(duration)} ms`
  }

  if (duration < 60_000) {
    return `${trimDecimal((Math.round((duration / 1000) * 10) / 10).toFixed(1))} s`
  }

  let minutes = Math.floor(duration / 60_000)
  let seconds = Math.round((duration % 60_000) / 1000)

  if (seconds === 60) {
    minutes += 1
    seconds = 0
  }

  return `${minutes}m ${seconds}s`
}

export function listJobRunSummaryEntries(summary) {
  if (!summary || typeof summary !== 'object') {
    return []
  }

  return Object.entries(summary)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({
      key,
      value: typeof value === 'object' ? JSON.stringify(value) : String(value),
    }))
}
