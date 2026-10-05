// 显式带上 index.js 后缀：vite 与 node ESM（node:test 直接加载源码）均可解析
import zhCN from './zh-CN/index.js'
import enUS from './en-US/index.js'
import { createI18n } from 'vue-i18n'

export const messages = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

const localeStorageKey = 'flares3:locale'
const supportedLocales = ['zh-CN', 'en-US']
const supportedLocaleMap = new Map(supportedLocales.map((locale) => [locale.toLowerCase(), locale]))

const readStorage = (key) => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeStorage = (key, value) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

const normalizeLocale = (value) => {
  if (!value) {
    return null
  }

  const raw = String(value).trim()
  if (!raw) {
    return null
  }

  const lower = raw.toLowerCase()
  const fromSupported = supportedLocaleMap.get(lower)
  if (fromSupported) {
    return fromSupported
  }

  if (lower === 'zh' || lower.startsWith('zh-')) {
    return 'zh-CN'
  }

  if (lower === 'en' || lower.startsWith('en-')) {
    return 'en-US'
  }

  return null
}

const getBrowserLocale = () => {
  if (typeof navigator === 'undefined') {
    return null
  }

  const value = navigator.languages?.[0] || navigator.language
  return normalizeLocale(value)
}

export const getInitialLocale = () =>
  normalizeLocale(readStorage(localeStorageKey)) || getBrowserLocale() || 'zh-CN'

const applyLocaleToDocument = (locale) => {
  if (typeof document === 'undefined') {
    return
  }

  document.documentElement.lang = locale
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: getInitialLocale(),
  fallbackLocale: 'zh-CN',
  messages,
})

applyLocaleToDocument(i18n.global.locale.value)

export const setLocale = (locale, { persist = true } = {}) => {
  const normalized = normalizeLocale(locale) || 'zh-CN'
  i18n.global.locale.value = normalized
  applyLocaleToDocument(normalized)

  if (persist) {
    writeStorage(localeStorageKey, normalized)
  }
}

export const toggleLocale = () => {
  const current = i18n.global.locale.value
  const next = current === 'zh-CN' ? 'en-US' : 'zh-CN'
  setLocale(next, { persist: true })
}

export const getCurrentLocale = () => i18n.global.locale.value

export const getSupportedLocales = () => supportedLocales.slice()
