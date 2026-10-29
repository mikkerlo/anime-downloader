<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import {
  DRIVE_NOT_CONNECTED,
  FFMPEG_MISSING_REASON,
  notConnectedTitle,
  useSharedLibrariesStore
} from '../../stores/shared-libraries';
import { usePlayFromDrive } from '../../composables/use-play-from-drive';

// One attached library's episodes of a title (#578), with Play from drive. The
// detail page's attached form lists all of them; a local title's page lists
// only the episodes this PC doesn't have (`exclude`), as "On <library>".
const props = defineProps<{ title: AttachedTitleDetail; exclude?: ReadonlySet<string> }>();

const shared = useSharedLibrariesStore();
const { ffmpegAvailable } = storeToRefs(shared);
const { play } = usePlayFromDrive();
const error = ref('');

const episodes = computed(() =>
  props.title.episodes.filter((e) => !props.exclude?.has(e.episodeInt))
);
// An unplugged drive's episodes still list, from the snapshot, with Play off (#582).
const library = computed(() => shared.libraries.find((l) => l.libraryId === props.title.libraryId));
const unplugged = computed(() => library.value?.available === false);

function blockedTitle(item: AttachedTitleItem): string | undefined {
  if (unplugged.value && library.value) return notConnectedTitle(library.value);
  return item.container === 'mkv' && !ffmpegAvailable.value ? FFMPEG_MISSING_REASON : undefined;
}

async function playItem(ep: AttachedTitleEpisode, item: AttachedTitleItem): Promise<void> {
  if (unplugged.value) return;
  error.value =
    (await play(
      props.title.libraryId,
      props.title.animeId,
      { episodeInt: ep.episodeInt, translationId: item.translationId },
      props.title
    )) ?? '';
}
</script>

<template>
  <section v-if="episodes.length > 0" class="drive-episodes" data-testid="drive-episodes">
    <div class="section-head">
      <h3>On {{ title.libraryName }}</h3>
      <span class="sl-muted">{{ episodes.length }} on the drive</span>
      <span v-if="unplugged" class="sl-badge" data-testid="drive-episodes-unplugged">{{
        DRIVE_NOT_CONNECTED
      }}</span>
    </div>
    <p v-if="error" class="sl-error">{{ error }}</p>
    <div v-for="ep in episodes" :key="ep.episodeInt" class="drive-row">
      <span class="ep-label">{{ ep.episodeFull }}</span>
      <div class="ep-items">
        <div v-for="item in ep.items" :key="item.translationId" class="ep-item">
          <span class="sl-muted">
            {{ item.author }} · {{ item.quality }}p · {{ item.container.toUpperCase() }}
          </span>
          <button
            class="sl-btn primary"
            data-testid="play-episode-from-drive"
            :disabled="unplugged || (item.container === 'mkv' && !ffmpegAvailable)"
            :title="blockedTitle(item)"
            @click="playItem(ep, item)"
          >
            Play from drive
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped src="./shared-library.css"></style>

<style scoped>
.drive-episodes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 18px;
}

.section-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.section-head h3 {
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 700;
}

.drive-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
}

.ep-label {
  min-width: 110px;
  font-weight: 600;
  font-size: 0.86rem;
}

.ep-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.ep-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
</style>
