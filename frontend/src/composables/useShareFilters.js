import { computed, ref } from 'vue'
import {
  buildExpiredGovernanceFilters,
  buildExpiringGovernanceFilters,
  buildSharesQueryParams,
  createDefaultShareFilters,
  filterShareOwners,
  hasActiveShareFilters,
  isExpiredShareGovernanceActive,
  isExpiringShareGovernanceActive,
  persistShareFiltersToStorage,
  restoreShareFiltersFromStorage,
} from '../utils/shares.js'

export function useShareFilters({ t, isAdmin, owners }) {
  const filters = ref(createDefaultShareFilters())
  const ownerSearchQuery = ref('')

  const typeOptions = computed(() => [
    { label: t('shares.filters.allTypes'), value: '' },
    { label: t('shares.types.file'), value: 'file' },
    { label: t('shares.types.text'), value: 'text' },
    { label: t('shares.types.textOneTime'), value: 'text_one_time' },
  ])
  const statusOptions = computed(() => [
    { label: t('shares.filters.allStatuses'), value: '' },
    { label: t('shares.status.active'), value: 'active' },
    { label: t('shares.status.expired'), value: 'expired' },
    { label: t('shares.status.exhausted'), value: 'exhausted' },
    { label: t('shares.status.consumed'), value: 'consumed' },
  ])
  const sortOptions = computed(() => [
    { label: t('shares.filters.sortUpdatedDesc'), value: 'updated_at__desc' },
    { label: t('shares.filters.sortExpiresAsc'), value: 'expires_at__asc' },
    { label: t('shares.filters.sortExpiresDesc'), value: 'expires_at__desc' },
  ])
  const ownerOptions = computed(() => [
    { label: t('shares.filters.allOwners'), value: '' },
    ...filterShareOwners(owners.value, ownerSearchQuery.value, filters.value.owner_id).map(
      (user) => ({
        label: String(user.username ?? ''),
        value: String(user.id ?? ''),
      })
    ),
  ])
  const hasActiveFilters = computed(() =>
    hasActiveShareFilters(filters.value, { isAdmin: isAdmin.value })
  )
  const expiredGovernanceActive = computed(() => isExpiredShareGovernanceActive(filters.value))
  const expiringGovernanceActive = computed(() => isExpiringShareGovernanceActive(filters.value))

  const handleFilterUpdate = ({ key, value } = {}) => {
    if (!key) return
    filters.value = { ...filters.value, [key]: value }
  }
  const handleOwnerSearchQueryUpdate = (value) => {
    ownerSearchQuery.value = String(value ?? '')
  }
  const focusExpired = () => {
    filters.value = buildExpiredGovernanceFilters(filters.value)
  }
  const focusExpiring = () => {
    filters.value = buildExpiringGovernanceFilters(filters.value)
  }
  const buildQueryParams = () => buildSharesQueryParams(filters.value, { isAdmin: isAdmin.value })
  const restore = () => {
    filters.value = restoreShareFiltersFromStorage()
  }
  const persist = () => persistShareFiltersToStorage(filters.value)

  return {
    filters,
    ownerSearchQuery,
    typeOptions,
    statusOptions,
    sortOptions,
    ownerOptions,
    hasActiveFilters,
    expiredGovernanceActive,
    expiringGovernanceActive,
    handleFilterUpdate,
    handleOwnerSearchQueryUpdate,
    focusExpired,
    focusExpiring,
    buildQueryParams,
    restore,
    persist,
  }
}
