import './assets/neobrutalism.css'
import './assets/shadcn-fonts.css'
import './assets/shadcn.css'
import './assets/markdown.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import { useThemeStore } from './stores/theme'
import { i18n } from './locales'
import { useMessage } from './composables/useMessage'
import { initPerformanceMonitoring } from './utils/performance'
import { initUploadResume } from './utils/uploadResume'

const app = createApp(App)
const pinia = createPinia()

useThemeStore(pinia).init()

app.use(pinia)
app.use(i18n)
app.use(router)

// 全局错误处理
app.config.errorHandler = (err, instance, info) => {
  console.error('Vue Error:', err)
  console.error('Component:', instance)
  console.error('Error Info:', info)

  // 显示用户友好的错误提示
  const message = useMessage()
  message.error('应用出现错误，请刷新页面重试')

  // 可选：上报到错误监控服务
  // reportError(err, instance, info)
}

// 捕获未处理的 Promise 错误
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled Promise Rejection:', event.reason)

  const message = useMessage()
  message.error('操作失败，请稍后重试')

  // 可选：上报到错误监控服务
  // reportError(event.reason)
})

// 初始化性能监控
initPerformanceMonitoring()

// 初始化断点续传（清理过期进度）
initUploadResume()

app.mount('#app')
