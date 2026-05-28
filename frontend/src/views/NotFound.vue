<template>
  <div class="not-found-page">
    <div class="not-found-content">
      <h1 class="not-found-code">404</h1>
      <p class="not-found-message">{{ t('common.notFound') }}</p>
      <router-link to="/" class="not-found-link">{{ t('common.backHome') }}</router-link>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

const { t } = useI18n({ useScope: 'global' })
</script>

<style scoped>
.not-found-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
}

.not-found-content {
  text-align: center;
}

.not-found-code {
  font-size: 72px;
  font-weight: 700;
  color: var(--color-text-secondary, #666);
  margin: 0 0 8px;
}

.not-found-message {
  font-size: 16px;
  color: var(--color-text-tertiary, #999);
  margin: 0 0 24px;
}

.not-found-link {
  color: var(--color-primary, #1677ff);
  text-decoration: none;
  font-size: 14px;
}

.not-found-link:hover {
  text-decoration: underline;
}
</style>
