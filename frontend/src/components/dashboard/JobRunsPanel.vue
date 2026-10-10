<script setup>
import { useI18n } from 'vue-i18n'
import { Play } from 'lucide-vue-next'
import Card from '../ui/card/Card.vue'
import Alert from '../ui/alert/Alert.vue'
import Tag from '../ui/tag/Tag.vue'
import Button from '../ui/button/Button.vue'
import {
  formatJobRunDuration,
  getJobRunStatusTagType,
  listJobRunSummaryEntries,
} from '../../utils/adminDashboard.js'

const props = defineProps({
  items: { type: Array, default: () => [] },
  total: { type: Number, default: 0 },
  loading: Boolean,
  runningJob: { type: String, default: '' },
})

const emit = defineEmits(['run'])

const { t, te, locale } = useI18n({ useScope: 'global' })

const getJobNameLabel = (jobName) => {
  const key = `dashboard.jobs.names.${jobName}`
  return te(key) ? t(key) : String(jobName || '-')
}

const getStatusLabel = (status) => {
  const key = `dashboard.jobs.status.${status}`
  return te(key) ? t(key) : t('dashboard.jobs.status.unknown')
}

const formatDateTime = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'

  return new Intl.DateTimeFormat(locale.value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}
</script>

<template>
  <Card class="job-runs-panel">
    <template #header>
      <div class="panel-header">
        <div class="panel-title-group">
          <div class="panel-title">{{ t('dashboard.jobs.title') }}</div>
          <p class="panel-subtitle">
            {{ t('dashboard.jobs.subtitle', { count: total || items.length }) }}
          </p>
        </div>
      </div>
    </template>

    <div v-if="loading && !items.length" class="panel-state">
      {{ t('dashboard.state.loadingContent') }}
    </div>

    <Alert
      v-else-if="!items.length"
      type="info"
      :title="t('dashboard.jobs.emptyTitle')"
      class="panel-empty"
    >
      {{ t('dashboard.jobs.emptyContent') }}
    </Alert>

    <div v-else class="job-run-list">
      <article v-for="run in items" :key="run.id" class="job-run-item">
        <div class="job-run-main">
          <div class="job-run-heading">
            <div class="job-run-title-group">
              <h3 class="job-run-title">{{ getJobNameLabel(run.jobName) }}</h3>
              <p class="job-run-created">{{ formatDateTime(run.createdAt) }}</p>
            </div>
            <div class="job-run-heading-actions">
              <Tag :type="getJobRunStatusTagType(run.status)" size="small">
                {{ getStatusLabel(run.status) }}
              </Tag>
              <Button
                type="default"
                size="small"
                class="job-run-run-btn"
                :loading="runningJob === run.jobName"
                :disabled="Boolean(runningJob)"
                :aria-label="t('dashboard.jobs.runAria', { name: getJobNameLabel(run.jobName) })"
                @click="emit('run', run.jobName)"
              >
                <Play :size="14" style="margin-right: 6px" />
                {{
                  runningJob === run.jobName ? t('dashboard.jobs.running') : t('dashboard.jobs.run')
                }}
              </Button>
            </div>
          </div>

          <dl class="job-run-meta">
            <div class="job-run-meta-item">
              <dt>{{ t('dashboard.jobs.labels.startedAt') }}</dt>
              <dd>{{ formatDateTime(run.startedAt) }}</dd>
            </div>
            <div class="job-run-meta-item">
              <dt>{{ t('dashboard.jobs.labels.finishedAt') }}</dt>
              <dd>{{ run.finishedAt ? formatDateTime(run.finishedAt) : '-' }}</dd>
            </div>
            <div class="job-run-meta-item">
              <dt>{{ t('dashboard.jobs.labels.duration') }}</dt>
              <dd>{{ formatJobRunDuration(run.durationMs) }}</dd>
            </div>
          </dl>

          <div class="job-run-summary-block">
            <div class="job-run-summary-title">{{ t('dashboard.jobs.labels.summary') }}</div>
            <div class="job-run-summary-list">
              <span
                v-for="entry in listJobRunSummaryEntries(run.summary)"
                :key="`${run.id}:${entry.key}`"
                class="job-run-summary-chip"
              >
                {{ entry.key }}: {{ entry.value }}
              </span>
              <span
                v-if="!listJobRunSummaryEntries(run.summary).length"
                class="job-run-summary-empty"
              >
                {{ t('dashboard.jobs.summaryEmpty') }}
              </span>
            </div>
          </div>

          <Alert v-if="run.errorMessage" type="error" :title="t('dashboard.jobs.labels.error')">
            {{ run.errorMessage }}
          </Alert>
        </div>
      </article>
    </div>
  </Card>
</template>

<style scoped>
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-sm);
}

.panel-title-group {
  min-width: 0;
}

.panel-title {
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: 18px;
  font-weight: var(--nb-heading-font-weight, 900);
}

.panel-subtitle {
  margin: 6px 0 0;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 13px;
}

.panel-state {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  padding: var(--nb-space-lg) 0;
  text-align: center;
}

.panel-empty {
  width: 100%;
}

.job-run-list {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-md);
}

.job-run-item {
  border: var(--nb-border);
  border-radius: var(--nb-radius);
  background: var(--nb-surface);
  padding: var(--nb-space-md);
}

.job-run-main {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.job-run-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.job-run-heading-actions {
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
  flex-shrink: 0;
}

.job-run-run-btn {
  display: inline-flex;
  align-items: center;
}

.job-run-title-group {
  min-width: 0;
}

.job-run-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.job-run-created {
  margin: 6px 0 0;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 13px;
}

.job-run-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin: 0;
}

.job-run-meta-item {
  border: var(--nb-border);
  border-radius: var(--nb-radius);
  padding: 10px 12px;
  background: var(--nb-gray-100);
}

:root[data-ui-theme='shadcn'] .job-run-meta-item {
  background: var(--nb-gray-50);
}

.job-run-meta-item dt {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 6px;
  text-transform: uppercase;
}

:root[data-ui-theme='shadcn'] .job-run-meta-item dt {
  text-transform: none;
}

.job-run-meta-item dd {
  margin: 0;
  font-size: 14px;
  word-break: break-word;
}

.job-run-summary-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.job-run-summary-title {
  font-size: 13px;
  font-weight: 700;
}

.job-run-summary-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.job-run-summary-chip {
  border: var(--nb-border);
  border-radius: var(--nb-radius);
  background: var(--nb-bg);
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-size: 12px;
  padding: 4px 8px;
}

.job-run-summary-empty {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 13px;
}

@media (max-width: 768px) {
  .job-run-heading {
    flex-direction: column;
  }
}
</style>
