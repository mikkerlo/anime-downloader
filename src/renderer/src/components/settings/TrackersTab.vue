<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { useLibraryStore } from '../../stores/library';
import TrackerAccountCard from './TrackerAccountCard.vue';
import ShikimoriConnectForm from './ShikimoriConnectForm.vue';

// Settings → Trackers (#700): one account card per tracker. T6 and T7 add the
// MyAnimeList and AniList cards, and T5b the multi-account controls.
const libraryStore = useLibraryStore();
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
  </div>
</template>
