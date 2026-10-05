<template>
  <div class="login-container">
    <div class="login-card">
      <div class="logo">
        <div class="logo-box">F</div>
        <span class="logo-text">FlareS3</span>
      </div>
      <p class="subtitle">{{ t('auth.subtitle') }}</p>

      <form class="login-form" @submit.prevent="handleSubmit">
        <FormItem :label="t('auth.username')">
          <Input
            v-model="formValue.username"
            :placeholder="t('auth.usernamePlaceholder')"
            size="large"
            @keyup.enter="handleSubmit"
          />
        </FormItem>

        <FormItem :label="t('auth.password')">
          <Input
            v-model="formValue.password"
            type="password"
            :placeholder="t('auth.passwordPlaceholder')"
            size="large"
            @keyup.enter="handleSubmit"
          />
        </FormItem>

        <Button type="primary" size="large" block :loading="loading" @click="handleSubmit">
          {{ t('auth.login') }}
        </Button>
      </form>

      <p class="footer-text">{{ t('auth.adminTip') }}</p>
      <!-- <a class="github-link" href="https://github.com/Today-ddr/r2box" target="_blank">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        GitHub
      </a> -->
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import { useMessage } from '../composables/useMessage'
import Input from '../components/ui/input/Input.vue'
import Button from '../components/ui/button/Button.vue'
import FormItem from '../components/ui/form-item/FormItem.vue'
import { resolvePostLoginNavigation } from '../utils/authRedirect.js'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const { t } = useI18n({ useScope: 'global' })
const message = useMessage()

const formValue = ref({
  username: '',
  password: '',
})

const loading = ref(false)

const loginErrorKeyByCode = {
  AUTH_INVALID_CREDENTIALS: 'auth.errors.invalidCredentials',
}

const handleSubmit = async () => {
  // 登录进行中直接忽略重复提交（回车 + 按钮点击可能同时触发）
  if (loading.value) return

  if (!formValue.value.username || !formValue.value.password) {
    message.error(t('auth.usernamePasswordRequired'))
    return
  }

  try {
    loading.value = true

    const result = await authStore.login(formValue.value.username, formValue.value.password)
    if (result.success) {
      const navigation = resolvePostLoginNavigation(route.query.next)
      if (navigation.type === 'hard') {
        window.location.assign(navigation.target)
        return
      }
      router.push(navigation.target)
    } else {
      const key = result.code ? loginErrorKeyByCode[result.code] : ''
      message.error(key ? t(key) : result.message || t('auth.loginFailed'))
    }
  } catch (error) {
    const code = error.response?.data?.code
    const key = code ? loginErrorKeyByCode[code] : ''
    message.error(key ? t(key) : error.response?.data?.error || t('auth.loginFailed'))
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: var(--nb-bg);
  padding: var(--nb-space-md);
}

.login-card {
  width: 100%;
  max-width: 420px;
  padding: var(--nb-space-2xl);
  background: var(--nb-surface);
  border: var(--nb-border);
  border-radius: var(--nb-radius);
  box-shadow: var(--nb-shadow);
}

.logo {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--nb-space-sm);
}

.logo-box {
  width: 56px;
  height: 56px;
  background-color: var(--nb-primary);
  color: var(--nb-primary-foreground, var(--nb-ink));
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--nb-radius);
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-weight: var(--nb-ui-font-weight-strong, 900);
  font-size: 30px;
  border: var(--nb-border);
}

.logo-text {
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-size: 32px;
  font-weight: var(--nb-ui-font-weight-strong, 900);
  text-transform: uppercase;
  letter-spacing: var(--nb-ui-letter-spacing, 0.02em);
}

.subtitle {
  text-align: center;
  color: var(--nb-gray-500);
  margin-top: var(--nb-space-sm);
  font-size: 14px;
}

.login-form {
  margin-top: var(--nb-space-xl);
}

.footer-text {
  margin-top: var(--nb-space-xl);
  text-align: center;
  color: var(--nb-gray-500);
  font-size: 12px;
}

.github-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--nb-space-sm);
  color: var(--nb-gray-600);
  text-decoration: none;
  font-size: 12px;
  justify-content: center;
  width: 100%;
  padding: 8px;
  border: var(--nb-border);
  border-radius: var(--nb-radius);
  transition: var(--nb-transition-fast);
}

.github-link:hover {
  background: var(--nb-gray-100);
  border-color: var(--nb-black);
  color: var(--nb-black);
}
</style>
