import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  createAnimeCacheService,
  type AnimeCacheEntry,
  type AnimeCacheService
} from '../../src/main/services/anime-cache'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AnimeDetail, EpisodeDetail } from '../../src/main/smotret-api'

function mkDetail(): AnimeDetail {
  return { posterUrl: 'https://example/a.jpg', posterUrlSmall: '' } as unknown as AnimeDetail
}
function mkEpisode(): EpisodeDetail {
  return {} as EpisodeDetail
}

describe('AnimeCacheService', () => {
  let tmpDir: string
  let store: InMemoryStorage
  let svc: AnimeCacheService
  let fetchedUrls: string[]
  let cachable: Set<number>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-cache-test-'))
    fetchedUrls = []
    cachable = new Set([1, 2, 3])
    store = new InMemoryStorage({ animeCache: {}, downloadedAnime: {}, library: {} })
    svc = createAnimeCacheService({
      store,
      userDataDir: tmpDir,
      fetchPoster: async (url: string) => {
        fetchedUrls.push(url)
        return Buffer.from('poster-bytes')
      },
      isCachable: (animeId: number) => cachable.has(animeId)
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null for an unknown anime and persists via setEntry', () => {
    expect(svc.getEntry(1)).toBeNull()
    const entry: AnimeCacheEntry = {
      animeDetail: null,
      episodes: {},
      qualityProbes: {},
      cachedAt: 0,
      posterCached: false
    }
    svc.setEntry(1, entry)
    expect(svc.getEntry(1)).toEqual(entry)
  })

  it('ensureEntry returns an empty default without writing', () => {
    const e = svc.ensureEntry(99)
    expect(e.cachedAt).toBe(0)
    // Not persisted by ensure alone
    expect(store.get<Record<string, unknown>>('animeCache')).toEqual({})
  })

  it('updateAnimeDetail is a no-op when isCachable returns false', () => {
    cachable.clear()
    svc.updateAnimeDetail(7, mkDetail())
    expect(store.get<Record<string, unknown>>('animeCache')).toEqual({})
  })

  it('updateAnimeDetail persists detail and triggers background poster fetch', async () => {
    svc.updateAnimeDetail(1, mkDetail())
    const after = store.get<Record<string, AnimeCacheEntry>>('animeCache')!
    expect(after['1'].animeDetail).not.toBeNull()
    expect(after['1'].cachedAt).toBeGreaterThan(0)
    // Background poster cache resolves on a microtask
    await new Promise((r) => setImmediate(r))
    expect(fetchedUrls).toEqual(['https://example/a.jpg'])
    expect(fs.existsSync(path.join(tmpDir, 'poster-cache', '1.jpg'))).toBe(true)
  })

  it('updateEpisode and updateQualityProbe stack onto the same entry', () => {
    svc.updateEpisode(2, 100, mkEpisode())
    svc.updateQualityProbe(2, 100, 1080)
    const e = svc.getEntry(2)!
    expect(e.episodes[100]).toBeDefined()
    expect(e.qualityProbes[100]).toBe(1080)
  })

  it('deleteEntry removes from store and unlinks the cached poster file', async () => {
    svc.updateAnimeDetail(1, mkDetail())
    await new Promise((r) => setImmediate(r)) // let poster write settle
    const posterPath = path.join(tmpDir, 'poster-cache', '1.jpg')
    expect(fs.existsSync(posterPath)).toBe(true)
    svc.deleteEntry(1)
    expect(svc.getEntry(1)).toBeNull()
    expect(fs.existsSync(posterPath)).toBe(false)
  })

  it('cachePosterImage skips when fetchPoster returns null', async () => {
    const skippingSvc = createAnimeCacheService({
      store: new InMemoryStorage({ animeCache: {}, downloadedAnime: {}, library: {} }),
      userDataDir: tmpDir,
      fetchPoster: async () => null,
      isCachable: () => true
    })
    await skippingSvc.cachePosterImage(42, 'https://example/x.jpg')
    expect(fs.existsSync(path.join(tmpDir, 'poster-cache', '42.jpg'))).toBe(false)
  })

  it('cleanupStale drops cache rows whose anime is neither downloaded nor in library', () => {
    store.set('animeCache', {
      '1': { episodes: {}, qualityProbes: {}, cachedAt: 0, posterCached: false, animeDetail: null },
      '2': { episodes: {}, qualityProbes: {}, cachedAt: 0, posterCached: false, animeDetail: null },
      '3': { episodes: {}, qualityProbes: {}, cachedAt: 0, posterCached: false, animeDetail: null }
    })
    store.set('downloadedAnime', { '1': {} })
    store.set('library', { '3': {} })
    svc.cleanupStale()
    const after = store.get<Record<string, AnimeCacheEntry>>('animeCache')!
    expect(Object.keys(after).sort()).toEqual(['1', '3'])
  })
})
