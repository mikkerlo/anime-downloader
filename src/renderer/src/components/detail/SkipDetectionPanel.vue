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
  <div class="skip-panel">
    <div class="skip-header" @click="skipPanelCollapsed = !skipPanelCollapsed">
      <div class="skip-header-left">
        <svg
          class="skip-chevron"
          :class="{ collapsed: skipPanelCollapsed }"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          width="14"
          height="14"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
        </svg>
        <span class="skip-label">Skip Detection (experimental)</span>
      </div>
      <span v-if="skipAnalyzing" class="skip-summary">{{ skipProgressLabel }}</span>
      <span v-else-if="skipDetections" class="skip-summary">
        {{ Object.keys(skipDetections.perEpisode).length }} episodes analyzed
      </span>
      <span v-else class="skip-summary">{{ skipEpisodeInputs.length }} downloaded</span>
    </div>
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
  </div>
</template>

<style scoped>
.skip-panel {
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 20px;
}

.skip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}

.skip-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.skip-chevron {
  color: #a0a0b8;
  transition: transform 0.15s;
}

.skip-chevron.collapsed {
  transform: rotate(-90deg);
}

.skip-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #a0a0b8;
}

.skip-summary {
  font-size: 0.8rem;
  color: #6a6a8a;
}

.skip-body {
  margin-top: 10px;
}

.skip-disabled {
  font-size: 0.85rem;
  color: #6a6a8a;
  font-style: italic;
}

.skip-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.skip-button {
  background-color: #0f3460;
  color: #e0e0e0;
  border: 1px solid #1f4980;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background-color 0.1s;
}

.skip-button:hover {
  background-color: #1a4880;
}

.skip-button-cancel {
  background-color: #5a2222;
  border-color: #803030;
}

.skip-button-cancel:hover {
  background-color: #803030;
}

.skip-progress-text {
  font-size: 0.8rem;
  color: #a0a0b8;
}

.skip-error {
  font-size: 0.8rem;
  color: #ff6a6a;
  margin-bottom: 10px;
}

.skip-results-meta {
  font-size: 0.75rem;
  color: #6a6a8a;
  margin-bottom: 8px;
}

.skip-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}

.skip-table th {
  text-align: left;
  padding: 4px 8px;
  color: #a0a0b8;
  font-weight: 600;
  border-bottom: 1px solid #0f3460;
}

.skip-table td {
  padding: 4px 8px;
  color: #d0d0e0;
  border-bottom: 1px solid #1a2a4d;
}

.skip-table tr:last-child td {
  border-bottom: none;
}

.skip-pair-count {
  color: #6a6a8a;
  font-size: 0.7rem;
  margin-left: 4px;
}

.skip-empty {
  color: #4a4a6a;
}
</style>
