<script setup lang="ts">
defineProps<{
  title?: string;
  desc?: string;
}>();
</script>

<template>
  <div class="set-group">
    <div v-if="title || desc || $slots.head" class="set-group-head">
      <h3 v-if="title">{{ title }}</h3>
      <p v-if="desc">{{ desc }}</p>
      <slot name="head" />
    </div>
    <slot />
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>
