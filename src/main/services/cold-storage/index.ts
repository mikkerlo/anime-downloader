import * as fs from 'fs'
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

export interface CleanupCandidate {
  animeId: number
  animeName: string
  episodeInt: string
  bytes: number
  watchedAt: number
}

export interface CleanupResult {
  ranAt: number
  deletedCount: number
  freedBytes: number
  items: CleanupCandidate[]
}

export type ColdStorageScanFileCheckResult = Record<
  string,
  { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
>

export interface ColdStorageServiceDeps {
  store: StorageService
  /** Fallback root when `downloadDir` is empty — `app.getPath('downloads')`. */
  downloadsFallbackDir: string
  sanitizeFilename: (s: string) => string
  parseEpisodeFromFilename: (
    file: string
  ) => { episodeInt: string; ext: 'mkv' | 'mp4' | 'ass' } | null
  /** Used by runWatchedCleanup to surface fresh file-episode maps to the renderer. */
  scanEpisodeFiles: (animeName: string) => ColdStorageScanFileCheckResult
  /** Invalidate index.ts's session-level scan cache for one anime (after a delete). */
  invalidateFileCache: (animeName: string) => void
  broadcast: (channel: string, ...args: unknown[]) => void
  /** Event channel for STORAGE_USAGE_PROGRESS. */
  usageProgressChannel: string
  /** Event channel for STORAGE_CLEANUP_PENDING — fired when confirm-required and !force. */
  cleanupPendingChannel: string
  /** Event channel for STORAGE_CLEANUP_FINISHED — fired after a successful run. */
  cleanupFinishedChannel: string
  /** Event channel for FILE_EPISODES_CHANGED — per-anime refresh after cleanup deletes. */
  fileEpisodesChangedChannel: string
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

  /**
   * Delete an episode's media + subtitle files across all storage roots.
   * If `translationId` is provided, only the matching tagged variants are removed
   * (plus its legacy un-tagged twin); otherwise every file matching the episode
   * base prefix goes. Always updates `downloadedEpisodes` when `animeId` is known.
   */
  deleteEpisodeFiles(
    animeName: string,
    episodeInt: string,
    animeId?: number,
    translationId?: number
  ): { bytesDeleted: number }
  /** True iff any `*.part` file for this episode is present across the storage roots. */
  episodeHasInProgressDownload(animeName: string, episodeInt: string): boolean
  /**
   * Drop `downloadedEpisodes[animeId:episodeInt:translationId]` (and the legacy
   * unkeyed twin pointing at the same translation) when no file for that
   * translation exists on disk. Called after cancel / cancel-by-episode.
   */
  pruneDownloadedEpisode(
    animeId: number,
    episodeInt: string,
    translationId: number,
    animeName: string,
    author: string
  ): void
  /** True iff a `.mkv` or `.mp4` for `(animeName, episodeInt, author)` exists in any storage root. */
  episodeFileExists(animeName: string, episodeInt: string, author: string): boolean
  /** Move every file matching one episode's base prefix from hot to cold. */
  moveEpisodeToColdStorage(animeName: string, episodeLabel: string): Promise<void>
  /** Move every finished file from the hot root into cold, with progress callback. */
  moveAllFilesToColdStorage(
    onProgress?: (current: number, total: number, file: string) => void
  ): Promise<{ moved: number; failed: string[] }>
  /** Resolve which watched episodes are old enough + still on disk to be cleanup targets. */
  findCleanupCandidates(days: number): CleanupCandidate[]
  /**
   * Resolve candidates, broadcast pending if confirmation required, otherwise
   * delete + log + broadcast finished. Idempotent: concurrent calls return a no-op.
   */
  runWatchedCleanup(force?: boolean): Promise<CleanupResult>
}

export function createColdStorageService(deps: ColdStorageServiceDeps): ColdStorageService {
  const {
    store,
    downloadsFallbackDir,
    sanitizeFilename,
    parseEpisodeFromFilename,
    scanEpisodeFiles,
    invalidateFileCache,
    broadcast,
    usageProgressChannel,
    cleanupPendingChannel,
    cleanupFinishedChannel,
    fileEpisodesChangedChannel
  } = deps

  let cleanupRunning = false

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

  function deleteEpisodeFiles(
    animeName: string,
    episodeInt: string,
    animeId?: number,
    translationId?: number
  ): { bytesDeleted: number } {
    invalidateFileCache(animeName)
    const animeDirName = sanitizeFilename(animeName)
    const dirsToCheck = dirsForScan()

    const padded = episodeInt.padStart(2, '0')
    const base = sanitizeFilename(`${animeName} - ${padded}`)

    let bytesDeleted = 0
    const trySize = (p: string): number => {
      try {
        return fs.statSync(p).size
      } catch {
        return 0
      }
    }

    if (translationId && animeId) {
      // Delete specific translation's files — find by author tag from metadata
      const episodes = store.get('downloadedEpisodes') as Record<
        string,
        { translationType: string; author: string; quality: number; translationId: number }
      >
      const metaKey = `${animeId}:${episodeInt}:${translationId}`
      const legacyKey = `${animeId}:${episodeInt}`
      const meta = episodes[metaKey] || episodes[legacyKey]
      if (meta) {
        const authorTag = sanitizeFilename(meta.author)
        const taggedBase = `${base} [${authorTag}]`
        for (const dir of dirsToCheck) {
          const animeDir = path.join(dir, animeDirName)
          for (const ext of ['.mkv', '.mp4', '.ass']) {
            const taggedPath = path.join(animeDir, `${taggedBase}${ext}`)
            const tSize = trySize(taggedPath)
            try {
              fs.unlinkSync(taggedPath)
              bytesDeleted += tSize
            } catch {
              /* ignore */
            }
            const legacyPath = path.join(animeDir, `${base}${ext}`)
            const lSize = trySize(legacyPath)
            try {
              fs.unlinkSync(legacyPath)
              bytesDeleted += lSize
            } catch {
              /* ignore */
            }
          }
        }
        delete episodes[metaKey]
        delete episodes[legacyKey]
        store.set('downloadedEpisodes', episodes)
      }
    } else {
      for (const dir of dirsToCheck) {
        const animeDir = path.join(dir, animeDirName)
        try {
          const files = fs.readdirSync(animeDir)
          for (const file of files) {
            if (
              file.startsWith(base) &&
              (file.endsWith('.mkv') || file.endsWith('.mp4') || file.endsWith('.ass'))
            ) {
              const fp = path.join(animeDir, file)
              const sz = trySize(fp)
              try {
                fs.unlinkSync(fp)
                bytesDeleted += sz
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* dir doesn't exist */
        }
      }

      if (animeId) {
        const episodes = store.get('downloadedEpisodes') as Record<string, unknown>
        const prefix = `${animeId}:${episodeInt}`
        for (const key of Object.keys(episodes)) {
          if (key === prefix || key.startsWith(prefix + ':')) {
            delete episodes[key]
          }
        }
        store.set('downloadedEpisodes', episodes)
      }
    }

    return { bytesDeleted }
  }

  function episodeHasInProgressDownload(animeName: string, episodeInt: string): boolean {
    const animeDirName = sanitizeFilename(animeName)
    const padded = episodeInt.padStart(2, '0')
    const base = sanitizeFilename(`${animeName} - ${padded}`)
    for (const dir of dirsForScan()) {
      const animeDir = path.join(dir, animeDirName)
      try {
        const files = fs.readdirSync(animeDir)
        for (const file of files) {
          if (file.startsWith(base) && file.endsWith('.part')) return true
        }
      } catch {
        /* dir missing */
      }
    }
    return false
  }

  function pruneDownloadedEpisode(
    animeId: number,
    episodeInt: string,
    translationId: number,
    animeName: string,
    author: string
  ): void {
    if (episodeFileExists(animeName, episodeInt, author)) return
    const episodes = store.get('downloadedEpisodes') as Record<
      string,
      { translationType: string; author: string; quality: number; translationId: number }
    >
    const key = `${animeId}:${episodeInt}:${translationId}`
    const legacyKey = `${animeId}:${episodeInt}`
    let changed = false
    if (key in episodes) {
      delete episodes[key]
      changed = true
    }
    if (episodes[legacyKey]?.translationId === translationId) {
      delete episodes[legacyKey]
      changed = true
    }
    if (changed) store.set('downloadedEpisodes', episodes)
  }

  function episodeFileExists(animeName: string, episodeInt: string, author: string): boolean {
    const animeDirName = sanitizeFilename(animeName)
    const padded = episodeInt.padStart(2, '0')
    const base = sanitizeFilename(`${animeName} - ${padded}`)
    const authorTag = sanitizeFilename(author || '')
    const taggedBase = authorTag ? `${base} [${authorTag}]` : base
    for (const dir of dirsForScan()) {
      const animeDir = path.join(dir, animeDirName)
      for (const candidate of [
        `${taggedBase}.mkv`,
        `${taggedBase}.mp4`,
        `${base}.mkv`,
        `${base}.mp4`
      ]) {
        if (fs.existsSync(path.join(animeDir, candidate))) return true
      }
    }
    return false
  }

  async function moveFileToCold(src: string, dest: string): Promise<void> {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
      fs.renameSync(src, dest)
    } catch {
      // Cross-filesystem: copy + delete
      await fsPromises.copyFile(src, dest)
      fs.unlinkSync(src)
    }
  }

  async function moveEpisodeToColdStorage(animeName: string, episodeLabel: string): Promise<void> {
    const coldDir = getColdStorageDir()
    if (!coldDir) return
    const hotDir = getDownloadDir()

    const animeDirName = sanitizeFilename(animeName)
    const hotAnimeDir = path.join(hotDir, animeDirName)
    const coldAnimeDir = path.join(coldDir, animeDirName)

    if (!fs.existsSync(hotAnimeDir)) return

    // episodeLabel is like "01", we need to find matching files
    const padded = episodeLabel.padStart(2, '0')
    const base = sanitizeFilename(`${animeName} - ${padded}`)

    // Move all files matching this episode base (including [Author] tagged variants)
    try {
      const files = fs.readdirSync(hotAnimeDir)
      for (const file of files) {
        if (!file.startsWith(base)) continue
        if (!['.mkv', '.mp4', '.ass'].some((ext) => file.endsWith(ext))) continue
        // Never move .part files or files with in-progress downloads
        if (file.endsWith('.mp4') && fs.existsSync(path.join(hotAnimeDir, file + '.part'))) continue
        const src = path.join(hotAnimeDir, file)
        await moveFileToCold(src, path.join(coldAnimeDir, file))
      }
    } catch {
      /* dir listing failed */
    }
  }

  async function moveAllFilesToColdStorage(
    onProgress?: (current: number, total: number, file: string) => void
  ): Promise<{ moved: number; failed: string[] }> {
    const coldDir = getColdStorageDir()
    const hotDir = getDownloadDir()
    const result = { moved: 0, failed: [] as string[] }

    if (!coldDir || !fs.existsSync(hotDir)) return result

    // Collect all finished files
    const filesToMove: { src: string; dest: string; label: string }[] = []
    const animeDirs = fs.readdirSync(hotDir, { withFileTypes: true }).filter((d) => d.isDirectory())

    for (const dir of animeDirs) {
      const dirPath = path.join(hotDir, dir.name)
      const files = fs.readdirSync(dirPath)

      for (const file of files) {
        // Skip .part files (in-progress downloads)
        if (file.endsWith('.part')) continue
        // Skip mp4 if a .part exists (download in progress)
        if (file.endsWith('.mp4') && files.includes(file + '.part')) continue
        // Only move media/subtitle files
        if (!['.mkv', '.mp4', '.ass'].some((ext) => file.endsWith(ext))) continue

        filesToMove.push({
          src: path.join(dirPath, file),
          dest: path.join(coldDir, dir.name, file),
          label: `${dir.name}/${file}`
        })
      }
    }

    for (let i = 0; i < filesToMove.length; i++) {
      const item = filesToMove[i]
      onProgress?.(i + 1, filesToMove.length, item.label)
      try {
        await moveFileToCold(item.src, item.dest)
        result.moved++
      } catch (err) {
        result.failed.push(`${item.label}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return result
  }

  function findCleanupCandidates(days: number): CleanupCandidate[] {
    if (!days || days <= 0) return []
    const watchProgress = store.get('watchProgress') as Record<
      string,
      { watched?: boolean; watchedAt?: number }
    >
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    const cutoff = Date.now() - days * 86400_000
    const candidates: CleanupCandidate[] = []

    for (const [key, entry] of Object.entries(watchProgress)) {
      if (!entry.watched || !entry.watchedAt || entry.watchedAt > cutoff) continue
      const sep = key.indexOf(':')
      if (sep < 0) continue
      const animeId = key.slice(0, sep)
      const episodeInt = key.slice(sep + 1)
      const anime = downloaded[animeId]
      if (!anime) continue
      const animeName = anime.titles?.romaji || anime.titles?.ru || anime.title
      if (!animeName) continue
      if (episodeHasInProgressDownload(animeName, episodeInt)) continue

      const animeDirName = sanitizeFilename(animeName)
      const padded = episodeInt.padStart(2, '0')
      const base = sanitizeFilename(`${animeName} - ${padded}`)
      let bytes = 0
      let hasFile = false
      for (const dir of dirsForScan()) {
        const animeDir = path.join(dir, animeDirName)
        try {
          const files = fs.readdirSync(animeDir)
          for (const file of files) {
            if (
              file.startsWith(base) &&
              (file.endsWith('.mkv') || file.endsWith('.mp4') || file.endsWith('.ass'))
            ) {
              hasFile = true
              try {
                bytes += fs.statSync(path.join(animeDir, file)).size
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* dir missing */
        }
      }
      if (!hasFile) continue
      candidates.push({
        animeId: Number(animeId),
        animeName,
        episodeInt,
        bytes,
        watchedAt: entry.watchedAt
      })
    }
    return candidates
  }

  async function runWatchedCleanup(force = false): Promise<CleanupResult> {
    const ranAt = Date.now()
    if (cleanupRunning) return { ranAt, deletedCount: 0, freedBytes: 0, items: [] }
    cleanupRunning = true
    try {
      const days = store.get('autoCleanupWatchedDays') as number
      if ((!days || days <= 0) && !force) {
        return { ranAt, deletedCount: 0, freedBytes: 0, items: [] }
      }
      const candidates = findCleanupCandidates(days)
      if (candidates.length === 0) {
        return { ranAt, deletedCount: 0, freedBytes: 0, items: [] }
      }

      const requireConfirm = store.get('autoCleanupConfirm') as boolean
      if (requireConfirm && !force) {
        broadcast(cleanupPendingChannel, { candidates })
        return { ranAt, deletedCount: 0, freedBytes: 0, items: [] }
      }

      const affectedAnime = new Set<string>()
      let freedBytes = 0
      const log = store.get('cleanupLog') as Array<{
        ranAt: number
        animeId: number
        animeName: string
        episodeInt: string
        bytes: number
      }>
      const items: CleanupCandidate[] = []

      for (const c of candidates) {
        const { bytesDeleted } = deleteEpisodeFiles(c.animeName, c.episodeInt, c.animeId)
        freedBytes += bytesDeleted
        affectedAnime.add(c.animeName)
        log.unshift({
          ranAt,
          animeId: c.animeId,
          animeName: c.animeName,
          episodeInt: c.episodeInt,
          bytes: bytesDeleted
        })
        items.push({ ...c, bytes: bytesDeleted })
      }

      while (log.length > 100) log.pop()
      store.set('cleanupLog', log)

      const result: CleanupResult = { ranAt, deletedCount: items.length, freedBytes, items }
      store.set('autoCleanupLastRun', {
        ranAt,
        deletedCount: result.deletedCount,
        freedBytes: result.freedBytes
      })

      for (const animeName of affectedAnime) {
        try {
          const data = scanEpisodeFiles(animeName)
          broadcast(fileEpisodesChangedChannel, animeName, data)
        } catch {
          /* ignore */
        }
      }
      broadcast(cleanupFinishedChannel, result)
      return result
    } finally {
      cleanupRunning = false
    }
  }

  return {
    getDownloadDir,
    getColdStorageDir,
    isAdvanced,
    dirsForScan,
    scanUsage,
    deleteEpisodeFiles,
    episodeHasInProgressDownload,
    pruneDownloadedEpisode,
    episodeFileExists,
    moveEpisodeToColdStorage,
    moveAllFilesToColdStorage,
    findCleanupCandidates,
    runWatchedCleanup
  }
}
