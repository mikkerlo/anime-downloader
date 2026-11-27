<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useLibraryStore } from '../../stores/library';
import { useTrackersStore } from '../../stores/trackers';
import TrackerAccountCard from './TrackerAccountCard.vue';
import ShikimoriConnectForm from './ShikimoriConnectForm.vue';
import MalConnectForm from './MalConnectForm.vue';

// Settings → Trackers (#700): one account card per tracker. MyAnimeList's
// (#702) shows while the new-tracker-cards flag is on; T7 adds AniList's, and
// T5b the multi-account controls.
const libraryStore = useLibraryStore();
const { newTrackerCardsEnabled } = storeToRefs(useTrackersStore());
const root = ref<HTMLElement | null>(null);

async function scrollToCard(trackerId: TrackerId | null): Promise<void> {
  if (!trackerId) return;
  await nextTick();
  root.value
    ?.querySelector(`[data-tracker-id="${trackerId}"]`)
    ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
      tracker-id="mal"
      desc="Connect your MyAnimeList account through your own MyAnimeList app."
      :connect-form="MalConnectForm"
    />
  </div>
</template>
