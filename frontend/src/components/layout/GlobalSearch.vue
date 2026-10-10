<script setup>
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { File as FileIcon, FileText, Loader2, Search, Share2 } from 'lucide-vue-next'
import Modal from '../ui/modal/Modal.vue'
import Input from '../ui/input/Input.vue'
import api from '../../services/api.js'

const { t } = useI18n({ useScope: 'global' })
const router = useRouter()

// 输入防抖间隔：避免每次按键都打到后端
const DEBOUNCE_MS = 300

const visible = ref(false)
const keyword = ref('')
const loading = ref(false)
const searched = ref(false)
const results = ref({ files: [], texts: [], shares: [] })

let debounceTimer = null
// 单调递增的请求序号：用于丢弃过期（关键词已变化 / 弹窗已关闭）的在途响应
let requestSeq = 0

const totalCount = computed(
  () => results.value.files.length + results.value.texts.length + results.value.shares.length
)
const hasResults = computed(() => totalCount.value > 0)
const showEmpty = computed(() => searched.value && !loading.value && !hasResults.value)
const showHint = computed(() => !searched.value && !loading.value)

const emptyResults = () => ({ files: [], texts: [], shares: [] })

const resetState = () => {
  keyword.value = ''
  results.value = emptyResults()
  loading.value = false
  searched.value = false
  requestSeq += 1
}

const open = () => {
  visible.value = true
}

// 弹窗关闭时清理防抖定时器并复位状态，下次打开从干净态开始
const handleModalUpdate = (next) => {
  visible.value = next
  if (!next) {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    resetState()
  }
}

const runSearch = async (term) => {
  const seq = ++requestSeq
  loading.value = true
  try {
    // 拦截器已返回 response.data，直接取 result.files/texts/shares，切勿再次解构 data
    const result = await api.search(term)
    if (seq !== requestSeq) return
    results.value = {
      files: Array.isArray(result?.files) ? result.files : [],
      texts: Array.isArray(result?.texts) ? result.texts : [],
      shares: Array.isArray(result?.shares) ? result.shares : [],
    }
    searched.value = true
  } catch {
    // 错误提示由 api 拦截器统一呈现，此处仅清空结果并保持已搜索态
    if (seq !== requestSeq) return
    results.value = emptyResults()
    searched.value = true
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

watch(keyword, (value) => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  const term = String(value ?? '').trim()
  if (!term) {
    // 空输入立即复位（作废在途请求），回到提示态
    requestSeq += 1
    results.value = emptyResults()
    loading.value = false
    searched.value = false
    return
  }
  debounceTimer = setTimeout(() => runSearch(term), DEBOUNCE_MS)
})

// 点击结果跳转对应页面并带入搜索词（复用各页 route.query.q 筛选）
const goTo = (path) => {
  const term = keyword.value.trim()
  visible.value = false
  router.push({ path, query: term ? { q: term } : {} })
  resetState()
}

const goToFiles = () => goTo('/')
const goToTexts = () => goTo('/texts')
const goToShares = () => goTo('/shares')

defineExpose({ open })
</script>

<template>
  <slot name="trigger" :open="open">
    <button type="button" class="global-search-trigger" @click="open">
      <Search :size="18" />
      <span>{{ t('search.entry') }}</span>
    </button>
  </slot>

  <Modal :show="visible" :title="t('search.title')" width="640px" @update:show="handleModalUpdate">
    <div class="global-search">
      <Input
        v-model="keyword"
        class="global-search-input"
        :placeholder="t('search.placeholder')"
        clearable
      />

      <div class="global-search-body">
        <div v-if="loading" class="global-search-status">
          <Loader2 class="global-search-spin" :size="18" />
          <span>{{ t('search.loading') }}</span>
        </div>

        <div v-else-if="showHint" class="global-search-status">{{ t('search.hint') }}</div>

        <div v-else-if="showEmpty" class="global-search-status">{{ t('search.empty') }}</div>

        <div v-else class="global-search-groups">
          <section v-if="results.files.length" class="global-search-group">
            <h4 class="global-search-group-title">{{ t('search.groups.files') }}</h4>
            <button
              v-for="file in results.files"
              :key="`file-${file.id}`"
              type="button"
              class="global-search-item"
              @click="goToFiles"
            >
              <FileIcon :size="16" class="global-search-item-icon" />
              <span class="global-search-item-name">{{ file.filename }}</span>
            </button>
          </section>
          <section v-if="results.texts.length" class="global-search-group">
            <h4 class="global-search-group-title">{{ t('search.groups.texts') }}</h4>
            <button
              v-for="text in results.texts"
              :key="`text-${text.id}`"
              type="button"
              class="global-search-item"
              @click="goToTexts"
            >
              <FileText :size="16" class="global-search-item-icon" />
              <span class="global-search-item-content">
                <span class="global-search-item-name">{{ text.title }}</span>
                <span v-if="text.content_preview" class="global-search-item-sub">
                  {{ text.content_preview }}
                </span>
              </span>
            </button>
          </section>

          <section v-if="results.shares.length" class="global-search-group">
            <h4 class="global-search-group-title">{{ t('search.groups.shares') }}</h4>
            <button
              v-for="share in results.shares"
              :key="`share-${share.type}-${share.share_code}`"
              type="button"
              class="global-search-item"
              @click="goToShares"
            >
              <Share2 :size="16" class="global-search-item-icon" />
              <span class="global-search-item-content">
                <span class="global-search-item-name">{{ share.resource_name }}</span>
                <span class="global-search-item-sub">{{ share.share_code }}</span>
              </span>
            </button>
          </section>
        </div>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.global-search-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--nb-space-sm);
  padding: 10px 14px;
  border: var(--nb-border);
  border-radius: var(--nb-radius);
  background: var(--nb-surface);
  color: var(--nb-ink);
  cursor: pointer;
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-weight: var(--nb-ui-font-weight, 700);
  transition: var(--nb-transition-fast);
}

.global-search-trigger:hover {
  transform: translate(var(--nb-lift-x), var(--nb-lift-y));
  box-shadow: var(--nb-shadow-sm);
}

.global-search {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-md);
}

.global-search-body {
  min-height: 160px;
  max-height: 52vh;
  overflow-y: auto;
}

.global-search-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--nb-space-sm);
  min-height: 160px;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: var(--nb-font-size-sm);
  text-align: center;
}

.global-search-spin {
  animation: global-search-spin 0.8s linear infinite;
}

@keyframes global-search-spin {
  to {
    transform: rotate(360deg);
  }
}

.global-search-groups {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-md);
}

.global-search-group-title {
  margin: 0 0 var(--nb-space-xs, 4px);
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.global-search-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
  padding: 10px 12px;
  border: var(--nb-border);
  border-radius: var(--nb-radius);
  background: var(--nb-surface);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: var(--nb-transition-fast);
}

.global-search-item + .global-search-item {
  margin-top: var(--nb-space-xs, 4px);
}

.global-search-item:hover {
  transform: translate(var(--nb-lift-x), var(--nb-lift-y));
  box-shadow: var(--nb-shadow-sm);
}

.global-search-item-icon {
  flex-shrink: 0;
}

.global-search-item-content {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.global-search-item-name {
  min-width: 0;
  font-weight: var(--nb-font-weight-semibold, 700);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.global-search-item-sub {
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
