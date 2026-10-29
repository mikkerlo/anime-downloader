<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { getAnimeName, getPosterSrc, POSTER_SCHEME } from '../../utils';
import { useLibraryStore } from '../../stores/library';

// `prioritized` is optional so a grid that has not bound it still mounts and
// renders an inert (un-filled) priority flag rather than throwing.
// `selectable` shows a checkbox for the Library's multi-select (#574); the
// grid decides what a click on the card means while it is on.
const props = withDefaults(
  defineProps<{
    anime: AnimeSearchResult;
    starred: boolean;
    prioritized?: boolean;
    selectable?: boolean;
    selected?: boolean;
    // An attached title whose drive is unplugged (#582): dimmed, with the reason.
    unavailable?: boolean;
    unavailableTitle?: string;
    // The title is also on an attached library: ask for its poster (#629).
    onDrive?: boolean;
  }>(),
  {
    prioritized: false,
    selectable: false,
    selected: false,
    unavailable: false,
    unavailableTitle: '',
    onDrive: false
  }
);

const emit = defineEmits<{
  toggleStar: [anime: AnimeSearchResult];
  togglePriority: [anime: AnimeSearchResult];
  toggleSelect: [anime: AnimeSearchResult];
}>();

const libraryStore = useLibraryStore();
// A local poster that fails to load (deleted since the id list was read, or
// none on the drive) falls back to the remote URL once.
const localFailed = ref(false);
watch(
  () => props.anime.id,
  () => {
    localFailed.value = false;
  }
);
const posterSrc = computed(() =>
  localFailed.value
    ? props.anime.posterUrlSmall
    : getPosterSrc(
        props.anime.id,
        props.anime.posterUrlSmall,
        libraryStore.posterIds,
        props.onDrive
      )
);

function onPosterError(): void {
  if (posterSrc.value.startsWith(POSTER_SCHEME)) localFailed.value = true;
}
</script>

<template>
  <div
    class="acard"
    :class="{ selected: selectable && selected, unavailable }"
    :data-unavailable="unavailable || undefined"
    :title="unavailable ? unavailableTitle || undefined : undefined"
  >
    <div class="poster-wrap">
      <span v-if="unavailable" class="unplugged" data-testid="drive-not-connected">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          width="14"
          height="14"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M9 3v4m6-4v4M7 7h10v4a5 5 0 01-10 0V7zm5 9v5M4 4l16 16"
          />
        </svg>
        Drive not connected
      </span>
      <input
        v-if="selectable"
        type="checkbox"
        class="select-box"
        data-testid="card-select"
        :checked="selected"
        :aria-label="`Select ${anime.title}`"
        @click.stop
        @change="emit('toggleSelect', anime)"
      />
      <img
        :src="posterSrc"
        :alt="anime.title"
        class="poster"
        loading="lazy"
        @error="onPosterError"
      />
      <button class="star-btn" :class="{ active: starred }" @click.stop="emit('toggleStar', anime)">
        <svg
          viewBox="0 0 24 24"
          :fill="starred ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="1.5"
          width="20"
          height="20"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
          />
        </svg>
      </button>
      <button
        class="priority-btn"
        :class="{ active: prioritized }"
        :title="prioritized ? 'Remove from Priority' : 'Add to Priority'"
        @click.stop="emit('togglePriority', anime)"
      >
        <svg
          viewBox="0 0 24 24"
          :fill="prioritized ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="1.5"
          width="20"
          height="20"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3 21V4.5l2.77-.693a9 9 0 016.208.682l.108.054a9 9 0 006.086.71l3.114-.732a48.524 48.524 0 00-.005 10.499l-3.11.732a9 9 0 01-6.085-.711l-.108-.054a9 9 0 00-6.208-.682L3 15"
          />
        </svg>
      </button>
    </div>
    <div class="acard-info">
      <div class="acard-title" :title="anime.title">{{ getAnimeName(anime) }}</div>
      <div class="acard-meta">
        <span v-if="anime.typeTitle">{{ anime.typeTitle }}</span>
        <span v-if="anime.year"> · {{ anime.year }}</span>
        <span v-if="anime.numberOfEpisodes"> · {{ anime.numberOfEpisodes }} ep</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.select-box {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 4;
  width: 20px;
  height: 20px;
  cursor: pointer;
  accent-color: var(--accent);
}

.acard.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent);
}

.acard.unavailable .poster,
.acard.unavailable .acard-info {
  opacity: 0.45;
  filter: grayscale(0.8);
}

.unplugged {
  position: absolute;
  bottom: 8px;
  left: 8px;
  right: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: var(--radius-chip);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  color: var(--text-2);
  font-size: 0.7rem;
  font-weight: 700;
  pointer-events: none;
}
</style>
