import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import { join } from 'path'
import { EPISODE_ARTIFACT_EXTS } from '@shared/episode-files'
import { ROOT_KEYS } from '@shared/storage-roots'
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

export type ColdStorageScanFileCheckResult = Record<string, EpisodeFileEntry[]>

export interface ColdStorageServiceDeps {
  store: StorageService
  /** Fallback root when `downloadDir` is empty — `app.getPath('downloads')`. */
  downloadsFallbackDir: string
  sanitizeFilename: (s: string) => string
  parseEpisodeFromFilename: (file: string) => { episodeInt: string; ext: EpisodeArtifactExt } | null
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
  /**
   * Which stored key `getDownloadDir()` resolves **through** right now (#451):
   * `hotStorageDir` in advanced mode with one set, `downloadDir` otherwise.
   *
   * The key a root move has to write, and the one `storage:rebind-root` reports
   * so the renderer never re-derives the rule. Derived from the same predicate
   * `resolveDownloadDir` branches on rather than restating it, for the reason
   * `downloadDirWith` exists: a second copy of "simple mode means `downloadDir`
   * is the root" is what #443 removed.
   *
   * The fallback has no key of its own, so an empty `downloadDir` still answers
   * `downloadDir` — writing it is exactly what replaces the fallback.
   */
  effectiveRootKey(): StorageRootKey
  /**
   * What `getDownloadDir()` **would** answer if `key` held `value` (#447).
   *
   * The two root-moving pickers need to know whether the path the user picked
   * actually moves the effective root before they decide to refuse, and they
   * have to know it *without* writing the store — a refusal writes nothing at
   * all. Asking the resolver a hypothetical keeps the fall-through rule in one
   * place; a picker that worked it out itself ("simple mode means `downloadDir`
   * is the root") would be a second copy of `getDownloadDir()`, which is what
   * #443 removed.
   *
   * `coldStorageDir` is accepted and answered truthfully — it is not an input
   * to the resolution, so it always answers the current root unchanged.
   */
  downloadDirWith(key: StorageRootKey, value: string): string
  /** Configured cold-storage root, or `''` if not set. */
  getColdStorageDir(): string
  /** `storageMode === 'advanced'`. */
  isAdvanced(): boolean
  /** Hot + cold roots, in scan order. */
  dirsForScan(): string[]
  /**
   * Every root the app has ever written into, **independent of `storageMode`**:
   * `downloadDir` (or the fallback when it is empty), `hotStorageDir` and
   * `coldStorageDir`, empties dropped and de-duplicated (#421).
   *
   * Deliberately NOT routed through `getDownloadDir()`, which returns
   * `hotStorageDir` in advanced mode and would therefore drop `downloadDir` —
   * exactly the root that holds everything downloaded before the user switched
   * to advanced mode. Deliberately NOT `dirsForScan()` either: that one is
   * mode-scoped on purpose because `CLEANUP_EXECUTE` feeds it to a recursive
   * `fs.rmSync`, so widening it would turn a stale `coldStorageDir` into file
   * loss. This list is only ever read, never deleted from.
   */
  allConfiguredRoots(): string[]
  /**
   * The first configured, **non-empty stored** root that is not on disk, or
   * `null` when they are all reachable (#421).
   *
   * Guards the two metadata-deleting callers of `episodeFileExists`: a root that
   * is away (unmounted drive, re-pointed setting) makes the predicate answer a
   * false `false` for every file inside it, so deleting on that answer is bulk,
   * irreversible loss.
   *
   * The `downloadsFallbackDir` fallback is exempt, and that exemption is
   * load-bearing: `downloadDir` defaults to `''`, and a profile that went
   * straight to advanced mode has never created `<downloads>/anime-dl`, so
   * including it would report a missing root on every call and disable the GC
   * permanently. Omitting it is safe by construction — if the path does not
   * exist, no file can be inside it.
   */
  missingConfiguredRoot(): string | null
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
   * No-op while any configured root is missing (#421).
   */
  pruneDownloadedEpisode(
    animeId: number,
    episodeInt: string,
    translationId: number,
    animeName: string,
    author: string
  ): void
  /**
   * Whole-store counterpart to `pruneDownloadedEpisode`: walk every
   * `downloadedEpisodes` entry once and drop the ones with no file on disk.
   * This is the *only* place that collection happens now —
   * `downloaded-episodes-get` filters its return value and never writes (#423),
   * so a page open can no longer delete persisted state. Hosted by a delayed
   * startup sweep in `bootstrap`, which is a moment that is allowed to write.
   *
   * `activeTranslationIds` is passed in rather than injected: this service is
   * constructed before `DownloadManager` exists, and the set has to be read at
   * sweep time anyway. It is not optional — `loadQueue` restores interrupted
   * items as `paused` and `getEpisodeGroups` skips only `cancelled`, so a video
   * that finished but was still parked as `.part` under the player lock at quit
   * has metadata and no final file at launch. Without the exemption every such
   * launch would delete it.
   *
   * Entries whose `animeId` has no `downloadedAnime` record are skipped, same as
   * the getter's filter has always done. No-op while any configured root is
   * missing (#421), same guard as `pruneDownloadedEpisode`.
   */
  reconcileDownloadedEpisodes(activeTranslationIds: ReadonlySet<number>): {
    kept: number
    dropped: number
  }
  /**
   * True iff a `.mkv` or `.mp4` for `(animeName, episodeInt, author)` exists in
   * any **configured** root — `allConfiguredRoots()`, not the mode-scoped
   * `dirsForScan()`, so a `storageMode` flip cannot hide a file that is on disk
   * (#421). Both callers use the answer to decide whether to delete metadata,
   * so both want the wide one.
   */
  episodeFileExists(animeName: string, episodeInt: string, author: string): boolean
  /**
   * Move one episode's files — `.mkv`, `.mp4`, `.ass` — from hot to cold, by
   * their **exact** names: `<anime> - NN [author].ext` as `enqueue` writes them,
   * plus the legacy untagged `<anime> - NN.ext` twin. Takes `episodeInt` (the
   * field the on-disk `NN` derives from), not `episodeLabel`, and scopes the
   * match to one author so a sibling translation is left alone (#416).
   * A per-file failure is logged and the rest still move (#414).
   */
  moveEpisodeToColdStorage(animeName: string, episodeInt: string, author: string): Promise<void>
  /**
   * Move exactly one file from hot to cold, named by its **download-dir-relative**
   * path — anime directory included, as `download-manager`'s `filename` fields
   * carry it. Narrower than `moveEpisodeToColdStorage`, which is scoped to an
   * episode+author rather than to a single file (#414, #416).
   * A failed move is logged and resolves, like `moveEpisodeToColdStorage`'s.
   */
  moveFileToColdByRelPath(relPath: string): Promise<void>
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

  /**
   * Which of the two root keys wins, over a value rather than over the store.
   *
   * Split out of `resolveDownloadDir` (#451) rather than restated beside it:
   * `effectiveRootKey()` has to name the key a root move must write, and the
   * mode+hot-set condition is the whole of that answer. Two copies of it could
   * disagree — the resolver resolving through `hotStorageDir` while a handler
   * writes `downloadDir` — which is the class of defect #443 and #447 both
   * closed by routing every caller through one rule.
   */
  function resolveRootKey(hotDir: string): StorageRootKey {
    const mode = store.get('storageMode') as string
    return mode === 'advanced' && hotDir ? 'hotStorageDir' : 'downloadDir'
  }

  /**
   * The hot → `downloadDir` → fallback chain, over values rather than over the
   * store. Both entry points below go through it so the rule is stated once
   * (#447): `getDownloadDir()` reads the live keys, `downloadDirWith()` swaps
   * one of them for a value that has not been written.
   */
  function resolveDownloadDir(hotDir: string, dir: string): string {
    if (resolveRootKey(hotDir) === 'hotStorageDir') return hotDir
    if (dir) return dir
    return join(downloadsFallbackDir, 'anime-dl')
  }

  function effectiveRootKey(): StorageRootKey {
    return resolveRootKey(store.get('hotStorageDir') as string)
  }

  function getDownloadDir(): string {
    return resolveDownloadDir(
      store.get('hotStorageDir') as string,
      store.get('downloadDir') as string
    )
  }

  function downloadDirWith(key: StorageRootKey, value: string): string {
    return resolveDownloadDir(
      key === 'hotStorageDir' ? value : (store.get('hotStorageDir') as string),
      key === 'downloadDir' ? value : (store.get('downloadDir') as string)
    )
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

  function allConfiguredRoots(): string[] {
    const downloadDir =
      (store.get('downloadDir') as string) || join(downloadsFallbackDir, 'anime-dl')
    const hotDir = (store.get('hotStorageDir') as string) || ''
    const coldDir = getColdStorageDir()
    return [...new Set([downloadDir, hotDir, coldDir].filter(Boolean))]
  }

  function missingConfiguredRoot(): string | null {
    // Keys from `ROOT_KEYS`, values raw — deliberately not `allConfiguredRoots()`,
    // which adds the fallback. The fallback must stay out of this check (see the
    // interface doc), so the two lists still have to be able to shrink
    // independently; sourcing the *key list* from the shared array does not
    // change that, it only stops this copy from being the one place a fourth
    // root key could be forgotten (#454).
    const storedRoots = ROOT_KEYS.map((key) => (store.get(key) as string) || '').filter(Boolean)
    for (const root of storedRoots) {
      if (!fs.existsSync(root)) return root
    }
    return null
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
          for (const ext of EPISODE_ARTIFACT_EXTS) {
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
            if (file.startsWith(base) && EPISODE_ARTIFACT_EXTS.some((ext) => file.endsWith(ext))) {
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
    const missingRoot = missingConfiguredRoot()
    if (missingRoot) {
      console.warn(
        `[storage] skipping downloadedEpisodes prune — configured root is missing: ${missingRoot}`
      )
      return
    }
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

  function reconcileDownloadedEpisodes(activeTranslationIds: ReadonlySet<number>): {
    kept: number
    dropped: number
  } {
    // Same guard as the prune above, for the same reason: an away root makes
    // `episodeFileExists` answer a false `false` for everything inside it, and
    // this pass persists its verdict over the whole library (#421).
    const missingRoot = missingConfiguredRoot()
    if (missingRoot) {
      console.warn(
        `[storage] skipping downloadedEpisodes reconcile — configured root is missing: ${missingRoot}`
      )
      return { kept: 0, dropped: 0 }
    }

    const episodes = store.get('downloadedEpisodes') as Record<
      string,
      { translationType: string; author: string; quality: number; translationId: number }
    >
    const downloaded = store.get('downloadedAnime') as Record<string, AnimeSearchResult>
    let kept = 0
    let dropped = 0

    for (const [key, entry] of Object.entries(episodes)) {
      const sep = key.indexOf(':')
      if (sep < 0) continue
      const animeId = key.slice(0, sep)
      // NOT `key.slice(sep + 1)`: `downloadedEpisodes` keys are
      // `animeId:episodeInt:translationId`, unlike `watchProgress`'s
      // `animeId:episodeInt`, so the rest of the key is not the episode. Parsed
      // the way the getter does, falling back to the whole remainder so legacy
      // two-part keys still resolve.
      const rest = key.slice(sep + 1)
      const colonIdx = rest.indexOf(':')
      const episodeInt = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest

      const anime = downloaded[animeId]
      if (!anime) continue
      const animeName = anime.titles?.romaji || anime.titles?.ru || anime.title
      if (!animeName) continue

      if (activeTranslationIds.has(entry.translationId)) {
        kept++
        continue
      }
      if (!episodeFileExists(animeName, episodeInt, entry.author)) {
        delete episodes[key]
        dropped++
        continue
      }
      kept++
    }

    if (dropped > 0) store.set('downloadedEpisodes', episodes)
    return { kept, dropped }
  }

  function episodeFileExists(animeName: string, episodeInt: string, author: string): boolean {
    const animeDirName = sanitizeFilename(animeName)
    const padded = episodeInt.padStart(2, '0')
    const base = sanitizeFilename(`${animeName} - ${padded}`)
    const authorTag = sanitizeFilename(author || '')
    const taggedBase = `${base} [${authorTag}]`
    for (const dir of allConfiguredRoots()) {
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

  async function moveEpisodeToColdStorage(
    animeName: string,
    episodeInt: string,
    author: string
  ): Promise<void> {
    const coldDir = getColdStorageDir()
    if (!coldDir) return
    const hotDir = getDownloadDir()

    const animeDirName = sanitizeFilename(animeName)
    const hotAnimeDir = path.join(hotDir, animeDirName)
    const coldAnimeDir = path.join(coldDir, animeDirName)

    if (!fs.existsSync(hotAnimeDir)) return

    // The exact names `enqueue` writes (`download-manager.ts`: `padStart(2,'0')`
    // then `sanitizeFilename(anime - NN)` + ` [sanitizeFilename(author)]`), plus
    // the legacy untagged twin that predates the tag and that nothing else will
    // ever collect. Built the way `deleteEpisodeFiles` builds it — the tag is
    // appended unconditionally, so an empty author matches the `[]` form that
    // `enqueue` really writes, not the bare base.
    //
    // This used to be a `startsWith(base)` prefix test, which was wrong three
    // ways (#416): the argument was `episodeLabel` (`"1 серия"` on real API
    // data, where the file is named from `episodeInt`, so nothing matched at
    // all); the prefix stopped before ` [author]`, so moving one translation
    // swept its siblings — which can still be mid-download; and it was
    // unbounded, so episode 10 also matched `- 100` and `- 10.5`.
    const padded = episodeInt.padStart(2, '0')
    const base = sanitizeFilename(`${animeName} - ${padded}`)
    const taggedBase = `${base} [${sanitizeFilename(author)}]`
    const wanted = new Set<string>()
    for (const ext of EPISODE_ARTIFACT_EXTS) {
      wanted.add(`${taggedBase}${ext}`)
      wanted.add(`${base}${ext}`)
    }

    // Filter the listing rather than iterating `wanted` and moving each name: a
    // missing candidate is the normal case (no `.mp4` survives a merge, legacy
    // twins usually do not exist). Iterating would not abandon the pass — the
    // per-file `catch` below is #414's — but `moveFileToCold`'s `copyFile`
    // fallback rejects ENOENT for a name that is not on disk, so every absent
    // candidate would log `[cold] Failed to move … ENOENT` and normal operation
    // would read as an error. Filtering also keeps the `.part` shadow guard
    // below reading the directory it already listed.
    try {
      const files = fs.readdirSync(hotAnimeDir)
      for (const file of files) {
        if (!wanted.has(file)) continue
        // Never move .part files or files with in-progress downloads
        if (file.endsWith('.mp4') && fs.existsSync(path.join(hotAnimeDir, file + '.part'))) continue
        const src = path.join(hotAnimeDir, file)
        // Per file, not per episode (#414). The bare outer catch used to
        // swallow the first failure and abandon every file behind it, so one
        // unmovable source left the merged .mkv sitting in hot with
        // autoMoveToCold on and nothing logged. Matches
        // moveAllFilesToColdStorage, which already collects per-file failures.
        try {
          await moveFileToCold(src, path.join(coldAnimeDir, file))
        } catch (err) {
          console.error(`[cold] Failed to move ${file} to cold storage:`, err)
        }
      }
    } catch {
      /* dir listing failed */
    }
  }

  async function moveFileToColdByRelPath(relPath: string): Promise<void> {
    const coldDir = getColdStorageDir()
    if (!coldDir) return
    // Resolve against the hot root the way every other cold-storage operation
    // does (getDownloadDir() re-reads storageMode / hotStorageDir / downloadDir
    // from the store), rather than trusting a path absolutised by the caller.
    const src = path.join(getDownloadDir(), relPath)
    if (!fs.existsSync(src)) return
    // Log and swallow, exactly as the per-file loop above does, so both movers
    // share one failure policy (#414). handleMergeComplete does not guard this
    // call, and DownloadManager's merge tail drops the promise it returns, so a
    // throw here would skip the merge notification and the skip-analysis
    // schedule and then surface as an unhandled rejection.
    try {
      await moveFileToCold(src, path.join(coldDir, relPath))
    } catch (err) {
      console.error(`[cold] Failed to move ${relPath} to cold storage:`, err)
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
        if (!EPISODE_ARTIFACT_EXTS.some((ext) => file.endsWith(ext))) continue

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
            if (file.startsWith(base) && EPISODE_ARTIFACT_EXTS.some((ext) => file.endsWith(ext))) {
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
    effectiveRootKey,
    downloadDirWith,
    getColdStorageDir,
    isAdvanced,
    dirsForScan,
    allConfiguredRoots,
    missingConfiguredRoot,
    scanUsage,
    deleteEpisodeFiles,
    episodeHasInProgressDownload,
    pruneDownloadedEpisode,
    reconcileDownloadedEpisodes,
    episodeFileExists,
    moveEpisodeToColdStorage,
    moveFileToColdByRelPath,
    moveAllFilesToColdStorage,
    findCleanupCandidates,
    runWatchedCleanup
  }
}
