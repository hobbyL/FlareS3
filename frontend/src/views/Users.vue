<template>
  <AppLayout>
    <div class="users-page">
      <header class="users-header">
        <div class="users-title-group">
          <div class="users-title-row">
            <h1 class="users-title">{{ t('users.title') }}</h1>
            <Button
              v-if="authStore.isAdmin"
              type="ghost"
              size="small"
              class="users-mobile-create-btn"
              :disabled="loading"
              :aria-label="t('users.createUser')"
              @click="showCreateModal = true"
            >
              <Plus :size="18" />
            </Button>
          </div>
          <p class="users-subtitle">
            {{ t('users.subtitle') }}
          </p>
        </div>

        <div class="users-actions">
          <div class="filter-row">
            <div class="filter-row-primary">
              <div class="filter-item username">
                <Select
                  v-model="filters.q"
                  :options="userOptions"
                  size="small"
                  :disabled="userOptionsLoading"
                />
              </div>

              <div class="filter-item status">
                <Select v-model="filters.status" :options="statusOptions" size="small" />
              </div>

              <div class="filter-item created-range">
                <DateRangePicker
                  v-model:startValue="filters.created_from_date"
                  v-model:endValue="filters.created_to_date"
                  size="small"
                  clearable
                />
              </div>
            </div>

            <div class="filter-row-secondary">
              <Button
                type="default"
                size="small"
                class="users-search-btn"
                :loading="loading && activeAction === 'search'"
                :disabled="loading"
                @click="handleSearch"
              >
                <Search :size="16" style="margin-right: 6px" />
                {{ t('common.search') }}
              </Button>
              <Button
                type="default"
                size="small"
                class="users-refresh-btn"
                :loading="loading && activeAction === 'refresh'"
                :disabled="loading"
                @click="handleRefresh"
              >
                <RefreshCw :size="16" style="margin-right: 6px" />
                {{ t('common.refresh') }}
              </Button>
            </div>
          </div>

          <Button
            v-if="authStore.isAdmin"
            type="primary"
            size="small"
            class="users-desktop-create-btn"
            :disabled="loading"
            @click="showCreateModal = true"
          >
            <Plus :size="16" style="margin-right: 6px" />
            {{ t('users.createUser') }}
          </Button>
        </div>
      </header>

      <section class="users-content">
        <Card class="users-table-card">
          <Table class="users-table" :columns="columns" :data="users" :loading="loading" />

          <Pagination
            v-if="pagination.itemCount > 0"
            :page="pagination.page"
            :page-size="pagination.pageSize"
            :total="pagination.itemCount"
            @update:page="changePage"
            @update:page-size="changePageSize"
          />
        </Card>
      </section>

      <Modal
        v-if="authStore.isAdmin"
        v-model:show="showCreateModal"
        :title="t('users.createModalTitle')"
        width="480px"
      >
        <FormItem :label="t('users.form.username')">
          <Input v-model="createForm.username" :placeholder="t('users.form.usernamePlaceholder')" />
        </FormItem>
        <FormItem :label="t('users.form.password')">
          <Input
            v-model="createForm.password"
            type="password"
            :placeholder="t('users.form.passwordPlaceholder')"
          />
        </FormItem>
        <FormItem :label="t('users.form.quota')">
          <Input
            v-model="createForm.quota_gb"
            type="number"
            :placeholder="t('users.form.quotaPlaceholder')"
          />
        </FormItem>

        <template #footer>
          <Button type="default" @click="showCreateModal = false">{{ t('common.cancel') }}</Button>
          <Button type="primary" :loading="creating" @click="handleCreate">{{
            t('common.create')
          }}</Button>
        </template>
      </Modal>

      <Modal v-model:show="showResetModal" :title="t('users.resetModalTitle')" width="420px">
        <FormItem :label="t('users.form.newPassword')">
          <Input
            v-model="resetForm.password"
            type="password"
            :placeholder="t('users.form.newPasswordPlaceholder')"
          />
        </FormItem>

        <template #footer>
          <Button type="default" @click="showResetModal = false">{{ t('common.cancel') }}</Button>
          <Button type="primary" :loading="resetting" @click="handleResetPassword">{{
            t('common.submit')
          }}</Button>
        </template>
      </Modal>

      <Modal
        :show="showDisableModal"
        :title="t('users.modals.disableTitle')"
        width="420px"
        @update:show="handleDisableModalUpdate"
      >
        <p class="users-confirm-text">
          {{ disableConfirmText }}
        </p>

        <template #footer>
          <Button type="default" :disabled="disabling" @click="handleDisableCancel">{{
            t('common.cancel')
          }}</Button>
          <Button type="danger" :loading="disabling" @click="handleDisableConfirm">{{
            t('users.actions.disable')
          }}</Button>
        </template>
      </Modal>

      <Modal
        :show="showDeleteModal"
        :title="t('users.modals.deleteTitle')"
        width="420px"
        @update:show="handleDeleteModalUpdate"
      >
        <p class="users-confirm-text">
          {{ deleteConfirmText }}
        </p>

        <template #footer>
          <Button type="default" :disabled="deleting" @click="handleDeleteCancel">{{
            t('common.cancel')
          }}</Button>
          <Button type="danger" :loading="deleting" @click="handleDeleteConfirm">{{
            t('users.actions.delete')
          }}</Button>
        </template>
      </Modal>

      <UserEditModal
        v-if="authStore.isAdmin"
        v-model:show="showEditModal"
        :user="editingUser"
        :submitting="updating"
        @submit="handleEditSubmit"
      />
    </div>
  </AppLayout>
</template>

<script setup>
import { computed, ref, h, onMounted, watch } from 'vue'
import {
  KeyRound,
  Pencil,
  Trash2,
  UserCheck,
  UserX,
  Plus,
  Search,
  RefreshCw,
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import api from '../services/api'
import { useThemeStore } from '../stores/theme'
import { useAuthStore } from '../stores/auth'
import { useUserOptionsStore } from '../stores/userOptions'
import AppLayout from '../components/layout/AppLayout.vue'
import Card from '../components/ui/card/Card.vue'
import Button from '../components/ui/button/Button.vue'
import Table from '../components/ui/table/Table.vue'
import Modal from '../components/ui/modal/Modal.vue'
import FormItem from '../components/ui/form-item/FormItem.vue'
import Input from '../components/ui/input/Input.vue'
import Select from '../components/ui/select/Select.vue'
import DateRangePicker from '../components/ui/date-range-picker/DateRangePicker.vue'
import Pagination from '../components/ui/pagination/Pagination.vue'
import Tag from '../components/ui/tag/Tag.vue'
import TableCellText from '../components/ui/table/TableCellText.vue'
import UserEditModal from '../components/users/UserEditModal.vue'
import { useMessage } from '../composables/useMessage'
import { buildUserEditPayload } from '../utils/userManagement.js'

const themeStore = useThemeStore()
const message = useMessage()
const { t, locale } = useI18n({ useScope: 'global' })
const authStore = useAuthStore()
const userOptionsStore = useUserOptionsStore()
const users = ref([])
const loading = ref(false)
const pagination = ref({ page: 1, pageSize: 20, itemCount: 0 })
const activeAction = ref('')

const filters = ref({
  q: '',
  status: '',
  created_from_date: '',
  created_to_date: '',
})

const userOptionsLoading = computed(() => userOptionsStore.loading)
const userOptionsUsers = computed(() => userOptionsStore.users)
const userOptions = computed(() => [
  { label: t('users.filters.allUsers'), value: '' },
  ...userOptionsUsers.value
    .filter((u) => u?.username)
    .map((u) => ({ label: u.username, value: u.username })),
])

const showCreateModal = ref(false)
const defaultCreateForm = () => ({ username: '', password: '', quota_gb: '10' })
const createForm = ref(defaultCreateForm())
const creating = ref(false)

const showResetModal = ref(false)
const resetForm = ref({ userId: '', password: '' })
const resetting = ref(false)

const showEditModal = ref(false)
const updating = ref(false)
const editingUser = ref(null)

const showDisableModal = ref(false)
const disabling = ref(false)
const pendingDisableUser = ref(null)

const showDeleteModal = ref(false)
const deleting = ref(false)
const pendingDeleteUser = ref(null)

const formatBytes = (bytes) => {
  const unit = 1024
  if (bytes < unit) return `${bytes} B`
  let div = unit,
    exp = 0
  while (bytes / div >= unit && exp < 4) {
    div *= unit
    exp++
  }
  return `${(bytes / div).toFixed(2)} ${['KB', 'MB', 'GB', 'TB', 'PB'][exp]}`
}

const toDisplayText = (value) => {
  if (value === null || value === undefined || value === '') return '-'
  return String(value)
}

const toRoleLabel = (value) => {
  if (value === 'admin') return t('role.admin')
  if (value === 'user') return t('role.user')
  return toDisplayText(value)
}

const toStatusLabel = (value) => {
  if (value === 'active') return t('users.status.active')
  if (value === 'disabled') return t('users.status.disabled')
  if (value === 'deleted') return t('users.status.deleted')
  return toDisplayText(value)
}

const statusOptions = computed(() => [
  { label: t('users.filters.allStatus'), value: '' },
  { label: t('users.status.active'), value: 'active' },
  { label: t('users.status.disabled'), value: 'disabled' },
  { label: t('users.status.deleted'), value: 'deleted' },
])

const columns = computed(() => [
  {
    title: t('users.columns.username'),
    key: 'username',
    align: 'left',
    ellipsis: true,
    render: (row) => h(TableCellText, { value: toDisplayText(row.username) }),
  },
  {
    title: t('users.columns.role'),
    key: 'role',
    width: 100,
    align: 'center',
    ellipsis: true,
    render: (row) => h(TableCellText, { value: toRoleLabel(row.role) }),
  },
  {
    title: t('users.columns.status'),
    key: 'status',
    width: 100,
    align: 'center',
    ellipsis: false,
    render: (row) => {
      const text = toStatusLabel(row.status)
      const type =
        row.status === 'active' ? 'success' : row.status === 'disabled' ? 'warning' : 'danger'
      return h(Tag, { type, size: 'small' }, () => text)
    },
  },
  {
    title: t('users.columns.quota'),
    key: 'quota_bytes',
    width: 140,
    align: 'center',
    ellipsis: true,
    render: (row) => {
      const text = formatBytes(row.quota_bytes || 0)
      return h(TableCellText, { value: text })
    },
  },
  {
    title: t('users.columns.actions'),
    key: 'actions',
    width:
      locale.value === 'zh-CN'
        ? themeStore.uiTheme === 'shadcn'
          ? 420
          : 460
        : themeStore.uiTheme === 'shadcn'
          ? 500
          : 580,
    align: 'center',
    ellipsis: false,
    render: (row) =>
      h('div', { class: 'action-buttons' }, [
        h(Button, { size: 'small', type: 'default', onClick: () => openEdit(row) }, () => [
          h(Pencil, { size: 16, style: 'margin-right: 4px' }),
          t('users.actions.edit'),
        ]),
        h(
          Button,
          {
            size: 'small',
            type: 'default',
            disabled: row.role === 'admin' && row.status === 'active',
            onClick: () => toggleStatus(row),
          },
          () => [
            row.status === 'active'
              ? h(UserX, { size: 16, style: 'margin-right: 4px' })
              : h(UserCheck, { size: 16, style: 'margin-right: 4px' }),
            row.status === 'active' ? t('users.actions.disable') : t('users.actions.enable'),
          ]
        ),
        h(Button, { size: 'small', type: 'default', onClick: () => openReset(row) }, () => [
          h(KeyRound, { size: 16, style: 'margin-right: 4px' }),
          t('users.actions.resetPassword'),
        ]),
        h(
          Button,
          {
            size: 'small',
            type: 'danger',
            disabled: row.role === 'admin',
            onClick: () => handleDelete(row),
          },
          () => [h(Trash2, { size: 16, style: 'margin-right: 4px' }), t('users.actions.delete')]
        ),
      ]),
  },
])

const toIsoStartOfDay = (dateValue) => {
  const local = new Date(`${dateValue}T00:00:00`)
  if (Number.isNaN(local.getTime())) return null
  return local.toISOString()
}

const addOneDayIso = (isoString) => {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() + 1)
  return date.toISOString()
}

const buildQueryParams = () => {
  const params = {}

  const q = filters.value.q?.trim()
  if (q) params.q = q

  if (filters.value.status) {
    params.status = filters.value.status
  }

  const createdFromDate = filters.value.created_from_date
  const createdToDate = filters.value.created_to_date

  if (createdFromDate || createdToDate) {
    let fromDate = createdFromDate
    let toDate = createdToDate

    if (fromDate && toDate && fromDate > toDate) {
      ;[fromDate, toDate] = [toDate, fromDate]
    }

    const fromIso = fromDate ? toIsoStartOfDay(fromDate) : null
    const toBaseIso = toDate ? toIsoStartOfDay(toDate) : null
    const toIso = toBaseIso ? addOneDayIso(toBaseIso) : null

    if (fromIso && toIso) {
      params.created_from = fromIso
      params.created_to = toIso
    } else if (fromIso) {
      const singleTo = addOneDayIso(fromIso)
      if (singleTo) {
        params.created_from = fromIso
        params.created_to = singleTo
      }
    } else if (toIso && toBaseIso) {
      params.created_from = toBaseIso
      params.created_to = toIso
    }
  }

  return params
}

const loadUserOptions = async () => {
  try {
    await userOptionsStore.fetchActiveUsers()
  } catch (error) {
    message.error(t('users.messages.loadUserOptionsFailed'))
  }
}

const loadUsers = async () => {
  loading.value = true
  try {
    const result = await api.getUsers({
      page: pagination.value.page,
      limit: pagination.value.pageSize,
      ...buildQueryParams(),
    })
    users.value = result.users || []
    pagination.value.itemCount = Number(result.total || 0)
  } catch (error) {
    message.error(t('users.messages.loadUsersFailed'))
  } finally {
    loading.value = false
    activeAction.value = ''
  }
}

const handleSearch = () => {
  if (loading.value) return
  activeAction.value = 'search'
  pagination.value.page = 1
  loadUsers()
}

const handleRefresh = () => {
  if (loading.value) return
  activeAction.value = 'refresh'
  loadUsers()
}

const changePage = (page) => {
  pagination.value.page = page
  loadUsers()
}

const changePageSize = (pageSize) => {
  const nextSize = Number(pageSize)
  if (!Number.isFinite(nextSize) || nextSize <= 0) return
  pagination.value.pageSize = nextSize
  pagination.value.page = 1
  loadUsers()
}

const parseQuotaGb = (value) => {
  const numeric = Number(String(value ?? '').trim())
  return Number.isFinite(numeric) ? numeric : Number.NaN
}

const disableConfirmText = computed(() => t('users.confirmDisable'))
const deleteConfirmText = computed(() => t('users.confirmDelete'))

const handleCreate = async () => {
  if (!createForm.value.username || !createForm.value.password) {
    message.error(t('users.messages.fillUsernamePassword'))
    return
  }
  const quotaGb = parseQuotaGb(createForm.value.quota_gb)
  if (!Number.isFinite(quotaGb) || quotaGb <= 0) {
    message.error(t('users.messages.quotaInvalid'))
    return
  }
  const quotaBytes = Math.round(quotaGb * 1024 * 1024 * 1024)
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) {
    message.error(t('users.messages.quotaInvalid'))
    return
  }
  try {
    creating.value = true
    await api.createUser({
      username: createForm.value.username,
      password: createForm.value.password,
      role: 'user',
      quota_bytes: quotaBytes,
    })
    message.success(t('users.messages.createSuccess'))
    showCreateModal.value = false
    createForm.value = defaultCreateForm()
    userOptionsStore.invalidate()
    await userOptionsStore.fetchActiveUsers({ force: true })
    pagination.value.page = 1
    loadUsers()
  } catch (error) {
    message.error(error.response?.data?.error || t('users.messages.createFailed'))
  } finally {
    creating.value = false
  }
}

const toggleStatus = async (row) => {
  if (row?.role === 'admin' && row?.status === 'active') {
    message.error(t('users.messages.adminCannotDisable'))
    return
  }
  if (row?.status === 'active') {
    openDisableModal(row)
    return
  }
  const userId = String(row?.id ?? '').trim()
  if (!userId) return
  try {
    await api.updateUser(userId, { status: 'active' })
    message.success(t('users.messages.statusUpdated'))
    loadUsers()
  } catch (error) {
    message.error(error.response?.data?.error || t('users.messages.statusUpdateFailed'))
  }
}

const openReset = (row) => {
  resetForm.value = { userId: row.id, password: '' }
  showResetModal.value = true
}

const handleResetPassword = async () => {
  if (!resetForm.value.password) {
    message.error(t('users.messages.newPasswordRequired'))
    return
  }
  try {
    resetting.value = true
    await api.resetUserPassword(resetForm.value.userId, resetForm.value.password)
    message.success(t('users.messages.passwordReset'))
    showResetModal.value = false
  } catch (error) {
    message.error(error.response?.data?.error || t('users.messages.resetFailed'))
  } finally {
    resetting.value = false
  }
}

const openEdit = (row) => {
  editingUser.value = { ...row }
  showEditModal.value = true
}

const handleEditSubmit = async (form) => {
  const currentUser = editingUser.value
  const userId = String(currentUser?.id ?? '').trim()
  if (!userId) return

  const payload = buildUserEditPayload(currentUser, form)
  if (payload.quota_bytes === null) {
    message.error(t('users.messages.quotaInvalid'))
    return
  }

  if (!Object.keys(payload).length) {
    message.info(t('users.messages.noChanges'))
    return
  }

  try {
    updating.value = true
    await api.updateUser(userId, payload)
    message.success(t('users.messages.updateSuccess'))
    showEditModal.value = false
    userOptionsStore.invalidate()
    await userOptionsStore.fetchActiveUsers({ force: true })
    await loadUsers()
  } catch (error) {
    message.error(error.response?.data?.error || t('users.messages.updateFailed'))
  } finally {
    updating.value = false
  }
}

const openDisableModal = (row) => {
  const id = String(row?.id ?? '').trim()
  if (!id) return
  pendingDisableUser.value = { id }
  showDisableModal.value = true
}

const closeDisableModal = () => {
  showDisableModal.value = false
  pendingDisableUser.value = null
}

const handleDisableModalUpdate = (nextValue) => {
  if (disabling.value) return
  if (!nextValue) {
    closeDisableModal()
    return
  }
  showDisableModal.value = true
}

const handleDisableCancel = () => {
  if (disabling.value) return
  closeDisableModal()
}

const handleDisableConfirm = async () => {
  if (disabling.value) return
  const userId = pendingDisableUser.value?.id
  if (!userId) return

  disabling.value = true
  try {
    await api.updateUser(userId, { status: 'disabled' })
    message.success(t('users.messages.statusUpdated'))
    closeDisableModal()
    loadUsers()
  } catch (error) {
    message.error(error.response?.data?.error || t('users.messages.statusUpdateFailed'))
  } finally {
    disabling.value = false
  }
}

const openDeleteModal = (row) => {
  const id = String(row?.id ?? '').trim()
  if (!id) return
  pendingDeleteUser.value = { id }
  showDeleteModal.value = true
}

const closeDeleteModal = () => {
  showDeleteModal.value = false
  pendingDeleteUser.value = null
}

const handleDeleteModalUpdate = (nextValue) => {
  if (deleting.value) return
  if (!nextValue) {
    closeDeleteModal()
    return
  }
  showDeleteModal.value = true
}

const handleDeleteCancel = () => {
  if (deleting.value) return
  closeDeleteModal()
}

const handleDeleteConfirm = async () => {
  if (deleting.value) return
  const userId = pendingDeleteUser.value?.id
  if (!userId) return

  deleting.value = true
  try {
    await api.deleteUser(userId)
    message.success(t('users.messages.userDeleted'))
    closeDeleteModal()
    userOptionsStore.invalidate()
    await userOptionsStore.fetchActiveUsers({ force: true })
    if (users.value.length <= 1 && pagination.value.page > 1) pagination.value.page -= 1
    loadUsers()
  } catch (error) {
    message.error(t('users.messages.deleteFailed'))
  } finally {
    deleting.value = false
  }
}

const handleDelete = (row) => {
  if (row?.role === 'admin') {
    message.error(t('users.messages.adminCannotDelete'))
    return
  }
  openDeleteModal(row)
}

watch(showEditModal, (visible) => {
  if (!visible && !updating.value) {
    editingUser.value = null
  }
})

onMounted(() => {
  loadUsers()
  loadUserOptions()
})
</script>

<style scoped>
.users-page {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.users-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--nb-space-lg);
}

.users-title-group {
  min-width: 0;
}

.users-title-row {
  display: flex;
  align-items: center;
  gap: var(--nb-space-sm);
}

.users-title {
  margin: 0;
  font-family: var(--nb-heading-font-family, var(--nb-font-mono));
  font-weight: var(--nb-heading-font-weight, 900);
  font-size: var(--nb-font-size-2xl);
  line-height: 1.2;
}

.users-mobile-create-btn {
  display: none;
  height: 32px;
  padding: 0 10px;
  align-items: center;
  justify-content: center;
}

.users-mobile-create-btn :deep(svg) {
  width: 18px;
  height: 18px;
}

.users-subtitle {
  margin: var(--nb-space-sm) 0 0;
  color: var(--nb-muted-foreground, var(--nb-gray-500));
  font-size: var(--nb-font-size-sm);
}

.users-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--nb-space-sm);
  flex-wrap: wrap;
}

.filter-row {
  display: flex;
  gap: var(--nb-space-sm);
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.filter-row-primary,
.filter-row-secondary {
  display: contents;
}

.filter-item.username {
  width: 160px;
}

.filter-item.status {
  width: 120px;
}

.filter-item.created-range {
  width: 280px;
}

.filter-item.username,
.filter-item.status,
.filter-item.created-range,
.users-search-btn,
.users-refresh-btn {
  min-width: 0;
}

.users-content {
  display: flex;
  flex-direction: column;
  gap: var(--nb-space-lg);
}

.users-table-card {
  /* min-height removed */
}

:deep(.users-table .brutal-table),
:deep(.users-table .shadcn-table) {
  table-layout: fixed;
}

:deep(.users-table .brutal-table th),
:deep(.users-table .brutal-table td),
:deep(.users-table .shadcn-table th),
:deep(.users-table .shadcn-table td) {
  white-space: nowrap;
}

:deep(.action-buttons) {
  display: flex;
  gap: 8px;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
}

:root[data-ui-theme='shadcn'] :deep(.action-buttons) {
  gap: 8px;
}

.users-confirm-text {
  margin: 0;
  color: var(--nb-ink);
}

@media (max-width: 768px) {
  .users-page {
    overflow-x: hidden;
    overflow-x: clip;
  }

  .users-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .users-title-group,
  .users-title-row,
  .users-subtitle,
  .users-actions {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .users-content,
  .users-header,
  .filter-row,
  .filter-row-primary,
  .filter-row-secondary {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .users-title-row {
    justify-content: flex-start;
  }

  .users-mobile-create-btn {
    display: inline-flex;
    flex-shrink: 0;
  }

  .users-actions {
    justify-content: flex-start;
    align-items: stretch;
  }

  .filter-row {
    flex-direction: column;
    justify-content: flex-start;
    align-items: stretch;
  }

  .filter-row-primary {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.4fr);
    gap: var(--nb-space-sm);
    justify-content: flex-start;
    align-items: stretch;
  }

  .filter-row-secondary {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--nb-space-sm);
    justify-content: flex-start;
    align-items: stretch;
  }

  .filter-item.username,
  .filter-item.status,
  .filter-item.created-range,
  .users-search-btn,
  .users-refresh-btn {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .users-desktop-create-btn {
    display: none;
  }

  .filter-row-primary :deep(.brutal-select-wrapper),
  .filter-row-primary :deep(.shadcn-select-wrapper),
  .filter-row-primary :deep(.date-range-picker),
  .filter-row-primary :deep(.brutal-select-trigger),
  .filter-row-primary :deep(.shadcn-select-trigger),
  .filter-row-primary :deep(.date-range-trigger) {
    width: 100%;
    min-width: 0;
    min-inline-size: 0;
    max-width: 100%;
    overflow: hidden;
  }
}
</style>
