import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlayerStore, type PlayerPayload } from '../../src/renderer/src/stores/player'

function payload(overrides: Partial<PlayerPayload> = {}): PlayerPayload {
  return {
    filePath: '',
    streamUrl: 'https://example/test.mp4',
    subtitleContent: '',
    animeName: 'Test',
    episodeLabel: '1',
    availableStreams: [{ height: 720, url: 'https://example/test.mp4' }],
    translationId: 1,
    translations: [{ id: 1, label: 'Sub', type: 'subRu', height: 720 }],
    downloadedTrIds: [],
    allEpisodes: [],
    episodeIndex: 0,
    animeId: 100,
    malId: 200,
    ...overrides
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('usePlayerStore', () => {
  it('opens and closes the player overlay', () => {
    const store = usePlayerStore()
    expect(store.playerState).toBeNull()
    store.openPlayer(payload())
    expect(store.playerState?.animeId).toBe(100)
    store.closePlayer()
    expect(store.playerState).toBeNull()
  })

  it('persists per-anime translation/author prefs', () => {
    const store = usePlayerStore()
    store.saveAnimePrefs(42, 'subEn', 'Anidub')
    store.saveAnimePrefs(7, 'voiceRu', 'AniLibria')
    expect(store.animePrefs[42]).toEqual({ translationType: 'subEn', author: 'Anidub' })
    expect(store.animePrefs[7]).toEqual({ translationType: 'voiceRu', author: 'AniLibria' })
  })

  it('overwrites prior prefs for the same anime', () => {
    const store = usePlayerStore()
    store.saveAnimePrefs(1, 'subRu', 'A')
    store.saveAnimePrefs(1, 'voiceEn', 'B')
    expect(store.animePrefs[1]).toEqual({ translationType: 'voiceEn', author: 'B' })
  })

  it('reopens with a fresh payload', () => {
    const store = usePlayerStore()
    store.openPlayer(payload({ animeId: 1 }))
    store.openPlayer(payload({ animeId: 2 }))
    expect(store.playerState?.animeId).toBe(2)
  })
})
