// The `downloadedEpisodes` writer, extracted out of `index.ts` for #412 so it
// can have two callers (the per-video hook and the group-complete repair path)
// and a test.
//
// The store is injected rather than mocked: `electron-store` is externalised
// from the Vitest bundle, so `vi.mock('electron')` never reaches it. A fake
// store is the only seam.

import { describe, it, expect } from 'vitest'
import {
  persistDownloadedEpisode,
  type DownloadedEpisodesMap,
  type DownloadedEpisodesStore,
  type DownloadedEpisodeSource
} from '../../src/main/lib/downloaded-episodes'

interface FakeStore extends DownloadedEpisodesStore {
  /** Reads without the copy `get` hands out, and counts `set` calls. */
  readonly entries: DownloadedEpisodesMap
  readonly writes: number
}

/**
 * Deliberately clones on `get` and replaces on `set`, the way the real
 * `StorageService` snapshot does — a fake that handed back a live reference
 * would make the helper's read-modify-write look correct even if it never
 * called `set`.
 */
function makeStore(initial: DownloadedEpisodesMap = {}): FakeStore {
  let held: DownloadedEpisodesMap = structuredClone(initial)
  let writes = 0
  return {
    get: () => structuredClone(held),
    set: (_key, value) => {
      held = structuredClone(value)
      writes++
    },
    get entries() {
      return held
    },
    get writes() {
      return writes
    }
  }
}

function source(overrides: Partial<DownloadedEpisodeSource> = {}): DownloadedEpisodeSource {
  return {
    animeId: 100,
    episodeInt: '3',
    translationId: 42,
    translationType: 'subRu',
    author: 'Author',
    quality: 1080,
    ...overrides
  }
}

describe('persistDownloadedEpisode', () => {
  it('writes the translation-keyed entry and reports that it did', () => {
    const store = makeStore()

    expect(persistDownloadedEpisode(store, source())).toBe(true)

    expect(store.entries).toEqual({
      '100:3:42': { translationType: 'subRu', author: 'Author', quality: 1080, translationId: 42 }
    })
    expect(store.writes).toBe(1)
  })

  it('drops the legacy untagged key for the same episode', () => {
    const store = makeStore({
      '100:3': { translationType: 'voiceRu', author: 'Old', quality: 480, translationId: 7 }
    })

    persistDownloadedEpisode(store, source())

    expect(Object.keys(store.entries)).toEqual(['100:3:42'])
  })

  it('leaves other episodes and other translations of the same episode alone', () => {
    const store = makeStore({
      '100:2:42': { translationType: 'subRu', author: 'Author', quality: 720, translationId: 42 },
      '100:3:99': { translationType: 'voiceRu', author: 'Other', quality: 720, translationId: 99 }
    })

    persistDownloadedEpisode(store, source())

    expect(Object.keys(store.entries).sort()).toEqual(['100:2:42', '100:3:42', '100:3:99'])
  })

  it('is idempotent — a second call leaves an identical entry and no other key', () => {
    const store = makeStore()

    persistDownloadedEpisode(store, source())
    const afterFirst = structuredClone(store.entries)
    persistDownloadedEpisode(store, source())

    // Both callers run on a normal download by design, so agreeing matters more
    // than writing once: two `set` calls, one stable result.
    expect(store.writes).toBe(2)
    expect(store.entries).toEqual(afterFirst)
  })

  it('overwrites an existing entry for the same key (a re-download updates quality)', () => {
    const store = makeStore({
      '100:3:42': { translationType: 'subRu', author: 'Author', quality: 480, translationId: 42 }
    })

    persistDownloadedEpisode(store, source({ quality: 1080 }))

    expect(store.entries['100:3:42'].quality).toBe(1080)
  })

  it('refuses an item with no anime id — the key would be unreadable', () => {
    for (const animeId of [0, -1]) {
      const store = makeStore()
      expect(persistDownloadedEpisode(store, source({ animeId }))).toBe(false)
      expect(store.entries).toEqual({})
      expect(store.writes).toBe(0)
    }
  })

  it('refuses an item with no episode number', () => {
    const store = makeStore()

    expect(persistDownloadedEpisode(store, source({ episodeInt: '' }))).toBe(false)

    expect(store.entries).toEqual({})
    expect(store.writes).toBe(0)
  })

  it('does not delete the legacy key when it refuses the write', () => {
    const store = makeStore({
      '100:3': { translationType: 'voiceRu', author: 'Old', quality: 480, translationId: 7 }
    })

    persistDownloadedEpisode(store, source({ animeId: 0 }))

    expect(Object.keys(store.entries)).toEqual(['100:3'])
  })
})
