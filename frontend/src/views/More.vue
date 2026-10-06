<template>
  <AppLayout max-width="960px">
    <div class="more-page">
      <header class="more-header">
        <div class="more-title-group">
          <h1 class="more-title">{{ t('more.title') }}</h1>
          <p class="more-subtitle">{{ t('more.subtitle') }}</p>
        </div>
      </header>

      <section class="more-grid">
        <Card class="more-card">
          <template #header>{{ t('more.sections.account') }}</template>

          <div class="account-summary">
            <div class="account-avatar">{{ accountInitial }}</div>

            <div class="account-meta">
              <div class="account-name">{{ authStore.user?.username || 'User' }}</div>
              <div class="account-role">{{ userRoleLabel || '-' }}</div>
            </div>
          </div>

          <div class="kv-list">
            <div class="kv-row">
              <span class="kv-label">{{ t('more.account.username') }}</span>
              <span class="kv-value">{{ authStore.user?.username || '-' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">{{ t('more.account.role') }}</span>
              <span class="kv-value">{{ userRoleLabel || '-' }}</span>
            </div>
          </div>

          <div class="password-divider" />

          <form class="password-form" @submit.prevent="handleChangePassword">
            <p class="password-form-title">{{ t('more.password.sectionTitle') }}</p>
            <FormItem :label="t('more.password.currentPlaceholder')">
              <Input
                v-model="passwordForm.currentPassword"
                type="password"
                :placeholder="t('more.password.currentPlaceholder')"
                @keyup.enter="handleChangePassword"
              />
            </FormItem>
            <FormItem :label="t('more.password.newPlaceholder')">
              <Input
                v-model="passwordForm.newPassword"
                type="password"
                :placeholder="t('more.password.newPlaceholder')"
                @keyup.enter="handleChangePassword"
              />
            </FormItem>
            <FormItem :label="t('more.password.confirmPlaceholder')">
              <Input
                v-model="passwordForm.confirmPassword"
                type="password"
                :placeholder="t('more.password.confirmPlaceholder')"
                @keyup.enter="handleChangePassword"
              />
            </FormItem>
            <Button
              type="primary"
              size="small"
              block
              :loading="changing"
              @click="handleChangePassword"
            >
              {{ t('more.password.submit') }}
            </Button>
          </form>
        </Card>

        <Card class="more-card">
          <template #header>
            <div class="more-card-heading">
              <span>{{ t('more.usage.sectionTitle') }}</span>
              <span class="usage-scope">{{ usageScopeLabel }}</span>
            </div>
          </template>

          <div class="usage-metrics">
            <div class="usage-metric">
              <div class="usage-label">{{ t('more.usage.usedSpace') }}</div>
              <div class="usage-value">{{ usage ? usage.usedSpaceFormatted : '-' }}</div>
            </div>
            <div class="usage-metric">
              <div class="usage-label">{{ t('more.usage.totalSpace') }}</div>
              <div class="usage-value">{{ usage ? usage.totalSpaceFormatted : '-' }}</div>
            </div>
            <div class="usage-metric">
              <div class="usage-label">{{ t('more.usage.fileCount') }}</div>
              <div class="usage-value">{{ usage ? usage.fileCount : '-' }}</div>
            </div>
          </div>

          <Progress
            :percentage="usagePercentClamped"
            :color="usageColor"
            :height="10"
            :show-indicator="false"
          />

          <div v-if="usageError" class="usage-retry">
            <Button type="default" size="small" @click="loadUsage">
              {{ t('more.usage.retry') }}
            </Button>
          </div>
        </Card>

        <Card class="more-card">
          <template #header>{{ t('more.sections.appearance') }}</template>

          <div class="action-list">
            <Button
              type="default"
              size="small"
              block
              :aria-label="themeTitle"
              @click="handleToggleTheme"
            >
              {{ themeLabel }}
            </Button>
            <Button type="default" size="small" block @click="handleCycleUiTheme">
              {{ uiThemeLabel }}
            </Button>
            <Button
              type="default"
              size="small"
              block
              :aria-label="languageLabel"
              @click="handleToggleLocale"
            >
              {{ languageLabel }}
            </Button>
          </div>
        </Card>

        <Card class="more-card">
          <template #header>{{ t('more.sections.session') }}</template>

          <div class="action-list">
            <Button type="danger" size="small" block @click="openLogoutConfirm">
              {{ t('more.actions.logout') }}
            </Button>
          </div>
        </Card>

        <Card class="more-card more-admin-card">
          <template #header>
            <div class="more-card-heading">
              <span>{{ t('more.sections.admin') }}</span>
              <span v-if="authStore.isAdmin" class="more-admin-hint">{{
                t('more.adminHint')
              }}</span>
            </div>
          </template>

          <p class="more-admin-description">{{ t('more.adminDescription') }}</p>

          <div v-if="adminItems.length" class="admin-link-list">
            <button
              v-for="item in adminItems"
              :key="item.key"
              type="button"
              class="admin-link"
              @click="navigate(item.path)"
            >
              <div class="admin-link-main">
                <span class="admin-link-icon">
                  <component :is="resolveAdminIcon(item.icon)" :size="18" />
                </span>
                <span class="admin-link-label">{{ item.label }}</span>
              </div>
              <span class="admin-link-action">{{ t('more.actions.open') }}</span>
            </button>
          </div>

          <div v-else class="admin-empty">{{ t('more.emptyAdmin') }}</div>
        </Card>
      </section>
    </div>

    <LogoutConfirmModal
      v-model:show="logoutConfirmVisible"
      :loading="logoutSubmitting"
      @confirm="confirmLogout"
    />
  </AppLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { HardDrive, History, LayoutDashboard, Settings, Users } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LogoutConfirmModal from '../components/auth/LogoutConfirmModal.vue'
import AppLayout from '../components/layout/AppLayout.vue'
import Button from '../components/ui/button/Button.vue'
import Card from '../components/ui/card/Card.vue'
import FormItem from '../components/ui/form-item/FormItem.vue'
import Input from '../components/ui/input/Input.vue'
import Progress from '../components/ui/progress/Progress.vue'
import { useLogoutConfirm } from '../composables/useLogoutConfirm.js'
import { useMessage } from '../composables/useMessage.js'
import { toggleLocale } from '../locales'
import api from '../services/api.js'
import { useAuthStore } from '../stores/auth'
import { useThemeStore } from '../stores/theme'
import { buildMorePageAdminItems } from '../utils/navigation.js'

const router = useRouter()
const authStore = useAuthStore()
const themeStore = useThemeStore()
const { t, locale } = useI18n({ useScope: 'global' })
const message = useMessage()

const adminIconMap = {
  chart: LayoutDashboard,
  mount: HardDrive,
  users: Users,
  audit: History,
  settings: Settings,
}

const adminItems = computed(() => buildMorePageAdminItems({ isAdmin: authStore.isAdmin, t }))

const accountInitial = computed(() =>
  String(authStore.user?.username || 'U')
    .slice(0, 1)
    .toUpperCase()
)
const userRoleLabel = computed(() => {
  const role = authStore.user?.role
  if (role === 'admin') return t('role.admin')
  if (role === 'user') return t('role.user')
  return role ? String(role) : ''
})

const themeLabel = computed(() => {
  const label = themeStore.isDark ? t('common.dark') : t('common.light')
  return t('common.themeWithValue', { value: label })
})

const themeTitle = computed(() =>
  themeStore.isDark ? t('sidebar.switchToLight') : t('sidebar.switchToDark')
)

const languageLabel = computed(() =>
  t('common.languageWithValue', {
    value: t(`languageName.${locale.value}`),
  })
)

const uiThemeLabel = computed(() =>
  t('more.uiThemeLabel', {
    value: themeStore.currentUiTheme?.label || '-',
  })
)

const resolveAdminIcon = (icon) => adminIconMap[icon] || Settings

const navigate = (path) => {
  router.push(path)
}

const handleToggleTheme = () => {
  themeStore.toggle()
}

const handleCycleUiTheme = () => {
  const themes = themeStore.availableUiThemes
  if (!themes.length) {
    return
  }

  const currentIndex = themes.findIndex((item) => item.id === themeStore.uiTheme)
  const nextTheme = themes[(currentIndex + 1 + themes.length) % themes.length]
  if (nextTheme?.id) {
    themeStore.setUiTheme(nextTheme.id)
  }
}

const handleToggleLocale = () => {
  toggleLocale()
}

// ── 修改密码 ──
const passwordForm = ref({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
})
const changing = ref(false)

const handleChangePassword = async () => {
  // 提交进行中直接忽略重复触发（回车 + 按钮点击可能同时发生）
  if (changing.value) return

  const { currentPassword, newPassword, confirmPassword } = passwordForm.value
  if (!currentPassword || !newPassword || !confirmPassword) {
    message.error(t('more.password.required'))
    return
  }
  if (newPassword.length < 8) {
    message.error(t('more.password.minLength'))
    return
  }
  if (newPassword !== confirmPassword) {
    message.error(t('more.password.mismatch'))
    return
  }
  if (newPassword === currentPassword) {
    message.error(t('more.password.sameAsCurrent'))
    return
  }

  try {
    changing.value = true
    await api.changePassword({
      current_password: currentPassword,
      new_password: newPassword,
    })
    // 服务端已删除全部会话，本端立即登出跳登录页，避免依赖 401 拦截器被动触发
    message.success(t('more.password.changed'))
    await authStore.logout()
    await router.push('/login')
  } catch (error) {
    // 错误提示已由 api 拦截器统一呈现（400 透传后端消息，其余走 errors.* 兜底）
  } finally {
    changing.value = false
  }
}

// ── 存储用量 ──
const usage = ref(null)
const usageError = ref(false)

const usageScopeLabel = computed(() =>
  authStore.isAdmin ? t('more.usage.globalScope') : t('more.usage.userScope')
)

const usagePercentClamped = computed(() => {
  const value = Number(usage.value?.usagePercent)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(100, value)
})

const usageColor = computed(() => {
  const value = usagePercentClamped.value
  if (value > 90) return 'var(--nb-danger)'
  if (value > 70) return 'var(--nb-warning)'
  return 'var(--nb-success)'
})

const loadUsage = async () => {
  try {
    usageError.value = false
    usage.value = await api.getStats()
  } catch (error) {
    // 用量拉取失败不阻塞页面其余区块，显示「-」占位 + 重试入口
    usageError.value = true
  }
}

onMounted(() => {
  loadUsage()
})

const { logoutConfirmVisible, logoutSubmitting, openLogoutConfirm, confirmLogout } =
  useLogoutConfirm()
</script>

<style scoped>
.more-page {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.more-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--nb-space-lg);
}

.more-title-group {
  min-width: 0;
}

.more-title {
  margin: 0;
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-weight: var(--nb-heading-font-weight, 900);
  font-size: var(--nb-font-size-2xl);
  line-height: 1.2;
}

.more-subtitle {
  margin: var(--nb-space-sm) 0 0;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: var(--nb-font-size-sm);
}

.more-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--nb-space-lg);
}

.more-card {
  min-width: 0;
}

.more-admin-card {
  grid-column: 1 / -1;
}

.more-card-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.more-admin-hint {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
}

.more-admin-description {
  margin: 0 0 var(--nb-space-md);
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: var(--nb-font-size-sm);
}

.account-summary {
  display: flex;
  align-items: center;
  gap: var(--nb-space-md);
  margin-bottom: var(--nb-space-md);
}

.account-avatar {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: var(--nb-border);
  background: var(--nb-primary);
  color: var(--nb-primary-foreground, var(--nb-ink));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: 20px;
  font-weight: var(--nb-heading-font-weight, 900);
}

.account-meta {
  min-width: 0;
}

.account-name {
  font-size: var(--nb-font-size-lg);
  font-weight: var(--nb-font-weight-semibold, 700);
}

.account-role {
  margin-top: 2px;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: var(--nb-font-size-sm);
}

.password-divider {
  height: 1px;
  margin: var(--nb-space-md) 0;
  background: var(--nb-border);
}

.password-form {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
}

.password-form-title {
  margin: 0 0 var(--nb-space-xs, 4px);
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  text-transform: uppercase;
}

.usage-scope {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
}

.usage-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--nb-space-sm);
  margin-bottom: var(--nb-space-md);
}

.usage-label {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  text-transform: uppercase;
}

.usage-value {
  margin-top: 2px;
  font-size: var(--nb-font-size-lg);
  font-weight: var(--nb-font-weight-semibold, 700);
  word-break: break-word;
}

.usage-retry {
  margin-top: var(--nb-space-sm);
}

.kv-list,
.action-list,
.admin-link-list {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-sm);
}

.kv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-sm);
  min-width: 0;
}

.kv-label {
  flex-shrink: 0;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  text-transform: uppercase;
}

.kv-value {
  min-width: 0;
  text-align: right;
  word-break: break-word;
}

.admin-link {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-sm);
  padding: 12px 14px;
  border: var(--nb-border);
  border-radius: var(--nb-radius);
  background: var(--nb-surface);
  color: inherit;
  text-align: left;
}

.admin-link-main {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.admin-link-icon {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--nb-border);
  border-radius: var(--nb-radius-sm, var(--nb-radius));
  background: var(--nb-secondary);
  flex-shrink: 0;
}

.admin-link-label {
  min-width: 0;
  word-break: break-word;
}

.admin-link-action,
.admin-empty {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: var(--nb-font-size-sm);
}

@media (max-width: 768px) {
  .more-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .usage-metrics {
    grid-template-columns: minmax(0, 1fr);
  }

  .kv-row {
    flex-direction: column;
    align-items: flex-start;
  }

  .kv-value {
    text-align: left;
  }

  .admin-link {
    align-items: flex-start;
    flex-direction: column;
  }

  .admin-link-main {
    width: 100%;
  }

  .admin-link-action {
    padding-left: 44px;
  }
}
</style>
