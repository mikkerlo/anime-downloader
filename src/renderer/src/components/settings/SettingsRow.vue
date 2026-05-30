<script setup lang="ts">
defineProps<{
  label?: string;
  desc?: string;
  stack?: boolean;
}>();
</script>

<template>
  <div class="set-row" :class="{ stack }">
    <div v-if="label || desc || $slots.desc || $slots.text" class="sr-text">
      <div v-if="label" class="sr-label">{{ label }}</div>
      <div v-if="desc || $slots.desc" class="sr-desc">
        <slot name="desc">{{ desc }}</slot>
      </div>
      <slot name="text" />
    </div>
    <div class="sr-control">
      <slot />
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>
