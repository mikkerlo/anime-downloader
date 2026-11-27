<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useLibraryStore } from '../../stores/library';
import { useTrackersStore } from '../../stores/trackers';
import TrackerAccountCard from './TrackerAccountCard.vue';
import ShikimoriConnectForm from './ShikimoriConnectForm.vue';
import AniListConnectForm from './AniListConnectForm.vue';

// Settings → Trackers (#700): one account card per tracker. T6 adds the
// MyAnimeList card and T5b the multi-account controls. The AniList card (#703)
// shows only while main reports the new-tracker-cards flag on (#703 § 8).
const libraryStore = useLibraryStore();
const { newTrackerCardsEnabled } = storeToRefs(useTrackersStore());
const root = ref<HTMLElement | null>(null);

// A card behind the flag (AniList, #703) renders only once the accounts
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
  </div>
</template>

<style scoped>
/* Each card is its own group: space them as `.set-group + .set-group` does. */
.tracker-account-card + .tracker-account-card {
  margin-top: 18px;
}
</style>
