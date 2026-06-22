// Library/navigation store (Phase 4 slice 4b, #111).
//
// Owns the per-view anime selection stacks, the current top-level view, and the
// focus-episode-per-anime map that AnimeDetailView reads on mount. Previously
// these lived as refs on App.vue and were prop-drilled / event-emitted to every
// view; the store collapses that into direct action calls.

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type LibraryView =
  | 'home'
  | 'search'
  | 'library'
  | 'shikimori'
  | 'friends'
  | 'calendar'
  | 'recommendations'
  | 'downloads'
  | 'settings'

// Views that have an inline AnimeDetailView overlay (open an anime within the
// view, keep a back-stack per view). `downloads`/`settings` are top-level only.
const STACKED_VIEWS = [
  'home',
  'search',
  'library',
  'shikimori',
  'friends',
  'calendar',
  'recommendations'
] as const
type StackedView = (typeof STACKED_VIEWS)[number]

function emptyStacks(): Record<StackedView, number | null> {
  return {
    home: null,
    search: null,
    library: null,
    shikimori: null,
    friends: null,
    calendar: null,
    recommendations: null
  }
}

function emptyHistory(): Record<StackedView, number[]> {
  return {
    home: [],
    search: [],
    library: [],
    shikimori: [],
    friends: [],
    calendar: [],
    recommendations: []
  }
}

export const useLibraryStore = defineStore('library', () => {
  const currentView = ref<LibraryView>('home')
  const animeByView = ref<Record<StackedView, number | null>>(emptyStacks())
  const animeHistoryByView = ref<Record<StackedView, number[]>>(emptyHistory())
  const focusEpisodeIntForAnime = ref<Record<number, string | undefined>>({})

  function isStackedView(view: LibraryView): view is StackedView {
    return (STACKED_VIEWS as readonly string[]).includes(view)
  }

  const activeAnimeId = computed<number | null>(() => {
    const view = currentView.value
    if (!isStackedView(view)) return null
    return animeByView.value[view]
  })

  const activeFocusEpisodeInt = computed<string | undefined>(() =>
    activeAnimeId.value != null ? focusEpisodeIntForAnime.value[activeAnimeId.value] : undefined
  )

  function navigate(view: LibraryView): void {
    currentView.value = view
  }

  function openAnime(id: number, focusEpisodeInt?: string): void {
    const view = currentView.value
    if (!isStackedView(view)) return
    const current = animeByView.value[view]
    if (current != null && current !== id) {
      animeHistoryByView.value[view].push(current)
    }
    if (focusEpisodeInt) {
      focusEpisodeIntForAnime.value[id] = focusEpisodeInt
    }
    animeByView.value[view] = id
  }

  function closeAnime(): void {
    const view = currentView.value
    if (!isStackedView(view)) return
    const stack = animeHistoryByView.value[view]
    animeByView.value[view] = stack.length > 0 ? stack.pop()! : null
  }

  function clearFocusEpisode(id: number): void {
    if (focusEpisodeIntForAnime.value[id] !== undefined) {
      delete focusEpisodeIntForAnime.value[id]
    }
  }

  return {
    currentView,
    animeByView,
    animeHistoryByView,
    focusEpisodeIntForAnime,
    activeAnimeId,
    activeFocusEpisodeInt,
    navigate,
    openAnime,
    closeAnime,
    clearFocusEpisode
  }
})
