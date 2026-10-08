<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Card from '../ui/card/Card.vue'
import Tag from '../ui/tag/Tag.vue'
import { buildOverviewCardsModel } from '../../utils/adminDashboard.js'

const props = defineProps({
  metrics: { type: Object, default: () => ({}) },
  setup: { type: Object, default: () => ({}) },
  loading: Boolean,
})

const { t } = useI18n({ useScope: 'global' })

const cards = computed(() =>
  buildOverviewCardsModel({
    metrics: props.metrics,
    setup: props.setup,
    loading: props.loading,
    t,
  })
)
</script>

<template>
  <section class="overview-grid">
    <Card v-for="card in cards" :key="card.key" class="overview-card">
      <div class="overview-card-body">
        <div v-if="card.metrics?.length" class="overview-card-metrics">
          <div v-for="metric in card.metrics" :key="metric.key" class="overview-card-metric">
            <div class="overview-card-metric-header">
              <span class="overview-card-metric-label"
                >{{ metric.label
                }}<span v-if="metric.unit" class="overview-card-metric-label">{{
                  metric.unit
                }}</span></span
              >
              <Tag v-if="metric.tagLabel" :type="metric.tagType" size="small">
                {{ metric.tagLabel }}
              </Tag>
            </div>
            <div class="overview-card-metric-value">{{ metric.value }}</div>
          </div>
        </div>

        <div v-else class="overview-card-metric overview-card-metric--single">
          <div class="overview-card-metric-header">
            <span class="overview-card-label">{{ card.label }}</span>
          </div>
          <div class="overview-card-metric-value">{{ card.value }}</div>
        </div>
      </div>
    </Card>
  </section>
</template>

<style scoped>
.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--nb-space-md);
  align-items: start;
}

.overview-card-body {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  gap: 10px;
}

.overview-card-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-size: 13px;
  font-weight: var(--nb-ui-font-weight, 700);
  text-transform: var(--nb-ui-text-transform, uppercase);
}

.overview-card-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.overview-card-metric {
  min-width: 0;
}

.overview-card-metric--single {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
}

.overview-card-metric-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
}

.overview-card-metric-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  line-height: 1.4;
}

.overview-card-metric-value {
  margin-top: 4px;
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: clamp(24px, 3vw, 34px);
  font-weight: var(--nb-heading-font-weight, 900);
  line-height: 1.1;
  word-break: break-word;
}

@media (max-width: 768px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }

  .overview-card-metrics {
    grid-template-columns: 1fr;
  }
}
</style>
