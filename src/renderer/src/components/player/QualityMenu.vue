<script setup lang="ts">
// Stream quality dropdown — surfaces available stream heights for the
// current source. Used only when streaming (not for local files). Phase
// 5 slice 5e (#118).

import { qualityLabel } from '../../utils';

defineProps<{
  open: boolean;
  availableStreams: { height: number; url: string }[];
  selectedHeight: number;
}>();

const emit = defineEmits<{
  'toggle-menu': [];
  select: [stream: { height: number; url: string }];
}>();

function onSelect(s: { height: number; url: string }): void {
  emit('select', s);
}
</script>

<template>
  <div class="preset-wrapper">
    <button class="ctrl-btn preset-btn" @click="emit('toggle-menu')" title="Video quality">
      {{ selectedHeight ? qualityLabel(selectedHeight) : '' }}
    </button>
    <div v-if="open" class="preset-menu">
      <button
        v-for="s in availableStreams"
        :key="s.height"
        class="preset-option"
        :class="{ selected: selectedHeight === s.height }"
        @click="onSelect(s)"
      >
        {{ qualityLabel(s.height) }}
      </button>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/player-menus.css"></style>
