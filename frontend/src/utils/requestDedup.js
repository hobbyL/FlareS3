/**
 * 请求去重工具 - 防止重复请求
 */

// 存储进行中的请求
const pendingRequests = new Map()

/**
 * 生成请求的唯一键
 */
function getRequestKey(method, url, data) {
  return `${method}:${url}:${JSON.stringify(data || {})}`
}

/**
 * 包装函数以支持请求去重
 * @param {Function} fn - 原始请求函数
 * @param {Function|string} keyGenerator - 自定义 key 生成器或固定 key
 * @returns {Function} 包装后的函数
 */
export function dedupRequest(fn, keyGenerator) {
  return async function (...args) {
    // 生成请求 key
    let key
    if (typeof keyGenerator === 'function') {
      key = keyGenerator(...args)
    } else if (typeof keyGenerator === 'string') {
      key = keyGenerator
    } else {
      // 默认使用函数名和参数作为 key
      key = `${fn.name}:${JSON.stringify(args)}`
    }

    // 如果已有相同请求在进行中，直接返回该 Promise
    if (pendingRequests.has(key)) {
      return pendingRequests.get(key)
    }

    // 发起新请求
    const promise = fn(...args).finally(() => {
      // 请求完成后从 Map 中移除
      pendingRequests.delete(key)
    })

    // 缓存 Promise
    pendingRequests.set(key, promise)
    return promise
  }
}

/**
 * 清空所有待处理请求（可选，用于测试或特殊场景）
 */
export function clearPendingRequests() {
  pendingRequests.clear()
}

/**
 * 获取当前待处理请求数量（可选，用于调试）
 */
export function getPendingRequestsCount() {
  return pendingRequests.size
}
