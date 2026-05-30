<script setup lang="ts">
import { inject } from 'vue';
import { SkipDetectionKey } from './keys';

const props = defineProps<{
  filteredEpisodes: EpisodeSummary[];
}>();

const skip = inject(SkipDetectionKey);
if (!skip) throw new Error('SkipDetectionPanel: missing SkipDetectionKey injection');

const {
  skipPanelCollapsed,
  skipDetections,
  skipAnalyzing,
  skipError,
  chapterInjecting,
  chapterInjectError,
  chapterInjectResult,
  skipEpisodeInputs,
  skipMkvEpisodeCount,
  skipProgressLabel,
  chapterInjectProgressLabel,
  formatSkipTime,
  runSkipAnalysis,
  cancelSkipAnalysis,
  injectChaptersToMkv
} = skip;
</script>

<template>
  <section class="skip-panel">
    <button class="skip-head" @click="skipPanelCollapsed = !skipPanelCollapsed">
      <svg class="skip-ico" viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
        <path
          d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653zM19.5 5.25a.75.75 0 01.75.75v12a.75.75 0 01-1.5 0V6a.75.75 0 01.75-.75z"
        />
      </svg>
      <h3>Skip detection</h3>
      <span class="muted">
        {{
          skipAnalyzing
            ? skipProgressLabel
            : skipDetections
              ? `${Object.keys(skipDetections.perEpisode).length} episodes analyzed`
              : `${skipEpisodeInputs.length} downloaded`
        }}
      </span>
      <span class="grow"></span>
      <svg
        class="skip-chevron"
        :class="{ open: !skipPanelCollapsed }"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        width="18"
        height="18"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
      </svg>
    </button>
    <div v-if="!skipPanelCollapsed" class="skip-body">
      <div v-if="skipEpisodeInputs.length < 2" class="skip-disabled">
        Need at least 2 downloaded episodes to analyze. Currently downloaded:
        {{ skipEpisodeInputs.length }}.
      </div>
      <template v-else>
        <div class="skip-actions">
          <button v-if="!skipAnalyzing" class="skip-button" @click="runSkipAnalysis">
            {{ skipDetections ? 'Re-analyze' : `Analyze ${skipEpisodeInputs.length} episodes` }}
          </button>
          <button v-else class="skip-button skip-button-cancel" @click="cancelSkipAnalysis">
            Cancel
          </button>
          <span v-if="skipAnalyzing" class="skip-progress-text">{{ skipProgressLabel }}</span>
          <button
            v-if="skipMkvEpisodeCount >= 3"
            class="skip-button"
            :disabled="chapterInjecting || skipAnalyzing"
            @click="injectChaptersToMkv"
          >
            {{ chapterInjecting ? 'Saving chapters…' : 'Save chapters to MKV' }}
          </button>
          <span v-if="chapterInjecting" class="skip-progress-text">{{
            chapterInjectProgressLabel
          }}</span>
        </div>
        <div v-if="skipError" class="skip-error">{{ skipError }}</div>
        <div v-if="chapterInjectError" class="skip-error">{{ chapterInjectError }}</div>
        <div v-if="chapterInjectResult" class="skip-results-meta">
          Wrote chapters to {{ chapterInjectResult.written }}/{{ chapterInjectResult.total }}
          episodes
          <template v-if="chapterInjectResult.skipped">
            · {{ chapterInjectResult.skipped }} skipped (no detection)
          </template>
          <template v-if="chapterInjectResult.failed">
            · {{ chapterInjectResult.failed }} failed
          </template>
        </div>
        <div v-if="skipDetections" class="skip-results">
          <div class="skip-results-meta">
            Analyzed {{ new Date(skipDetections.analyzedAt).toLocaleString() }} · window
            {{ skipDetections.algorithm.windowSec }}s · min run
            {{ skipDetections.algorithm.minRunSec }}s · threshold
            {{ skipDetections.algorithm.matchBitThreshold }}/32 bits
          </div>
          <table class="skip-table">
            <thead>
              <tr>
                <th>Episode</th>
                <th>OP</th>
                <th>ED</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="ep in props.filteredEpisodes" :key="ep.episodeInt">
                <template v-if="skipDetections.perEpisode[ep.episodeInt]">
                  <td>{{ ep.episodeFull || `Episode ${ep.episodeInt}` }}</td>
                  <td>
                    <template v-if="skipDetections.perEpisode[ep.episodeInt].op">
                      {{ formatSkipTime(skipDetections.perEpisode[ep.episodeInt].op!.startSec) }}–{{
                        formatSkipTime(skipDetections.perEpisode[ep.episodeInt].op!.endSec)
                      }}
                      <span class="skip-pair-count"
                        >({{ skipDetections.perEpisode[ep.episodeInt].op!.pairCount }} pairs)</span
                      >
                    </template>
                    <span v-else class="skip-empty">—</span>
                  </td>
                  <td>
                    <template v-if="skipDetections.perEpisode[ep.episodeInt].ed">
                      {{ formatSkipTime(skipDetections.perEpisode[ep.episodeInt].ed!.startSec) }}–{{
                        formatSkipTime(skipDetections.perEpisode[ep.episodeInt].ed!.endSec)
                      }}
                      <span class="skip-pair-count"
                        >({{ skipDetections.perEpisode[ep.episodeInt].ed!.pairCount }} pairs)</span
                      >
                    </template>
                    <span v-else class="skip-empty">—</span>
                  </td>
                  <td>
                    {{ formatSkipTime(skipDetections.perEpisode[ep.episodeInt].durationSec) }}
                  </td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.skip-panel {
  margin-top: 26px;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  overflow: hidden;
}

.skip-head {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 16px 18px;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}

.skip-head:hover {
  background: var(--surface-2);
}

.skip-head .skip-ico {
  color: var(--accent);
  flex-shrink: 0;
}

.skip-head h3 {
  font-family: var(--font-display);
  font-size: 1.04rem;
  font-weight: 700;
  color: var(--text);
  flex-shrink: 0;
}

.skip-head .muted {
  font-size: 0.8rem;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.skip-head .grow {
  flex: 1;
}

.skip-chevron {
  color: var(--text-3);
  flex-shrink: 0;
  transition: transform 0.2s var(--ease);
}

.skip-chevron.open {
  transform: rotate(180deg);
}

.skip-body {
  padding: 4px 18px 18px;
  border-top: 1px solid var(--border-soft);
}

.skip-disabled {
  padding: 18px 0 6px;
  font-size: 0.85rem;
  color: var(--text-3);
  line-height: 1.5;
}

.skip-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
  flex-wrap: wrap;
}

.skip-button {
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border);
  padding: 8px 14px;
  border-radius: var(--radius-btn);
  font-size: 0.84rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.skip-button:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.skip-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.skip-button-cancel {
  color: var(--st-red);
  border-color: color-mix(in srgb, var(--st-red) 40%, transparent);
}

.skip-button-cancel:hover {
  border-color: var(--st-red);
  color: var(--st-red);
}

.skip-progress-text {
  font-size: 0.8rem;
  color: var(--text-2);
  font-family: var(--font-data);
}

.skip-error {
  font-size: 0.8rem;
  color: var(--st-red);
  margin-bottom: 10px;
}

.skip-results-meta {
  font-size: 0.74rem;
  color: var(--text-3);
  margin-bottom: 10px;
  font-family: var(--font-data);
}

.skip-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}

.skip-table th {
  text-align: left;
  padding: 6px 8px;
  color: var(--text-faint);
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--border-soft);
}

.skip-table td {
  padding: 7px 8px;
  color: var(--text-2);
  font-family: var(--font-data);
  border-bottom: 1px solid var(--border-soft);
}

.skip-table tr:last-child td {
  border-bottom: none;
}

.skip-pair-count {
  color: var(--text-faint);
  font-size: 0.7rem;
  margin-left: 4px;
}

.skip-empty {
  color: var(--text-faint);
}
</style>
