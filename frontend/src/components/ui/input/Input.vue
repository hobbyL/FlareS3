<script setup>
import { computed } from 'vue'
import { useThemeStore } from '../../../stores/theme'
import BrutalInput from './BrutalInput.vue'
import ShadcnInput from './ShadcnInput.vue'

const props = defineProps({
  modelValue: [String, Number],
  label: String,
  type: { type: String, default: 'text' },
  placeholder: String,
  disabled: Boolean,
  readonly: Boolean,
  rows: { type: Number, default: 3 },
  size: { type: String, default: 'medium' },
  clearable: { type: Boolean, default: false },
  passwordToggle: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'keyup', 'password-toggle'])

const themeStore = useThemeStore()
const currentComponent = computed(() => {
  return themeStore.uiTheme === 'shadcn' ? ShadcnInput : BrutalInput
})
</script>

<template>
  <component
    :is="currentComponent"
    v-bind="props"
    @update:model-value="emit('update:modelValue', $event)"
    @keyup="emit('keyup', $event)"
    @password-toggle="emit('password-toggle', $event)"
  />
</template>
