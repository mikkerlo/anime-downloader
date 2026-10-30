<script setup lang="ts">
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import AnimeCard from '../shared/AnimeCard.vue';
import FfmpegMissingBanner from './FfmpegMissingBanner.vue';
import ImportDialog from './ImportDialog.vue';
import LibraryActionsMenu from './LibraryActionsMenu.vue';
import { useLibraryStore } from '../../stores/library';
import {
  DRIVE_NOT_CONNECTED,
  FFMPEG_MISSING_REASON,
  READ_ONLY_BADGE,
  ROLE_BADGE,
  lastSyncWhen,
  notConnectedTitle,
  pathOverflowText,
  rateText,
  readOnlyTitle,
  syncStatusText,
  useSharedLibrariesStore
} from '../../stores/shared-libraries';
import { usePlayFromDrive } from '../../composables/use-play-from-drive';
import { useSyncStore } from '../../stores/sync';
import { formatAgo } from '../../utils';

// Library → Shared Libraries (#578, owner decision 3): one section per
// attached library, its titles from the drive's snapshot. Copy to this PC (per
// title) and Import all (per library) open the import dialog (#579), while
// the drive is connected. Each section header is the library's
// management row (#581): availability, Last seen, a badge, Last sync, and the
// ⋯ menu. Sync now and the status line are the merge's (#584); the review
// sheet and the read-only history links are #585's.
// Strings from the drive are rendered as text only.
defineProps<{ starredIds: ReadonlySet<number> }>();
const emit = defineEmits<{ toggleStar: [anime: AnimeSearchResult] }>();

const libraryStore = useLibraryStore();
const shared = useSharedLibrariesStore();
const { libraries, ffmpegAvailable, syncStatus, syncing } = storeToRefs(shared);
const sync = useSyncStore();
const { conflictCount } = storeToRefs(sync);
const { play } = usePlayFromDrive();
const error = ref('');
// The import dialog: one title (Copy to this PC) or every title (Import all).
const copying = ref<{ libraryId: string; animeIds: number[] | null } | null>(null);

const ROLE_NOTE: Partial<Record<AttachedLibraryRole, string>> = {
  foreign: 'Owned by someone else: used as videos only, its watch state is ignored.',
  claim: 'Used on this PC as its owner.'
};

async function playTitle(lib: AttachedLibraryInfo, title: AttachedLibraryTitle): Promise<void> {
  const target = shared.playTarget(title);
  if (!target || !lib.available) return;
  error.value = (await play(lib.libraryId, title.animeId, target)) ?? '';
}

/** Why Play is off, or undefined when it plays (#582: an unplugged drive first). */
function playBlockedTitle(
  lib: AttachedLibraryInfo,
  title: AttachedLibraryTitle
): string | undefined {
  if (!lib.available) return notConnectedTitle(lib);
  return shared.playTarget(title) ? undefined : FFMPEG_MISSING_REASON;
}
</script>

<template>
  <div class="shared-tab" data-testid="shared-libraries-tab">
    <p v-if="libraries.length === 0" class="status-text">No Shared Library is open.</p>
    <header v-else class="tab-head" data-testid="shared-tab-head">
      <button
        class="sl-btn"
        data-testid="sync-now"
        :disabled="syncing.includes('all')"
        title="Merge watch state with every connected library you own or use as its owner, then Shikimori"
        @click="shared.syncNow()"
      >
        {{ syncing.includes('all') ? 'Syncing…' : 'Sync now' }}
      </button>
      <button
        v-if="conflictCount > 0"
        class="sl-btn"
        data-testid="review-conflicts"
        @click="sync.openReview()"
      >
        Needs your input<span class="tab-badge">{{ conflictCount }}</span>
      </button>
      <button class="sl-btn" data-testid="sync-history-all" @click="sync.openHistory()">
        Sync history
      </button>
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
        <span
          v-if="lib.access === 'read-only'"
          class="sl-badge"
          data-testid="read-only-badge"
          :data-reason="lib.accessReason"
          :title="readOnlyTitle(lib)"
          >{{ READ_ONLY_BADGE }}</span
        >
        <span v-if="!lib.available" class="sl-muted" data-testid="last-seen"
          >Last seen {{ formatAgo(lib.lastSeenAt) }}</span
        >
        <span class="sl-muted" data-testid="last-sync"
          >Last sync: {{ lastSyncWhen(lib.lastSyncAt) }}</span
        >
        <span
          v-if="syncStatusText(syncStatus.libraries[lib.libraryId])"
          class="sl-muted"
          data-testid="sync-status"
          >{{ syncStatusText(syncStatus.libraries[lib.libraryId]) }}</span
        >
        <button
          class="link-btn"
          data-testid="library-sync-history"
          @click="sync.openHistory(lib.libraryId)"
        >
          Sync history
        </button>
        <div class="grow"></div>
        <button
          class="sl-btn"
          data-testid="import-all"
          :disabled="!lib.available || lib.titles.length === 0"
          :title="
            lib.available ? 'Copy every title of this library to this PC' : notConnectedTitle(lib)
          "
          @click="copying = { libraryId: lib.libraryId, animeIds: null }"
        >
          Import all
        </button>
        <LibraryActionsMenu :library="lib" @error="error = $event" />
      </header>
      <p v-if="ROLE_NOTE[lib.role]" class="sl-muted">{{ ROLE_NOTE[lib.role] }}</p>
      <p v-if="lib.message" class="sl-warn" data-testid="read-only-message">{{ lib.message }}</p>
      <p v-if="lib.pathOverflow > 0" class="sl-warn" data-testid="path-overflow">
        {{ pathOverflowText(lib.pathOverflow) }}
      </p>
      <FfmpegMissingBanner v-if="!ffmpegAvailable && lib.mkvCount > 0" :mkv-count="lib.mkvCount" />
      <p v-if="!lib.available" class="sl-muted" data-testid="not-connected-note">
        {{ DRIVE_NOT_CONNECTED }}: this library's folder can't be read right now.
      </p>

      <div v-if="lib.titles.length > 0" class="poster-grid">
        <div
          v-for="title in lib.titles"
          :key="title.animeId"
          class="card-wrap"
          data-testid="drive-title"
          :data-available="lib.available"
        >
          <AnimeCard
            :anime="title.anime"
            :starred="starredIds.has(title.animeId)"
            :unavailable="!lib.available"
            :unavailable-title="notConnectedTitle(lib)"
            @toggle-star="emit('toggleStar', $event)"
            @click="libraryStore.openAnime(title.animeId)"
          />
          <span v-if="title.onThisPc" class="on-pc-badge" data-testid="on-this-pc">On this PC</span>
          <div class="card-actions">
            <span v-if="title.rate" class="sl-muted rate-line" data-testid="drive-title-rate">{{
              rateText(title.rate)
            }}</span>
            <button
              class="sl-btn primary"
              data-testid="play-from-drive"
              :disabled="!lib.available || !shared.playTarget(title)"
              :title="playBlockedTitle(lib, title)"
              @click.stop="playTitle(lib, title)"
            >
              Play from drive
            </button>
            <button
              class="sl-btn"
              data-testid="copy-to-pc"
              :disabled="!lib.available"
              :title="lib.available ? undefined : notConnectedTitle(lib)"
              @click.stop="copying = { libraryId: lib.libraryId, animeIds: [title.animeId] }"
            >
              Copy to this PC
            </button>
          </div>
        </div>
      </div>
    </section>
    <ImportDialog
      v-if="copying"
      :library-id="copying.libraryId"
      :anime-ids="copying.animeIds"
      @close="copying = null"
    />
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

.link-btn {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}

.link-btn:hover {
  text-decoration: underline;
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

.rate-line {
  font-size: 0.75rem;
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
