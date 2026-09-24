/**
 * 前端性能监控 - Web Vitals
 */

// 性能指标收集
const metrics = {
  LCP: null, // Largest Contentful Paint
  FID: null, // First Input Delay
  CLS: null, // Cumulative Layout Shift
  FCP: null, // First Contentful Paint
  TTFB: null, // Time to First Byte
}

// 自定义指标
const customMetrics = {
  apiLatency: {},
  routeLoadTime: {},
}

/**
 * 上报性能指标到控制台（可扩展到服务端）
 */
function reportMetric(name, value, rating) {
  console.log(`[Performance] ${name}:`, {
    value: Math.round(value),
    rating,
  })

  // 可选：上报到服务端
  // sendToAnalytics({ name, value, rating })
}

/**
 * 监控 LCP (Largest Contentful Paint)
 * 目标: < 2.5s
 */
function observeLCP() {
  if (!('PerformanceObserver' in window)) return

  try {
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries()
      const lastEntry = entries[entries.length - 1]
      const value = lastEntry.renderTime || lastEntry.loadTime
      metrics.LCP = value

      const rating = value < 2500 ? 'good' : value < 4000 ? 'needs-improvement' : 'poor'
      reportMetric('LCP', value, rating)
    })

    observer.observe({ type: 'largest-contentful-paint', buffered: true })
  } catch (e) {
    console.warn('LCP observation failed:', e)
  }
}

/**
 * 监控 FID (First Input Delay)
 * 目标: < 100ms
 */
function observeFID() {
  if (!('PerformanceObserver' in window)) return

  try {
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries()
      entries.forEach((entry) => {
        const value = entry.processingStart - entry.startTime
        metrics.FID = value

        const rating = value < 100 ? 'good' : value < 300 ? 'needs-improvement' : 'poor'
        reportMetric('FID', value, rating)
      })
    })

    observer.observe({ type: 'first-input', buffered: true })
  } catch (e) {
    console.warn('FID observation failed:', e)
  }
}

/**
 * 监控 CLS (Cumulative Layout Shift)
 * 目标: < 0.1
 */
function observeCLS() {
  if (!('PerformanceObserver' in window)) return

  try {
    let clsValue = 0
    let clsEntries = []

    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries()
      entries.forEach((entry) => {
        if (!entry.hadRecentInput) {
          clsValue += entry.value
          clsEntries.push(entry)
        }
      })

      metrics.CLS = clsValue
      const rating = clsValue < 0.1 ? 'good' : clsValue < 0.25 ? 'needs-improvement' : 'poor'
      reportMetric('CLS', clsValue, rating)
    })

    observer.observe({ type: 'layout-shift', buffered: true })
  } catch (e) {
    console.warn('CLS observation failed:', e)
  }
}

/**
 * 监控 FCP (First Contentful Paint)
 */
function observeFCP() {
  if (!('PerformanceObserver' in window)) return

  try {
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries()
      entries.forEach((entry) => {
        if (entry.name === 'first-contentful-paint') {
          const value = entry.startTime
          metrics.FCP = value

          const rating = value < 1800 ? 'good' : value < 3000 ? 'needs-improvement' : 'poor'
          reportMetric('FCP', value, rating)
        }
      })
    })

    observer.observe({ type: 'paint', buffered: true })
  } catch (e) {
    console.warn('FCP observation failed:', e)
  }
}

/**
 * 获取 TTFB (Time to First Byte)
 */
function getTTFB() {
  try {
    const navigationEntry = performance.getEntriesByType('navigation')[0]
    if (navigationEntry) {
      const value = navigationEntry.responseStart - navigationEntry.requestStart
      metrics.TTFB = value

      const rating = value < 800 ? 'good' : value < 1800 ? 'needs-improvement' : 'poor'
      reportMetric('TTFB', value, rating)
    }
  } catch (e) {
    console.warn('TTFB measurement failed:', e)
  }
}

/**
 * 记录 API 延迟
 */
export function recordAPILatency(endpoint, latency) {
  customMetrics.apiLatency[endpoint] = latency
  console.log(`[Performance] API Latency - ${endpoint}:`, Math.round(latency), 'ms')
}

/**
 * 记录路由加载时间
 */
export function recordRouteLoadTime(route, loadTime) {
  customMetrics.routeLoadTime[route] = loadTime
  console.log(`[Performance] Route Load - ${route}:`, Math.round(loadTime), 'ms')
}

/**
 * 获取所有性能指标
 */
export function getMetrics() {
  return {
    ...metrics,
    custom: customMetrics,
  }
}

/**
 * 初始化性能监控
 */
export function initPerformanceMonitoring() {
  // 页面加载完成后开始监控
  if (document.readyState === 'complete') {
    startMonitoring()
  } else {
    window.addEventListener('load', startMonitoring)
  }
}

function startMonitoring() {
  observeLCP()
  observeFID()
  observeCLS()
  observeFCP()
  getTTFB()

  // 5 秒后输出所有指标汇总
  setTimeout(() => {
    console.log('[Performance] Summary:', getMetrics())
  }, 5000)
}
