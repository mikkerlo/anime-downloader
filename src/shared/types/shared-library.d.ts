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

// --- Attached libraries: the open flow (S7a #578) ---------------------------------

/**
 * How this PC uses an attached library: `owner` (logged in as its owner, or
 * the session expired), `claim` (no account, claimed locally), `foreign`
 * (logged in as someone else: used as videos, its state ignored), or `videos`.
 */
type AttachedLibraryRole = 'videos' | 'owner' | 'claim' | 'foreign'

// `mount`: `access(W_OK)` refused on an availability transition; `write-failed`:
// a real write failed (`reportWriteFailure`, S8 #582), until the next transition.
type AttachedLibraryAccessReason = SharedLibraryReadOnlyReason | 'mount' | 'write-failed'

/** An attached library's availability transition (S8 #582); S9 (#584) merges on them. */
interface AttachedLibraryTransition {
  libraryId: string
  available: boolean
  access: 'read-write' | 'read-only'
  accessReason?: AttachedLibraryAccessReason
  // `access` went from read-only to read-write on this transition.
  becameWritable: boolean
}

/** A claim PC's rate for an attached title, read from the library base (S9 #584). */
interface AttachedTitleRate {
  score: number
  status: string
  episodes: number
}

/** One `attachedLibraries` entry, keyed by `libraryId`. */
interface AttachedLibraryRecord {
  root: string
  name: string
  mode: SharedLibraryMode
  owner: SharedLibraryOwner | null
  access: 'read-write' | 'read-only'
  accessReason?: AttachedLibraryAccessReason
  claim?: { ownerId: number; at: number }
  lastSeenAt: number
  lastSyncAt: number | null
}

/** What the open flow found in one library root, before attaching it. */
interface SharedLibraryCandidate {
  root: string
  // null when there is nothing to attach: `manifest.json` is newer or over a cap.
  libraryId: string | null
  name: string
  ownerNickname: string | null
  mode: SharedLibraryMode | null
  titleCount: number
  // `choose`: a With-metadata library on a PC with no Shikimori account.
  identity: 'videos' | 'owner' | 'foreign' | 'choose'
  readOnly?: { reason: SharedLibraryReadOnlyReason; message: string }
}

/** `shared-library:pick-and-discover`: `dir` is null when the dialog was cancelled. */
interface SharedLibraryDiscovery {
  dir: string | null
  candidates: SharedLibraryCandidate[]
}

/** The no-account choice: videos only, or a local claim as the owner. */
type SharedLibraryAttachChoice = 'videos' | 'claim'

/** Which discovery an attach takes its root from: the open flow's, or the poller's toast (#581). */
type SharedLibraryAttachSource = 'opened' | 'found'

/** One episode file a title's Play from drive can start. */
interface AttachedPlayTarget {
  episodeInt: string
  translationId: number
  container: 'mkv' | 'mp4'
}

interface AttachedLibraryTitle {
  animeId: number
  name: string
  // From the metadata snapshot, for `AnimeCard`.
  anime: AnimeSearchResult
  hasPoster: boolean
  // Also in `downloadedAnime` on this PC.
  onThisPc: boolean
  itemCount: number
  mkvCount: number
  // The first episode in order, and the first that plays without ffmpeg.
  play: { any: AttachedPlayTarget | null; withoutFfmpeg: AttachedPlayTarget | null }
  // On a claim PC, from `sync-bases/library-<libraryId>.json` (#582).
  rate?: AttachedTitleRate
}

interface AttachedLibraryInfo {
  libraryId: string
  root: string
  name: string
  mode: SharedLibraryMode
  ownerNickname: string | null
  role: AttachedLibraryRole
  access: 'read-write' | 'read-only'
  accessReason?: AttachedLibraryAccessReason
  // S5's read-only message (`version`, `size`, `interrupted`).
  message?: string
  // Read on this run and still there (#581): false when the root couldn't be
  // read at startup, or the poller found it gone.
  available: boolean
  // While available, when the poller last saw it; otherwise the last time it was.
  lastSeenAt: number
  // S9 (#584) sets it; null shows "Last sync: never".
  lastSyncAt: number | null
  // Items past Windows' MAX_PATH at this root (`absoluteOverflow`).
  pathOverflow: number
  mkvCount: number
  titles: AttachedLibraryTitle[]
}

type SharedLibraryAttachResult =
  | { ok: true; library: AttachedLibraryInfo; ffmpegMissing?: { mkvCount: number } }
  | { ok: false; error: string }

interface AttachedTitleItem {
  translationId: number
  translationType: string
  author: string
  quality: number
  container: 'mkv' | 'mp4'
  hasSubtitle: boolean
}

interface AttachedTitleEpisode {
  episodeInt: string
  episodeFull: string
  items: AttachedTitleItem[]
}

/** `shared-library:get-title`: one title as the drive has it. */
interface AttachedTitleDetail {
  libraryId: string
  libraryName: string
  animeId: number
  anime: AnimeSearchResult
  meta: SharedLibraryMeta | null
  hasPoster: boolean
  episodes: AttachedTitleEpisode[]
  // On a claim PC, from the library base (#582).
  rate?: AttachedTitleRate
}

/** `resolveItem` on the service: a played file and its sidecar, both checked at play time. */
interface AttachedResolvedItem {
  libraryId: string
  path: string
  subtitlePath?: string
}

/** `checkItem` (S12 #592's integrity step). */
type AttachedItemCheck = 'ok' | 'missing' | 'wrong-size' | 'escapes'

// --- Drive detection, Forget, Re-locate (S7c #581) ---------------------------------

/** `shared-library:found`: unknown libraries on a newly mounted volume, one event per volume. */
interface SharedLibraryFound {
  // `E:` or the mount folder's name.
  volume: string
  dir: string
  candidates: SharedLibraryCandidate[]
}

/** What Forget would discard; the two never overlap. */
interface SharedLibraryPendingCount {
  libraryChanges: number
  resolutions: number
}

/** `shared-library:forget`: asks first when anything would be discarded. */
type SharedLibraryForgetResult =
  | { needsConfirm: true; pendingCount: SharedLibraryPendingCount }
  | { needsConfirm: false }

/** `shared-library:relocate`: `error` is null when the picker was cancelled. */
type SharedLibraryRelocateResult =
  | { ok: true; library: AttachedLibraryInfo }
  | { ok: false; error: string | null }

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
  /** The dialog's id: the target's filesystem and write probes run once per folder within it (#575). */
  session?: string
  /** How unmerged pairs would go (#576), for the preflight's names and sizes; `copy-as-is` by default. */
  unmerged?: ExportUnmergedMode
  /** The merge's video codec (#576); `copy` by default. */
  codec?: string
}

/**
 * Unmerged `.mp4` + `.ass` pairs (#576): copied as both files, or merged into
 * one `.mkv` on the target with the exporting PC's ffmpeg.
 */
type ExportUnmergedMode = 'copy-as-is' | 'merge'

/** Whether this PC can merge on export (#576): its ffmpeg and the HEVC encoders it reports. */
interface ExportMergeSupport {
  available: boolean
  encoders: string[]
}

/** An export's merge in flight (#576): waiting for a download merge, or merging. */
interface ExportMergeState {
  phase: 'waiting' | 'merging'
  percent: number
}

/** The target's filesystem type, as the per-OS probe reports it (#575). */
type ExportFsType = 'fat32' | 'exfat' | 'ntfs' | 'apfs' | 'hfs' | 'ext' | 'other' | 'unknown'

/**
 * The export preflight (#575). Item lists are keys. At plan time they cover
 * every ready tree item the target doesn't already have, and the dialog
 * narrows them to the selection; at start they cover the selection.
 */
interface ExportPreflight {
  /** No blockers. */
  ok: boolean
  fsType: ExportFsType
  /** Refuse the export (a read-only target). */
  blockers: string[]
  /** Never block: the drive's own warnings first, then the item ones. */
  warnings: string[]
  /** Warnings about the drive, not about items (the write probe's unexpected errors). */
  driveWarnings: string[]
  /** Items with a file over FAT32's 4 GiB − 1 bytes: not copied. */
  skipped: string[]
  /** Re-encodes (S6c #576) whose source is over the FAT32 limit: skipped at run time if still over. */
  mayBeSkipped: string[]
  /** Items the naming rule changed (shortened or made Windows-safe): S5's `naming.renamed`. */
  renamed: string[]
  /** The download-folder name and the library name of each renamed item. */
  renames: Record<string, { from: string; to: string }>
  /** Items past Windows' MAX_PATH under this root (`absoluteOverflow`). */
  overflow: string[]
}

interface ExportPlan {
  titles: ExportTreeTitle[]
  target: ExportTarget | null
  /** Null before a folder is picked, and for a blocked target. */
  preflight: ExportPreflight | null
  /** Whether Merge into MKV can be offered (#576). */
  merge: ExportMergeSupport
}

interface ExportStartRequest {
  selection: ExportSelectionItem[]
  target: string
  name: string
  /** `copy-as-is` when left out; `merge` falls back to it on a PC without ffmpeg (#576). */
  unmerged?: ExportUnmergedMode
  /** `copy` when left out, never the Merging tab's `videoCodec` (#576). */
  codec?: string
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
  /** The current item's merge (#576); null while copying. */
  merge?: ExportMergeState | null
  /** Items that failed (verify, a source error, a path that escapes the root). */
  failed: { key: string; label: string; reason: string }[]
  /** Items skipped as too large for the drive (`too-large-for-filesystem`), by preflight or at run time. */
  skipped: { key: string; label: string; reason: string }[]
  /** Selected items that had no file when the job was planned. */
  missing: number
  /** A note for the user, such as which path a resume chose. */
  note: string | null
  /** The job-level error (`failed`). */
  error: string | null
  createdAt: number
}
