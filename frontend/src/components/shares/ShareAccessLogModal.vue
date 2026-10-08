<template>
  <Modal
    :show="show"
    :title="t('shares.access.title')"
    width="720px"
    @update:show="handleUpdateShow"
  >
    <p class="access-scope">
      {{ scopeLabel }}
      <code class="access-scope-value">{{ scopeName || '-' }}</code>
    </p>

    <div v-if="loading" class="modal-state">{{ t('shares.access.loading') }}</div>

    <template v-else>
      <div v-if="items.length === 0" class="access-empty">
        {{ t('shares.access.empty') }}
      </div>

      <table v-else class="access-table">
        <thead>
          <tr>
            <th class="access-col-time">{{ t('shares.access.columns.time') }}</th>
            <th class="access-col-ip">{{ t('shares.access.columns.ip') }}</th>
            <th class="access-col-ua">{{ t('shares.access.columns.userAgent') }}</th>
            <th class="access-col-result">{{ t('shares.access.columns.result') }}</th>
            <th class="access-col-path">{{ t('shares.access.columns.path') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td class="access-col-time">{{ formatDateTime(item.created_at) }}</td>
            <td class="access-col-ip">{{ item.ip || '-' }}</td>
            <td class="access-col-ua">
              <span :title="item.user_agent || ''">{{ userAgentSummary(item.user_agent) }}</span>
            </td>
            <td class="access-col-result">
              <Tag :type="toResultVariant(item.result)" size="small">
                {{ t(toResultLabelKey(item.result)) }}
              </Tag>
            </td>
            <td class="access-col-path">
              <span :title="item.path || ''">{{ item.path || '-' }}</span>
            </td>
          </tr>
        </tbody>
      </table>

      <Pagination
        :page="page"
        :page-size="limit"
        :total="total"
        :show-page-size="false"
        :disabled="loading"
        @update:page="changePage"
      />
    </template>

    <template #footer>
      <Button type="default" :disabled="loading" @click="handleUpdateShow(false)">
        {{ t('common.close') }}
      </Button>
    </template>
  </Modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '../ui/modal/Modal.vue'
import Button from '../ui/button/Button.vue'
import Tag from '../ui/tag/Tag.vue'
import Pagination from '../ui/pagination/Pagination.vue'
import api from '../../services/api'
import { formatShareDateTime } from '../../utils/shares.js'

const props = defineProps({
  show: Boolean,
  shareType: String,
  shareId: String,
  shareName: String,
})

const emit = defineEmits(['update:show'])

const { t, locale } = useI18n({ useScope: 'global' })

const loading = ref(false)
const items = ref([])
const page = ref(1)
const limit = 20
const total = ref(0)

const resolvedShareType = computed(() => String(props.shareType ?? '').trim())
const resolvedShareId = computed(() => String(props.shareId ?? '').trim())

const scopeLabel = computed(() => {
  const type = resolvedShareType.value
  if (type === 'file') return t('shares.types.file')
  if (type === 'text') return t('shares.types.text')
  if (type === 'folder') return t('shares.types.folder')
  return t('shares.types.unknown')
})

const scopeName = computed(() => String(props.shareName ?? '').trim())

const formatDateTime = (isoString) => formatShareDateTime(isoString, locale.value)

const userAgentSummary = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return '-'
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw
}

const toResultLabelKey = (result) => {
  const normalized = String(result ?? '').trim()
  if (normalized === 'ok') return 'shares.access.results.ok'
  if (normalized === 'rejected_password') return 'shares.access.results.rejectedPassword'
  if (normalized === 'expired') return 'shares.access.results.expired'
  if (normalized === 'exhausted') return 'shares.access.results.exhausted'
  if (normalized === 'not_found') return 'shares.access.results.notFound'
  return 'shares.access.results.unknown'
}

const toResultVariant = (result) => {
  const normalized = String(result ?? '').trim()
  if (normalized === 'ok') return 'success'
  if (normalized === 'rejected_password') return 'warning'
  if (normalized === 'expired') return 'info'
  if (normalized === 'exhausted') return 'danger'
  return 'default'
}

const loadAccesses = async () => {
  const shareType = resolvedShareType.value
  const shareId = resolvedShareId.value
  if (!shareType || !shareId) return

  loading.value = true
  try {
    const result = await api.getShareAccesses(shareType, shareId, { page: page.value })
    items.value = result?.items || []
    total.value = Number(result?.total || 0)
    const resolvedPage = Number(result?.page || page.value)
    if (Number.isFinite(resolvedPage) && resolvedPage > 0) {
      page.value = resolvedPage
    }
  } catch (_error) {
    // 错误提示由 api 拦截器统一弹出，这里仅复位加载态，避免双 toast
  } finally {
    loading.value = false
  }
}

const changePage = (nextPage) => {
  if (loading.value) return
  const target = Number(nextPage)
  if (!Number.isFinite(target) || target < 1) return
  page.value = target
  loadAccesses()
}

const handleUpdateShow = (value) => {
  emit('update:show', value)
}

watch(
  () => props.show,
  (visible) => {
    if (visible) {
      page.value = 1
      loadAccesses()
    } else {
      items.value = []
      total.value = 0
      page.value = 1
      loading.value = false
    }
  },
  { immediate: true }
)

watch(
  () => [props.shareType, props.shareId],
  () => {
    if (props.show) {
      page.value = 1
      loadAccesses()
    }
  }
)
</script>

<style scoped>
.modal-state {
  padding: var(--nb-space-md);
  text-align: center;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
}

.access-scope {
  margin: 0 0 var(--nb-space-md);
  font-size: 12px;
  color: var(--nb-muted-foreground, var(--muted-foreground, var(--nb-gray-500)));
}

.access-scope-value {
  font-family: var(--nb-font-mono, monospace);
  color: var(--nb-ink, var(--foreground, #111));
  word-break: break-all;
}

.access-empty {
  padding: var(--nb-space-lg);
  text-align: center;
  font-size: 13px;
  color: var(--nb-muted-foreground, var(--muted-foreground, var(--nb-gray-500)));
}

.access-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin-bottom: var(--nb-space-md);
}

.access-table th,
.access-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: var(--nb-border, 1px solid var(--border, rgba(0, 0, 0, 0.08)));
  vertical-align: top;
  word-break: break-all;
}

.access-table th {
  font-weight: 600;
  color: var(--nb-muted-foreground, var(--muted-foreground, var(--nb-gray-600)));
  white-space: nowrap;
}

.access-col-time {
  width: 150px;
  white-space: nowrap;
}

.access-col-ip {
  width: 120px;
  white-space: nowrap;
}

.access-col-ua {
  max-width: 180px;
}

.access-col-result {
  width: 90px;
  white-space: nowrap;
}

.access-col-path {
  max-width: 140px;
}
</style>
