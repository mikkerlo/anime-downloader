import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useLibraryStore } from '../../src/renderer/src/stores/library'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useLibraryStore', () => {
  it('opens an anime on the current view and tracks active', () => {
    const store = useLibraryStore()
    store.navigate('library')
    store.openAnime(42)
    expect(store.animeByView.library).toBe(42)
    expect(store.activeAnimeId).toBe(42)
  })

  it('pushes the previous selection onto the history stack', () => {
    const store = useLibraryStore()
    store.navigate('search')
    store.openAnime(1)
    store.openAnime(2)
    expect(store.animeByView.search).toBe(2)
    expect(store.animeHistoryByView.search).toEqual([1])
  })

  it('does not push onto history when reopening the same anime', () => {
    const store = useLibraryStore()
    store.navigate('home')
    store.openAnime(7)
    store.openAnime(7)
    expect(store.animeHistoryByView.home).toEqual([])
  })

  it('keeps per-view stacks isolated', () => {
    const store = useLibraryStore()
    store.navigate('home')
    store.openAnime(10)
    store.navigate('library')
    store.openAnime(20)
    expect(store.animeByView.home).toBe(10)
    expect(store.animeByView.library).toBe(20)
    expect(store.activeAnimeId).toBe(20)
    store.navigate('home')
    expect(store.activeAnimeId).toBe(10)
  })

  it('pops history on closeAnime; nulls out when stack is empty', () => {
    const store = useLibraryStore()
    store.navigate('search')
    store.openAnime(1)
    store.openAnime(2)
    store.closeAnime()
    expect(store.animeByView.search).toBe(1)
    store.closeAnime()
    expect(store.animeByView.search).toBe(null)
  })

  it('stores focusEpisodeInt per anime and clears on demand', () => {
    const store = useLibraryStore()
    store.navigate('home')
    store.openAnime(11, '5')
    expect(store.focusEpisodeIntForAnime[11]).toBe('5')
    expect(store.activeFocusEpisodeInt).toBe('5')
    store.clearFocusEpisode(11)
    expect(store.focusEpisodeIntForAnime[11]).toBeUndefined()
    expect(store.activeFocusEpisodeInt).toBeUndefined()
  })

  it('treats non-stacked views (downloads/settings) as having no active anime', () => {
    const store = useLibraryStore()
    store.navigate('home')
    store.openAnime(3)
    store.navigate('settings')
    expect(store.activeAnimeId).toBe(null)
    store.openAnime(99) // no-op on a non-stacked view
    expect(store.animeByView.home).toBe(3)
  })
})
