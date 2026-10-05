// Toast composable for global message notifications
import { getCurrentInstance, h, ref, render } from 'vue'
import Toast from '../components/ui/toast/Toast.vue'

let toastInstance = null
let toastContainer = null
let toastRef = null
let toastVNode = null

const createToastInstance = (appContext) => {
  if (toastInstance) return toastInstance
  if (typeof document === 'undefined') return null

  toastContainer = document.createElement('div')
  document.body.appendChild(toastContainer)

  toastRef = ref(null)
  toastVNode = h(Toast, { ref: toastRef })
  toastVNode.appContext = appContext
  render(toastVNode, toastContainer)

  toastInstance =
    toastRef.value || toastVNode.component?.exposed || toastVNode.component?.proxy || null

  return toastInstance
}

export const useMessage = () => {
  const instance = getCurrentInstance()
  const appContext = instance?.appContext

  const getInstance = () => {
    if (!toastInstance) {
      if (!appContext) return null
      createToastInstance(appContext)
    }
    return toastRef?.value || toastInstance
  }

  const invoke = (method, message, duration) => {
    const target = getInstance()
    if (target?.[method]) {
      target[method](message, duration)
      return
    }
    Promise.resolve().then(() => {
      const retry = getInstance()
      retry?.[method]?.(message, duration)
    })
  }

  return {
    success: (message, duration) => invoke('success', message, duration),
    error: (message, duration) => invoke('error', message, duration),
    warning: (message, duration) => invoke('warning', message, duration),
    info: (message, duration) => invoke('info', message, duration),
  }
}

/**
 * 预热全局 toast 单例。
 *
 * 在应用挂载前显式创建 toast 容器（需在 app.use(pinia) / app.use(i18n) 之后调用，
 * Toast 组件依赖这些插件），使全局 errorHandler / unhandledrejection
 * 在任何组件挂载前也能弹出提示，避免冷启动早期的错误静默丢失。
 *
 * @param {import('vue').App} app - 已安装所需插件的 Vue 应用实例
 * @returns {object|null} 已建立的 toast 实例
 */
export const ensureMessageInstance = (app) => {
  if (typeof document === 'undefined') return null
  return createToastInstance(app?._context)
}

export default useMessage
