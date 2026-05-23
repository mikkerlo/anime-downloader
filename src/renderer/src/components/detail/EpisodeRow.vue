<script setup lang="ts">
import { inject } from 'vue';
import { formatSpeed, formatEta } from '../../utils';
import { TRANSLATION_TYPES, typeChip } from './translation-types';
import { EpisodeListKey, EpisodeDownloadsKey } from './keys';
import type { EpisodeRow } from '../../composables/use-episode-list';

const props = defineProps<{
  row: EpisodeRow;
  playerMode: 'system' | 'builtin';
  translationType: string;
}>();

const list = inject(EpisodeListKey);
if (!list) throw new Error('EpisodeRow: missing EpisodeListKey injection');
const downloads = inject(EpisodeDownloadsKey);
if (!downloads) throw new Error('EpisodeRow: missing EpisodeDownloadsKey injection');

const { getRealHeight, qualityLabel, onEpisodeTranslationChange } = list;
const {
  getGroup,
  dlProgress,
  getFileForTranslation,
  hasAnyFile,
  selectedTrHasFile,
  isEpisodeWatched,
  episodeProgressPercent,
  openFile,
  showInFolder,
  deleteFile,
  playStream,
  downloadEpisode,
  cancelEpisodeDownload
} = downloads;
</script>

<template>
  <div :data-ep-int="props.row.episode.episodeInt" class="episode-row">
    <span class="ep-name">{{ props.row.episode.episodeFull }}</span>
    <template v-if="props.row.isLocked">
      <span class="ep-author locked">
        {{ props.row.selectedTr?.authorsSummary || 'Unknown' }}
        <span class="lock-label">Queued</span>
      </span>
    </template>
    <template v-else-if="props.row.allTranslations.length > 0">
      <select
        class="ep-select"
        :value="props.row.selectedTr?.id || ''"
        @change="
          onEpisodeTranslationChange(
            props.row.episode.id,
            props.row.episode.episodeInt,
            Number(($event.target as HTMLSelectElement).value)
          )
        "
      >
        <!-- Show selected type first, then the rest. Filter the leading
             `find` result to handle a corrupted/stale translationType
             setting — `!` would bypass TypeScript but crash at runtime
             once Vue read `.value` on undefined. -->
        <template
          v-for="type in [
            TRANSLATION_TYPES.find((t) => t.value === props.translationType),
            ...TRANSLATION_TYPES.filter((t) => t.value !== props.translationType)
          ].filter(Boolean) as typeof TRANSLATION_TYPES"
          :key="type.value"
        >
          <optgroup
            v-if="props.row.allTranslations.some((tr) => tr.type === type.value)"
            :label="type.label"
          >
            <option
              v-for="tr in props.row.allTranslations
                .filter((t) => t.type === type.value)
                .sort((a, b) => getRealHeight(b) - getRealHeight(a))"
              :key="tr.id"
              :value="tr.id"
            >
              {{ props.row.downloadedTrIds.has(tr.id) ? '⬇ ' : '' }}{{ tr.authorsSummary }} ({{
                qualityLabel(getRealHeight(tr))
              }})
            </option>
          </optgroup>
        </template>
      </select>
    </template>
    <span v-else class="ep-missing">No translation</span>
    <!-- Download / merge status -->
    <div
      v-if="getGroup(props.row.episode.episodeFull)?.mergeStatus === 'merging'"
      class="ep-dl-status merging"
    >
      Merging
      {{
        getGroup(props.row.episode.episodeFull)?.mergePercent != null
          ? getGroup(props.row.episode.episodeFull)?.mergePercent + '%'
          : '...'
      }}
    </div>
    <div
      v-else-if="getGroup(props.row.episode.episodeFull)?.mergeStatus === 'failed'"
      class="ep-dl-status merge-failed"
    >
      Merge failed
    </div>
    <div
      v-else-if="getGroup(props.row.episode.episodeFull)?.video?.status === 'downloading'"
      class="ep-dl-status"
    >
      <div class="ep-progress-wrap">
        <div
          class="ep-progress-bar"
          :style="{ width: dlProgress(getGroup(props.row.episode.episodeFull)!.video) + '%' }"
        ></div>
      </div>
      <span class="ep-dl-text">{{
        formatSpeed(getGroup(props.row.episode.episodeFull)!.video!.speed)
      }}</span>
      <span class="ep-dl-text"
        >ETA {{ formatEta(getGroup(props.row.episode.episodeFull)!.video!) }}</span
      >
    </div>
    <div
      v-else-if="getGroup(props.row.episode.episodeFull)?.video?.status === 'queued'"
      class="ep-dl-status queued"
    >
      Queued
    </div>
    <div
      v-else-if="getGroup(props.row.episode.episodeFull)?.video?.status === 'paused'"
      class="ep-dl-status paused"
    >
      Paused ({{ Math.round(dlProgress(getGroup(props.row.episode.episodeFull)!.video)) }}%)
    </div>
    <div
      v-else-if="getGroup(props.row.episode.episodeFull)?.video?.status === 'failed'"
      class="ep-dl-status failed"
    >
      Failed
    </div>
    <div class="ep-right">
      <span
        v-if="isEpisodeWatched(props.row.episode.episodeInt)"
        class="watched-badge"
        title="Watched"
        >✓</span
      >
      <span
        v-else-if="episodeProgressPercent(props.row.episode.episodeInt) > 0"
        class="watch-progress-badge"
        :title="`Watched ${episodeProgressPercent(props.row.episode.episodeInt)}%`"
      >
        {{ episodeProgressPercent(props.row.episode.episodeInt) }}%
      </span>
      <span
        v-if="props.row.selectedTr"
        class="type-chip"
        :style="{
          backgroundColor: typeChip(props.row.selectedTr.type).color + '22',
          color: typeChip(props.row.selectedTr.type).color
        }"
        >{{ typeChip(props.row.selectedTr.type).short }}</span
      >
      <span
        v-if="props.row.selectedTr"
        class="quality-badge"
        :class="{ hd: getRealHeight(props.row.selectedTr) >= 1080 }"
        >{{ qualityLabel(getRealHeight(props.row.selectedTr)) }}</span
      >
      <template v-if="selectedTrHasFile(props.row)">
        <span class="file-type-badge">{{
          getFileForTranslation(
            props.row.episode.episodeInt,
            props.row.selectedTr?.id
          )?.type.toUpperCase()
        }}</span>
      </template>
      <template v-else-if="hasAnyFile(props.row.episode.episodeInt)">
        <span class="file-type-badge other-dl">⬇</span>
      </template>
    </div>
    <div class="ep-links">
      <template v-if="selectedTrHasFile(props.row)">
        <button class="link-btn open" @click="openFile(props.row)" title="Open file">Open</button>
        <button class="link-btn folder" @click="showInFolder(props.row)" title="Show in folder">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="14"
            height="14"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M2 7.5V18a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-6.5l-2-2.5H4a2 2 0 00-2 2z"
            />
          </svg>
        </button>
        <button class="link-btn delete" @click="deleteFile(props.row)" title="Delete file">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="14"
            height="14"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </button>
      </template>
      <button
        v-if="
          getGroup(props.row.episode.episodeFull) &&
          (!['completed', 'cancelled'].includes(
            getGroup(props.row.episode.episodeFull)?.video?.status || ''
          ) ||
            getGroup(props.row.episode.episodeFull)?.mergeStatus === 'merging')
        "
        class="link-btn cancel"
        @click="cancelEpisodeDownload(props.row.episode.episodeFull)"
        title="Cancel"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          width="14"
          height="14"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <button
        v-if="
          props.playerMode === 'builtin' && props.row.selectedTr && !selectedTrHasFile(props.row)
        "
        class="link-btn play"
        @click="playStream(props.row)"
        title="Play (stream)"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
      <button
        v-if="props.row.selectedTr && !props.row.isLocked && !selectedTrHasFile(props.row)"
        class="link-btn dl"
        @click="downloadEpisode(props.row)"
        title="Download this episode"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          width="14"
          height="14"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M2 19.5h20M12 2v14m0 0l-4-4m4 4l4-4"
          />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.episode-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 14px;
  background-color: #16213e;
  border-radius: 6px;
}

.ep-name {
  font-size: 0.9rem;
  color: #e0e0e0;
  min-width: 100px;
}

.ep-author {
  flex: 1;
  font-size: 0.8rem;
  color: #6a6a8a;
}

.ep-author.locked {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lock-label {
  font-size: 0.65rem;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 4px;
  background-color: #0f3460;
  color: #3498db;
  flex-shrink: 0;
  height: 20px;
  display: inline-flex;
  align-items: center;
  line-height: 1;
}

.ep-select {
  padding: 4px 8px;
  background-color: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 0.8rem;
  outline: none;
  min-width: 150px;
  max-width: 300px;
  flex: 1;
}

.ep-select:focus {
  border-color: #e94560;
}

.ep-missing {
  flex: 1;
  font-size: 0.8rem;
  color: #e94560;
  opacity: 0.6;
}

.ep-right {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
}

.type-chip,
.quality-badge,
.file-type-badge {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 0.65rem;
  font-weight: 700;
  flex-shrink: 0;
  line-height: 1;
  height: 20px;
  display: inline-flex;
  align-items: center;
}

.type-chip {
  letter-spacing: 0.3px;
}

.watched-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background-color: rgba(106, 176, 76, 0.2);
  color: #6ab04c;
  font-size: 0.75rem;
  font-weight: 700;
  flex-shrink: 0;
}

.watch-progress-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 4px;
  background-color: rgba(233, 69, 96, 0.15);
  color: #e94560;
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
  height: 20px;
  flex-shrink: 0;
}

.quality-badge {
  background-color: #0f3460;
  color: #6a6a8a;
}

.quality-badge.hd {
  background-color: #1a4a2e;
  color: #6ab04c;
}

.ep-links {
  display: flex;
  gap: 6px;
}

.link-btn {
  padding: 4px 12px;
  background-color: #0f3460;
  border-radius: 4px;
  color: #e94560;
  font-size: 0.75rem;
  text-decoration: none;
  font-weight: 600;
  transition: background-color 0.15s;
}

.link-btn:hover {
  background-color: #1a4a7a;
}

.link-btn.play {
  color: #e94560;
  cursor: pointer;
  border: none;
  font-weight: 600;
  font-size: 0.75rem;
}

.link-btn.dl {
  color: #3498db;
  cursor: pointer;
  border: none;
  font-weight: 600;
  font-size: 0.75rem;
}

.link-btn.open {
  color: #6ab04c;
  cursor: pointer;
  border: none;
  font-weight: 600;
  font-size: 0.75rem;
}

.link-btn.folder {
  color: #f0932b;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
}

.link-btn.delete {
  color: #e94560;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
}

.link-btn.cancel {
  color: #f39c12;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
}

.ep-dl-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.7rem;
  color: #3498db;
  min-width: 120px;
  flex-shrink: 0;
}

.ep-dl-status.queued {
  color: #6a6a8a;
}

.ep-dl-status.paused {
  color: #f39c12;
}

.ep-dl-status.failed {
  color: #e94560;
}

.ep-dl-status.merging {
  color: #f39c12;
  font-weight: 600;
}

.ep-dl-status.merge-failed {
  color: #e94560;
}

.ep-progress-wrap {
  flex: 1;
  height: 4px;
  background-color: #0f3460;
  border-radius: 2px;
  overflow: hidden;
  min-width: 50px;
}

.ep-progress-bar {
  height: 100%;
  background-color: #3498db;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.ep-dl-text {
  font-size: 0.65rem;
  color: #6a6a8a;
  white-space: nowrap;
}

.file-type-badge {
  background-color: #1a4a2e;
  color: #6ab04c;
}

.file-type-badge.other-dl {
  background-color: #0f3460;
  color: #3498db;
  font-size: 0.7rem;
}
</style>
