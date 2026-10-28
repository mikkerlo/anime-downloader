<script setup lang="ts">
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import AnimeCard from '../shared/AnimeCard.vue';
import FfmpegMissingBanner from './FfmpegMissingBanner.vue';
import LibraryActionsMenu from './LibraryActionsMenu.vue';
import { useLibraryStore } from '../../stores/library';
import {
  FFMPEG_MISSING_REASON,
  ROLE_BADGE,
  lastSyncWhen,
  pathOverflowText,
  useSharedLibrariesStore
} from '../../stores/shared-libraries';
import { usePlayFromDrive } from '../../composables/use-play-from-drive';
import { formatAgo } from '../../utils';

// Library → Shared Libraries (#578, owner decision 3): one section per
// attached library, its titles from the drive's snapshot. Copy to this PC and
// Import all arrive with S7b (#579). Each section header is the library's
// management row (#581): availability, Last seen, a badge, Last sync, and the
// ⋯ menu. The empty `slot-*` spans are where S9 (#584) and S10 (#585) render.
// Strings from the drive are rendered as text only.
defineProps<{ starredIds: ReadonlySet<number> }>();
const emit = defineEmits<{ toggleStar: [anime: AnimeSearchResult] }>();

const libraryStore = useLibraryStore();
const shared = useSharedLibrariesStore();
const { libraries, ffmpegAvailable } = storeToRefs(shared);
const { play } = usePlayFromDrive();
const error = ref('');

const ROLE_NOTE: Partial<Record<AttachedLibraryRole, string>> = {
  foreign: 'Owned by someone else: used as videos only, its watch state is ignored.',
  owner: 'Sync arrives in a later update.',
  claim: 'Used on this PC as its owner. Sync arrives in a later update.'
};

async function playTitle(lib: AttachedLibraryInfo, title: AttachedLibraryTitle): Promise<void> {
  const target = shared.playTarget(title);
  if (!target) return;
  error.value = (await play(lib.libraryId, title.animeId, target)) ?? '';
}
</script>

<template>
  <div class="shared-tab" data-testid="shared-libraries-tab">
    <p v-if="libraries.length === 0" class="status-text">No Shared Library is open.</p>
    <header v-else class="tab-head" data-testid="shared-tab-head">
      <span class="slot" data-testid="slot-sync-now"></span>
      <span class="slot" data-testid="slot-sync-history"></span>
    </header>
    <p v-if="error" class="sl-error">{{ error }}</p>
    <section
      v-for="lib in libraries"
      :key="lib.libraryId"
      class="lib-section"
      data-testid="shared-library-section"
    >
      <header class="lib-head">
        <span
          class="dot"
          :class="lib.available ? 'on' : 'off'"
          data-testid="availability-dot"
          :data-available="lib.available"
          :title="lib.available ? 'Connected' : 'Not connected'"
        ></span>
        <h3 class="lib-name">{{ lib.name }}</h3>
        <span v-if="lib.ownerNickname" class="sl-muted">{{ lib.ownerNickname }}</span>
        <span class="sl-badge" data-testid="role-badge">{{ ROLE_BADGE[lib.role] }}</span>
        <span v-if="lib.access === 'read-only'" class="sl-badge" data-testid="read-only-badge"
          >Read-only</span
        >
        <span v-if="!lib.available" class="sl-muted" data-testid="last-seen"
          >Last seen {{ formatAgo(lib.lastSeenAt) }}</span
        >
        <span class="sl-muted" data-testid="last-sync"
          >Last sync: {{ lastSyncWhen(lib.lastSyncAt) }}</span
        >
        <span class="slot" data-testid="slot-sync-status"></span>
        <span class="slot" data-testid="slot-conflicts"></span>
        <div class="grow"></div>
        <button class="sl-btn" disabled title="Arrives in a later update">Import all</button>
        <LibraryActionsMenu :library="lib" @error="error = $event" />
      </header>
      <p v-if="ROLE_NOTE[lib.role]" class="sl-muted">{{ ROLE_NOTE[lib.role] }}</p>
      <p v-if="lib.message" class="sl-warn" data-testid="read-only-message">{{ lib.message }}</p>
      <p v-if="lib.pathOverflow > 0" class="sl-warn" data-testid="path-overflow">
        {{ pathOverflowText(lib.pathOverflow) }}
      </p>
      <FfmpegMissingBanner v-if="!ffmpegAvailable && lib.mkvCount > 0" :mkv-count="lib.mkvCount" />
      <p v-if="!lib.available" class="sl-muted">This library's folder can't be read right now.</p>

      <div v-if="lib.titles.length > 0" class="poster-grid">
        <div
          v-for="title in lib.titles"
          :key="title.animeId"
          class="card-wrap"
          data-testid="drive-title"
        >
          <AnimeCard
            :anime="title.anime"
            :starred="starredIds.has(title.animeId)"
            @toggle-star="emit('toggleStar', $event)"
            @click="libraryStore.openAnime(title.animeId)"
          />
          <span v-if="title.onThisPc" class="on-pc-badge" data-testid="on-this-pc">On this PC</span>
          <div class="card-actions">
            <button
              class="sl-btn primary"
              data-testid="play-from-drive"
              :disabled="!shared.playTarget(title)"
              :title="shared.playTarget(title) ? undefined : FFMPEG_MISSING_REASON"
              @click.stop="playTitle(lib, title)"
            >
              Play from drive
            </button>
            <button class="sl-btn" disabled title="Arrives in a later update">
              Copy to this PC
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped src="./shared-library.css"></style>

<style scoped>
.shared-tab {
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.lib-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lib-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.tab-head {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.slot:empty,
.tab-head:not(:has(.slot:not(:empty))) {
  display: none;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot.on {
  background: var(--st-green);
}

.dot.off {
  background: var(--text-faint);
}

.lib-name {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 700;
}

.grow {
  flex: 1;
}

.card-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
}

.on-pc-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  padding: 2px 8px;
  border-radius: var(--radius-chip);
  background: color-mix(in srgb, var(--st-green) 85%, black);
  color: #fff;
  font-size: 0.7rem;
  font-weight: 700;
  pointer-events: none;
}

.card-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.status-text {
  text-align: center;
  color: var(--text-faint);
  font-size: 1.05rem;
  padding-top: 80px;
}
</style>
