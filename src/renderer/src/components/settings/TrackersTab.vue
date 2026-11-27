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
      tracker-id="anilist"
      desc="Connect AniList to sync your list there."
      :connect-form="AniListConnectForm"
    />
  </div>
</template>
