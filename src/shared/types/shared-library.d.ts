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

/**
 * A layout v2 owner (#713): a non-Shikimori account. `provider` is open (a
 * `TrackerId` today) and `userId` its decimal id as a string.
 */
interface SharedLibraryTrackerOwner {
  provider: string
  userId: string
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
  /** Layout minor 1 (#623): set only on an `.mkv` an export merged from an unmerged pair. */
  source?: SharedLibraryItemSource
}

/**
 * The `.mp4` + `.ass` pair an export merged into an item's `.mkv` (#623).
 * Trusted only while `outputSize` equals the item's `size`: a rewrite by an
 * older PC carries it back onto a different file by `itemKey`.
 */
interface SharedLibraryItemSource {
  /** The `.mp4`'s size when it was merged. */
  size: number
  /** The `.ass`'s size when it was merged. */
  subtitleSize: number
  /** The merge's video codec: `copy` or the encoder. */
  codec: string
  /** The merged `.mkv`'s size when it was written. */
  outputSize: number
}

interface SharedLibraryNaming {
  rule: 'v1'
  // Item keys whose names differ from the plain download-folder name.
  renamed: string[]
}

/** `.anime-dl/manifest.json` as the reader returns it. */
interface SharedLibraryManifest {
  // 2 only for a v2 owner (#713): a library owned by a non-Shikimori account.
  layoutVersion: 1 | 2
  layoutMinor: number
  libraryId: string
  name?: string
  owner: SharedLibraryOwner | SharedLibraryTrackerOwner | null
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
  owner: SharedLibraryOwner | SharedLibraryTrackerOwner | null
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
  // A v1 claim names a v1 (Shikimori) owner, a v2 claim (#714) a v2 owner by
  // `(provider, userId)`. The writer matches only a v1 claim until #715.
  claim: SharedLibraryActorClaim | null
  // The accounts that match a v2 owner (#713): every connected account (#714),
  // Shikimori's included, so a hand-written v2 `provider: 'shikimori'` owner
  // matches it.
  trackerAccounts: { provider: string; userId: string }[]
}

type SharedLibraryActorClaim =
  | { libraryId: string; ownerId: number }
  | { libraryId: string; provider: string; userId: string }

/** `resolveItem` / `resolveWriteTarget`: an absolute path, or why there is none. */
type SharedLibraryResolved = string | 'missing' | 'escapes'

// --- Attached libraries: the open flow (S7a #578) ---------------------------------

/**
 * How this PC uses an attached library: `owner` (one of its connected
 * accounts is the owner, an expired session included), `claim` (no tracker
 * account, claimed locally), `foreign` (accounts, none of them the owner: used
 * as videos, its state ignored), or `videos`.
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
  // `null` for a v2 library too, so a downgraded v6 reads it as `videos`.
  owner: SharedLibraryOwner | null
  // A v2 library's owner (#713); never set next to a v1 `owner`.
  trackerOwner?: SharedLibraryTrackerOwner
  access: 'read-write' | 'read-only'
  accessReason?: AttachedLibraryAccessReason
  claim?: { ownerId: number; at: number }
  // A no-account PC's claim of a v2 library (#714), beside `trackerOwner`, so a
  // v1 claim keeps exactly `{ ownerId, at }` and a 6.x never reads this one.
  trackerClaim?: { provider: string; userId: string; at: number }
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
  // The owner's tracker (#714): `'shikimori'` for a v1 owner, a v2 owner's
  // `provider` (an open string); null with no owner.
  ownerProvider: string | null
  mode: SharedLibraryMode | null
  titleCount: number
  // `choose`: a With-metadata library on a PC with no tracker account (#714).
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
  // The owner's tracker (#714): `'shikimori'` for a v1 owner, a v2 owner's
  // `provider`, null with no owner. A hand-written v2 `provider: 'shikimori'`
  // library is `'shikimori'` too, so the Shikimori leg also checks `layoutVersion`.
  ownerProvider: string | null
  // 2 for a v2 library (`trackerOwner`), 1 otherwise (#714). Until #715 only a
  // v1 library runs a leg, joins the Shikimori leg or offers Sync now.
  layoutVersion: 1 | 2
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
  notDownloaded: ExportNotDownloaded[]
}

/** A translation a not-downloaded episode can be pre-fetched in (#577), from the cached episode data. */
interface ExportPrefetchOption {
  translationId: number
  translationType: string
  author: string
  /** The download's height: the probed one, else the declared one. */
  height: number
  /** The estimate (shown with "~"), or null when it's unknown. */
  sizeBytes: number | null
}

/** A not-downloaded episode: selectable for pre-fetch (#577) when it has options and the plan's gate is `ok`. */
interface ExportNotDownloaded {
  episodeInt: string
  label: string
  /** The default (the title's downloaded translation) first; empty when the cached list has none. */
  options: ExportPrefetchOption[]
  /** Why it can't be pre-fetched whatever the gate (a stale episode list); null otherwise. */
  unavailable: string | null
}

/**
 * Whether not-downloaded episodes can be pre-fetched (#577): `offline` and
 * `no-token` keep them disabled; `unavailable` when this PC can't enqueue.
 */
type ExportPrefetchGate = 'ok' | 'offline' | 'no-token' | 'unavailable'

/** A pre-fetched item on the job card (#577). */
interface ExportPrefetchView {
  key: string
  label: string
  state:
    | 'waiting-download'
    | 'downloading'
    | 'waiting-connection'
    | 'waiting-merge'
    | 'copying'
    | 'done'
    | 'failed'
  /** The download's progress while `downloading`. */
  percent: number
  /** "Subtitles failed to download", or null. */
  warning: string | null
}

/**
 * How the export would treat the chosen folder (the table in docs/shared-library.md):
 * - `new`: no library there, one is created at `root`;
 * - `add`: a Videos-only library, added to in Videos only (with `ownerNickname`
 *   set when it is the sibling an earlier export made next to a foreign library);
 * - `upgrade`: a Videos-only library, With metadata (S6e #586): this user takes
 *   it over, only with `confirmTakeover` (owner decision 9);
 * - `own-metadata`: a With metadata library owned by this PC's account: merged
 *   first, then widened, always With metadata (a Videos only add is routed here);
 * - `claimed`: a library this PC uses through a local claim (S7a #578), never
 *   written; the export goes into a library at `root`, next to it;
 * - `other-owner` (#714): a With metadata library another of this PC's
 *   accounts owns (`owner`), never written; the export goes into the picked
 *   owner's library at `root`, next to it;
 * - `foreign`: a With metadata library owned by someone else, never written;
 *   the export goes into a new library at `root`, next to it;
 * - `read-only`: a library this version can't write (a newer major, over a cap,
 *   or interrupted), blocked.
 */
type ExportTargetKind =
  | 'new'
  | 'add'
  | 'upgrade'
  | 'own-metadata'
  | 'claimed'
  | 'other-owner'
  | 'foreign'
  | 'read-only'

/** *Videos only*, or *With metadata*: the watch state of the titles in scope too (S6e #586). */
type ExportMode = 'videos' | 'metadata'

/** A With metadata job's step (S6e #586): the copy, then the watch state, then done. */
type ExportJobPhase = 'copy' | 'state' | 'done'

interface ExportTarget {
  /** The folder the user picked. */
  dir: string
  /** The library root the export writes (a new folder for `new` and `foreign`). */
  root: string
  kind: ExportTargetKind
  /** The mode the export runs in: the request's, except `own-metadata`, always With metadata. */
  mode: ExportMode
  /** The library's name: the existing one's, or the one to create. */
  libraryName: string
  /** `foreign`, `claimed` or `other-owner`, or a library next to one: whose library is at the picked folder. */
  ownerNickname?: string
  /**
   * The owner of the library the target names (#714): the library at `root`
   * for `own-metadata`, the one at the picked folder for `other-owner`. The
   * dialog preselects it in the owner picker.
   */
  owner?: { provider: string; nickname: string | null }
  /**
   * Why the export goes into a separate library instead of taking over the
   * Videos-only one at the picked folder (#714): set when the takeover can't
   * be offered for the picked owner (the library is at a newer layout minor).
   */
  separateReason?: string
  /** Why the export is blocked (`read-only`); null when it isn't. */
  blocked: string | null
  /** Free bytes on the target's filesystem, or null when `statfs` failed. */
  free: number | null
  /**
   * Keys of tree items the library already has: not copied again. The same key
   * with the same size, or an unmerged pair whose `.mkv` an export merged (#623).
   */
  present: string[]
  /** Of `present`, the unmerged pairs the library has as an `.mkv` an export merged (#623). */
  presentMerged: string[]
  /**
   * Not-downloaded episodes the library already has (#577), as the item keys of
   * their translations it holds: shown as on the drive, never pre-fetched.
   * Absent means none.
   */
  presentMissing?: string[]
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
  /** `videos` by default (S6e #586). */
  mode?: ExportMode
  /**
   * The owner a new With metadata library gets (#714), one of the plan's
   * `owners`. Left out: an own library at the folder keeps its owner, else
   * `defaultOwner`.
   */
  owner?: TrackerId
  /** "Create a separate library instead" (#714): never take over the Videos-only library there. */
  sibling?: boolean
}

/** One account the export can make the owner of a new With metadata library (#714). */
interface ExportOwnerOption {
  provider: TrackerId
  nickname: string
  /** A Shikimori owner: the library stays v1, which older versions of the app open. */
  olderVersions: boolean
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
  /** Whether not-downloaded episodes can be pre-fetched (#577). */
  prefetch: ExportPrefetchGate
  /** Free bytes where pre-fetched episodes download (the hot root), or null when unknown. */
  localFree: number | null
  /**
   * An account the export can make the owner is set (`shikimoriUser` until
   * #715, an expired session included): With metadata is offered (S6e #586).
   */
  canExportMetadata: boolean
  /** `defaultOwner`'s nickname, for the default library name; null with no owner. */
  nickname: string | null
  /** The accounts the owner picker offers (#714): Shikimori only until #715. */
  owners: ExportOwnerOption[]
  /** The primary when it is offered, else the first offered owner; null with none (#714). */
  defaultOwner: TrackerId | null
}

interface ExportStartRequest {
  selection: ExportSelectionItem[]
  /** Not-downloaded episodes to download first, each in the translation picked (#577). */
  prefetch?: ExportSelectionItem[]
  target: string
  name: string
  /** `copy-as-is` when left out; `merge` falls back to it on a PC without ffmpeg (#576). */
  unmerged?: ExportUnmergedMode
  /** `copy` when left out, never the Merging tab's `videoCodec` (#576). */
  codec?: string
  /** `videos` when left out (S6e #586). */
  mode?: ExportMode
  /** The user confirmed becoming the owner of a Videos-only library (`upgrade`, owner decision 9). */
  confirmTakeover?: boolean
  /** As on the plan (#714); `start` refuses an owner that isn't connected and offered. */
  owner?: TrackerId
  sibling?: boolean
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
  /** Pre-fetched items (#577), in start order; main always sends it. */
  prefetch?: ExportPrefetchView[]
  /** A note for the user, such as which path a resume chose. */
  note: string | null
  /** The job-level error (`failed`). */
  error: string | null
  createdAt: number
  /** `metadata` for a With metadata job (S6e #586); absent for Videos only. */
  mode?: ExportMode
  /** A With metadata job's step: "Copying", then "Saving watch state". */
  phase?: ExportJobPhase
}

// --- Copy to this PC (S7b #579) ---------------------------------------------------

/** Where copied episodes land: the hot (download) root or the cold one. */
type ImportDestination = 'hot' | 'cold'

/** `import:plan`: one title's episodes (Copy to this PC), or every title (`null`, Import all). */
interface ImportPlanRequest {
  libraryId: string
  animeIds: number[] | null
}

/** An item the import never creates; the dialog lists it with the reason. */
interface ImportRejected {
  key: string
  label: string
  reason: string
}

interface ImportPlan {
  libraryId: string
  libraryName: string
  /** `ExportTree`'s shape; `notDownloaded` is always empty. A `missing` episode's file is gone from the drive. */
  titles: ExportTreeTitle[]
  rejected: ImportRejected[]
  hot: { dir: string; free: number | null }
  /** Null when cold storage isn't set up or its folder is missing (`coldUnavailable` says which). */
  cold: { dir: string; free: number | null } | null
  coldUnavailable: string | null
  /** Set when there is nothing to plan: the library isn't attached, or its drive isn't connected. */
  error: string | null
}

interface ImportStartRequest {
  libraryId: string
  selection: ExportSelectionItem[]
  destination: ImportDestination
}

type ImportStartResult = { ok: true; job: ImportJobView } | { ok: false; reason: string }

/** The duplicate prompt's answers: keep this PC's file, replace it with the drive's, or keep both. */
type ImportDuplicateChoice = 'keep' | 'replace' | 'keep-both'

interface ImportDuplicateAnswer {
  choice: ImportDuplicateChoice
  /** "Apply to all remaining": later duplicates of this job get the same answer. */
  applyToAll: boolean
}

/** An episode this PC already has, waiting for the user's answer. */
interface ImportDuplicatePrompt {
  key: string
  label: string
  /** This PC's file: the same translation's, else another translation's. */
  localSize: number
  driveSize: number
  /** The local file is another translation's, under another name. */
  canKeepBoth: boolean
  /** False while this PC's copy is still downloading (`.part`) or merging. */
  canReplace: boolean
}

/** Export's statuses, plus `waiting-duplicate`: paused on the duplicate prompt. */
type ImportJobStatus = ExportJobStatus | 'waiting-duplicate'

/** An import job as the renderer shows it (`IMPORT_JOB_UPDATED`). */
interface ImportJobView {
  jobId: string
  libraryId: string
  libraryName: string
  destination: ImportDestination
  status: ImportJobStatus
  itemsDone: number
  itemsTotal: number
  bytesDone: number
  bytesTotal: number
  /** The item being copied, as "Title — episode". */
  current: string | null
  duplicate: ImportDuplicatePrompt | null
  failed: { key: string; label: string; reason: string }[]
  /** Duplicates where this PC's file was kept. */
  kept: { key: string; label: string; reason: string }[]
  note: string | null
  error: string | null
  createdAt: number
}
