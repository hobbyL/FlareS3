<script setup>
import { computed, nextTick, ref } from 'vue'
import { X, Eye, EyeOff } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n({ useScope: 'global' })

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

const inputId = computed(() => `input-${Math.random().toString(36).substr(2, 9)}`)

const inputEl = ref(null)
const passwordVisible = ref(false)

const effectiveType = computed(() => {
  if (props.type === 'password' && passwordVisible.value) return 'text'
  return props.type
})

const togglePassword = () => {
  emit('password-toggle', { visible: !passwordVisible.value })
  passwordVisible.value = !passwordVisible.value
}

const nonClearableTypes = new Set(['textarea', 'date', 'time', 'datetime-local', 'file'])
const supportsClear = computed(() => !nonClearableTypes.has(props.type))

const reserveClearSpace = computed(() => props.clearable && supportsClear.value)

const hasValue = computed(() => {
  if (props.modelValue === null || props.modelValue === undefined) return false
  return String(props.modelValue) !== ''
})

const showClear = computed(
  () => reserveClearSpace.value && hasValue.value && !props.disabled && !props.readonly
)

const handleClear = async () => {
  emit('update:modelValue', '')
  await nextTick()
  inputEl.value?.focus?.()
}
</script>

<template>
  <div class="shadcn-input-wrapper" :class="[`size-${size}`, { 'has-clear': reserveClearSpace, 'has-toggle': passwordToggle }]">
    <label v-if="label" class="input-label" :for="inputId">{{ label }}</label>
    <textarea
      v-if="type === 'textarea'"
      :id="inputId"
      class="shadcn-input"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :rows="rows"
      @input="emit('update:modelValue', $event.target.value)"
      @keyup="emit('keyup', $event)"
    />
    <div v-else class="shadcn-input-control">
      <input
        :id="inputId"
        ref="inputEl"
        :type="effectiveType"
        class="shadcn-input"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        @input="emit('update:modelValue', $event.target.value)"
        @keyup="emit('keyup', $event)"
      />
      <button
        v-if="passwordToggle && type === 'password'"
        type="button"
        class="shadcn-input-toggle"
        :aria-label="passwordVisible ? t('input.hidePassword') : t('input.showPassword')"
        @mousedown.prevent
        @click="togglePassword"
      >
        <EyeOff v-if="passwordVisible" :size="16" />
        <Eye v-else :size="16" />
      </button>
      <button
        v-if="showClear"
        type="button"
        class="shadcn-input-clear"
        :aria-label="t('input.clear')"
        @mousedown.prevent
        @click="handleClear"
      >
        <X :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.shadcn-input-wrapper {
  width: 100%;
}

.shadcn-input-control {
  position: relative;
  width: 100%;
}

.input-label {
  display: block;
  font-family: var(--nb-font-ui);
  font-weight: var(--nb-font-weight-medium);
  font-size: 0.875rem;
  line-height: 1;
  color: var(--foreground);
  margin-bottom: 8px;
}

.shadcn-input {
  width: 100%;
  font-family: var(--nb-font-sans);
  font-weight: var(--nb-font-weight-regular);
  font-size: 0.875rem;
  border: 1px solid var(--input);
  border-radius: var(--nb-radius-md);
  background: var(--background);
  color: var(--foreground);
  outline: none;
  transition:
    box-shadow 0.15s ease,
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.size-small input.shadcn-input {
  height: 36px;
  padding: 0 12px;
}

.size-medium input.shadcn-input {
  height: 40px;
  padding: 0 12px;
}

.size-large input.shadcn-input {
  height: 44px;
  padding: 0 16px;
}

.shadcn-input-wrapper.has-clear input.shadcn-input {
  padding-right: 40px;
}

.shadcn-input-wrapper.has-toggle input.shadcn-input {
  padding-right: 40px;
}

.shadcn-input-wrapper.has-clear.has-toggle input.shadcn-input {
  padding-right: 68px;
}

.shadcn-input-toggle {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--nb-radius-sm);
  color: var(--muted-foreground);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.shadcn-input-toggle:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}

.shadcn-input-toggle:focus-visible {
  box-shadow: var(--nb-focus-ring);
}

.shadcn-input-wrapper.has-clear.has-toggle .shadcn-input-clear {
  right: 38px;
}

.size-small textarea.shadcn-input {
  padding: 8px 12px;
}

.size-medium textarea.shadcn-input {
  padding: 8px 12px;
}

.size-large textarea.shadcn-input {
  padding: 10px 16px;
}

.shadcn-input:focus-visible {
  box-shadow: var(--nb-focus-ring);
}

.shadcn-input:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.shadcn-input::placeholder {
  color: var(--muted-foreground);
}

textarea.shadcn-input {
  resize: vertical;
  min-height: 80px;
  line-height: 1.5;
}

.shadcn-input-clear {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--nb-radius-sm);
  color: var(--muted-foreground);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.shadcn-input-clear:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}

.shadcn-input-clear:focus-visible {
  box-shadow: var(--nb-focus-ring);
}

/* Normalize native date/time inputs to match shadcn/ui look */
input[type='date'].shadcn-input,
input[type='time'].shadcn-input,
input[type='datetime-local'].shadcn-input {
  -webkit-appearance: none;
  appearance: none;
  padding-right: 40px;
}

input[type='date'].shadcn-input::-webkit-calendar-picker-indicator,
input[type='time'].shadcn-input::-webkit-calendar-picker-indicator,
input[type='datetime-local'].shadcn-input::-webkit-calendar-picker-indicator {
  opacity: 0.65;
  cursor: pointer;
  margin-right: 8px;
}

input[type='date'].shadcn-input:disabled::-webkit-calendar-picker-indicator,
input[type='time'].shadcn-input:disabled::-webkit-calendar-picker-indicator,
input[type='datetime-local'].shadcn-input:disabled::-webkit-calendar-picker-indicator {
  cursor: not-allowed;
}
</style>
