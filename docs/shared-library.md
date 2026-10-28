# Shared Library

A Shared Library is a folder (usually on a removable drive) that carries videos, and optionally watch state, between installs. It must be readable by another install, by an older or newer app version, and by a person with VLC and no app at all. This page describes the on-drive format, v1 (#573, epic #563). The export, open and sync flows that use it (S6a #574, S7a #578, S9 #584) are documented as they land; S11 (#587) completes the page.

The code lives in `src/main/lib/shared-library/`, and its types in `src/shared/types/shared-library.d.ts`:

| File | What |
|---|---|
| `format.ts` | Constants (`LAYOUT_VERSION`, `LAYOUT_MINOR`, `NAMING_RULE`, `CAPS`), the v1 schema as data, the schema fingerprint, the unknown-field bag, `carryUnknown`, `itemKey`, the bag-mode serializer (`serializeMeta`) and `toAnimeSearchResult` |
| `read.ts` | `readManifest`, `readState`, `readMeta`, `readLibrary`: validation, the version and size checks, the pair search |
| `write.ts` | `createLibrary`, `writeManifest`, `writeState`: the checks, the cap check, the torn-pair repair, the atomic sequence, the by-path carry |
| `naming.ts` | The naming rule v1 (`nameItems`, `nameItem`, `plainName`) |
| `index-html.ts` | `renderIndexHtml`: the escaped, script-free `index.html` |
| `discover.ts` | `discoverLibraries(dir)` |
| `paths.ts` | The lexical path check, `resolveItem`, `resolveWriteTarget`, `absoluteOverflow`, poster names |
| `mount-candidates.ts` | Where a removable drive can be mounted, per OS, each check on a 1 s async budget (#574; S7c #581 reuses it) |

The export (S6a #574) lives in `src/main/services/shared-library-export/` (`plan.ts`, `copy.ts`, `snapshot.ts`, `locate.ts`, `job.ts`, `index.ts`); see [Export](#export-videos-only-574).

Nothing calls `writeState` before S9 (#584).

## Layout

Everything is relative to the library root, the folder the user picks.

```
<LibraryRoot>/
  .anime-dl/
    manifest.json        layout + identity (atomic; previous copy kept)
    manifest.prev.json
    state.json           SyncDoc v1 from S4 (#572), for titles in scope only ("With metadata" libraries only)
    state.prev.json
    meta/<animeId>.json  metadata snapshot (titles, genres, year, type, episode list, malId, searchResult)
    posters/<animeId>.jpg
  {Title}/{Title} - NN [Author].mkv     the download folder's naming, made Windows-safe
  {Title}/{Title} - NN [Author].ass     optional sidecar when copied unmerged
  index.html             only when some name differs from the plain download-folder name
```

Every file is two-space JSON with a final newline. Known fields are written in schema order, then unknown fields, so a file written in that order round-trips byte for byte.

### `manifest.json`

- `layoutVersion` (major, `1`) and `layoutMinor` (`0`), separate from the state's `stateVersion` / `stateMinor` so the layout and the state schema change independently.
- `libraryId` (a uuid) and `name`.
- `owner`: `{ shikimoriId, nickname }`, or `null` for a *Videos only* library. `mode`: `'videos'` (owner `null`) or `'metadata'` (an owner).
- `generation`, incremented on every manifest write, and `stateGeneration`, the `generation` of the `state.json` it was written with (`null` when there is no state).
- `lastWriter`: `{ installId, appVersion, at }`, rebuilt on every write.
- `titles[]`: `{ animeId, name }`, the explicit scope. A title missing from the drive is out of scope, not deleted; deletions are tombstones inside `state.json`.
- `items[]`: `{ animeId, episodeInt, translationId, translationType, author, quality, path, subtitlePath?, size, sha256? }`, keyed by `itemKey(item)` = `animeId:episodeInt:translationId` with `episodeInt` opaque (`"12.5"` included). `path` is relative, with `/` separators.
- `naming`: `{ rule: 'v1', renamed }`, the item keys whose names differ from the plain download-folder name.

### `state.json`

S4's `SyncDoc` in an envelope: `{ stateVersion, stateMinor, libraryId, generation, manifestGeneration, doc }`.

- The envelope's `stateVersion` / `stateMinor` are authoritative. The writer sets `doc.stateVersion` / `doc.stateMinor` equal to them; on read, a mismatch is an envelope failure.
- `libraryId` is copied from the manifest on every state write. The pair rule requires it to match, so a `state.json` copied in from another library never pairs.
- `generation` is the state's own counter: every state write takes `s₀ + 1` (below). `manifestGeneration` is a back-reference to the manifest `generation` it was written with.

### `meta/<animeId>.json`

A metadata snapshot whose `searchResult` is a verbatim `AnimeSearchResult`. On the drive, unknown keys in `searchResult` are kept in its bag and written back. They are narrowed away only at the boundary into the local `library` row: `toAnimeSearchResult(searchResult)` keeps only `AnimeSearchResult`'s fields, and that is the value `ApplyDeps.sharedSearchResult` hands S4's `applySyncDoc`. `meta` has no writer walk (below), so S6a (#574)'s meta merge on re-export must call `carryUnknown` to keep a newer minor's `searchResult` keys.

## The version rule

- **Minor bump:** every change is an additive optional field (at any level) whose absence has a defined meaning that equals the previous version's behaviour. New enum values count as minor only in fields the format declares open (none in v1). A new tombstone kind is a major, unless it only ever appears next to `starred` or `priority`: S4's `pruneDocTombstones` keeps an entry only when it has one of those, and the writer's walk can't restore an entry that is gone from `doc`.
- **Major bump:** anything else, including raising any cap (file size, string length, item count), because an older reader would drop the newer writer's data on write-back.
- **Readers:** a newer minor opens read-write, and its unknown fields are preserved on every object the writer keeps. A newer major opens read-only, with an explanation.

The rule is enforced mechanically, not by a round-trip test. `describeSchema()` returns the v1 schema as data (each field's path, type, required flag and enum, plus the caps) and a checked-in fingerprint test compares it with `test/fixtures/shared-library/schema-v1.json` through `compareFingerprint`: an added optional field fails unless the matching `*_MINOR` was bumped, and any other difference, a cap change included, fails unless the major was bumped. The test prints which rule applied.

## Two files, one consistent pair

`writeState` writes `state.json` (`generation: s₀ + 1`, `manifestGeneration: g + 1`) and then `manifest.json` (`generation: g + 1`, `stateGeneration: s₀ + 1`). A drive pulled between the two is detected, not silently mixed.

**The pair rule.** A `(manifest, state)` pair is accepted only when `state.libraryId === manifest.libraryId`, `manifest.stateGeneration === state.generation` (exact), and `state.manifestGeneration <= manifest.generation`.

- The exact half is enough because every state write takes a generation strictly greater than every state generation on the drive, so a given `stateGeneration` names exactly one state write. That uniqueness rests on `s₀`: the highest `generation` in any readable `state.json` / `state.prev.json` (orphans and other libraries' states included) and any `stateGeneration` in a readable `manifest.json` / `manifest.prev.json`, or 0, computed once before the writer changes anything.
- The back-reference is `<=`, a sanity bound only. A manifest-only write (`writeManifest`: S6a's checkpoints, S6e's widening) raises `manifest.generation` without touching state, so a consistent library routinely has `state.manifestGeneration < manifest.generation`. With `===`, the first such write would make the library match no pair and open read-only for good. The bound catches state from a later manifest than the one being read (a hand edit, a `manifest.prev` fallback). **Don't tighten it back to `===`.**
- A manifest with `stateGeneration: null` pairs with no state. Any `state.json` / `state.prev.json` is then an orphan: ignored by the reader, its size and version unread, replaced by the next `writeState`. With `mode: 'metadata'` that is a With-metadata library with empty state (`state: null`, `stateInitialized: false`): valid, not torn, read-write for the owner or a matching claim.

**The pair search.**

0. `stat` `manifest.json` and `manifest.prev.json`, then read their version integers and count their `items[]`. Either over its size cap or the item cap: read-only (`'size'`). Either a newer `layoutVersion`: read-only (`'version'`).
1. Pick the manifest: `manifest.json`, or `manifest.prev.json` (torn) when it is missing or invalid.
2. Its `stateGeneration` is `null`: stop, with no state.
3. `stat` `state.json` and `state.prev.json` and read their version integers: over the size cap is `'size'`, a newer `stateVersion` is `'version'`. Then match the manifest with `state.json`, then `state.prev.json`.
4. Neither matches: try `manifest.prev`. With `stateGeneration: null` it pairs with no state (torn, read-write, and the repair touches only the manifest side); otherwise it is tried with `state.prev`.
5. Nothing matches: read-only (`'interrupted'`), "This library was interrupted while being written. Plug it into the PC that last wrote it."

A `.prev` pair comes back with `torn: true` and the pair used. `readLibrary`'s read-only result carries its `reason` (`'version'`, `'size'` or `'interrupted'`), its message, and the manifest still worth listing: none when `manifest.json` itself is newer or over a cap.

**A newer major, or a file over a cap, comes before the pair search, with no fallback.** "Invalid" in the pair search means only unparseable or failing envelope validation at a known major. Without that, a newer app's v2 `state.json` would fail v1 validation, step 4 would pair the `.prev` files as torn and read-write, and the owner's next write would repair, deleting the newer write. The writers refuse on the read-only decision before the repair, so **the repair never runs on a tree that contains a newer major or an over-cap file**.

## Writes

The same atomic sequence for `manifest.json` and `state.json`:

1. write `X.tmp` and fsync it;
2. delete `X.prev`, ignoring `ENOENT` (renaming onto an existing file can fail with `EPERM`/`EEXIST` on FAT32/exFAT or under antivirus, so the writer never renames onto an existing target);
3. rename `X` to `X.prev`;
4. rename `X.tmp` to `X`;
5. on POSIX, fsync the directory.

From an untorn pair every crash point leaves a readable pair. A stale `X.tmp` is never read.

**The writer checks ownership itself.** `writeManifest(root, next, actor, expectedGeneration, { takeover? })` and `writeState(root, doc, actor, expectedStateGeneration)`, with `actor = { installId, appVersion, shikimoriUserId, claim }`:

- Both re-read the drive through the reader's pair search and refuse on a different `libraryId` (`writeManifest`'s `next`), the read-only decision, or a stale generation (`StaleGenerationError`). On a torn read the expected generation is the chosen manifest's (`manifest.prev`'s when it fell back), and the expected state generation that manifest's `stateGeneration`.
- `writeState` needs `mode: 'metadata'` and the owner (`owner.shikimoriId === actor.shikimoriUserId`) or a claim matching both `libraryId` and the owner; otherwise `NotOwnerError`. It accepts the empty-state form with `expectedStateGeneration: null`, takes `libraryId` from the on-disk manifest, and writes the manifest half of the pair itself.
- `writeManifest` on a `metadata` library needs the same owner-or-claim check. On a *Videos only* library anyone may write, but `owner` and `mode` change only through `{ takeover: true }`: accepted only on a manifest with `owner: null`, from a logged-in actor who becomes the owner of a `metadata` library, always with `stateGeneration: null`.
- `createLibrary(root, manifest, actor)` writes the first manifest and refuses when `manifest.json` or `manifest.prev.json` exists. A `metadata` library starts owned by the logged-in actor with `stateGeneration: null`.

**The order of every write:** every check above; then `s₀` (`writeState`) and the serialization of every file the write produces, checked against every cap (`LibraryTooLargeError`); then the torn-pair repair; then the atomic sequence. **Nothing on the drive changes before the repair**, so a refused write, `LibraryTooLargeError` included, leaves the tree untouched, the unpaired files and any stale `X.tmp` included.

**The first write into a With-metadata library** always passes through the empty-state form: step 1 writes a `metadata` manifest with `stateGeneration: null` (a new library, or a takeover); step 2 writes `state.json` at `s₀ + 1` (an orphan until step 3); step 3 writes the manifest with the new `stateGeneration`. After step 1 or 2 the library reads as metadata with empty state; a crash inside step 1's or 3's rename falls back to `manifest.prev`, torn (for a takeover, the *Videos only* manifest; for a new library, no library at all).

### Repairing a torn pair

On a torn read, `X.prev` is the half the reader used and step 2 of the sequence would delete it. So both writers, after every check and after `s₀`, first restore the chosen `.prev` files as the current ones: delete the unpaired `X`, rename `X.prev` to `X`, fsync the directory. The state side is skipped when the chosen manifest has `stateGeneration: null`.

- **Manifest side first.** When `manifest.json` is valid but pairs with nothing, the reader takes `(manifest.prev, state.prev)`. Repairing the state side first would leave the unpaired `manifest.json` next to the restored `state.json` with no `state.prev` to fall back to.
- Every intermediate tree reads as the same matching pair, and every step is idempotent, so a crash during the repair is repaired by the next write.
- The repair discards only the unpaired half, which no reader uses: the reader's fallback, made permanent.

## Untrusted input

The drive comes from another PC or another person, so the reader is defensive.

- **Caps:** `manifest.json` and `state.json` 32 MB, `meta/*.json` 1 MB, strings 2 KB (UTF-8), 200k items; the `.prev` copies share their file's cap. The caps are part of the schema as data, so the fingerprint covers them and raising one is a major bump.
- **Over a cap means read-only, not invalid.** The reader `stat`s `manifest.json`, `manifest.prev.json` and every non-orphan state file before parsing them; any file over its size cap, or a manifest over the item cap, gives `'size'` ("This library is larger than this version can open") with no fallback. Items are never truncated: truncating and then writing back would delete every item past the cap. The writers throw `LibraryTooLargeError` rather than produce an over-cap file.
- **Only an envelope failure invalidates a file.** The manifest envelope fails when the file is unparseable or not an object, `layoutVersion` / `layoutMinor` isn't an integer at a known major, `libraryId` isn't a uuid, `generation` isn't an integer, `stateGeneration` isn't an integer or `null`, `mode` isn't in the enum, `owner` doesn't fit `mode`, or `items` / `titles` isn't an array. The state envelope fails on the same checks for `stateVersion` / `stateMinor`, `libraryId`, `generation` and `manifestGeneration`, when `doc` isn't an object, or when `doc`'s version pair differs from the envelope's. A state whose `libraryId` differs from the manifest's never pairs with it.
- **A bad entry is dropped, never fatal.** `JSON.parse` runs inside `try`, and schema validation drops invalid entries (of `items[]`, `titles[]`, `naming.renamed`, and the state's keyed collections and string arrays) instead of throwing.
- **Dropped entries are carried through by the writer.** Every entry the reader dropped from the chosen manifest is written back byte for byte at its original index (at the end if the array is now shorter), because case collisions are resolved in `items[]` order. State entries go back by key in the keyed collections (`titles`, `titles[id].watch`, `titles[id].skip.perEpisode`, `tombstones`) and at their index in the string arrays (`titles[id].dismissed`, `priorityOrder.value`). A valid entry with the same key replaces a carried one. Carried entries count toward the file-size and item caps but are exempt from the string cap; they never reach a consumer (listing, resolving, `absoluteOverflow`, `index.html`, `applySyncDoc`).
- **Invalid non-envelope fields keep their raw value.** A known field outside the envelope that fails validation (such as a 3 KB `name`) is left out of the read result and written back raw unless the caller sets a valid one. The fields the writer owns (`lastWriter`, the generations) are never carried. Every non-envelope field is optional in `readLibrary`'s result type.
- **Paths are checked lexically on read** (relative, normalized, `/`-separated, no `..`, no dot-only component, no drive letter, no UNC, no NUL, no `:`, no `\`). The reader never calls `realpath`: a 200k-item manifest would cost 200k syscalls per open, and a missing file would throw `ENOENT` and drop its item. `resolveItem(root, item)` runs `realpath` when an item is used and returns the absolute path, `'missing'` or `'escapes'` (for `subtitlePath` too); a missing or escaping item stays in the manifest. `resolveWriteTarget(root, path)` resolves the deepest existing ancestor, so a symlinked directory (or a dangling symlink) can't redirect a copy outside the root.
- Posters are accepted only as `posters/<int>.jpg`.

### Unknown fields

- The reader puts each object's unknown fields in a non-enumerable, symbol-keyed bag (`UNKNOWN_FIELDS`). The serializer emits an object's allow-listed known fields plus its bag, and nothing else, so it never has to tell a field from the drive from one from the store.
- **The `SyncDoc` doc and title levels are the exception:** they use S4's plain-key carry. `applySyncDoc` finds unknown keys there with `Object.entries`, which never sees a symbol key, and keeps them in the local `syncMeta.unknown`; `projectSyncDoc` spreads them back. So the reader leaves non-`KNOWN_*` keys there as plain enumerable properties.
- **The writers guarantee preservation by path.** Making callers carry the bag doesn't work: S4's `clampSyncDoc` (`structuredClone`), `pruneDocTombstones`, `decidePriorityOrder` and `decideSkip` (spreads), `sameValue`, and sync bases going through `JSON.stringify` all drop it. So `writeState` and `writeManifest` walk what they write and add the chosen file's unknown fields at every path that file has: by key in keyed collections, by `itemKey` for items, by `animeId` for titles, by field name in records, plus the envelope's top level and the manifest's `owner` and `naming` (not `lastWriter`, which is rebuilt).
- **The output's unknown fields are exactly the chosen file's.** Unknown fields that only the caller's objects carry are dropped at every level, and with no chosen file (`createLibrary`, the empty-state form) every unknown field is dropped. The reason is S4's store-wide `syncMeta.unknown`: `projectSyncDoc` seeds every doc and title from it and `applySyncDoc` overwrites it from whichever doc it applied last, so keeping caller-only fields would leak library A's keys into library B. As a consequence the drive's value wins on a collision.
- The walk never recreates an object the caller removed, so pruning, scope changes and deletions keep working.
- **The writer stamps `max(own minor, chosen file's minor)`** for `stateMinor` (envelope and `doc`) and `layoutMinor`. Every unknown field in the output comes from the chosen file, so the chosen file's minor always describes the file; a first write stamps the writer's own minor. `SyncDoc.stateMinor` is therefore `number`, while `STATE_MINOR` stays `0`.

### Never on the drive

`token`, `shikimoriCredentials`, `syncplayPassword`, any absolute local path (S4 strips `skip`'s `filePath`), or any field from this PC that isn't on the allow-list. The forbidden names are stripped wherever unknown fields are copied (`copyUnknown`): from bags, and from the plain keys at the doc and title levels. The only off-allow-list fields that reach the drive are the ones read from this drive's chosen file, through the writer's walk.

## The naming rule (`naming.rule = 'v1'`)

Each path component goes through these steps, in order (S6b #575 consumes the rule rather than extending it):

1. Start from today's name: `sanitizeFilename` (`download-manager.ts`), `{Title}/{Title} - NN [Author].ext`.
2. **Windows-safety:** drop control characters (U+0000–U+001F, U+007F); a component that is empty or only dots becomes `_`; a reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, `COM¹²³`, `LPT¹²³`, case-insensitive, on the part before the first dot) gets `_` appended to that part (`nul.mkv` → `nul_.mkv`).
3. **Budget:** when the relative path is over 200 UTF-16 code units or a component over 240 UTF-8 bytes, the title is cut to fit and gets `~` plus the first 6 hex characters of `sha256(full title)`. When that would leave fewer than 24 characters of the title, the author tag is cut the same way (to at most 64 UTF-16 units and 128 bytes) and the title fitted again.
4. **Strip trailing dots and spaces** from every component (`_` if that empties it): Windows silently strips them, so a recorded `path` would otherwise not match the file.
5. **Case-insensitive collisions** (exFAT, NTFS, APFS): in `items[]` order, a later title directory that differs from an earlier one only in case gets the title's hash suffix, and a later file that collides gets a suffix from its item key.

The budget is relative, so an item gets the same name whatever the mount point. Names that are already Windows-valid and within budget are byte-identical to the download folder's. Renamed items are listed in `naming.renamed`, and only then is `index.html` written: a static, script-free table of titles and episodes linking to the relative paths, every string HTML-escaped. The player always resolves through `items[].path` (S7a), never by rebuilding a name.

**Absolute path length (MAX_PATH).** A deep root can still push root + relative past 259 characters on Windows. Inside the app that doesn't break reads (Node passes Windows paths through `\\?\`), but VLC, Explorer, or a spawned tool without long-path support can fail. The format stays mount-independent, so this is reported, not prevented: `absoluteOverflow(root, items)` returns the keys of items whose absolute path under a Windows-style root is over 259 UTF-16 units, for S6b's export preflight and S7a's open.

## Discovery

`discoverLibraries(dir)` checks `dir`, then each folder one level below it, for `.anime-dl/manifest.json` (or a lone `manifest.prev.json`, left by a crash inside a manifest write). One drive can hold several libraries.

## Export, Videos only (#574)

The user picks titles, translations and episodes, a folder and a library name, and gets a *Videos only* library: the episodes, the manifest, and per title a `meta/<animeId>.json` snapshot and `posters/<animeId>.jpg`. No watch state is written (S9 #584). Entry points: "Export…" on a title's page (that title preselected), Library's **Select** → "Export N titles…", and Settings → Storage → "Export to a Shared Library…" (every downloaded title, nothing selected). Jobs show in Downloads.

**Plan.** The selection is `[{ animeId, translationId, episodeInt }]`. Each item is looked up in `downloadedEpisodes` (`${animeId}:${episodeInt}:${translationId}`) and resolved on disk across the hot and cold roots with the episode list's scan (`scanEpisodeFilesAsync`), under each of the title's folder names (romaji, ru, title), tagged file first, then legacy. An item with no file is *missing* (pre-fetching is S6d #577); one whose translation is `merging` or `deferred` is *busy*; both are skipped. An unmerged `.mp4` + `.ass` pair is copied as both files (`subtitlePath`); merging on export is S6c (#576). The source is re-resolved just before each copy, so an auto-move between hot and cold during a job is followed.

**Target.** The library root is the picked folder when it holds a library itself, otherwise `<folder>/<name>` (`libraryFolderName`: `sanitizeFilename` plus the naming rule's Windows-safety and trailing-dot steps). It is classified by its manifest's `mode` and `owner` against `shikimoriUser.id` only (claims arrive with S7a #578, and S6e #586 tells them apart):

| Target | Videos-only export |
|---|---|
| No library | `new`: create `<folder>/<name>/` with `mode: 'videos'` and `owner: null` |
| A Videos-only library (`owner: null`), made by any PC | `add`: anyone may add to it, a PC with no account included |
| A With metadata library owned by this PC's account | `own-metadata`: blocked ("This library carries watch state…"). S6e (#586) routes it to With metadata |
| A With metadata library with any other owner, or a claim | `foreign`: never written. The siblings `<name>`, `<name> (2)`, … are checked in order: the first Videos-only library among them (the one an earlier export made; anyone may add to it) is added to, as `add` with the owner's nickname, so a re-export copies only what's new; the first free name gets a new library; any other library or plain folder is skipped |
| A library this version can't write (a newer major, over a cap, interrupted) | `read-only`: blocked with the reader's message |

The size estimate counts only items the library doesn't already have with the same key and the same size (`present`). Free space is `statfs(folder)` against those bytes plus a 1% margin (`fitsFreeSpace`, `src/shared/shared-library-export.ts`, shared by the dialog's live bar and main's start check). The start also refuses an empty copy, a library that would pass the 200k item cap, and a second job while one runs.

**Copy.** For each file:

1. `resolveWriteTarget(root, path)`; on `'escapes'` the item is skipped and logged, so a symlinked directory can't redirect a copy outside the root. The item's folder is created one level deep only, so a vanished drive root is never recreated;
2. stream to `<dest>.anime-dl-tmp`, hashing as it goes, fsync, delete any old `<dest>` (never rename onto an existing file), rename into place;
3. verify: the size, plus a re-read sha256 for files under 2 GB (size only above that). A mismatch deletes the file and marks the item failed; it stays out of the manifest;
4. the item joins the manifest at the next checkpoint.

The manifest is written through `writeManifest` every 10 items and at the end (and on pause and cancel), so a cancelled or crashed job leaves a valid library holding whatever finished. Items keep their `sha256`. A title joins `titles[]` with its first finished item; its `meta` and poster are written just before its first file. Names come from the v1 rule, with the library's existing items passed to `nameItems` as the earlier items they are; renamed keys go to `naming.renamed`, and `index.html` is rewritten at each checkpoint when that list is non-empty. Filesystem-specific checks (FAT32, writability, path length) are S6b (#575).

**The `meta` re-export.** A `meta/<animeId>.json` that reads at a known major gets the local snapshot's known fields merged over it, and `carryUnknown` carries the existing file's unknown fields at every record level (the file, `titles`, `searchResult` and its `titles`, each `genres` and `episodes` entry by key), so a re-export keeps a newer minor's fields. A file over its 1 MB cap is left alone; an invalid one is replaced. The local snapshot passes the v1 schema check first, so nothing a reader would drop is written, and only allow-listed fields leave this PC.

**Job identity is the library id.** A new library's `libraryId` is generated at start and its manifest, with no items, is written before the first file is copied. The job is saved as `userData/export-jobs/<jobId>.json` ([Storage](./storage.md)). Every run first finds the library: the last known root if its manifest has the same `libraryId`, otherwise the candidate mounts from `mount-candidates.ts` (`D:`–`Z:` on Windows, `/Volumes/*` on macOS, `/media/$USER/*`, `/run/media/$USER/*` and `/mnt/*` on Linux), each searched at its root and one level below with a 1 s budget per check. Two drives with the same `libraryId` (a cloned stick): the first match wins and the job's note says which path it chose and where else the library is. Before each file the job checks the root still holds that library (a `stat` of the manifest it last read or wrote, a full read when that changed), so a different drive at the old letter or path, with another library or none, is never written. Not found: the job is "Waiting for drive '<name>'", retried every 10 s, on Resume, and through "Locate…", a folder picker that accepts only a folder (or a folder one level below it) holding that `libraryId`. A drive pulled mid-copy is the same state: the rename never happens and the manifest stays at the last checkpoint. On resume the leftover `.anime-dl-tmp` is deleted and that file restarts; at boot an unfinished job shows as paused.

**Playback hold, per file.** Before each file the job checks `playerPresenceService.isOpen()`, the merge hold's signal (`docs/ffmpeg.md`, #516). A file already copying when the player opens finishes; the next one waits, shown as "Paused while the player is open", for an `onRelease` listener the job adds when it starts and removes (the returned unsubscribe) when it ends, is cancelled or is paused. Episodes are at most about 700 MB, roughly 25 s on USB 2; a movie in flight can take longer, an accepted risk.

**Jobs reach the renderer** through `export:job-updated` ([IPC](./ipc.md)), into `useExportStore`, and a job card in Downloads: "Exporting to <library> — 12 / 40 files, 8.1 / 23 GB", with Pause, Resume and Cancel, the two waiting states, and Dismiss once it's finished.

## Opening a library (#578)

`AttachedLibraryService` (`src/main/services/attached-library/`) owns every attached library. It persists `attachedLibraries` (`libraryId → { root, name, mode, owner, access, accessReason?, claim?, lastSeenAt, lastSyncAt }`, see `docs/settings.md`), keeps each manifest and its `meta/` snapshots in memory, and re-reads every persisted root at startup. **Its roots are never storage roots:** they are not in `ROOT_KEYS`, never handed to `coldStorageService`, never scanned by `episode-file-scan.ts` or the usage scan, and never added to the player's `dirsToCheck`, so cleanup and cold-storage moves can't touch a drive. The service is the only thing that knows these paths.

**Nothing writes to a library before S9 (#584).** Opening, the writability check and playing read only; a test snapshots the tree and spies on every write-capable `fs.promises` call under the root.

### The open flow

1. **Pick a folder** ("Open Shared Library…" in Settings → Storage and in the Library header): `shared-library:pick-and-discover`.
2. **Discover** with `discoverLibraries`. With more than one library, the user picks from a list showing name, owner nickname, mode and title count.
3. **Read** with `readLibrary`. A missing `name` falls back to the root's folder name.

   | Reader result | Open result |
   |---|---|
   | `ok`, `torn: true` | Opens on the pair the reader chose, `access` unchanged; a log line. The next S9 write repairs it |
   | read-only `'version'` (a newer state) | `access: 'read-only'`, `accessReason: 'version'`; still plays |
   | read-only `'interrupted'` | `access: 'read-only'`, `accessReason: 'interrupted'`, with S5's message; still plays |
   | read-only `'size'`, state file over its cap | `access: 'read-only'`, `accessReason: 'size'`, with S5's message; still plays |
   | read-only, `manifest.json` itself newer or over its size or item cap | The reader lists no manifest: the open flow shows the message and there is nothing to attach or play |

   **Path length:** when `absoluteOverflow(root, items)` flags items, a non-blocking warning: "N files are past Windows' 260-character path limit at this location. They play in the app, but other players may not open them. Move the library to a shorter folder to fix this."
4. **Writability, without writing.** `checkWritable(root)` (`writable.ts`) is the one read-only check, shared with S8 (#582): `fs.promises.access(<root>/.anime-dl, W_OK)`. `EROFS`, `EACCES` and `EPERM` give `access: 'read-only'`, `accessReason: 'mount'`. On attach `access` starts as `read-write` (unless the reader made it read-only), and this check can only demote it; any other error leaves it and is logged. Where `access` can't see the truth (Windows write-protected media), S8 demotes on the first failed write.
5. **Identity**, against `store.get('shikimoriUser')?.id`, never the credentials (session expiry clears only `shikimoriCredentials`):

   | Library | This PC | Role |
   |---|---|---|
   | Videos only | any | `videos` |
   | With metadata, owner = `shikimoriUser.id` | logged in, or the session expired | `owner` |
   | With metadata, owner ≠ `shikimoriUser.id` | logged in as someone else | `foreign`, after a warning: used as videos, its state ignored, never written. "To keep your own progress on this drive, create your own Shared Library next to it." |
   | With metadata | no account (`shikimoriUser` null), online or not | A choice: "Use as videos only" (`videos`), or "Use this library as <nickname>" after "Only do this if you are <nickname>", a **local claim** `claim: { ownerId, at }` (`claim`) |

   The role is derived again on every read. A claim lasts while the PC has no account: a login as the same id makes it plain ownership, as a different id the library turns foreign; either way the claim is dropped (S9 keeps the library base and merges later). A claim never pushes to Shikimori. **Until S9**, `owner` and `claim` libraries are read-only for state: titles show and play, nothing merges or writes, and the library header says "Sync arrives in a later update".
6. **ffmpeg.** ffmpeg isn't bundled (owner decision 1): every PC that uses a Shared Library downloads ffmpeg, ffprobe and fpcalc once while online, or through Prepare for offline (S12 #592). After attaching, `checkFfmpeg()` runs; with ffmpeg missing and `.mkv` items, the result carries `ffmpegMissing: { mkvCount }` and the open flow and the library's section show "ffmpeg isn't installed on this PC, so N MKV episodes can't play. MP4 episodes with .ass subtitles still play. Connect to the internet once to download it, or use Prepare for offline." `.mkv` needs ffmpeg (the MSE remux); `.mp4` + `.ass` doesn't.

### Play from drive

Titles render from the snapshot (`meta/<animeId>.json`, `posters/<animeId>.jpg` through `anime-poster://`, which falls back to the drive after the local poster cache; a drive poster is capped at 2 MB, checked when the library is opened and again each time it is served, and read through one handle that stops past the cap). Library → Shared Libraries shows each library's titles; the detail page's attached form lists the drive's episodes and translations with no network and no `animeCache` entry, and a title that is also downloaded keeps its normal page with an "On <library>" group for the episodes only the drive has. `player:find-local-file` with the anime id resolves local first, then the drive's `items[].path`, `realpath`-checked on every call through `paths.ts` `resolveItem`; see `docs/player.md`. `checkItem(libraryId, item)` (ok / missing / wrong size / outside the root) is the same check for S12's integrity step.

**Long paths when spawning ffmpeg.** Node's `fs` calls already use `\\?\` on Windows, but a spawned ffmpeg or ffprobe gets a plain argument. `spawnPathFor(abs)` (`spawn-path.ts`) returns `path.toNamespacedPath(abs)` for a path under an attached root and every other path unchanged; the player's remux / transcode sessions and legacy remux take their file argument through it. A no-op off Windows. S8 uses the same helper.

## Tests

`test/lib/shared-library/`: the golden and edge-case trees under `test/fixtures/shared-library/v1/` (byte-compared, so excluded from Prettier), the schema fingerprint `test/fixtures/shared-library/schema-v1.json`, and over-cap trees built at test time with sparse files. `write.test.ts` injects a crash at every mutating `fs.promises` call of every write and checks the tree reads as a matching pair after each one.
