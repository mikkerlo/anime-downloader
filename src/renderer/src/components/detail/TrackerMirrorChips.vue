<script setup lang="ts">
// The mirrors' chips under the primary's rate panel (#705): one per connected
// tracker that isn't the primary, in tracker order. TrackerPanel mounts this
// only with two or more trackers connected, so a single-tracker user never
// holds the title or reads it per tracker.
//
// - The values are the store's `rateFor` (the mirror's cache with its last
//   queued `after`); the total is its entry's `anime.episodes`, else the page's.
// - `stale`, `queued`, `unmapped` and `differs` are main's, from the held
//   title's `tracker:get-rate` result. Nothing here evaluates a difference:
//   "Copy from primary" shows exactly when `differs` is non-empty.
// - "Session expired" and "Needs setup" come from that tracker's sync status
//   and link to its Settings → Trackers card.
import { computed, onScopeDispose, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { TRACKER_LABELS } from '@shared/trackers/labels';
import { TRACKER_BADGES } from '@shared/trackers/title-links';
import { useTrackersStore } from '../../stores/trackers';
import { useLibraryStore } from '../../stores/library';

const props = defineProps<{
  anime: AnimeDetail;
}>();

const trackers = useTrackersStore();
const { connected, primary } = storeToRefs(trackers);
const library = useLibraryStore();

const malId = computed(() => props.anime.myAnimeListId || null);

let release: (() => void) | null = null;
watch(
  malId,
  (id) => {
    release?.();
    release = id ? trackers.holdTitle(id) : null;
  },
  { immediate: true }
);
onScopeDispose(() => release?.());

const STATUS_LABELS: Record<ShikiUserRateStatus, string> = {
  planned: 'Planned',
  watching: 'Watching',
  rewatching: 'Rewatching',
  completed: 'Completed',
  on_hold: 'On Hold',
  dropped: 'Dropped'
};

const FIELD_LABELS: Record<SyncRateField, string> = {
  status: 'status',
  episodes: 'episodes',
  score: 'score',
  rewatches: 'rewatches'
};

interface MirrorChip {
  trackerId: TrackerId;
  label: string;
  badge: string;
  values: TrackerRateValues | null;
  total: number | null;
  stale: boolean;
  queued: boolean;
  unmapped: boolean;
  differs: SyncRateField[];
  expired: boolean;
  needsSetup: boolean;
  mirroring: boolean;
}

const chips = computed<MirrorChip[]>(() => {
  const id = malId.value;
  if (!id) return [];
  return connected.value
    .filter((t) => t !== primary.value)
    .map((t) => {
      const result = trackers.rateStateFor(t, id);
      const status = trackers.syncStatusFor(t);
      const listed = trackers.ratesByTracker[t]?.find((e) => e.malId === id);
      return {
        trackerId: t,
        label: TRACKER_LABELS[t],
        badge: TRACKER_BADGES[t],
        values: trackers.rateFor(t, id) ?? result?.values ?? null,
        total: listed?.anime.episodes || props.anime.numberOfEpisodes || null,
        stale: result?.stale === true,
        queued: result?.queued === true,
        unmapped: result?.unmapped === true,
        differs: result?.differs ?? [],
        expired: status.sessionExpired,
        needsSetup: status.needsSetup,
        mirroring: trackers.mirrorOn(t)
      };
    });
});

function valuesText(c: MirrorChip): string {
  if (c.unmapped) return `Not on ${c.label}`;
  const v = c.values;
  if (!v) return 'Not in list';
  const eps = c.total ? `${v.episodes}/${c.total}` : `${v.episodes}`;
  return `${STATUS_LABELS[v.status]} · ${eps} · ★ ${v.score > 0 ? v.score : '–'}`;
}

function differsTitle(c: MirrorChip): string {
  const from = primary.value ? TRACKER_LABELS[primary.value] : 'the primary';
  return `Differs from ${from}: ${c.differs.map((f) => FIELD_LABELS[f]).join(', ')}`;
}

const copying = ref<Partial<Record<TrackerId, boolean>>>({});
const copyError = ref<Partial<Record<TrackerId, string>>>({});

async function copy(t: TrackerId): Promise<void> {
  const id = malId.value;
  if (!id || copying.value[t]) return;
  copying.value = { ...copying.value, [t]: true };
  copyError.value = { ...copyError.value, [t]: '' };
  try {
    await trackers.copyFromPrimary(t, id);
  } catch (err) {
    copyError.value = {
      ...copyError.value,
      [t]: err instanceof Error ? err.message : String(err)
    };
  } finally {
    copying.value = { ...copying.value, [t]: false };
  }
}

function openSettings(t: TrackerId): void {
  library.navigateToSettingsTab('trackers', t);
}
</script>

<template>
  <div v-if="chips.length" class="mirror-chips" data-testid="mirror-chips">
    <div
      v-for="c in chips"
      :key="c.trackerId"
      class="mirror-chip"
      :class="{ 'mirror-chip-warn': c.differs.length > 0 }"
      :data-testid="`mirror-chip-${c.trackerId}`"
      :title="c.differs.length > 0 ? differsTitle(c) : undefined"
    >
      <div class="mc-row">
        <span class="mc-badge" :title="c.label">{{ c.badge }}</span>
        <span class="mc-values" :class="{ 'mc-unmapped': c.unmapped }">{{ valuesText(c) }}</span>
        <span class="mc-icons">
          <span
            v-if="c.queued"
            class="mc-icon"
            data-testid="mc-queued"
            :title="`Waiting to sync to ${c.label}`"
            :aria-label="`Waiting to sync to ${c.label}`"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="12"
              height="12"
            >
              <circle cx="12" cy="12" r="9" />
              <path stroke-linecap="round" d="M12 7v5l3 2" />
            </svg>
          </span>
          <span
            v-if="c.stale"
            class="mc-icon"
            data-testid="mc-stale"
            :title="`Saved values: ${c.label} couldn't be reached`"
            :aria-label="`Saved values: ${c.label} couldn't be reached`"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="12"
              height="12"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M3 3l18 18M12 5a7 7 0 016.95 6.155A4 4 0 0118 19H9m-3-2a4 4 0 01-1.9-7.516"
              />
            </svg>
          </span>
          <button
            v-if="c.expired"
            type="button"
            class="mc-icon mc-icon-btn mc-alert"
            data-testid="mc-expired"
            :title="`${c.label} session expired: sign in again`"
            :aria-label="`${c.label} session expired: sign in again`"
            @click="openSettings(c.trackerId)"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="12"
              height="12"
            >
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path stroke-linecap="round" d="M8 11V8a4 4 0 018 0v3" />
            </svg>
          </button>
          <button
            v-else-if="c.needsSetup"
            type="button"
            class="mc-icon mc-icon-btn mc-alert"
            data-testid="mc-needs-setup"
            :title="`${c.label} needs setup`"
            :aria-label="`${c.label} needs setup`"
            @click="openSettings(c.trackerId)"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              width="12"
              height="12"
            >
              <path stroke-linecap="round" d="M12 8v5M12 16.5v.01" />
              <path
                stroke-linejoin="round"
                d="M10.3 3.9L2.5 18a2 2 0 001.7 3h15.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"
              />
            </svg>
          </button>
        </span>
      </div>
      <div v-if="!c.mirroring || c.differs.length > 0" class="mc-row mc-sub">
        <span
          v-if="!c.mirroring"
          class="mc-off"
          data-testid="mc-mirror-off"
          :title="`Changes you make aren't mirrored to ${c.label}`"
          >mirroring off</span
        >
        <button
          v-if="c.differs.length > 0"
          type="button"
          class="mc-copy"
          data-testid="mc-copy"
          :disabled="copying[c.trackerId] === true"
          @click="copy(c.trackerId)"
        >
          Copy from primary
        </button>
      </div>
      <div
        v-if="copyError[c.trackerId]"
        class="mc-error"
        data-testid="mc-error"
        :title="copyError[c.trackerId]"
      >
        Couldn't copy to {{ c.label }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.mirror-chips {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: -6px 0 14px;
}

.mirror-chip {
  padding: 6px 8px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  font-size: 0.74rem;
  color: var(--text-2);
}

.mirror-chip-warn {
  border-color: color-mix(in srgb, var(--st-orange) 55%, transparent);
  background: color-mix(in srgb, var(--st-orange) 8%, var(--surface-2));
}

.mc-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.mc-sub {
  margin-top: 5px;
  justify-content: space-between;
}

.mc-badge {
  flex: none;
  min-width: 16px;
  padding: 0 3px;
  box-sizing: border-box;
  height: 16px;
  border-radius: 4px;
  background: var(--st-blue);
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 0.55rem;
  font-weight: 800;
}

.mc-values {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-data);
}

.mc-unmapped {
  font-family: var(--font-ui);
  color: var(--text-3);
}

.mc-icons {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.mc-icon {
  display: inline-grid;
  place-items: center;
  color: var(--text-3);
}

.mc-icon-btn {
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
}

.mc-alert {
  color: var(--st-red);
}

.mc-off {
  font-size: 0.68rem;
  color: var(--text-3);
}

.mc-copy {
  margin-left: auto;
  padding: 3px 8px;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--st-orange);
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 5px;
  cursor: pointer;
}

.mc-copy:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mc-error {
  margin-top: 4px;
  font-size: 0.7rem;
  color: var(--st-red);
}
</style>
