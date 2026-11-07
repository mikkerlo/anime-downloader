import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  createAnimeCacheService,
  type AnimeCacheEntry,
  type AnimeCacheService
} from '../../src/main/services/anime-cache'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { SmotretApi, type AnimeDetail, type EpisodeDetail } from '../../src/main/smotret-api'

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

  it('cachePosterImage reports whether the file exists afterwards (#592)', async () => {
    const failing = createAnimeCacheService({
      store: new InMemoryStorage({ animeCache: {}, downloadedAnime: {}, library: {} }),
      userDataDir: tmpDir,
      fetchPoster: async () => {
        throw new Error('network')
      },
      isCachable: () => true
    })
    await expect(failing.cachePosterImage(42, 'https://example/x.jpg')).resolves.toBe(false)
    await expect(failing.cachePosterImage(42, '')).resolves.toBe(false)
    await expect(svc.cachePosterImage(1, 'https://example/a.jpg')).resolves.toBe(true)
    // Already on disk: true without a fetch.
    fetchedUrls = []
    await expect(svc.cachePosterImage(1, '')).resolves.toBe(true)
    expect(fetchedUrls).toEqual([])
  })

  it('updateAnimeDetail leaves posterCached false when the poster fetch fails (#592)', async () => {
    // On main the flag went to true anyway: `cachePosterImage` swallowed the error.
    const failingStore = new InMemoryStorage({ animeCache: {}, downloadedAnime: {}, library: {} })
    const failing = createAnimeCacheService({
      store: failingStore,
      userDataDir: tmpDir,
      fetchPoster: async () => null,
      isCachable: () => true
    })
    failing.updateAnimeDetail(5, mkDetail())
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(failing.getEntry(5)?.posterCached).toBe(false)

    svc.updateAnimeDetail(1, mkDetail())
    await vi.waitFor(() => expect(svc.getEntry(1)?.posterCached).toBe(true))
  })

  it('refreshAnimeDetail awaits the poster, and repairs a posterCached: true with no file (#592)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const gated = createAnimeCacheService({
      store,
      userDataDir: tmpDir,
      fetchPoster: async () => {
        await gate
        return Buffer.from('late')
      },
      isCachable: (id) => cachable.has(id)
    })
    svc.setEntry(2, { ...svc.ensureEntry(2), posterCached: true })
    const posterPath = path.join(tmpDir, 'poster-cache', '2.jpg')
    let settled = false
    const done = gated.refreshAnimeDetail(2, mkDetail()).then((r) => {
      settled = true
      return r
    })
    await new Promise((r) => setImmediate(r))
    expect(settled).toBe(false)
    expect(svc.getEntry(2)?.animeDetail).not.toBeNull()
    release()
    await expect(done).resolves.toEqual({ posterOk: true })
    expect(fs.readFileSync(posterPath, 'utf8')).toBe('late')
    expect(svc.getEntry(2)?.posterCached).toBe(true)
    await expect(gated.refreshAnimeDetail(99, mkDetail())).resolves.toEqual({ posterOk: false })
  })

  it('updateEpisodes persists a whole batch with a single store write', () => {
    const setSpy = vi.spyOn(store, 'set')
    svc.updateEpisodes(1, [
      { ...mkEpisode(), id: 100 },
      { ...mkEpisode(), id: 101 },
      { ...mkEpisode(), id: 102 }
    ])
    expect(setSpy).toHaveBeenCalledTimes(1)
    const entry = svc.getEntry(1)!
    expect(Object.keys(entry.episodes).sort()).toEqual(['100', '101', '102'])
    expect(entry.cachedAt).toBeGreaterThan(0)
  })

  it('updateEpisodes is a no-op for an empty batch or a non-cachable anime', () => {
    const setSpy = vi.spyOn(store, 'set')
    svc.updateEpisodes(1, [])
    svc.updateEpisodes(999, [{ ...mkEpisode(), id: 100 }])
    expect(setSpy).not.toHaveBeenCalled()
  })

  // #204 retired the bespoke probe buffer + getEntry overlay: the store layer
  // itself now coalesces disk writes, so probes persist straight through.
  describe('quality probes', () => {
    it('updateQualityProbe persists via a sub-key write and reads straight back', () => {
      const setSpy = vi.spyOn(store, 'set')
      svc.updateQualityProbe(1, 500, 1080)
      svc.updateQualityProbe(1, 501, 720)
      expect(setSpy).toHaveBeenCalledTimes(2)
      expect(setSpy).toHaveBeenLastCalledWith('animeCache.1', expect.anything())
      expect(svc.getEntry(1)!.qualityProbes).toEqual({ 500: 1080, 501: 720 })
    })

    it('probes stack onto an entry without clobbering its episodes', () => {
      svc.updateEpisode(1, 100, mkEpisode())
      svc.updateQualityProbe(1, 500, 1080)
      const persisted = store.get<Record<string, AnimeCacheEntry>>('animeCache')!['1']
      expect(persisted.episodes['100']).toBeDefined()
      expect(persisted.qualityProbes).toEqual({ 500: 1080 })
    })

    it('non-cachable probes are dropped', () => {
      const setSpy = vi.spyOn(store, 'set')
      svc.updateQualityProbe(999, 500, 1080)
      expect(setSpy).not.toHaveBeenCalled()
    })
  })

  function emptyEntry(): AnimeCacheEntry {
    return { episodes: {}, qualityProbes: {}, cachedAt: 0, posterCached: false, animeDetail: null }
  }

  it('cleanupStale drops the rows and posters the injected predicate rejects', () => {
    store.set('animeCache', { '1': emptyEntry(), '2': emptyEntry(), '3': emptyEntry() })
    fs.mkdirSync(svc.getPosterCacheDir(), { recursive: true })
    for (const id of [1, 2, 3]) fs.writeFileSync(svc.getPosterCachePath(id), 'p')
    cachable = new Set([1, 3])
    svc.cleanupStale()
    const after = store.get<Record<string, AnimeCacheEntry>>('animeCache')!
    expect(Object.keys(after).sort()).toEqual(['1', '3'])
    expect(fs.existsSync(svc.getPosterCachePath(2))).toBe(false)
    expect(fs.existsSync(svc.getPosterCachePath(1))).toBe(true)
  })

  // Red on the old cleanupStale, which re-checked `downloadedAnime` / `library`
  // itself and ignored the predicate (#570).
  it('cleanupStale keeps a continue-watching-only title and its poster', () => {
    store.set('animeCache', { '2': emptyEntry() })
    store.set('downloadedAnime', {})
    store.set('library', {})
    fs.mkdirSync(svc.getPosterCacheDir(), { recursive: true })
    fs.writeFileSync(svc.getPosterCachePath(2), 'p')
    cachable = new Set([2])
    svc.cleanupStale()
    expect(Object.keys(store.get<Record<string, AnimeCacheEntry>>('animeCache')!)).toEqual(['2'])
    expect(fs.existsSync(svc.getPosterCachePath(2))).toBe(true)
  })

  it('getCachedPosterIds lists the ids with a poster on disk, and nothing else', () => {
    expect(svc.getCachedPosterIds()).toEqual([])
    fs.mkdirSync(svc.getPosterCacheDir(), { recursive: true })
    for (const name of ['7.jpg', '42.jpg', '0.jpg', 'x.jpg', '9.jpg.tmp', '-1.jpg']) {
      fs.writeFileSync(path.join(svc.getPosterCacheDir(), name), 'p')
    }
    expect(svc.getCachedPosterIds().sort((a, b) => a - b)).toEqual([7, 42])
  })

  it('isCachable is the injected predicate', () => {
    expect(svc.isCachable(1)).toBe(true)
    expect(svc.isCachable(99)).toBe(false)
  })

  // #684: smotret's `.ru` hosts answered poster URLs with a 200 HTML page, which
  // the old fetchPoster cached as `<id>.jpg`, and nothing ever fetched it again.
  describe('a "site moved" page in place of a poster (#684)', () => {
    const HTML = '<!DOCTYPE html><html><head><title>Адрес сайта изменился! - Anime 365'
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

    it('purgeNonImagePosters deletes it and clears posterCached, per entry', () => {
      const cached = (): AnimeCacheEntry => ({ ...emptyEntry(), posterCached: true })
      store.set('animeCache', { '7': cached(), '8': cached() })
      fs.mkdirSync(svc.getPosterCacheDir(), { recursive: true })
      fs.writeFileSync(svc.getPosterCachePath(7), HTML)
      fs.writeFileSync(svc.getPosterCachePath(8), JPEG)
      // Unreadable as a file: kept, and the sweep does not throw.
      fs.mkdirSync(path.join(svc.getPosterCacheDir(), '9.jpg'))
      const entry8 = structuredClone(svc.getEntry(8))
      const setSpy = vi.spyOn(store, 'set')

      svc.purgeNonImagePosters()

      expect(svc.getCachedPosterIds().sort((a, b) => a - b)).toEqual([8, 9])
      expect(svc.getEntry(7)?.posterCached).toBe(false)
      expect(svc.getEntry(8)).toEqual(entry8)
      expect(fs.readFileSync(svc.getPosterCachePath(8))).toEqual(JPEG)
      // Through `setPosterCached`'s sub-key write, never the whole map.
      expect(setSpy.mock.calls.map((c) => c[0])).toEqual(['animeCache.7'])
    })

    it('cachePosterImage through the real fetchPoster caches nothing for it', async () => {
      const realFetch = globalThis.fetch
      const requested: string[] = []
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        requested.push(String(url))
        return new Response(HTML, { headers: { 'content-type': 'text/html; charset=UTF-8' } })
      })
      try {
        const api = new SmotretApi(() => '')
        const real = createAnimeCacheService({
          store,
          userDataDir: tmpDir,
          fetchPoster: (u) => api.fetchPoster(u),
          isCachable: () => true
        })
        await expect(
          real.cachePosterImage(7, 'https://smotret-anime.ru/posters/7.1234.200x600.0.jpg')
        ).resolves.toBe(false)
        expect(fs.existsSync(real.getPosterCachePath(7))).toBe(false)
        expect(requested).toEqual(['https://smotret-anime.app/posters/7.1234.200x600.0.jpg'])
      } finally {
        globalThis.fetch = realFetch
      }
    })
  })
})
