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

  // The helper has no try/catch of its own, and the #428 hook policy depends on
  // that: a real store failure has to reach `DownloadManager.dispatchHook` for
  // the queue row to be marked. Pinned here so a well-meaning `try { … } catch`
  // added inside the helper — which would silently restore the swallow this
  // issue removed, and make the caller's throw path dead code — fails a test.
  //
  // Both throwing points are electron-store reads/writes: `set` is a
  // synchronous whole-file atomic JSON write, so ENOSPC, EACCES on a locked
  // userData dir, EROFS and serialization errors all come out of it.
  describe('a real store failure propagates, it is not swallowed (#428)', () => {
    it('propagates a throw from set', () => {
      const store: DownloadedEpisodesStore = {
        get: () => ({}),
        set: () => {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        }
      }

      expect(() => persistDownloadedEpisode(store, source())).toThrow(/ENOSPC/)
    })

    it('propagates a throw from get', () => {
      const store: DownloadedEpisodesStore = {
        get: () => {
          throw new Error('EACCES: permission denied')
        },
        set: () => {
          throw new Error('set should never be reached')
        }
      }

      expect(() => persistDownloadedEpisode(store, source())).toThrow(/EACCES/)
    })

    it('never reaches the store at all for an unkeyable item, so it cannot fail', () => {
      // The distinction the policy rests on: `false` means "could never have
      // been keyed", and that verdict is reached before any store call, so it
      // is not a disguised failure and must not mark the row.
      const store: DownloadedEpisodesStore = {
        get: () => {
          throw new Error('should not be read')
        },
        set: () => {
          throw new Error('should not be written')
        }
      }

      expect(persistDownloadedEpisode(store, source({ animeId: 0 }))).toBe(false)
      expect(persistDownloadedEpisode(store, source({ episodeInt: '' }))).toBe(false)
    })
  })
})
