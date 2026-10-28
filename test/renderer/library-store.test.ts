import { describe, it, expect, beforeEach, vi } from 'vitest'
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

// #570: one request per view load for the ids with a cached poster.
describe('useLibraryStore — poster ids', () => {
  function stubApi(getCachedPosterIds: () => Promise<number[]>): void {
    ;(globalThis as { window?: unknown }).window = { api: { getCachedPosterIds } }
  }

  it('loads the id set from main', async () => {
    stubApi(vi.fn().mockResolvedValue([3, 5]))
    const store = useLibraryStore()
    expect(store.posterIds.size).toBe(0)
    await store.loadPosterIds()
    expect([...store.posterIds]).toEqual([3, 5])
  })

  it('shares one request between concurrent loads, and re-requests on the next load', async () => {
    const get = vi.fn().mockResolvedValue([1])
    stubApi(get)
    const store = useLibraryStore()
    await Promise.all([store.loadPosterIds(), store.loadPosterIds()])
    expect(get).toHaveBeenCalledTimes(1)
    get.mockResolvedValue([1, 2])
    await store.loadPosterIds()
    expect(get).toHaveBeenCalledTimes(2)
    expect([...store.posterIds]).toEqual([1, 2])
  })

  it('a failed load keeps the last set and never rejects', async () => {
    const get = vi.fn().mockResolvedValueOnce([9]).mockRejectedValueOnce(new Error('boom'))
    stubApi(get)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = useLibraryStore()
    await store.loadPosterIds()
    await expect(store.loadPosterIds()).resolves.toBeUndefined()
    expect([...store.posterIds]).toEqual([9])
    err.mockRestore()
  })
})
