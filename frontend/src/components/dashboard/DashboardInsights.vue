<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '../ui/card/Card.vue'
import { buildDashboardInsightsModel } from '../../utils/adminDashboard.js'

const props = defineProps({
  metrics: { type: Object, default: () => ({}) },
  setup: { type: Object, default: () => ({}) },
  loading: Boolean,
})

const { t } = useI18n({ useScope: 'global' })
const RING_RADIUS = 44
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

const insights = computed(() =>
  buildDashboardInsightsModel({
    metrics: props.metrics,
    setup: props.setup,
    loading: props.loading,
    t,
  })
)

const ringSegments = computed(() => {
  let offset = 0

  return insights.value.userStatus.segments
    .map((segment) => {
      const dashLength = segment.ratio * RING_CIRCUMFERENCE
      const currentOffset = offset
      offset += dashLength

      return {
        ...segment,
        dashLength,
        dashOffset: currentOffset,
      }
    })
    .filter((segment) => segment.dashLength > 0)
})

const getShareBarHeight = (bar) => {
  if (bar.value <= 0) return '10px'
  return `${Math.max(18, Math.round(bar.barRatio * 52) + 12)}px`
}

const getTextFreshnessWidth = (segment) => `${Math.max(0, Math.min(segment.ratio * 100, 100))}%`
const getTextFreshnessColumns = (segments) => {
  if (!segments.length) return 'minmax(0, 1fr)'
  return segments.map((segment) => `minmax(0, ${Math.max(segment.ratio, 0.12)}fr)`).join(' ')
}
</script>

<template>
  <section class="dashboard-insights-grid">
    <div class="dashboard-insights-column dashboard-insights-column--primary">
      <Card class="dashboard-insights-card dashboard-insights-card--user-status">
        <div class="dashboard-insights-card-head">
          <div class="dashboard-insights-section-title">{{ insights.userStatus.title }}</div>
        </div>

        <div class="user-status-panel">
          <div class="user-status-ring">
            <div class="user-status-ring-shell">
              <svg
                class="user-status-ring-svg"
                viewBox="0 0 120 120"
                role="img"
                :aria-label="insights.userStatus.title"
              >
                <circle class="user-status-ring-track" cx="60" cy="60" r="44" />
                <circle
                  v-for="segment in ringSegments"
                  :key="segment.key"
                  class="user-status-ring-segment"
                  :data-tone="segment.tone"
                  cx="60"
                  cy="60"
                  r="44"
                  :stroke-dasharray="`${segment.dashLength} ${RING_CIRCUMFERENCE}`"
                  :stroke-dashoffset="`${-segment.dashOffset}`"
                />
              </svg>

              <div class="user-status-ring-center">
                <div class="user-status-total-label">{{ insights.userStatus.totalLabel }}</div>
                <div class="user-status-total-value">{{ insights.userStatus.totalValue }}</div>
                <div v-if="insights.userStatus.empty" class="user-status-empty">
                  {{ t('dashboard.insights.userStatus.empty') }}
                </div>
              </div>
            </div>
          </div>

          <div class="user-status-summary">
            <div class="user-status-legend">
              <div
                v-for="segment in insights.userStatus.segments"
                :key="segment.key"
                class="user-status-legend-item"
              >
                <div class="user-status-legend-copy">
                  <span
                    class="user-status-legend-dot"
                    :data-tone="segment.tone"
                    aria-hidden="true"
                  ></span>
                  <span class="user-status-legend-label">{{ segment.label }}</span>
                </div>
                <span class="user-status-legend-value">{{ segment.displayValue }}</span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card class="dashboard-insights-card dashboard-insights-card--share-status">
        <div class="dashboard-insights-card-head">
          <div class="dashboard-insights-section-title">{{ insights.shareStatus.title }}</div>
        </div>

        <div class="share-status">
          <div class="share-status-chart">
            <div
              v-for="bar in insights.shareStatus.bars"
              :key="bar.key"
              class="share-status-bar"
              :data-tone="bar.tone"
              :style="{ '--share-bar-height': getShareBarHeight(bar) }"
            >
              <div class="share-status-bar-plot">
                <div class="share-status-bar-value">{{ bar.displayValue }}</div>
                <div class="share-status-bar-shell">
                  <div class="share-status-bar-fill"></div>
                </div>
              </div>
              <div class="share-status-bar-label">{{ bar.label }}</div>
            </div>
          </div>
        </div>
      </Card>
    </div>

    <div class="dashboard-insights-column dashboard-insights-column--secondary">
      <Card class="dashboard-insights-card dashboard-insights-card--health">
        <div class="dashboard-insights-card-head">
          <div class="dashboard-insights-section-title">
            {{ t('dashboard.insights.health.title') }}
          </div>
        </div>

        <div class="dashboard-insights-stack">
          <section class="dashboard-insights-panel dashboard-insights-panel--config">
            <div class="config-health">
              <div class="dashboard-insights-subtitle">{{ insights.configHealth.title }}</div>
              <div class="config-health-steps">
                <div
                  v-for="step in insights.configHealth.steps"
                  :key="step.key"
                  class="config-health-step"
                  :data-step="step.key"
                  :class="{ 'is-complete': step.complete, 'is-active': step.active }"
                >
                  <span class="config-health-step-bar"></span>
                  <span class="config-health-step-label">{{ step.label }}</span>
                </div>
              </div>
              <div class="config-health-body">
                <div class="config-health-status-row">
                  <div class="config-health-status" :data-tone="insights.configHealth.statusKey">
                    {{ insights.configHealth.statusLabel }}
                  </div>
                  <div class="config-health-value">
                    {{
                      t('dashboard.insights.configHealth.countLabel', {
                        count: insights.configHealth.value,
                      })
                    }}
                  </div>
                </div>
                <div class="config-health-hint">{{ insights.configHealth.hint }}</div>
              </div>
            </div>
          </section>

          <section class="dashboard-insights-panel dashboard-insights-panel--alerts">
            <div class="file-alerts">
              <div class="dashboard-insights-subtitle">{{ insights.fileAlerts.title }}</div>
              <div
                v-for="item in insights.fileAlerts.items"
                :key="item.key"
                class="file-alert-item"
                :data-tone="item.tone"
              >
                <div class="file-alert-item-copy">
                  <div class="file-alert-label">{{ item.label }}</div>
                </div>
                <div class="file-alert-value">{{ item.displayValue }}</div>
              </div>
            </div>
          </section>
        </div>
      </Card>

      <Card class="dashboard-insights-card dashboard-insights-card--text-freshness">
        <div class="dashboard-insights-card-head">
          <div class="dashboard-insights-section-title">{{ insights.textFreshness.title }}</div>
        </div>

        <div class="text-freshness">
          <div class="text-freshness-head">
            <div class="text-freshness-total-label">{{ insights.textFreshness.totalLabel }}</div>
            <div class="text-freshness-total-value">{{ insights.textFreshness.totalValue }}</div>
          </div>
          <div class="text-freshness-track" aria-hidden="true">
            <div
              v-for="segment in insights.textFreshness.segments"
              :key="segment.key"
              class="text-freshness-segment"
              :data-tone="segment.tone"
              :style="{ width: getTextFreshnessWidth(segment) }"
            ></div>
          </div>
          <div
            class="text-freshness-list"
            :style="{
              gridTemplateColumns: getTextFreshnessColumns(insights.textFreshness.segments),
            }"
          >
            <div
              v-for="segment in insights.textFreshness.segments"
              :key="segment.key"
              class="text-freshness-item"
            >
              <span class="text-freshness-item-label">{{ segment.label }}</span>
              <span class="text-freshness-item-value">{{ segment.displayValue }}</span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  </section>
</template>

<style scoped>
.dashboard-insights-grid {
  display: grid;
  grid-template-columns: max-content minmax(360px, 1fr);
  gap: 12px;
  align-items: start;
}

.dashboard-insights-column {
  display: grid;
  gap: 12px;
  align-content: start;
}

.dashboard-insights-card {
  min-width: 0;
  height: 100%;
}

.dashboard-insights-card--user-status {
  width: fit-content;
  max-width: 100%;
  height: auto;
  justify-self: start;
  align-self: start;
}

.dashboard-insights-card-head {
  display: grid;
  gap: 10px;
  margin-bottom: 16px;
}

.dashboard-insights-card-head::after {
  content: '';
  width: 100%;
  height: 1px;
  background: color-mix(in srgb, var(--nb-border, var(--nb-gray-200)) 80%, transparent);
}

.dashboard-insights-section-title {
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: 17px;
  font-weight: var(--nb-heading-font-weight, 900);
  letter-spacing: 0.01em;
}

.dashboard-insights-subtitle {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.user-status-panel {
  display: grid;
  grid-template-columns: minmax(170px, 208px) fit-content(220px);
  gap: 20px;
  justify-content: start;
  align-items: center;
  width: fit-content;
  max-width: 100%;
}

.user-status-ring {
  display: flex;
  align-items: center;
  justify-content: center;
}

.user-status-ring-shell {
  position: relative;
  width: 100%;
  max-width: 208px;
}

.user-status-ring-svg {
  width: 100%;
  max-width: 208px;
  height: auto;
  transform: rotate(-90deg);
}

.user-status-ring-track {
  fill: none;
  stroke: var(--nb-border, var(--nb-gray-200));
  stroke-width: 10;
}

.user-status-ring-segment {
  fill: none;
  stroke-width: 10;
}

.user-status-ring-segment[data-tone='success'] {
  stroke: color-mix(in srgb, var(--nb-success, #16a34a) 82%, #2f6b4f);
}

.user-status-ring-segment[data-tone='danger'] {
  stroke: color-mix(in srgb, var(--nb-ink, #0f172a) 86%, #475569);
}

.user-status-ring-segment[data-tone='muted'] {
  stroke: color-mix(in srgb, var(--nb-muted-foreground, var(--nb-gray-400)) 82%, #cbd5e1);
}

.user-status-ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.user-status-summary {
  display: flex;
  min-width: 0;
  max-width: 220px;
  align-self: center;
}

.user-status-total-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.user-status-total-value {
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: clamp(30px, 4vw, 42px);
  font-weight: var(--nb-heading-font-weight, 900);
  line-height: 1;
}

.user-status-empty {
  margin-top: 8px;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 11px;
}

.user-status-legend {
  display: grid;
  gap: 8px;
  width: 100%;
  border-top: none;
}

.user-status-legend-item {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  padding: 2px 0;
  border-bottom: none;
}

.user-status-legend-copy {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-status-legend-dot {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--nb-border, var(--nb-gray-200));
}

.user-status-legend-dot[data-tone='success'] {
  background: var(--nb-success, #16a34a);
}

.user-status-legend-dot[data-tone='danger'] {
  background: var(--nb-danger, #dc2626);
}

.user-status-legend-dot[data-tone='muted'] {
  background: var(--nb-muted-foreground, var(--nb-gray-400));
}

.user-status-legend-label {
  min-width: 0;
  color: var(--nb-foreground, var(--nb-ink, #0f172a));
  font-size: 14px;
}

.user-status-legend-value {
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-weight: 800;
  font-size: 14px;
}

.dashboard-insights-stack {
  display: grid;
  gap: 10px;
  align-content: start;
}

.dashboard-insights-panel {
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--nb-border, var(--nb-gray-200)) 85%, transparent);
  border-radius: 18px;
  background: color-mix(in srgb, var(--nb-secondary, #f8fafc) 55%, transparent);
}

.config-health {
  display: grid;
  gap: 12px;
}

.config-health-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.config-health-step {
  display: grid;
  gap: 5px;
}

.config-health-step-bar {
  min-height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--nb-border, var(--nb-gray-200)) 85%, transparent);
}

.config-health-step.is-active .config-health-step-bar {
  background: color-mix(in srgb, var(--nb-warning, #f59e0b) 72%, #cbd5e1);
}

.config-health-step.is-complete .config-health-step-bar {
  background: color-mix(in srgb, var(--nb-success, #16a34a) 82%, #84cc16);
}

.config-health-step-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 11px;
}

.config-health-body {
  display: grid;
  gap: 8px;
}

.config-health-status-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.config-health-status {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--nb-border, var(--nb-gray-200)) 88%, transparent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  background: color-mix(in srgb, var(--nb-surface, #ffffff) 88%, var(--nb-secondary, #f8fafc));
}

.config-health-status[data-tone='ready'] {
  color: color-mix(in srgb, var(--nb-success, #16a34a) 78%, #2f6b4f);
  background: color-mix(in srgb, var(--nb-success, #16a34a) 10%, var(--nb-surface, #ffffff));
}

.config-health-status[data-tone='pendingDefault'] {
  color: color-mix(in srgb, var(--nb-warning, #f59e0b) 72%, #8a6c55);
  background: color-mix(in srgb, var(--nb-warning, #f59e0b) 10%, var(--nb-surface, #ffffff));
}

.config-health-status[data-tone='missing'] {
  color: color-mix(in srgb, var(--nb-ink, #0f172a) 82%, #64748b);
  background: color-mix(in srgb, var(--nb-ink, #0f172a) 5%, var(--nb-surface, #ffffff));
}

.config-health-value {
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: 13px;
  font-weight: 800;
}

.config-health-hint {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 11px;
  line-height: 1.45;
  word-break: break-word;
}

.file-alerts {
  display: grid;
  gap: 10px;
}

.file-alert-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--nb-border, var(--nb-gray-200)) 88%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--nb-surface, #ffffff) 92%, var(--nb-secondary, #f8fafc));
}

.file-alert-item[data-tone='warning'] {
  border-color: color-mix(
    in srgb,
    var(--nb-warning, #f59e0b) 18%,
    var(--nb-border, var(--nb-gray-200))
  );
}

.file-alert-item[data-tone='info'] {
  border-color: color-mix(
    in srgb,
    var(--nb-info, #2563eb) 16%,
    var(--nb-border, var(--nb-gray-200))
  );
}

.file-alert-item-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.file-alert-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
}

.file-alert-value {
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: 18px;
  font-weight: 900;
}

.share-status {
  display: grid;
  gap: 10px;
}

.share-status-chart {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  align-items: end;
  min-height: 108px;
}

.share-status-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  justify-items: center;
  align-items: center;
}

.share-status-bar-plot {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  width: 100%;
  min-height: 88px;
}

.share-status-bar-shell {
  display: flex;
  align-items: end;
  justify-content: center;
  width: 100%;
  min-height: 68px;
  padding: 6px 0 0;
  border-radius: 12px;
  background: color-mix(in srgb, var(--nb-surface, #ffffff) 88%, var(--nb-secondary, #f8fafc));
  border: 1px solid color-mix(in srgb, var(--nb-border, var(--nb-gray-200)) 82%, transparent);
}

.share-status-bar-fill {
  width: 14px;
  height: var(--share-bar-height);
  min-height: 10px;
  border-radius: 999px 999px 4px 4px;
  background: color-mix(in srgb, var(--nb-ink, #0f172a) 86%, #475569);
}

.share-status-bar[data-tone='warning'] .share-status-bar-fill {
  background: color-mix(in srgb, var(--nb-warning, #f59e0b) 74%, #a1551d);
}

.share-status-bar[data-tone='muted'] .share-status-bar-fill {
  background: color-mix(in srgb, var(--nb-muted-foreground, var(--nb-gray-400)) 82%, #b7c4d3);
}

.share-status-bar[data-tone='success'] .share-status-bar-fill {
  background: color-mix(in srgb, var(--nb-success, #16a34a) 80%, #2f6b4f);
}

.share-status-bar-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 11px;
  font-weight: 700;
  line-height: 1.35;
  text-align: center;
}

.share-status-bar-value {
  position: absolute;
  bottom: calc(var(--share-bar-height) + 10px);
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
  white-space: nowrap;
}

.text-freshness {
  display: grid;
  gap: 10px;
}

.text-freshness-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.text-freshness-total-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
}

.text-freshness-total-value {
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: 13px;
  font-weight: 800;
}

.text-freshness-track {
  display: flex;
  width: 100%;
  min-height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--nb-border, var(--nb-gray-200)) 65%, transparent);
}

.text-freshness-segment {
  min-width: 0;
  background: color-mix(in srgb, var(--nb-info, #2563eb) 70%, #244a86);
}

.text-freshness-segment[data-tone='medium'] {
  background: color-mix(in srgb, var(--nb-info, #2563eb) 38%, #6f97ca);
}

.text-freshness-segment[data-tone='muted'] {
  background: color-mix(in srgb, var(--nb-info, #2563eb) 16%, #c2d4eb);
}

.text-freshness-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.text-freshness-item {
  display: flex;
  flex-direction: row;
  align-items: baseline;
  justify-content: center;
  gap: 6px;
  min-width: 0;
}

.text-freshness-item-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
}

.text-freshness-item-value {
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: 12px;
  font-weight: 800;
}

@media (max-width: 1080px) {
  .dashboard-insights-grid {
    grid-template-columns: max-content minmax(280px, 1fr);
  }

  .user-status-panel {
    grid-template-columns: minmax(160px, 196px) minmax(0, 1fr);
    gap: 16px;
  }
}

@media (max-width: 768px) {
  .dashboard-insights-grid {
    grid-template-columns: 1fr;
  }

  .dashboard-insights-column {
    display: contents;
  }

  .dashboard-insights-card-head {
    margin-bottom: 14px;
  }

  .user-status-panel {
    grid-template-columns: 1fr;
  }

  .dashboard-insights-panel {
    padding: 12px 14px;
  }

  .config-health-status-row,
  .file-alert-item,
  .text-freshness-head,
  .text-freshness-item {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
