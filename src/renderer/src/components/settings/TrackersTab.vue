<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useLibraryStore } from '../../stores/library';
import { useTrackersStore } from '../../stores/trackers';
import TrackerAccountCard from './TrackerAccountCard.vue';
import ShikimoriConnectForm from './ShikimoriConnectForm.vue';
import AniListConnectForm from './AniListConnectForm.vue';
import MalConnectForm from './MalConnectForm.vue';

// Settings → Trackers (#700): one account card per tracker, in `TrackerId`
// order. The AniList (#703) and MyAnimeList (#702) cards show only while main
// reports the new-tracker-cards flag on; T5b adds the multi-account controls.
const libraryStore = useLibraryStore();
const { newTrackerCardsEnabled } = storeToRefs(useTrackersStore());
const root = ref<HTMLElement | null>(null);

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
    />
    <TrackerAccountCard
      v-if="newTrackerCardsEnabled"
      tracker-id="anilist"
      desc="Connect AniList to sync your list there."
      :connect-form="AniListConnectForm"
    />
    <TrackerAccountCard
      v-if="newTrackerCardsEnabled"
      tracker-id="mal"
      desc="Connect your MyAnimeList account through your own MyAnimeList app."
      :connect-form="MalConnectForm"
    />
  </div>
</template>

<style scoped>
/* Each card is its own group: space them as `.set-group + .set-group` does. */
.tracker-account-card + .tracker-account-card {
  margin-top: 18px;
}
</style>
