import * as fs from 'fs'
import * as path from 'path'
import type { StorageService } from '../../store/types'
import type { AnimeDetail, EpisodeDetail } from '../../smotret-api'

export interface AnimeCacheEntry {
  animeDetail: AnimeDetail | null
  episodes: Record<number, EpisodeDetail>
  qualityProbes: Record<number, number>
  cachedAt: number
  posterCached: boolean
  fullProbeAt?: number
  fullProbeEpisodeCount?: number
}

export interface AnimeCacheServiceDeps {
  store: StorageService
  /** `app.getPath('userData')` — the poster cache sits at `<userData>/poster-cache/`. */
  userDataDir: string
  /** Smotret-anime poster fetcher. Returning `null` skips the write. */
  fetchPoster: (posterUrl: string) => Promise<Buffer | null | undefined>
  /** Index.ts-owned gate: anime is in library or downloaded, so worth caching. */
  isCachable: (animeId: number) => boolean
}

export interface AnimeCacheService {
  getEntry(animeId: number): AnimeCacheEntry | null
  setEntry(animeId: number, entry: AnimeCacheEntry): void
  deleteEntry(animeId: number): void
  ensureEntry(animeId: number): AnimeCacheEntry
  updateAnimeDetail(animeId: number, detail: AnimeDetail): void
  updateEpisode(animeId: number, episodeId: number, detail: EpisodeDetail): void
  updateEpisodes(animeId: number, details: EpisodeDetail[]): void
  updateQualityProbe(animeId: number, translationId: number, height: number): void
  cachePosterImage(animeId: number, posterUrl: string): Promise<void>
  getPosterCacheDir(): string
  getPosterCachePath(animeId: number): string
  cleanupStale(): void
}

export function createAnimeCacheService(deps: AnimeCacheServiceDeps): AnimeCacheService {
  const { store, userDataDir, fetchPoster, isCachable } = deps

  const getPosterCacheDir = (): string => path.join(userDataDir, 'poster-cache')
  const getPosterCachePath = (animeId: number): string =>
    path.join(getPosterCacheDir(), `${animeId}.jpg`)

  function getEntry(animeId: number): AnimeCacheEntry | null {
    // Sub-key read: clones only this anime's entry — a whole-map read would
    // structuredClone every cached show per call on the detail-open hot path.
    return (store.get(`animeCache.${animeId}`) as AnimeCacheEntry | undefined) ?? null
  }

  // Sub-key writes for the same reason: a whole-map read-modify-write would
  // clone every cached show twice per call on hot write paths (per-translation
  // quality probes). Disk writes are coalesced by the store layer itself.
  function setEntry(animeId: number, entry: AnimeCacheEntry): void {
    store.set(`animeCache.${animeId}`, entry)
  }

  function deleteEntry(animeId: number): void {
    store.delete(`animeCache.${animeId}`)
    // Also delete cached poster
    const posterPath = getPosterCachePath(animeId)
    try {
      fs.unlinkSync(posterPath)
    } catch {
      /* ignore */
    }
  }

  async function cachePosterImage(animeId: number, posterUrl: string): Promise<void> {
    if (!posterUrl) return
    const destPath = getPosterCachePath(animeId)
    if (fs.existsSync(destPath)) return
    try {
      fs.mkdirSync(getPosterCacheDir(), { recursive: true })
      const buffer = await fetchPoster(posterUrl)
      if (!buffer) return
      fs.writeFileSync(destPath, buffer)
    } catch {
      // Non-critical, ignore
    }
  }

  function ensureEntry(animeId: number): AnimeCacheEntry {
    const existing = getEntry(animeId)
    if (existing) return existing
    return { animeDetail: null, episodes: {}, qualityProbes: {}, cachedAt: 0, posterCached: false }
  }

  function updateAnimeDetail(animeId: number, detail: AnimeDetail): void {
    if (!isCachable(animeId)) return
    const entry = ensureEntry(animeId)
    entry.animeDetail = detail
    entry.cachedAt = Date.now()
    setEntry(animeId, entry)
    // Cache poster in background
    if (!entry.posterCached) {
      cachePosterImage(animeId, detail.posterUrl || detail.posterUrlSmall)
        .then(() => {
          entry.posterCached = true
          setEntry(animeId, entry)
        })
        .catch(() => {})
    }
  }

  function updateEpisode(animeId: number, episodeId: number, detail: EpisodeDetail): void {
    if (!isCachable(animeId)) return
    const entry = ensureEntry(animeId)
    entry.episodes[episodeId] = detail
    entry.cachedAt = Date.now()
    setEntry(animeId, entry)
  }

  // One store read + one store write for the whole batch. The per-episode
  // variant used to run a full read-modify-write cycle per episode, which at
  // a 30-episode page meant ~60 full-file store operations per detail open.
  function updateEpisodes(animeId: number, details: EpisodeDetail[]): void {
    if (details.length === 0 || !isCachable(animeId)) return
    const entry = ensureEntry(animeId)
    for (const detail of details) {
      entry.episodes[detail.id] = detail
    }
    entry.cachedAt = Date.now()
    setEntry(animeId, entry)
  }

  function updateQualityProbe(animeId: number, translationId: number, height: number): void {
    if (!isCachable(animeId)) return
    const entry = ensureEntry(animeId)
    entry.qualityProbes[translationId] = height
    setEntry(animeId, entry)
  }

  function cleanupStale(): void {
    const cache = store.get('animeCache') as Record<string, AnimeCacheEntry>
    const downloaded = store.get('downloadedAnime') as Record<string, unknown>
    const lib = store.get('library') as Record<string, unknown>
    let changed = false
    for (const key of Object.keys(cache)) {
      if (!downloaded[key] && !lib[key]) {
        delete cache[key]
        const posterPath = getPosterCachePath(Number(key))
        try {
          fs.unlinkSync(posterPath)
        } catch {
          /* ignore */
        }
        changed = true
      }
    }
    if (changed) store.set('animeCache', cache)
  }

  return {
    getEntry,
    setEntry,
    deleteEntry,
    ensureEntry,
    updateAnimeDetail,
    updateEpisode,
    updateEpisodes,
    updateQualityProbe,
    cachePosterImage,
    getPosterCacheDir,
    getPosterCachePath,
    cleanupStale
  }
}
