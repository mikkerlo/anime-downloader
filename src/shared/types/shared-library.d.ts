// Shared domain types — the Shared Library on-drive format v1 (#573, epic #563).
// Ambient globals (see anime.ts header). `src/main/lib/shared-library/` reads
// and writes these; `docs/shared-library.md` describes the format.
//
// Every non-envelope field is optional in what the reader returns: a field that
// fails validation is left out (and written back raw by the writer), so a
// consumer has to handle a missing value.

type SharedLibraryMode = 'videos' | 'metadata'

/** Why `readLibrary` opened a library read-only. */
type SharedLibraryReadOnlyReason = 'version' | 'size' | 'interrupted'

interface SharedLibraryOwner {
  shikimoriId: number
  nickname?: string
}

interface SharedLibraryWriter {
  installId: string
  appVersion: string
  at: number
}

/** One title in the library's scope. */
interface SharedLibraryTitle {
  animeId: number
  name: string
}

/** One file in the library, keyed by `animeId:episodeInt:translationId`. */
interface SharedLibraryItem {
  animeId: number
  // Opaque, as in `downloadedEpisodes` keys (`"12.5"` included).
  episodeInt: string
  translationId: number
  translationType: string
  author: string
  quality: number
  // Relative to the library root, `/`-separated.
  path: string
  subtitlePath?: string
  size: number
  sha256?: string
}

interface SharedLibraryNaming {
  rule: 'v1'
  // Item keys whose names differ from the plain download-folder name.
  renamed: string[]
}

/** `.anime-dl/manifest.json` as the reader returns it. */
interface SharedLibraryManifest {
  layoutVersion: 1
  layoutMinor: number
  libraryId: string
  name?: string
  owner: SharedLibraryOwner | null
  mode: SharedLibraryMode
  generation: number
  stateGeneration: number | null
  lastWriter?: SharedLibraryWriter
  titles: SharedLibraryTitle[]
  items: SharedLibraryItem[]
  naming?: SharedLibraryNaming
}

/** What `writeManifest` / `createLibrary` take: the writer owns the rest. */
interface SharedLibraryManifestInput {
  libraryId: string
  name?: string
  owner: SharedLibraryOwner | null
  mode: SharedLibraryMode
  titles: SharedLibraryTitle[]
  items: SharedLibraryItem[]
  naming?: SharedLibraryNaming
}

/**
 * A `SyncDoc` as the reader returns it from a drive. The envelope's version
 * pair is authoritative, and every other doc-level field may be missing.
 */
interface SharedSyncDoc {
  stateVersion: 1
  stateMinor: number
  installId?: string
  titles?: Record<string, SyncTitleState>
  priorityOrder?: SyncField<string[]>
  tombstones?: SyncDoc['tombstones']
  [unknownField: string]: unknown
}

/** `.anime-dl/state.json`: the `SyncDoc` in its envelope. */
interface SharedLibraryState {
  stateVersion: 1
  stateMinor: number
  libraryId: string
  generation: number
  manifestGeneration: number
  doc: SharedSyncDoc
}

type SharedLibraryFile = 'manifest.json' | 'manifest.prev.json' | 'state.json' | 'state.prev.json'

type SharedLibraryRead =
  /** No `.anime-dl/manifest.json` or `manifest.prev.json`. */
  | { status: 'none' }
  | {
      status: 'read-only'
      reason: SharedLibraryReadOnlyReason
      message: string
      // The manifest still worth listing, or null when there is none (a newer
      // or over-cap `manifest.json`, or no valid manifest at all).
      manifest: SharedLibraryManifest | null
    }
  | {
      status: 'ok'
      manifest: SharedLibraryManifest
      mode: SharedLibraryMode
      state: SharedLibraryState | null
      stateInitialized: boolean
      // The reader settled on a `.prev` file; the next write repairs it.
      torn: boolean
      pair: { manifest: SharedLibraryFile; state: SharedLibraryFile | null }
    }

/** A `meta/<animeId>.json` metadata snapshot. */
interface SharedLibraryMeta {
  animeId: number
  malId?: number | null
  titles?: { ru?: string; romaji?: string; ja?: string; en?: string }
  genres?: { id: number; title: string }[]
  year?: number
  type?: string
  episodes?: { episodeInt: string; episodeFull?: string }[]
  searchResult?: AnimeSearchResult
}

type SharedLibraryMetaRead =
  | { status: 'ok'; meta: SharedLibraryMeta }
  | { status: 'missing' | 'size' | 'invalid' }

/** Who is writing: the writer checks ownership itself. */
interface SharedLibraryActor {
  installId: string
  appVersion: string
  shikimoriUserId: number | null
  claim: { libraryId: string; ownerId: number } | null
}

/** `resolveItem` / `resolveWriteTarget`: an absolute path, or why there is none. */
type SharedLibraryResolved = string | 'missing' | 'escapes'

// --- Export (S6a #574) -------------------------------------------------------------

/** One episode of one translation picked for export. */
interface ExportSelectionItem {
  animeId: number
  translationId: number
  episodeInt: string
}

/**
 * One episode in the export tree. `ready` is on disk; `missing` has a
 * `downloadedEpisodes` entry but no file; `busy` is merging, deferred or
 * still downloading, and is skipped.
 */
interface ExportTreeEpisode {
  key: string
  episodeInt: string
  label: string
  state: 'ready' | 'missing' | 'busy'
  /** Video plus `.ass` sidecar bytes; 0 unless `ready`. */
  size: number
  /** An unmerged `.mp4` + `.ass` pair, copied as both files. */
  unmerged: boolean
}

interface ExportTreeTranslation {
  translationId: number
  author: string
  translationType: string
  quality: number
  episodes: ExportTreeEpisode[]
}

interface ExportTreeTitle {
  animeId: number
  name: string
  translations: ExportTreeTranslation[]
  /** Episodes in the title's episode list with no download in any translation. */
  notDownloaded: { episodeInt: string; label: string }[]
}

/**
 * How the export would treat the chosen folder:
 * - `new`: no library there, one is created at `root`;
 * - `add`: a Videos-only library, added to (with `ownerNickname` set when it is
 *   the sibling an earlier export made next to a foreign library);
 * - `own-metadata`: a With metadata library owned by this PC's account, blocked
 *   until S6e (#586);
 * - `foreign`: a With metadata library owned by someone else (or claimed), never
 *   written; the export goes into a new library at `root`, next to it;
 * - `read-only`: a library this version can't write (a newer major, over a cap,
 *   or interrupted), blocked.
 */
type ExportTargetKind = 'new' | 'add' | 'own-metadata' | 'foreign' | 'read-only'

interface ExportTarget {
  /** The folder the user picked. */
  dir: string
  /** The library root the export writes (a new folder for `new` and `foreign`). */
  root: string
  kind: ExportTargetKind
  /** The library's name: the existing one's, or the one to create. */
  libraryName: string
  /** `foreign`, or `add` next to a foreign library: whose library is at the picked folder. */
  ownerNickname?: string
  /** Why the export is blocked (`own-metadata`, `read-only`); null when it isn't. */
  blocked: string | null
  /** Free bytes on the target's filesystem, or null when `statfs` failed. */
  free: number | null
  /** Keys of tree items the library already has (same key, same size): not copied again. */
  present: string[]
}

interface ExportPlanRequest {
  /** The titles the tree covers; null for every downloaded title. */
  animeIds: number[] | null
  /** The picked folder, or null before one is picked. */
  target: string | null
  /** The library name for a new library. */
  name: string
}

interface ExportPlan {
  titles: ExportTreeTitle[]
  target: ExportTarget | null
}

interface ExportStartRequest {
  selection: ExportSelectionItem[]
  target: string
  name: string
}

type ExportStartResult = { ok: true; job: ExportJobView } | { ok: false; reason: string }

/**
 * - `running`: copying;
 * - `held`: paused while the player is open (resumes on its release);
 * - `waiting-drive`: the library isn't found; retried every 10 s, on Resume and
 *   through Locate…;
 * - `paused`: by the user, or an unfinished job found at boot.
 */
type ExportJobStatus =
  | 'running'
  | 'held'
  | 'waiting-drive'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** An export job as the renderer shows it (`EXPORT_JOB_UPDATED`). */
interface ExportJobView {
  jobId: string
  libraryId: string
  libraryName: string
  /** The last known library root. */
  root: string
  status: ExportJobStatus
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  /** The item being copied, as "Title — episode". */
  current: string | null
  /** Items that failed (verify, a source error, a path that escapes the root). */
  failed: { key: string; label: string; reason: string }[]
  /** Selected items that had no file when the job was planned. */
  missing: number
  /** A note for the user, such as which path a resume chose. */
  note: string | null
  /** The job-level error (`failed`). */
  error: string | null
  createdAt: number
}
