<script setup lang="ts">
const props = defineProps<{
  modelValue: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

function toggle(): void {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
}
</script>

<template>
  <button
    type="button"
    class="switch"
    :class="{ on: modelValue }"
    :disabled="disabled"
    :aria-pressed="modelValue"
    @click="toggle"
  ></button>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>
