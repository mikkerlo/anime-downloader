import * as fsPromises from 'fs/promises'
import * as path from 'path'
import { join } from 'path'
import type { StorageService } from '../../store/types'
import type { AnimeSearchResult } from '../../smotret-api'

export interface UsageEpisodeFiles {
  mkv?: { path: string; size: number }
  mp4?: { path: string; size: number }
  ass?: { path: string; size: number }
}

interface AnimeUsageAccum {
  animeId: number
  animeName: string
  posterUrlSmall: string
  bytesHot: number
  bytesCold: number
  fileCount: number
  episodes: Map<string, { files: UsageEpisodeFiles; totalBytes: number }>
}

export interface StorageEpisodeUsage {
  episodeInt: string
  files: UsageEpisodeFiles
  totalBytes: number
  watched: boolean
  watchedAt?: number
}

export interface StorageAnimeUsage {
  animeId: number
  animeName: string
  posterUrlSmall: string
  bytes: number
  bytesHot: number
  bytesCold: number
  fileCount: number
  episodes: StorageEpisodeUsage[]
}

export interface StorageUsage {
  totalBytes: number
  bytesHot: number
  bytesCold: number
  fileCount: number
  perAnime: StorageAnimeUsage[]
}

export interface ColdStorageServiceDeps {
  store: StorageService
  /** Fallback root when `downloadDir` is empty — `app.getPath('downloads')`. */
  downloadsFallbackDir: string
  sanitizeFilename: (s: string) => string
  parseEpisodeFromFilename: (
    file: string
  ) => { episodeInt: string; ext: 'mkv' | 'mp4' | 'ass' } | null
  broadcast: (channel: string, ...args: unknown[]) => void
  /** Event channel for STORAGE_USAGE_PROGRESS. */
  usageProgressChannel: string
}

export interface ColdStorageService {
  /** Active hot-storage root (advanced mode hot dir, then `downloadDir`, then fallback). */
  getDownloadDir(): string
  /** Configured cold-storage root, or `''` if not set. */
  getColdStorageDir(): string
  /** `storageMode === 'advanced'`. */
  isAdvanced(): boolean
  /** Hot + cold roots, in scan order. */
  dirsForScan(): string[]
  /** Walk hot/cold roots, total bytes per anime/episode, classify by bucket. */
  scanUsage(): Promise<StorageUsage>
}

export function createColdStorageService(deps: ColdStorageServiceDeps): ColdStorageService {
  const {
    store,
    downloadsFallbackDir,
    sanitizeFilename,
    parseEpisodeFromFilename,
    broadcast,
    usageProgressChannel
  } = deps

  function getDownloadDir(): string {
    const mode = store.get('storageMode') as string
    if (mode === 'advanced') {
      const hotDir = store.get('hotStorageDir') as string
      if (hotDir) return hotDir
    }
    const dir = store.get('downloadDir') as string
    if (dir) return dir
    return join(downloadsFallbackDir, 'anime-dl')
  }

  function getColdStorageDir(): string {
    return (store.get('coldStorageDir') as string) || ''
  }

  function isAdvanced(): boolean {
    return (store.get('storageMode') as string) === 'advanced'
  }

  function dirsForScan(): string[] {
    const dirs = [getDownloadDir()]
    if (isAdvanced()) {
      const cold = getColdStorageDir()
      if (cold) dirs.push(cold)
    }
    return dirs
  }

  async function scanUsage(): Promise<StorageUsage> {
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    const watchProgress = store.get('watchProgress') as Record<
      string,
      { watched?: boolean; watchedAt?: number }
    >
    // Downloads are written under sanitizeFilename(getAnimeName(anime)), where
    // getAnimeName prefers titles.romaji, then titles.ru, then title. Register all
    // three candidates so the scan finds folders regardless of which variant was
    // current at download time. The "preferred" name (matching the live folder
    // name) is what we surface to the renderer so delete calls round-trip cleanly.
    const dirNameToId = new Map<string, string>()
    const idToDisplayName = new Map<string, string>()
    for (const id of Object.keys(downloaded)) {
      const a = downloaded[id]
      if (!a) continue
      const preferred = a.titles?.romaji || a.titles?.ru || a.title
      if (!preferred) continue
      idToDisplayName.set(id, preferred)
      const candidates = [preferred, a.titles?.ru, a.titles?.romaji, a.title]
      for (const name of candidates) {
        if (!name) continue
        const key = sanitizeFilename(name)
        if (!dirNameToId.has(key)) dirNameToId.set(key, id)
      }
    }

    const accum = new Map<string, AnimeUsageAccum>()
    const hotDir = getDownloadDir()
    const coldDir = isAdvanced() ? getColdStorageDir() : ''

    const dirs: Array<{ root: string; bucket: 'hot' | 'cold' }> = []
    if (hotDir) dirs.push({ root: hotDir, bucket: 'hot' })
    if (coldDir && coldDir !== hotDir) dirs.push({ root: coldDir, bucket: 'cold' })

    // First pass: list anime folders so we can emit progress meaningfully
    const animeFolders: Array<{ root: string; bucket: 'hot' | 'cold'; folder: string }> = []
    for (const { root, bucket } of dirs) {
      try {
        const entries = await fsPromises.readdir(root, { withFileTypes: true })
        for (const e of entries) {
          if (e.isDirectory()) animeFolders.push({ root, bucket, folder: e.name })
        }
      } catch {
        /* dir missing */
      }
    }

    const total = animeFolders.length
    const reportProgress = total > 50
    let scanned = 0

    for (const { root, bucket, folder } of animeFolders) {
      const animeId = dirNameToId.get(folder)
      if (!animeId) {
        scanned++
        if (reportProgress) broadcast(usageProgressChannel, { scanned, total })
        continue
      }
      const animeRec = downloaded[animeId]
      let entry = accum.get(animeId)
      if (!entry) {
        entry = {
          animeId: Number(animeId),
          animeName: idToDisplayName.get(animeId) || animeRec.title,
          posterUrlSmall: animeRec.posterUrlSmall || '',
          bytesHot: 0,
          bytesCold: 0,
          fileCount: 0,
          episodes: new Map()
        }
        accum.set(animeId, entry)
      }

      const animeDir = path.join(root, folder)
      let files: string[]
      try {
        files = await fsPromises.readdir(animeDir)
      } catch {
        scanned++
        if (reportProgress) broadcast(usageProgressChannel, { scanned, total })
        continue
      }

      for (const file of files) {
        const parsed = parseEpisodeFromFilename(file)
        if (!parsed) continue
        const fullPath = path.join(animeDir, file)
        let size = 0
        try {
          size = (await fsPromises.stat(fullPath)).size
        } catch {
          continue
        }

        let ep = entry.episodes.get(parsed.episodeInt)
        if (!ep) {
          ep = { files: {}, totalBytes: 0 }
          entry.episodes.set(parsed.episodeInt, ep)
        }
        // Cold storage takes priority when both buckets have the file.
        const existing = ep.files[parsed.ext]
        if (existing && bucket === 'hot') continue
        ep.files[parsed.ext] = { path: fullPath, size }
        ep.totalBytes =
          (ep.files.mkv?.size || 0) + (ep.files.mp4?.size || 0) + (ep.files.ass?.size || 0)
        if (existing) {
          // Replaced hot with cold — adjust counters.
          entry.bytesHot -= existing.size
          entry.fileCount -= 1
        }
        if (bucket === 'hot') entry.bytesHot += size
        else entry.bytesCold += size
        entry.fileCount += 1
      }

      scanned++
      if (reportProgress) broadcast(usageProgressChannel, { scanned, total })
    }

    let totalBytes = 0
    let totalHot = 0
    let totalCold = 0
    let totalFiles = 0
    const perAnime = [...accum.values()]
      .map((a) => {
        const bytes = a.bytesHot + a.bytesCold
        totalBytes += bytes
        totalHot += a.bytesHot
        totalCold += a.bytesCold
        totalFiles += a.fileCount
        const episodes = [...a.episodes.entries()]
          .map(([episodeInt, ep]) => {
            const wp = watchProgress[`${a.animeId}:${episodeInt}`]
            return {
              episodeInt,
              files: ep.files,
              totalBytes: ep.totalBytes,
              watched: !!wp?.watched,
              watchedAt: wp?.watchedAt
            }
          })
          .sort((x, y) => Number(x.episodeInt) - Number(y.episodeInt))
        return {
          animeId: a.animeId,
          animeName: a.animeName,
          posterUrlSmall: a.posterUrlSmall,
          bytes,
          bytesHot: a.bytesHot,
          bytesCold: a.bytesCold,
          fileCount: a.fileCount,
          episodes
        }
      })
      .sort((x, y) => y.bytes - x.bytes)

    return { totalBytes, bytesHot: totalHot, bytesCold: totalCold, fileCount: totalFiles, perAnime }
  }

  return { getDownloadDir, getColdStorageDir, isAdvanced, dirsForScan, scanUsage }
}
