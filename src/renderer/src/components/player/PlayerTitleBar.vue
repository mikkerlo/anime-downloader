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
  episodeLabel: string;
  multiEpisode: boolean;
  canPrev: boolean;
  canNext: boolean;
  navigating: boolean;
  prefetchInFlight: PrefetchInFlight | null;
}>();

const emit = defineEmits<{
  close: [];
  'go-prev': [];
  'go-next': [];
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
    <button
      v-if="multiEpisode"
      class="ep-nav-btn"
      :disabled="!canPrev || navigating"
      @click="emit('go-prev')"
      title="Previous episode (Shift+←)"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
    </button>
    <span class="title-text">{{ animeName }} — {{ episodeLabel }}</span>
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
    <button
      v-if="multiEpisode"
      class="ep-nav-btn"
      :disabled="!canNext || navigating"
      @click="emit('go-next')"
      title="Next episode (Shift+→)"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
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
  gap: 12px;
  padding: 12px 16px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7) 0%, transparent 100%);
  z-index: 5;
}

.close-btn {
  background: none;
  border: none;
  color: #fff;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.title-text {
  color: #fff;
  font-size: 0.9rem;
  font-weight: 500;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
}

.prefetch-indicator {
  color: rgba(255, 255, 255, 0.75);
  font-size: 0.78rem;
  font-weight: 500;
  padding: 2px 8px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.25);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  white-space: nowrap;
}

.ep-nav-btn {
  background: none;
  border: none;
  color: #fff;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  opacity: 0.8;
}

.ep-nav-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
  opacity: 1;
}

.ep-nav-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
</style>
