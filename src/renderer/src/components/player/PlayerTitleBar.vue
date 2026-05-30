<script setup lang="ts">
// Top title bar for the player overlay — close button, episode prev/next
// nav, anime title + episode label, and the prefetch indicator. Phase 5
// slice 5e (#118).

import { formatSpeed } from '../../utils';

type PrefetchInFlight = {
  episodeInt: string;
  translationId: number;
  progress: number;
  speed: number;
};

defineProps<{
  animeName: string;
  subtitle: string;
  prefetchInFlight: PrefetchInFlight | null;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <div class="title-bar">
    <button class="close-btn" @click="emit('close')" title="Close player">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
    </button>
    <div class="pt-meta">
      <div class="pt-title">{{ animeName }}</div>
      <div class="pt-sub">{{ subtitle }}</div>
    </div>
    <span
      v-if="prefetchInFlight"
      class="prefetch-indicator"
      :title="`Pre-fetching episode ${prefetchInFlight.episodeInt}`"
    >
      ↓ Ep {{ prefetchInFlight.episodeInt }} · {{ prefetchInFlight.progress }}%<template
        v-if="prefetchInFlight.speed > 0"
      >
        · {{ formatSpeed(prefetchInFlight.speed) }}</template
      >
    </span>
  </div>
</template>

<style scoped>
.title-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 24px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.7) 0%, transparent 100%);
  z-index: 5;
}

.close-btn {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: background 0.15s var(--ease);
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.pt-meta {
  margin-right: auto;
  min-width: 0;
}

.pt-title {
  color: #fff;
  font-family: var(--font-display);
  font-size: 0.98rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pt-sub {
  color: rgba(255, 255, 255, 0.55);
  font-size: 0.82rem;
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prefetch-indicator {
  color: rgba(255, 255, 255, 0.78);
  font-family: var(--font-data);
  font-size: 0.74rem;
  font-weight: 600;
  padding: 3px 10px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: var(--radius-chip);
  background: rgba(0, 0, 0, 0.3);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  white-space: nowrap;
}
</style>
