<script setup>
import { computed, ref } from 'vue'
import { useThemeStore } from '../../../stores/theme'
import BrutalUpload from './BrutalUpload.vue'
import ShadcnUpload from './ShadcnUpload.vue'

const props = defineProps({
  multiple: Boolean,
  directory: Boolean,
})

const emit = defineEmits(['file-selected', 'before-upload'])

const themeStore = useThemeStore()
const currentComponent = computed(() => {
  return themeStore.uiTheme === 'shadcn' ? ShadcnUpload : BrutalUpload
})

const innerRef = ref(null)

defineExpose({
  clear: () => innerRef.value?.clear?.(),
})
</script>

<template>
  <component
    :is="currentComponent"
    ref="innerRef"
    :multiple="props.multiple"
    :directory="props.directory"
    @file-selected="emit('file-selected', $event)"
    @before-upload="emit('before-upload', $event)"
  >
    <slot />
  </component>
</template>
