<script setup>
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from '../ui/modal/Modal.vue'
import FormItem from '../ui/form-item/FormItem.vue'
import Input from '../ui/input/Input.vue'
import Select from '../ui/select/Select.vue'
import Button from '../ui/button/Button.vue'
import { createUserEditForm } from '../../utils/userManagement.js'

const props = defineProps({
  show: Boolean,
  user: { type: Object, default: () => null },
  submitting: Boolean,
})

const emit = defineEmits(['update:show', 'submit'])
const { t } = useI18n({ useScope: 'global' })

const showProxy = computed({
  get: () => props.show,
  set: (value) => emit('update:show', value),
})

const form = reactive(createUserEditForm())

const resetForm = () => {
  Object.assign(form, createUserEditForm(props.user || {}))
}

watch(
  () => props.show,
  (show) => {
    if (show) resetForm()
  },
  { immediate: true }
)

watch(
  () => props.user,
  () => {
    if (props.show) resetForm()
  },
  { deep: true }
)

const roleOptions = computed(() => [
  { label: t('role.user'), value: 'user' },
  { label: t('role.admin'), value: 'admin' },
])

const statusOptions = computed(() => [
  { label: t('users.status.active'), value: 'active' },
  { label: t('users.status.disabled'), value: 'disabled' },
  {
    label: t('users.status.deleted'),
    value: 'deleted',
    disabled: props.user?.status !== 'deleted',
  },
])

const handleSubmit = () => {
  emit('submit', { ...form })
}
</script>

<template>
  <Modal v-model:show="showProxy" :title="t('users.editModalTitle')" width="480px">
    <FormItem :label="t('users.form.username')">
      <Input v-model="form.username" readonly />
    </FormItem>

    <FormItem :label="t('users.form.role')">
      <Select v-model="form.role" :options="roleOptions" />
    </FormItem>

    <FormItem :label="t('users.form.status')">
      <Select v-model="form.status" :options="statusOptions" />
    </FormItem>

    <FormItem :label="t('users.form.quota')">
      <Input
        v-model="form.quota_gb"
        type="number"
        :placeholder="t('users.form.quotaPlaceholder')"
      />
    </FormItem>

    <template #footer>
      <Button type="default" :disabled="submitting" @click="showProxy = false">
        {{ t('common.cancel') }}
      </Button>
      <Button type="primary" :loading="submitting" @click="handleSubmit">
        {{ t('common.submit') }}
      </Button>
    </template>
  </Modal>
</template>
