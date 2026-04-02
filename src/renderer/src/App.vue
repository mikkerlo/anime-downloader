<script setup lang="ts">
import { ref, computed } from 'vue'
import Sidebar from './components/Sidebar.vue'
import SearchView from './components/SearchView.vue'
import LibraryView from './components/LibraryView.vue'
import SettingsView from './components/SettingsView.vue'
import DownloadsView from './components/DownloadsView.vue'
import AnimeDetailView from './components/AnimeDetailView.vue'

const currentView = ref('search')
const animeByView = ref<Record<string, number | null>>({
  search: null,
  library: null
})

// Persist translation type and author selections per anime across re-mounts
const animePrefs = ref<Record<number, { translationType?: string; author?: string }>>({})

const activeAnimeId = computed(() => animeByView.value[currentView.value] ?? null)

function openAnime(id: number): void {
  animeByView.value[currentView.value] = id
}

function closeAnime(): void {
  animeByView.value[currentView.value] = null
}

function saveAnimePrefs(animeId: number, translationType: string, author: string): void {
  animePrefs.value[animeId] = { translationType, author }
}

function navigate(view: string): void {
  currentView.value = view
}
</script>

<template>
  <div class="app">
    <Sidebar :current-view="currentView" @navigate="navigate" />
    <AnimeDetailView v-if="activeAnimeId" :key="activeAnimeId" :anime-id="activeAnimeId" :initial-prefs="animePrefs[activeAnimeId]" @back="closeAnime" @prefs-changed="saveAnimePrefs" />
    <SearchView v-show="currentView === 'search' && !activeAnimeId" @open-anime="openAnime" />
    <LibraryView v-if="currentView === 'library' && !activeAnimeId" @open-anime="openAnime" />
    <SettingsView v-if="currentView === 'settings'" />
    <DownloadsView v-if="currentView === 'downloads'" />
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background-color: #1a1a2e;
  color: #e0e0e0;
  overflow: hidden;
}

.app {
  display: flex;
  height: 100vh;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #4a4a6a;
  font-size: 1.2rem;
}
</style>
