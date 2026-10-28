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
