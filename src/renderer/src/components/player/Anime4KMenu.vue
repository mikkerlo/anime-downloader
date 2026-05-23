<script setup lang="ts">
// Anime4K WebGPU shader preset dropdown. Only rendered when WebGPU is
// available; otherwise PlayerView shows a "No GPU" hint. Phase 5 slice
// 5e (#118).

import type { Anime4KPreset } from '../../composables/use-anime4k';

defineProps<{
  open: boolean;
  preset: Anime4KPreset;
  presetLabel: string;
  gpuName: string;
}>();

const emit = defineEmits<{
  'toggle-menu': [];
  select: [preset: Anime4KPreset];
}>();

const presets: { key: Anime4KPreset; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: 'mode-a', label: 'Mode A (1080p source)' },
  { key: 'mode-b', label: 'Mode B (720p source)' },
  { key: 'mode-c', label: 'Mode C (480p source)' }
];
</script>

<template>
  <div class="preset-wrapper">
    <button
      class="ctrl-btn preset-btn"
      :class="{ active: preset !== 'off' }"
      @click="emit('toggle-menu')"
      title="Anime4K shaders"
    >
      {{ presetLabel }}
    </button>
    <div v-if="open" class="preset-menu">
      <button
        v-for="p in presets"
        :key="p.key"
        class="preset-option"
        :class="{ selected: preset === p.key }"
        @click="emit('select', p.key)"
      >
        {{ p.label }}
      </button>
      <div class="preset-gpu-info">GPU: {{ gpuName }}</div>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/player-menus.css"></style>
<style scoped>
.preset-gpu-info {
  padding: 6px 12px;
  color: #6a6a8a;
  font-size: 0.7rem;
  border-top: 1px solid #0f3460;
  margin-top: 4px;
}
</style>
