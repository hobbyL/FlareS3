/**
 * API 错误提示解析。
 *
 * 从 axios 错误对象推导出应向用户展示的动作，兼容后端两种错误体形状：
 * - 绝大多数路由：`{ error: "消息字符串" }`
 * - 上传路由：`{ error: { code, message } }`
 *
 * 抽成纯函数是为了让拦截器的分支逻辑可在 node:test 下直接断言，
 * 而无需 window / DOM / axios 实例。
 */

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
    return { action: 'notify', message: '权限不足，无法执行此操作', type: 'error' }
  }

  // 429：请求过于频繁。
  if (status === 429) {
    return { action: 'notify', message: '请求过于频繁，请稍后再试', type: 'warning' }
  }

  // 5xx：服务器错误。优先展示后端消息，缺失时回退中文兜底。
  if (typeof status === 'number' && status >= 500) {
    return { action: 'notify', message: backendMessage || '服务器错误，请稍后重试', type: 'error' }
  }

  // 无响应：网络错误。
  if (!error?.response) {
    return { action: 'notify', message: '网络连接失败，请检查网络设置', type: 'error' }
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
    return { action: 'notify', message: backendMessage || '请求失败，请检查输入', type: 'error' }
  }

  return { action: 'silent' }
}
