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

type AttachedLibraryAccessReason = SharedLibraryReadOnlyReason | 'mount'

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
  // Read on this run: false when the root couldn't be read at startup.
  available: boolean
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
}

/** `resolveItem` on the service: a played file and its sidecar, both checked at play time. */
interface AttachedResolvedItem {
  libraryId: string
  path: string
  subtitlePath?: string
}

/** `checkItem` (S12 #592's integrity step). */
type AttachedItemCheck = 'ok' | 'missing' | 'wrong-size' | 'escapes'
