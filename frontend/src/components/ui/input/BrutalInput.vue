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
  <div
    class="brutal-input-wrapper"
    :class="[`size-${size}`, { 'has-clear': reserveClearSpace, 'has-toggle': passwordToggle }]"
  >
    <label v-if="label" class="input-label" :for="inputId">{{ label }}</label>
    <textarea
      v-if="type === 'textarea'"
      :id="inputId"
      class="brutal-input"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :rows="rows"
      @input="emit('update:modelValue', $event.target.value)"
      @keyup="emit('keyup', $event)"
    />
    <div v-else class="brutal-input-control">
      <input
        :id="inputId"
        ref="inputEl"
        :type="effectiveType"
        class="brutal-input"
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
        class="brutal-input-toggle"
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
        class="brutal-input-clear"
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
.brutal-input-wrapper {
  width: 100%;
}

.brutal-input-control {
  position: relative;
  width: 100%;
}

.input-label {
  display: block;
  font-family: var(--nb-font-ui, var(--nb-font-mono));
  font-weight: var(--nb-ui-font-weight, 700);
  font-size: 14px;
  text-transform: var(--nb-ui-text-transform, uppercase);
  letter-spacing: var(--nb-ui-letter-spacing, 0.02em);
  color: var(--nb-black);
  margin-bottom: var(--nb-space-xs);
}

.brutal-input {
  width: 100%;
  font-family: var(--nb-font-sans);
  font-weight: 300;
  font-size: 16px;
  border: var(--nb-border);
  border-radius: var(--nb-radius);
  background: var(--nb-input-bg);
  color: var(--nb-black);
  outline: none;
  transition: var(--nb-transition);
}

/* Input sizing (Fixed height, centered text) */
.size-small input.brutal-input {
  padding: 0 12px;
  height: 36px;
  font-size: 14px;
  line-height: 34px;
}

.size-medium input.brutal-input {
  padding: 0 16px;
  height: 44px;
  font-size: 16px;
  line-height: 42px;
}

.size-large input.brutal-input {
  padding: 0 20px;
  height: 52px;
  font-size: 18px;
  line-height: 50px;
}

.brutal-input-wrapper.has-clear input.brutal-input {
  padding-right: 40px;
}

.brutal-input-wrapper.has-toggle input.brutal-input {
  padding-right: 40px;
}

.brutal-input-wrapper.has-clear.has-toggle input.brutal-input {
  padding-right: 68px;
}

.brutal-input-toggle {
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
  border-radius: var(--nb-radius);
  color: var(--nb-gray-500);
  cursor: pointer;
  transition: var(--nb-transition);
}

.brutal-input-toggle:hover {
  background: var(--nb-gray-100);
  color: var(--nb-black);
}

.brutal-input-toggle:focus-visible {
  box-shadow: var(--nb-focus-ring);
}

.brutal-input-wrapper.has-clear.has-toggle .brutal-input-clear {
  right: 38px;
}

.brutal-input-clear {
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
  border-radius: var(--nb-radius);
  color: var(--nb-gray-500);
  cursor: pointer;
  transition: var(--nb-transition);
}

.brutal-input-clear:hover {
  background: var(--nb-gray-100);
  color: var(--nb-black);
}

.brutal-input-clear:focus-visible {
  box-shadow: var(--nb-focus-ring);
}

/* Textarea sizing (Auto height, padding) */
.size-small textarea.brutal-input {
  padding: 8px 12px;
  font-size: 14px;
}

.size-medium textarea.brutal-input {
  padding: 12px 16px;
  font-size: 16px;
}

.size-large textarea.brutal-input {
  padding: 16px 20px;
  font-size: 18px;
}

.brutal-input:focus {
  border-color: var(--nb-deep-blue);
  box-shadow: var(--nb-focus-ring);
}

.brutal-input:disabled {
  background-color: var(--nb-gray-200);
  color: var(--nb-gray-400);
  border-color: var(--nb-gray-400);
  cursor: not-allowed;
}

.brutal-input::placeholder {
  color: var(--nb-gray-400);
}

textarea.brutal-input {
  resize: vertical;
  min-height: 100px;
}
</style>
