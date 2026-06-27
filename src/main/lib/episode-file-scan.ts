// Episode-file scan cache backing `CHANNELS.FILE_CHECK_EPISODES` (#196).
//
// Extracted out of `src/main/index.ts` so the cache-first / async-first-scan /
// concurrent-dedupe behavior is unit-testable (index.ts is excluded from the
// coverage gate and pulls in electron). The cache + helpers live here because
// `coldStorageService` and `skipAnalysisService` also feed off the synchronous
// `scanEpisodeFiles` scanner.
//
// Two scanners, deliberately:
//   - `scanEpisodeFiles`      — synchronous (`readdirSync`), injected into
//     skip-analysis + cold-storage which call it synchronously.
//   - `scanEpisodeFilesAsync` — `fsPromises.readdir`, used by the
//     `checkEpisodeFiles` first-hit path + the background rescan so the first
//     per-anime scan never stalls the single-threaded main process.
// Both fold filenames through the shared `accumulateEpisodeFiles` parser so the
// author-tag / legacy-filename matching can't drift between them.

import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'

/**
 * Map of episode base-name (sanitized `${anime} - NN`) → matched files on disk.
 * Produced by the episode-file scanner and (after `filterScanResult`) returned
 * verbatim by `CHANNELS.FILE_CHECK_EPISODES`.
 */
export type FileCheckResult = Record<
  string,
  { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
>

/**
 * Fold one anime directory's filenames into the running scan result. Matches
 * author-tagged `Name - NN [Author].mkv` first, then legacy un-tagged
 * `Name - NN.mkv`. Shared by the sync + async scanners.
 */
export function accumulateEpisodeFiles(
  result: FileCheckResult,
  animeDir: string,
  files: string[]
): void {
  for (const file of files) {
    const match = file.match(/^(.+?) \[(.+?)\]\.(mkv|mp4)$/)
    if (match) {
      const base = match[1]
      const author = match[2]
      const ext = match[3] as 'mkv' | 'mp4'
      if (!result[base]) result[base] = []
      const existing = result[base].find((e) => e.author === author)
      if (existing) {
        existing.type = ext
        existing.filePath = path.join(animeDir, file)
      } else {
        result[base].push({ type: ext, filePath: path.join(animeDir, file), author })
      }
      continue
    }

    const legacyMatch = file.match(/^(.+)\.(mkv|mp4)$/)
    if (legacyMatch) {
      const base = legacyMatch[1]
      const ext = legacyMatch[2] as 'mkv' | 'mp4'
      if (!result[base]) result[base] = []
      const hasAuthorVersion = result[base].some((e) => e.author)
      if (!hasAuthorVersion || !result[base].some((e) => !e.author)) {
        const existing = result[base].find((e) => !e.author)
        if (existing) {
          existing.type = ext
          existing.filePath = path.join(animeDir, file)
        } else {
          result[base].push({ type: ext, filePath: path.join(animeDir, file) })
        }
      }
    }
  }
}

/** Narrow a full per-anime scan down to the requested episode-ints. */
export function filterScanResult(
  fullResult: FileCheckResult,
  animeName: string,
  episodeInts: string[],
  sanitizeFilename: (name: string) => string
): FileCheckResult {
  const baseMap = new Map<string, string>()
  for (const epInt of episodeInts) {
    const padded = epInt.padStart(2, '0')
    const base = sanitizeFilename(`${animeName} - ${padded}`)
    baseMap.set(base, epInt)
  }

  const filtered: FileCheckResult = {}
  for (const [base, files] of Object.entries(fullResult)) {
    const epInt = baseMap.get(base)
    if (epInt) filtered[epInt] = files
  }
  return filtered
}

export interface EpisodeFileScanDeps {
  /** Directories to scan for an anime (download dir + optional cold-storage dir). */
  getDirsToScan: () => string[]
  sanitizeFilename: (name: string) => string
  /** Emitted by a background rescan when the on-disk set changed since the cache. */
  onEpisodesChanged: (animeName: string, result: FileCheckResult) => void
}

export interface EpisodeFileScanner {
  /** Synchronous full scan — consumed by skip-analysis + cold-storage. */
  scanEpisodeFiles: (animeName: string) => FileCheckResult
  /** Async full scan — backs the first-hit path + background rescan. */
  scanEpisodeFilesAsync: (animeName: string) => Promise<FileCheckResult>
  /**
   * Cache-first episode-file check. Cache hit → serve immediately + kick a
   * background rescan; cache miss → async scan, deduped so concurrent misses
   * for the same anime share one scan + one cache write.
   */
  checkEpisodeFiles: (animeName: string, episodeInts: string[]) => Promise<FileCheckResult>
  backgroundRescan: (animeName: string) => Promise<void>
  /** Drop a single anime's cache entry (after a download/merge/delete). */
  invalidate: (animeName: string) => void
  /** Drop the entry whose key sanitizes to `dirName` (after a path-keyed delete). */
  invalidateByDirName: (dirName: string) => void
  /** Clear the whole cache (before a bulk move-to-cold). */
  clear: () => void
}

export function createEpisodeFileScanner(deps: EpisodeFileScanDeps): EpisodeFileScanner {
  const { getDirsToScan, sanitizeFilename, onEpisodesChanged } = deps
  const fileCheckCache = new Map<string, FileCheckResult>()
  // In-flight scans keyed by animeName: concurrent misses (back-nav, parallel
  // openers) share one disk scan + one cache write instead of double-scanning.
  const inFlight = new Map<string, Promise<FileCheckResult>>()

  function scanEpisodeFiles(animeName: string): FileCheckResult {
    const animeDirName = sanitizeFilename(animeName)
    const result: FileCheckResult = {}
    for (const dir of getDirsToScan()) {
      const animeDir = path.join(dir, animeDirName)
      if (!fs.existsSync(animeDir)) continue
      let files: string[]
      try {
        files = fs.readdirSync(animeDir)
      } catch {
        continue
      }
      accumulateEpisodeFiles(result, animeDir, files)
    }
    return result
  }

  async function scanEpisodeFilesAsync(animeName: string): Promise<FileCheckResult> {
    const animeDirName = sanitizeFilename(animeName)
    const result: FileCheckResult = {}
    for (const dir of getDirsToScan()) {
      const animeDir = path.join(dir, animeDirName)
      let files: string[]
      try {
        files = await fsPromises.readdir(animeDir)
      } catch {
        continue
      }
      accumulateEpisodeFiles(result, animeDir, files)
    }
    return result
  }

  function normalize(r: FileCheckResult): FileCheckResult {
    const sorted: FileCheckResult = {}
    for (const key of Object.keys(r).sort()) {
      sorted[key] = [...r[key]].sort((a, b) => (a.author || '').localeCompare(b.author || ''))
    }
    return sorted
  }

  async function backgroundRescan(animeName: string): Promise<void> {
    const result = await scanEpisodeFilesAsync(animeName)
    const cached = fileCheckCache.get(animeName)
    const newJson = JSON.stringify(normalize(result))
    const cachedJson = cached ? JSON.stringify(normalize(cached)) : ''
    if (newJson !== cachedJson) {
      fileCheckCache.set(animeName, result)
      onEpisodesChanged(animeName, result)
    }
  }

  async function checkEpisodeFiles(
    animeName: string,
    episodeInts: string[]
  ): Promise<FileCheckResult> {
    const cached = fileCheckCache.get(animeName)
    if (cached) {
      backgroundRescan(animeName).catch((err) => console.error('Background rescan failed:', err))
      return filterScanResult(cached, animeName, episodeInts, sanitizeFilename)
    }

    let scan = inFlight.get(animeName)
    if (!scan) {
      // `scan` is assigned synchronously before either callback can run, so it's
      // safe to compare against the live in-flight entry inside them. If an
      // `invalidate`/`clear` (download/merge/move/delete) drops this entry while
      // the scan is pending, we must NOT write the now-stale result back over the
      // delete — only the current in-flight scan is allowed to populate the cache.
      // The awaiting caller still gets `result` returned; we just suppress the
      // stale WRITE. A superseding scan's finally likewise can't evict a newer one.
      scan = scanEpisodeFilesAsync(animeName)
        .then((result) => {
          if (inFlight.get(animeName) === scan) fileCheckCache.set(animeName, result)
          return result
        })
        .finally(() => {
          if (inFlight.get(animeName) === scan) inFlight.delete(animeName)
        })
      inFlight.set(animeName, scan)
    }
    const fullResult = await scan
    return filterScanResult(fullResult, animeName, episodeInts, sanitizeFilename)
  }

  function invalidate(animeName: string): void {
    fileCheckCache.delete(animeName)
    // Drop any in-flight scan too, so its `.then` can't repopulate the cache
    // with the pre-invalidation (stale) result after this delete.
    inFlight.delete(animeName)
  }

  function invalidateByDirName(dirName: string): void {
    for (const [key] of fileCheckCache) {
      if (sanitizeFilename(key) === dirName) {
        fileCheckCache.delete(key)
        inFlight.delete(key)
        break
      }
    }
  }

  function clear(): void {
    fileCheckCache.clear()
    inFlight.clear()
  }

  return {
    scanEpisodeFiles,
    scanEpisodeFilesAsync,
    checkEpisodeFiles,
    backgroundRescan,
    invalidate,
    invalidateByDirName,
    clear
  }
}
