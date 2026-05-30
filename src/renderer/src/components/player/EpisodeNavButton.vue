<script setup lang="ts">
// Prev/next-episode arrow for the player's control bar. Relocated here from
// the title bar in the Refined Dark redesign (#167): the design groups the
// episode-nav arrows with play/pause in the control bar's left cluster.
// Presentation-only — PlayerView owns canPrev/canNext/navigating and the
// goToEpisode handler, wiring them to `disabled` + the `nav` emit.

defineProps<{
  direction: 'prev' | 'next';
  disabled: boolean;
}>();

const emit = defineEmits<{
  nav: [];
}>();
</script>

<template>
  <button
    class="ctrl-btn ep-nav-btn"
    :disabled="disabled"
    :title="direction === 'prev' ? 'Previous episode (Shift+←)' : 'Next episode (Shift+→)'"
    @click="emit('nav')"
  >
    <svg v-if="direction === 'prev'" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z" />
    </svg>
    <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 6h2v12h-2V6zM6 6l8.5 6L6 18V6z" />
    </svg>
  </button>
</template>

<style scoped src="@renderer/assets/player-menus.css"></style>
<style scoped>
.ep-nav-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.ep-nav-btn:disabled:hover {
  background: none;
}
</style>
