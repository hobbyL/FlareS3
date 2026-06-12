<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Ellipsis,
  FileText,
  FolderOpen,
  HardDrive,
  History,
  Languages,
  LayoutDashboard,
  LogOut,
  Palette,
  Settings,
  Share2,
  SunMoon,
  Users,
  X,
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toggleLocale } from '../../locales'
import { useLogoutConfirm } from '../../composables/useLogoutConfirm.js'
import { useAuthStore } from '../../stores/auth'
import { useThemeStore } from '../../stores/theme'
import {
  buildMobileTabbarItems,
  buildMorePageAdminItems,
  normalizeNavigationPath,
} from '../../utils/navigation.js'
import LogoutConfirmModal from '../auth/LogoutConfirmModal.vue'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const themeStore = useThemeStore()
const { t, locale } = useI18n({ useScope: 'global' })
const moreSheetOpen = ref(false)
let bodyScrollLockState = null

const iconMap = {
  folder: FolderOpen,
  'file-text': FileText,
  share: Share2,
  more: Ellipsis,
  chart: LayoutDashboard,
  mount: HardDrive,
  users: Users,
  audit: History,
  settings: Settings,
}

const tabItems = computed(() => buildMobileTabbarItems({ t }))
const currentPath = computed(() => normalizeNavigationPath(route.path))
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
const themeModeValue = computed(() => (themeStore.isDark ? t('common.dark') : t('common.light')))
const uiThemeValue = computed(() => themeStore.currentUiTheme?.label || '-')
const languageValue = computed(() => t(`languageName.${locale.value}`))
const moreActionItems = computed(() => [
  {
    key: 'theme-mode',
    icon: SunMoon,
    label: t('more.mobileSheet.lightDark'),
    value: themeModeValue.value,
    onClick: handleToggleTheme,
  },
  {
    key: 'ui-theme',
    icon: Palette,
    label: t('more.mobileSheet.theme'),
    value: uiThemeValue.value,
    onClick: handleCycleUiTheme,
  },
  {
    key: 'language',
    icon: Languages,
    label: t('more.mobileSheet.language'),
    value: languageValue.value,
    onClick: handleToggleLocale,
  },
])

const isActive = (item) =>
  item.key === '/more'
    ? moreSheetOpen.value ||
      (item.matchPaths || []).some((path) => normalizeNavigationPath(path) === currentPath.value)
    : (item.matchPaths || []).some((path) => normalizeNavigationPath(path) === currentPath.value)

const lockBodyScroll = () => {
  if (typeof window === 'undefined' || typeof document === 'undefined' || bodyScrollLockState) {
    return
  }

  const { body } = document
  bodyScrollLockState = {
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    style: {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    },
  }

  body.style.position = 'fixed'
  body.style.top = `-${bodyScrollLockState.scrollY}px`
  body.style.left = '0'
  body.style.right = '0'
  body.style.width = '100%'
  body.style.overflow = 'hidden'
}

const unlockBodyScroll = () => {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !bodyScrollLockState) {
    return
  }

  const { body } = document
  const { scrollX, scrollY, style } = bodyScrollLockState
  body.style.position = style.position
  body.style.top = style.top
  body.style.left = style.left
  body.style.right = style.right
  body.style.width = style.width
  body.style.overflow = style.overflow
  bodyScrollLockState = null
  window.scrollTo(scrollX, scrollY)
}

const closeMoreSheet = () => {
  moreSheetOpen.value = false
}

const openMoreSheet = () => {
  moreSheetOpen.value = true
}

const navigate = (path, { closeSheet = false } = {}) => {
  if (normalizeNavigationPath(path) === currentPath.value) {
    if (closeSheet) {
      closeMoreSheet()
    }
    return
  }
  router.push(path)
  if (closeSheet) {
    closeMoreSheet()
  }
}

const handleTabClick = (item) => {
  if (item.key === '/more') {
    openMoreSheet()
    return
  }
  navigate(item.path)
}

const resolveIcon = (icon) => iconMap[icon] || Ellipsis

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

const { logoutConfirmVisible, logoutSubmitting, openLogoutConfirm, confirmLogout } =
  useLogoutConfirm({
    beforeOpen: closeMoreSheet,
  })

watch(
  () => route.path,
  () => {
    closeMoreSheet()
  }
)

watch(moreSheetOpen, (isOpen) => {
  if (isOpen) {
    lockBodyScroll()
    return
  }

  unlockBodyScroll()
})

onBeforeUnmount(() => {
  unlockBodyScroll()
})
</script>

<template>
  <nav class="mobile-tabbar" :aria-label="t('mobileNav.ariaLabel')">
    <button
      v-for="item in tabItems"
      :key="item.key"
      type="button"
      class="tabbar-item"
      :class="{ 'is-active': isActive(item) }"
      :aria-label="item.label"
      :aria-current="isActive(item) ? 'page' : undefined"
      :aria-expanded="item.key === '/more' ? moreSheetOpen : undefined"
      @click="handleTabClick(item)"
    >
      <component :is="resolveIcon(item.icon)" :size="18" class="tabbar-icon" />
      <span class="tabbar-label">{{ item.label }}</span>
    </button>
  </nav>

  <Teleport to="body">
    <Transition name="more-sheet">
      <div v-if="moreSheetOpen" class="more-sheet-overlay" @click.self="closeMoreSheet">
        <section
          class="more-sheet"
          role="dialog"
          aria-modal="true"
          :aria-label="t('mobileNav.more')"
        >
          <div class="more-sheet-grabber" aria-hidden="true"></div>

          <header class="more-sheet-header">
            <div class="account-summary">
              <div class="account-avatar">{{ accountInitial }}</div>
              <div class="account-meta">
                <div class="account-name">{{ authStore.user?.username || 'User' }}</div>
                <div class="account-role">{{ userRoleLabel || '-' }}</div>
              </div>
            </div>

            <button
              type="button"
              class="sheet-close-btn"
              :aria-label="t('more.mobileSheet.close')"
              @click="closeMoreSheet"
            >
              <X :size="18" />
            </button>
          </header>

          <div class="more-menu-list">
            <button
              v-for="item in moreActionItems"
              :key="item.key"
              type="button"
              class="more-menu-item"
              @click="item.onClick"
            >
              <span class="more-menu-icon">
                <component :is="item.icon" :size="18" />
              </span>
              <span class="more-menu-label">{{ item.label }}</span>
              <span class="more-menu-value">{{ item.value }}</span>
            </button>

            <button
              v-for="item in adminItems"
              :key="item.key"
              type="button"
              class="more-menu-item"
              @click="navigate(item.path, { closeSheet: true })"
            >
              <span class="more-menu-icon">
                <component :is="resolveIcon(item.icon)" :size="18" />
              </span>
              <span class="more-menu-label">{{ item.label }}</span>
            </button>

            <button type="button" class="more-menu-item is-danger" @click="openLogoutConfirm">
              <span class="more-menu-icon">
                <LogOut :size="18" />
              </span>
              <span class="more-menu-label">{{ t('more.actions.logout') }}</span>
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>

  <LogoutConfirmModal
    v-model:show="logoutConfirmVisible"
    :loading="logoutSubmitting"
    @confirm="confirmLogout"
  />
</template>

<style scoped>
.mobile-tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 140;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: var(--nb-border);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--nb-surface) 92%, transparent) 0%,
    var(--nb-surface) 100%
  );
  box-shadow: 0 -10px 28px color-mix(in srgb, var(--nb-shadow-color, #000) 18%, transparent);
  backdrop-filter: blur(14px);
}

.tabbar-item {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 6px;
  border: 0;
  border-radius: calc(var(--nb-radius-md, var(--nb-radius)) + 2px);
  background: transparent;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-size: 11px;
  font-weight: var(--nb-ui-font-weight, 700);
  text-transform: var(--nb-ui-text-transform, uppercase);
}

.tabbar-icon {
  flex-shrink: 0;
}

.tabbar-label {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tabbar-item.is-active {
  color: var(--nb-primary);
  background: color-mix(in srgb, var(--nb-primary) 14%, transparent);
}

.more-sheet-overlay {
  position: fixed;
  inset: 0;
  z-index: 150;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0 10px calc(var(--app-mobile-tabbar-offset, 72px) + 8px);
  background: linear-gradient(
    180deg,
    transparent 0%,
    color-mix(in srgb, var(--nb-shadow-color, #000) 42%, transparent) 100%
  );
}

.more-sheet {
  width: min(100%, 430px);
  max-height: calc(100dvh - var(--app-mobile-tabbar-offset, 72px) - 24px);
  overflow: auto;
  border: var(--nb-border);
  border-radius: 24px 24px var(--nb-radius-lg, var(--nb-radius))
    var(--nb-radius-lg, var(--nb-radius));
  background:
    radial-gradient(
      circle at top left,
      color-mix(in srgb, var(--nb-primary) 18%, transparent),
      transparent 36%
    ),
    var(--nb-surface);
  box-shadow: 0 18px 48px color-mix(in srgb, var(--nb-shadow-color, #000) 36%, transparent);
}

.more-sheet-grabber {
  width: 42px;
  height: 4px;
  margin: 10px auto 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--nb-muted-foreground, var(--nb-gray-500)) 52%, transparent);
}

.more-sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-space-md);
  padding: 16px 16px 12px;
}

.account-summary {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.account-avatar {
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--nb-border);
  border-radius: 16px;
  background: var(--nb-primary);
  color: var(--nb-primary-foreground, var(--nb-ink));
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: 22px;
  font-weight: 900;
}

.account-meta {
  min-width: 0;
}

.account-name {
  overflow: hidden;
  color: var(--nb-foreground, var(--nb-black));
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-size: 18px;
  font-weight: 900;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-role {
  margin-top: 4px;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
}

.sheet-close-btn {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--nb-border);
  border-radius: 999px;
  background: var(--nb-surface);
  color: var(--nb-foreground, var(--nb-black));
}

.more-menu-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px 14px;
}

.more-menu-item {
  width: 100%;
  min-width: 0;
  min-height: 46px;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: var(--nb-border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--nb-surface) 86%, var(--nb-bg));
  color: var(--nb-foreground, var(--nb-black));
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-weight: var(--nb-ui-font-weight, 700);
  text-align: left;
}

.more-menu-icon {
  width: 36px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: color-mix(in srgb, var(--nb-primary) 14%, transparent);
  color: var(--nb-primary);
}

.more-menu-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more-menu-value {
  min-width: 0;
  max-width: 150px;
  overflow: hidden;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more-menu-item.is-danger {
  color: var(--nb-danger);
}

.more-menu-item.is-danger .more-menu-icon {
  background: color-mix(in srgb, var(--nb-danger) 14%, transparent);
  color: var(--nb-danger);
}

.more-sheet-enter-active,
.more-sheet-leave-active {
  transition: opacity 0.18s ease;
}

.more-sheet-enter-active .more-sheet,
.more-sheet-leave-active .more-sheet {
  transition:
    transform 0.22s ease,
    opacity 0.22s ease;
}

.more-sheet-enter-from,
.more-sheet-leave-to {
  opacity: 0;
}

.more-sheet-enter-from .more-sheet,
.more-sheet-leave-to .more-sheet {
  opacity: 0;
  transform: translateY(18px);
}

:root[data-ui-theme='shadcn'] .mobile-tabbar {
  border-top: 1px solid var(--border);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--background) 90%, transparent) 0%,
    var(--background) 100%
  );
}

:root[data-ui-theme='shadcn'] .tabbar-item {
  text-transform: none;
}

:root[data-ui-theme='shadcn'] .tabbar-item.is-active {
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 12%, transparent);
}

:root[data-ui-theme='shadcn'] .more-sheet {
  border: 1px solid var(--border);
  background:
    radial-gradient(
      circle at top left,
      color-mix(in srgb, var(--primary) 16%, transparent),
      transparent 36%
    ),
    var(--background);
}

:root[data-ui-theme='shadcn'] .account-avatar,
:root[data-ui-theme='shadcn'] .sheet-close-btn,
:root[data-ui-theme='shadcn'] .more-menu-item {
  border: 1px solid var(--border);
}

:root[data-ui-theme='shadcn'] .account-name,
:root[data-ui-theme='shadcn'] .sheet-close-btn,
:root[data-ui-theme='shadcn'] .more-menu-item {
  color: var(--foreground);
}

:root[data-ui-theme='shadcn'] .account-avatar {
  background: var(--primary);
  color: var(--primary-foreground);
}

:root[data-ui-theme='shadcn'] .more-menu-item {
  background: color-mix(in srgb, var(--background) 86%, var(--muted));
}

:root[data-ui-theme='shadcn'] .more-menu-icon {
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
}

@media (min-width: 769px) {
  .mobile-tabbar {
    display: none;
  }
}
</style>
