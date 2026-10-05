/**
 * API 错误提示解析。
 *
 * 从 axios 错误对象推导出应向用户展示的动作，兼容后端两种错误体形状：
 * - 绝大多数路由：`{ error: "消息字符串" }`
 * - 上传路由：`{ error: { code, message } }`
 *
 * 兜底文案统一走 i18n `errors` 命名空间（zh-CN / en-US 双语），
 * 避免英文界面弹出硬编码中文 toast。i18n 实例取自 locales 导出的全局对象，
 * locales 模块不反向依赖本文件，无循环依赖。
 */

import { i18n } from '../locales/index.js'

/** 读取 errors 命名空间下的兜底文案 */
const tError = (key) => i18n.global.t(key)

/**
 * 从后端错误体中取出可展示的消息，兼容字符串与 `{ message }` 两种形状。
 *
 * @param {unknown} backendError - `error.response.data.error` 的原始值
 * @returns {string} 提取到的消息；无法提取时返回空串
 */
function extractBackendMessage(backendError) {
  if (typeof backendError === 'string') return backendError
  if (
    backendError &&
    typeof backendError === 'object' &&
    typeof backendError.message === 'string'
  ) {
    return backendError.message
  }
  return ''
}

/**
 * 解析 axios 错误应触发的用户提示动作。
 *
 * @param {object} error - axios 错误对象
 * @param {{ isAuthApi?: boolean }} [options]
 * @returns {{ action: 'redirect' }
 *   | { action: 'notify', message: string, type: 'error' | 'warning' }
 *   | { action: 'silent' }}
 */
export function resolveApiErrorNotice(error, { isAuthApi = false } = {}) {
  const status = error?.response?.status
  const backendMessage = extractBackendMessage(error?.response?.data?.error)

  // 401：未授权。非 auth 接口重定向到登录页；auth 接口交由调用方自行处理。
  if (status === 401 && !isAuthApi) {
    return { action: 'redirect' }
  }

  // 403：权限不足。
  if (status === 403) {
    return { action: 'notify', message: tError('errors.forbidden'), type: 'error' }
  }

  // 429：请求过于频繁。
  if (status === 429) {
    return { action: 'notify', message: tError('errors.rateLimited'), type: 'warning' }
  }

  // 5xx：服务器错误。优先展示后端消息，缺失时回退 i18n 兜底。
  if (typeof status === 'number' && status >= 500) {
    return { action: 'notify', message: backendMessage || tError('errors.server'), type: 'error' }
  }

  // 无响应：网络错误。
  if (!error?.response) {
    return { action: 'notify', message: tError('errors.network'), type: 'error' }
  }

  // 其他 4xx（400、404 等，排除已处理的 401/403/429）。
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 429
  ) {
    return {
      action: 'notify',
      message: backendMessage || tError('errors.requestFailed'),
      type: 'error',
    }
  }

  return { action: 'silent' }
}
