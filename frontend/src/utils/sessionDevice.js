/**
 * 会话 user_agent 简化描述（纯函数，可单测）。
 *
 * UA 字符串只做展示用途的粗分类，不做精确解析；识别不出时返回空串，
 * 由视图层做 i18n 兜底（本模块不承担 i18n 职责）。任何输入（含
 * null/空串/乱串）都不抛错（type-safety 运行时契约）。
 */

const DEVICE_RULES = [
  { keyword: 'Windows', label: 'Windows' },
  { keyword: 'iPhone', label: 'iOS' },
  { keyword: 'iPad', label: 'iOS' },
  { keyword: 'Android', label: 'Android' },
  { keyword: 'Macintosh', label: 'macOS' },
  { keyword: 'Mac OS X', label: 'macOS' },
  { keyword: 'Linux', label: 'Linux' },
]

function detectDevice(userAgent) {
  // 顺序即优先级：Android UA 含 Linux，iPhone/iPad UA 含 Mac OS X，窄的先判
  for (const rule of DEVICE_RULES) {
    if (userAgent.includes(rule.keyword)) {
      return rule.label
    }
  }
  return ''
}

function matchVersion(userAgent, pattern) {
  const match = userAgent.match(pattern)
  if (!match) return ''
  const version = match[1]
  return typeof version === 'string' && version ? ` ${version}` : ''
}

/**
 * 解析 UA 为人类可读的设备 / 浏览器描述。
 *
 * @param {string|null|undefined} userAgent - 原始 User-Agent 头
 * @returns {{ device: string, browser: string }}
 *   device: 'Windows' | 'macOS' | 'Linux' | 'Android' | 'iOS' | ''（未识别）
 *   browser: 'Chrome xx' | 'Edge xx' | 'Opera xx' | 'Firefox xx' | 'Safari xx' | ''
 *
 * 注意 Chrome 判定必须排在 Edge / Opera 之后——它们的 UA 均含 Chrome 字样。
 */
export function describeUserAgent(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent.trim()) {
    return { device: '', browser: '' }
  }

  const device = detectDevice(userAgent)

  // 判定顺序即优先级：Edg(Edge) / OPR(Opera) 的 UA 都包含 Chrome，先排除
  let browser = ''
  if (/Edg(?:e|A|iOS)?\/([\d.]+)/.test(userAgent)) {
    browser = `Edge${matchVersion(userAgent, /Edg(?:e|A|iOS)?\/([\d.]+)/)}`
  } else if (/OPR\/([\d.]+)/.test(userAgent)) {
    browser = `Opera${matchVersion(userAgent, /OPR\/([\d.]+)/)}`
  } else if (/Firefox\/([\d.]+)/.test(userAgent)) {
    browser = `Firefox${matchVersion(userAgent, /Firefox\/([\d.]+)/)}`
  } else if (/Chrome\/([\d.]+)/.test(userAgent)) {
    browser = `Chrome${matchVersion(userAgent, /Chrome\/([\d.]+)/)}`
  } else if (/Version\/([\d.]+).*Safari/.test(userAgent)) {
    browser = `Safari${matchVersion(userAgent, /Version\/([\d.]+).*Safari/)}`
  }

  return { device, browser }
}
