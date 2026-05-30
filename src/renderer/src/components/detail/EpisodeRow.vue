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
  posterUrl: string;
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
  <div
    :data-ep-int="props.row.episode.episodeInt"
    class="ep-row"
    :class="{ watched: isEpisodeWatched(props.row.episode.episodeInt) }"
  >
    <div class="ep-num">
      <svg
        v-if="isEpisodeWatched(props.row.episode.episodeInt)"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        width="18"
        height="18"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
      </svg>
      <span v-else>{{ props.row.episode.episodeInt }}</span>
    </div>

    <div class="ep-thumb">
      <img :src="posterUrl" :alt="props.row.episode.episodeFull" loading="lazy" />
      <span
        v-if="
          !isEpisodeWatched(props.row.episode.episodeInt) &&
          episodeProgressPercent(props.row.episode.episodeInt) > 0
        "
        class="ep-thumb-prog"
        :style="{ width: episodeProgressPercent(props.row.episode.episodeInt) + '%' }"
      ></span>
      <span
        v-else-if="isEpisodeWatched(props.row.episode.episodeInt)"
        class="ep-thumb-prog"
        style="width: 100%"
      ></span>
    </div>

    <div class="ep-info">
      <div class="ep-title">{{ props.row.episode.episodeFull }}</div>
      <div class="ep-sub">
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
        <span v-if="selectedTrHasFile(props.row)" class="file-type-badge">{{
          getFileForTranslation(
            props.row.episode.episodeInt,
            props.row.selectedTr?.id
          )?.type.toUpperCase()
        }}</span>
        <span v-else-if="hasAnyFile(props.row.episode.episodeInt)" class="file-type-badge other-dl"
          >⬇ on disk</span
        >
        <span
          v-if="
            !isEpisodeWatched(props.row.episode.episodeInt) &&
            episodeProgressPercent(props.row.episode.episodeInt) > 0
          "
          class="wp-badge"
          >Watched {{ episodeProgressPercent(props.row.episode.episodeInt) }}%</span
        >
      </div>
    </div>

    <div class="ep-state">
      <template v-if="props.row.isLocked">
        <span class="ep-author locked">
          {{ props.row.selectedTr?.authorsSummary || 'Unknown' }}
          <span class="lock-label">Queued</span>
        </span>
      </template>
      <div v-else-if="props.row.allTranslations.length > 0" class="select-wrap ep-tr">
        <select
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
        <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </div>
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
            : '…'
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
        class="ep-dl-status ep-dl-progress"
      >
        <div class="pbar thin">
          <span
            :style="{ width: dlProgress(getGroup(props.row.episode.episodeFull)!.video) + '%' }"
          ></span>
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

      <div class="ep-actions">
        <template v-if="selectedTrHasFile(props.row)">
          <button class="iconbtn" @click="openFile(props.row)" title="Open file">
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
          <button class="iconbtn ghost" @click="showInFolder(props.row)" title="Show in folder">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="15"
              height="15"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M2 7.5V18a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-6.5l-2-2.5H4a2 2 0 00-2 2z"
              />
            </svg>
          </button>
          <button class="iconbtn danger" @click="deleteFile(props.row)" title="Delete file">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="15"
              height="15"
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
          class="iconbtn danger"
          @click="cancelEpisodeDownload(props.row.episode.episodeFull)"
          title="Cancel"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="15"
            height="15"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <button
          v-if="
            props.playerMode === 'builtin' && props.row.selectedTr && !selectedTrHasFile(props.row)
          "
          class="iconbtn solid"
          @click="playStream(props.row)"
          title="Play (stream)"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
        <button
          v-if="props.row.selectedTr && !props.row.isLocked && !selectedTrHasFile(props.row)"
          class="iconbtn"
          @click="downloadEpisode(props.row)"
          title="Download this episode"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="15"
            height="15"
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
  </div>
</template>

<style scoped>
.ep-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: var(--row-pad) 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  transition: all 0.15s var(--ease);
}

.ep-row:hover {
  border-color: var(--border-strong);
  background: var(--surface-2);
}

.ep-row.watched {
  opacity: 0.72;
}

.ep-num {
  width: 40px;
  min-width: 40px;
  font-family: var(--font-data);
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-3);
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ep-row.watched .ep-num {
  color: var(--accent);
}

.ep-thumb {
  width: 48px;
  min-width: 48px;
  aspect-ratio: 2 / 3;
  border-radius: 6px;
  overflow: hidden;
  position: relative;
  background: var(--surface-2);
}

.ep-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.ep-thumb .ep-thumb-prog {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  background: var(--accent);
}

.ep-info {
  flex: 1;
  min-width: 0;
}

.ep-title {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ep-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 5px;
}

.type-chip,
.quality-badge,
.file-type-badge,
.wp-badge {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 7px;
  border-radius: 5px;
  font-size: 0.64rem;
  font-weight: 700;
  line-height: 1;
  flex-shrink: 0;
}

.type-chip {
  letter-spacing: 0.3px;
}

.quality-badge {
  background: var(--surface-3);
  color: var(--text-3);
}

.quality-badge.hd {
  background: color-mix(in srgb, var(--st-green) 16%, transparent);
  color: var(--st-green);
}

.file-type-badge {
  background: color-mix(in srgb, var(--st-green) 16%, transparent);
  color: var(--st-green);
}

.file-type-badge.other-dl {
  background: color-mix(in srgb, var(--st-blue) 16%, transparent);
  color: var(--st-blue);
}

.wp-badge {
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-data);
}

.ep-state {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.ep-author {
  font-size: 0.8rem;
  color: var(--text-3);
}

.ep-author.locked {
  display: flex;
  align-items: center;
  gap: 6px;
}

.lock-label {
  font-size: 0.62rem;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: var(--radius-chip);
  background: color-mix(in srgb, var(--st-blue) 16%, transparent);
  color: var(--st-blue);
  flex-shrink: 0;
}

.select-wrap.ep-tr select {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 7px 26px 7px 11px;
  background: var(--surface-2);
  max-width: 220px;
}

.select-wrap.ep-tr .caret {
  right: 9px;
}

.ep-missing {
  font-size: 0.8rem;
  color: var(--st-red);
  opacity: 0.7;
}

.ep-dl-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.72rem;
  color: var(--st-blue);
}

.ep-dl-progress {
  width: 150px;
}

.ep-dl-progress .pbar {
  flex: 1;
}

.ep-dl-progress .pbar > span {
  background: var(--st-blue);
}

.ep-dl-status.queued {
  color: var(--text-3);
}

.ep-dl-status.paused {
  color: var(--st-orange);
}

.ep-dl-status.failed,
.ep-dl-status.merge-failed {
  color: var(--st-red);
}

.ep-dl-status.merging {
  color: var(--st-orange);
  font-weight: 600;
}

.ep-dl-text {
  font-size: 0.66rem;
  color: var(--text-3);
  white-space: nowrap;
  font-family: var(--font-data);
}

.ep-actions {
  display: flex;
  gap: 8px;
}

.iconbtn {
  width: 34px;
  height: 34px;
  border-radius: var(--radius-btn);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: all 0.15s;
}

.iconbtn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.iconbtn.solid {
  background: var(--accent);
  color: var(--accent-ink);
  border-color: var(--accent);
}

.iconbtn.solid:hover {
  background: var(--accent-hover);
}

.iconbtn.ghost {
  background: transparent;
}

.iconbtn.danger:hover {
  border-color: var(--st-red);
  color: var(--st-red);
}
</style>
