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
  /**
   * Index.ts-owned gate: starred, downloaded, or watched in the last 90 days
   * (#570), so worth caching. `cleanupStale` keeps exactly these.
   */
  isCachable: (animeId: number) => boolean
}

export interface AnimeCacheService {
  getEntry(animeId: number): AnimeCacheEntry | null
  setEntry(animeId: number, entry: AnimeCacheEntry): void
  deleteEntry(animeId: number): void
  ensureEntry(animeId: number): AnimeCacheEntry
  updateAnimeDetail(animeId: number, detail: AnimeDetail): void
  refreshAnimeDetail(animeId: number, detail: AnimeDetail): Promise<{ posterOk: boolean }>
  updateEpisode(animeId: number, episodeId: number, detail: EpisodeDetail): void
  updateEpisodes(animeId: number, details: EpisodeDetail[]): void
  updateQualityProbe(animeId: number, translationId: number, height: number): void
  cachePosterImage(animeId: number, posterUrl: string): Promise<boolean>
  getPosterCacheDir(): string
  getPosterCachePath(animeId: number): string
  /** Ids with a poster on disk, for the renderer's `anime-poster://` sources. */
  getCachedPosterIds(): number[]
  isCachable(animeId: number): boolean
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

  /** True only when the poster file exists afterwards (#592); never rejects. */
  async function cachePosterImage(animeId: number, posterUrl: string): Promise<boolean> {
    const destPath = getPosterCachePath(animeId)
    if (fs.existsSync(destPath)) return true
    if (!posterUrl) return false
    try {
      fs.mkdirSync(getPosterCacheDir(), { recursive: true })
      const buffer = await fetchPoster(posterUrl)
      if (!buffer) return false
      fs.writeFileSync(destPath, buffer)
    } catch {
      // Non-critical, ignore
    }
    return fs.existsSync(destPath)
  }

  function posterUrlOf(detail: AnimeDetail): string {
    return detail.posterUrl || detail.posterUrlSmall
  }

  function writeDetail(animeId: number, detail: AnimeDetail): AnimeCacheEntry {
    const entry = ensureEntry(animeId)
    entry.animeDetail = detail
    entry.cachedAt = Date.now()
    setEntry(animeId, entry)
    return entry
  }

  function setPosterCached(animeId: number, posterCached: boolean): void {
    const entry = getEntry(animeId)
    if (!entry || entry.posterCached === posterCached) return
    setEntry(animeId, { ...entry, posterCached })
  }

  /**
   * Prepare for offline (#592): writes the detail, then awaits the poster, so
   * the caller's progress tick comes after the file is on disk. A
   * `posterCached: true` with no file is fetched again.
   */
  async function refreshAnimeDetail(
    animeId: number,
    detail: AnimeDetail
  ): Promise<{ posterOk: boolean }> {
    if (!isCachable(animeId)) return { posterOk: false }
    writeDetail(animeId, detail)
    const posterOk = await cachePosterImage(animeId, posterUrlOf(detail))
    setPosterCached(animeId, posterOk)
    return { posterOk }
  }

  function ensureEntry(animeId: number): AnimeCacheEntry {
    const existing = getEntry(animeId)
    if (existing) return existing
    return { animeDetail: null, episodes: {}, qualityProbes: {}, cachedAt: 0, posterCached: false }
  }

  function updateAnimeDetail(animeId: number, detail: AnimeDetail): void {
    if (!isCachable(animeId)) return
    const entry = writeDetail(animeId, detail)
    // Cache poster in background; the flag follows whether the file arrived.
    if (!entry.posterCached) {
      void cachePosterImage(animeId, posterUrlOf(detail)).then((ok) => setPosterCached(animeId, ok))
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

  function getCachedPosterIds(): number[] {
    let names: string[]
    try {
      names = fs.readdirSync(getPosterCacheDir())
    } catch {
      return []
    }
    const ids: number[] = []
    for (const name of names) {
      const match = /^([1-9]\d*)\.jpg$/.exec(name)
      if (match) ids.push(Number(match[1]))
    }
    return ids
  }

  function cleanupStale(): void {
    const cache = store.get('animeCache') as Record<string, AnimeCacheEntry>
    let changed = false
    for (const key of Object.keys(cache)) {
      if (!isCachable(Number(key))) {
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
    refreshAnimeDetail,
    updateEpisode,
    updateEpisodes,
    updateQualityProbe,
    cachePosterImage,
    getPosterCacheDir,
    getPosterCachePath,
    getCachedPosterIds,
    isCachable,
    cleanupStale
  }
}
