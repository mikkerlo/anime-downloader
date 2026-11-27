<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { FEATURE_KEYS, isCapable, type FeatureKey } from '@shared/trackers/feature-source';
import { TRACKER_LABELS } from '@shared/trackers/labels';
import { useLibraryStore } from '../../stores/library';
import { useTrackersStore } from '../../stores/trackers';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';
import TrackerAccountCard from './TrackerAccountCard.vue';
import TrackerPrimaryDialog from './TrackerPrimaryDialog.vue';
import SettingsGroup from './SettingsGroup.vue';
import SettingsRow from './SettingsRow.vue';
import ShikimoriConnectForm from './ShikimoriConnectForm.vue';
import AniListConnectForm from './AniListConnectForm.vue';
import MalConnectForm from './MalConnectForm.vue';

// Settings → Trackers (#700): one account card per tracker, in `TrackerId`
// order. The AniList (#703) and MyAnimeList (#702) cards show only while main
// reports the new-tracker-cards flag on. With 2+ connected accounts the cards
// get the primary and mirror controls and this tab the feature sources (#701).
const libraryStore = useLibraryStore();
const trackersStore = useTrackersStore();
const { newTrackerCardsEnabled, connected, featureSources, multiAccount, primaryCapable } =
  storeToRefs(trackersStore);
const { showSaved } = useSettingsAutosave();
const root = ref<HTMLElement | null>(null);

// ---- Feature sources (#701) --------------------------------------------------
const FEATURE_LABELS: Record<FeatureKey, string> = {
  calendar: 'Calendar',
  chronology: 'Chronology',
  forYou: 'For You',
  details: 'Details',
  airing: 'Auto-download episode counts'
};

// Each feature lists the connected trackers the capability matrix allows. One
// is plain text, none hides the row. The select's value is the stored
// override while it is listed, else '' (Default).
const featureRows = computed(() =>
  FEATURE_KEYS.map((feature) => {
    const options = connected.value.filter((id) => isCapable(feature, id));
    const stored = featureSources.value[feature];
    const resolved = trackersStore.defaultFeatureSource(feature);
    return {
      feature,
      label: FEATURE_LABELS[feature],
      options,
      value: stored && options.includes(stored) ? stored : '',
      defaultLabel: resolved ? `Default (${TRACKER_LABELS[resolved]})` : 'Default'
    };
  }).filter((row) => row.options.length > 0)
);
const featureError = ref('');

async function onFeatureChange(feature: FeatureKey, e: Event): Promise<void> {
  const value = (e.target as HTMLSelectElement).value;
  featureError.value = '';
  try {
    await trackersStore.setFeatureSource(feature, value === '' ? null : (value as TrackerId));
    showSaved();
  } catch (err) {
    featureError.value = String(err);
  }
}

// ---- The primary choice after a disconnect (#701) ----------------------------
// Main already made the first remaining tracker primary; the dialog offers it
// and every other remaining tracker with a primary write path.
const primaryChoice = ref<{ candidates: TrackerId[]; interim: TrackerId } | null>(null);

function onNeedsPrimaryChoice(candidates: TrackerId[]): void {
  const interim = candidates[0];
  if (!interim) return;
  const options = candidates.filter((id) => id === interim || primaryCapable.value.includes(id));
  if (options.length >= 2) primaryChoice.value = { candidates: options, interim };
}

async function onPrimaryChosen(trackerId: TrackerId): Promise<void> {
  primaryChoice.value = null;
  try {
    await trackersStore.setPrimary(trackerId);
    showSaved();
  } catch (err) {
    console.warn('[trackers] setting the primary failed:', err);
  }
}

// A card behind the flag (AniList, MyAnimeList) renders only once the accounts
// payload says so, which can land after this tab mounted: a link to it waits
// for that payload, then scrolls.
let waitingFor: TrackerId | null = null;
watch(newTrackerCardsEnabled, (enabled) => {
  const trackerId = waitingFor;
  waitingFor = null;
  if (enabled && trackerId) void scrollToCard(trackerId);
});

async function scrollToCard(trackerId: TrackerId | null): Promise<void> {
  if (!trackerId) return;
  await nextTick();
  const card = root.value?.querySelector(`[data-tracker-id="${trackerId}"]`);
  if (!card) {
    if (!newTrackerCardsEnabled.value) waitingFor = trackerId;
    return;
  }
  card.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// A deep link ("Session expired", "Sign in again") names the card to show. The
// shell keeps this tab alive, so a link raised while it is cached creates no
// new tab: read the id on setup and watch it too.
const initialTrackerId = libraryStore.consumePendingSettingsTrackerId();
onMounted(() => void scrollToCard(initialTrackerId));
watch(
  () => libraryStore.pendingSettingsTrackerId,
  (trackerId) => {
    if (trackerId) void scrollToCard(libraryStore.consumePendingSettingsTrackerId());
  }
);
</script>

<template>
  <div ref="root">
    <TrackerAccountCard
      tracker-id="shikimori"
      desc="Connect your Shikimori account to sync watch progress."
      :connect-form="ShikimoriConnectForm"
      @needs-primary-choice="onNeedsPrimaryChoice"
    />
    <TrackerAccountCard
      v-if="newTrackerCardsEnabled"
      tracker-id="anilist"
      desc="Connect AniList to sync your list there."
      :connect-form="AniListConnectForm"
      @needs-primary-choice="onNeedsPrimaryChoice"
    />
    <TrackerAccountCard
      v-if="newTrackerCardsEnabled"
      tracker-id="mal"
      desc="Connect your MyAnimeList account through your own MyAnimeList app."
      :connect-form="MalConnectForm"
      @needs-primary-choice="onNeedsPrimaryChoice"
    />

    <div v-if="multiAccount" class="feature-sources">
      <SettingsGroup
        title="Feature sources"
        desc="Which tracker backs each feature. Default follows the primary when it can."
      >
        <SettingsRow
          v-for="row in featureRows"
          :key="row.feature"
          :label="row.label"
          :data-feature="row.feature"
        >
          <span v-if="row.options.length === 1" class="feature-single">{{
            TRACKER_LABELS[row.options[0]]
          }}</span>
          <div v-else class="select-wrap">
            <select :value="row.value" @change="onFeatureChange(row.feature, $event)">
              <option value="">{{ row.defaultLabel }}</option>
              <option v-for="id in row.options" :key="id" :value="id">
                {{ TRACKER_LABELS[id] }}
              </option>
            </select>
            <svg
              class="caret"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M19.5 8.25l-7.5 7.5-7.5-7.5"
              />
            </svg>
          </div>
        </SettingsRow>
        <SettingsRow v-if="featureError" stack>
          <div class="inline-result bad feature-error">{{ featureError }}</div>
        </SettingsRow>
      </SettingsGroup>
    </div>

    <TrackerPrimaryDialog
      v-if="primaryChoice"
      :candidates="primaryChoice.candidates"
      :interim="primaryChoice.interim"
      @choose="onPrimaryChosen"
      @close="primaryChoice = null"
    />
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
/* Each card is its own group: space them as `.set-group + .set-group` does. */
.tracker-account-card + .tracker-account-card,
.tracker-account-card + .feature-sources {
  margin-top: 18px;
}
</style>
