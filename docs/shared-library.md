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
| `mount-candidates.ts` | Where a removable drive can be mounted, per OS, each check on a 1 s async budget (#574; S7c #581 reuses it), network mounts dropped by `classifyMounts()` (#581) |

The export (S6a #574) lives in `src/main/services/shared-library-export/` (`plan.ts`, `copy.ts`, `snapshot.ts`, `locate.ts`, `job.ts`, `index.ts`); see [Export](#export-videos-only-574).

The merge runner (S9 #584, `src/main/services/sync-runner/`) is the only caller of `writeState`; see [Merge](#merge-584).

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

- `layoutVersion` (major, `1`) and `layoutMinor` (`1` since #623, which added `items[].source`), separate from the state's `stateVersion` / `stateMinor` so the layout and the state schema change independently.
- `libraryId` (a uuid) and `name`.
- `owner`: `{ shikimoriId, nickname }`, or `null` for a *Videos only* library. `mode`: `'videos'` (owner `null`) or `'metadata'` (an owner).
- `generation`, incremented on every manifest write, and `stateGeneration`, the `generation` of the `state.json` it was written with (`null` when there is no state).
- `lastWriter`: `{ installId, appVersion, at }`, rebuilt on every write.
- `titles[]`: `{ animeId, name }`, the explicit scope. A title missing from the drive is out of scope, not deleted; deletions are tombstones inside `state.json`.
- `items[]`: `{ animeId, episodeInt, translationId, translationType, author, quality, path, subtitlePath?, size, sha256?, source? }`, keyed by `itemKey(item)` = `animeId:episodeInt:translationId` with `episodeInt` opaque (`"12.5"` included). `path` is relative, with `/` separators.
- `items[].source` (minor 1, #623): `{ size, subtitleSize, codec, outputSize }`, only on an `.mkv` an export merged from an unmerged pair: the `.mp4`'s and `.ass`'s sizes when it was merged, the merge's codec (`copy` or the encoder), and the `.mkv`'s size when it was written. A reader trusts it only while `outputSize` equals the item's `size` ([Re-export](#merge-on-export-576)). Its absence is minor 0's behaviour: the item is matched by size alone.
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

**Plan.** The selection is `[{ animeId, translationId, episodeInt }]`. Each item is looked up in `downloadedEpisodes` (`${animeId}:${episodeInt}:${translationId}`) and resolved on disk across the hot and cold roots with the episode list's scan (`scanEpisodeFilesAsync`), under each of the title's folder names (romaji, ru, title), tagged file first, then legacy. An item with no file is *missing* (an episode with no download at all can be [pre-fetched](#pre-fetch-577)); one whose translation is `merging` or `deferred` is *busy*; both are skipped. An unmerged `.mp4` + `.ass` pair is copied as both files (`subtitlePath`); merging on export is S6c (#576). The source is re-resolved just before each copy, so an auto-move between hot and cold during a job is followed.

**Target.** The library root is the picked folder when it holds a library itself, otherwise `<folder>/<name>` (`libraryFolderName`: `sanitizeFilename` plus the naming rule's Windows-safety and trailing-dot steps). It is classified by its manifest's `mode` and `owner` against `shikimoriUser.id` only (claims arrive with S7a #578, and S6e #586 tells them apart):

| Target | Videos-only export |
|---|---|
| No library | `new`: create `<folder>/<name>/` with `mode: 'videos'` and `owner: null` |
| A Videos-only library (`owner: null`), made by any PC | `add`: anyone may add to it, a PC with no account included |
| A With metadata library owned by this PC's account | `own-metadata`: blocked ("This library carries watch state…"). S6e (#586) routes it to With metadata |
| A With metadata library with any other owner, or a claim | `foreign`: never written. The siblings `<name>`, `<name> (2)`, … are checked in order: the first Videos-only library among them (the one an earlier export made; anyone may add to it) is added to, as `add` with the owner's nickname, so a re-export copies only what's new; the first free name gets a new library; any other library or plain folder is skipped |
| A library this version can't write (a newer major, over a cap, interrupted) | `read-only`: blocked with the reader's message |

The size estimate counts only items the library doesn't already have (`present`): the same key with the same size, or the same key as an `.mkv` an export merged from this very pair ([Re-export](#merge-on-export-576)). Free space is `statfs(folder)` against those bytes plus a 1% margin (`fitsFreeSpace`, `src/shared/shared-library-export.ts`, shared by the dialog's live bar and main's start check). The start also refuses an empty copy, a library that would pass the 200k item cap, and a second job while one runs.

**Copy.** For each file:

1. `resolveWriteTarget(root, path)`; on `'escapes'` the item is skipped and logged, so a symlinked directory can't redirect a copy outside the root. The item's folder is created one level deep only, so a vanished drive root is never recreated;
2. stream to `<dest>.anime-dl-tmp`, hashing as it goes, fsync, delete any old `<dest>` (never rename onto an existing file), rename into place;
3. verify: the size, plus a re-read sha256 for files under 2 GB (size only above that). A mismatch deletes the file and marks the item failed; it stays out of the manifest;
4. the item joins the manifest at the next checkpoint.

The manifest is written through `writeManifest` every 10 items and at the end (and on pause and cancel), so a cancelled or crashed job leaves a valid library holding whatever finished. Items keep their `sha256`. A title joins `titles[]` with its first finished item; its `meta` and poster are written just before its first file. Names come from the v1 rule, with the library's existing items passed to `nameItems` as the earlier items they are; renamed keys go to `naming.renamed`, and `index.html` is rewritten at each checkpoint when that list is non-empty. Filesystem-specific checks (FAT32, writability, path length) are the [preflight](#export-preflight-575).

**The `meta` re-export.** A `meta/<animeId>.json` that reads at a known major gets the local snapshot's known fields merged over it, and `carryUnknown` carries the existing file's unknown fields at every record level (the file, `titles`, `searchResult` and its `titles`, each `genres` and `episodes` entry by key), so a re-export keeps a newer minor's fields. A file over its 1 MB cap is left alone; an invalid one is replaced. The local snapshot passes the v1 schema check first, so nothing a reader would drop is written, and only allow-listed fields leave this PC.

**Job identity is the library id.** A new library's `libraryId` is generated at start and its manifest, with no items, is written before the first file is copied. The job is saved as `userData/export-jobs/<jobId>.json` ([Storage](./storage.md)). Every run first finds the library: the last known root if its manifest has the same `libraryId`, otherwise the candidate mounts from `mount-candidates.ts` (`D:`–`Z:` on Windows, `/Volumes/*` on macOS, `/media/$USER/*`, `/run/media/$USER/*` and `/mnt/*` on Linux), each searched at its root and one level below with a 1 s budget per check. Two drives with the same `libraryId` (a cloned stick): the first match wins and the job's note says which path it chose and where else the library is. Before each file the job checks the root still holds that library (a `stat` of the manifest it last read or wrote, a full read when that changed), so a different drive at the old letter or path, with another library or none, is never written. Not found: the job is "Waiting for drive '<name>'", retried every 10 s, on Resume, and through "Locate…", a folder picker that accepts only a folder (or a folder one level below it) holding that `libraryId`. A drive pulled mid-copy is the same state: the rename never happens and the manifest stays at the last checkpoint. On resume the leftover `.anime-dl-tmp` is deleted and that file restarts; at boot an unfinished job shows as paused.

**Playback hold, per file.** Before each file the job checks `playerPresenceService.isOpen()`, the merge hold's signal (`docs/ffmpeg.md`, #516). A file already copying when the player opens finishes; the next one waits, shown as "Paused while the player is open", for an `onRelease` listener the job adds when it starts and removes (the returned unsubscribe) when it ends, is cancelled or is paused. Episodes are at most about 700 MB, roughly 25 s on USB 2; a movie in flight can take longer, an accepted risk.

**Jobs reach the renderer** through `export:job-updated` ([IPC](./ipc.md)), into `useExportStore`, and a job card in Downloads: "Exporting to <library> — 12 / 40 files, 8.1 / 23 GB", with Pause, Resume and Cancel, the two waiting states, and Dismiss once it's finished.

### Export preflight (#575)

`services/shared-library-export/preflight.ts` says what will happen on the target before a byte is copied. It runs when the plan is built (`export:plan` returns it as `preflight`) and again at start, and its outcome is `{ ok, fsType, blockers, warnings, skipped, renamed, overflow }` (plus `mayBeSkipped`, `driveWarnings` and `renames`, the old → new names the dialog shows). Blockers refuse the export; warnings never block. The plan's preflight covers every ready tree item the target doesn't already have, and the dialog narrows it to the selection with `preflightForSelection` (`src/shared/shared-library-export.ts`), whose warning texts main's start uses too. A blocked target (`own-metadata`, `read-only`) gets no preflight.

**Where it probes.** A new library's folder doesn't exist yet, so both probes run in the root's **nearest existing ancestor**, found with `stat` alone (walking up to the filesystem root), and preflight never creates a folder. For a new library that is the picked folder (or above it); for a sibling next to a foreign library it is the picked folder, never the foreign root; for `add` it is the library's own root, never its `.anime-dl/`.

**Filesystem type.** `fs-type-probe.ts` asks the OS: PowerShell `(Get-Volume -FilePath $env:ANIME_DL_PROBE_PATH).FileSystem` on Windows (the path goes in through the environment, so no quoting can break the command), `df -P` and then `diskutil info -plist <mount>` (`FilesystemType`, `MountPoint`) on macOS, and `findmnt -J -o FSTYPE,TARGET --target <dir>` on Linux. The result is `fat32 | exfat | ntfs | apfs | hfs | ext | other | unknown` (Linux's `fuseblk`, which ntfs-3g and exfat-fuse share, is `unknown`). Each probe has a 3 s budget; a timeout, a failed command or unreadable output gives `unknown`, which raises no type-based warning. The type alone never decides read-only: macOS with a third-party NTFS driver is writable.

**Writable.** `.anime-dl-probe-<random>` is created with `wx` in that folder, 1 byte is written, and the file is removed in a `finally`. `EROFS` is a blocker ("This drive is read-only on this computer (NTFS on macOS)."), and so are `EACCES` and `EPERM` ("This folder is read-only for you on this computer…"); any other error is a drive warning, and the copy's own errors still apply. While the dialog is open the type and write probes run **once per folder** (the plan request's `session`; a new library name re-plans without a new probe). A blocking result isn't kept, so a stick whose lock switch was flipped, or a folder fixed with `chmod`, is probed again when it is picked again. Start **always probes again** and never reads the dialog's result, so a stick swapped or write-protected after the plan is refused, with the dialog's message. Before probing, `.anime-dl-probe-*` files in that folder older than an hour are removed (left by a killed app); a fresher one may belong to another open dialog and is left alone.

**FAT32's 4 GiB − 1 bytes.** On `fat32`, an item whose largest file is **over** 4 294 967 295 bytes is skipped on its own (a file of exactly that size fits); the rest of the export goes ahead. Skipped items are listed in the dialog and on the job card, and don't count toward the size estimate or the free-space check. Start refuses a selection whose every item is skipped. An S6c (#576) re-encode whose *source* is over the limit is only warned about ("may be skipped if it's still over 4 GB"); a `copy`-codec merge is checked up front by the sum of its inputs.

**The run-time size rule** (`isTooLargeForFilesystem` in `copy.ts`, which S6c's merge step reuses) covers outputs whose size isn't known up front, and a filesystem the probe called `unknown`. A write failure is `skipped: too-large-for-filesystem` when the error is `EFBIG` or ffmpeg's "File too large", or when, on `fat32` or `unknown`, the partial temp file had reached the FAT32 limit, `FAT32_TEMP_THRESHOLD` (4 GiB − 1 bytes less one 1 MiB read chunk, since Windows' fastfat may refuse the whole write that would cross it). Windows reports that limit as a full disk (`ENOSPC`, not `EFBIG`), and a PowerShell probe that timed out there gives `unknown`, so `unknown` takes this branch too. A real disk-full well short of 4 GiB stays a failure, and so does one past 4 GiB − 1 bytes, which proves the drive isn't FAT32 (an ntfs-3g stick is `fuseblk`, so `unknown`, on Linux). Only a disk-full that happens to stop within that last 1 MiB on an `unknown` drive is counted as a skip, an accepted edge. The temp file is deleted, the item joins the preflight skips on the job card, and the job goes on. Any other error, `EIO` included, is still a failure.

**Names.** Every planned path goes through S5's v1 rule (`nameItems`, [above](#the-naming-rule-namingrule--v1)) on every target, because the drive will be opened on Windows later; preflight doesn't extend it. The keys it changed, shortened or made Windows-safe, are `renamed`: the same keys S5 records in `naming.renamed`, which makes it write `index.html`. There is no separate `shortened` list. Start uses preflight's names for the job, so the two can't differ. Names apply only to new items; existing items keep their recorded `path`.

**Path length.** The overflow check is S5's `absoluteOverflow(root, items)`, not a copy of it, run on every OS. On macOS and Linux the root is first written as Windows would see it: its path below the mount point the type probe reported, under a drive letter (`/media/u/STICK/Anime Library` → `E:\Anime Library`); with no known mount point it is skipped there. A non-empty result is a warning naming those items: "N files will have paths too long for some Windows apps. Choose a shorter folder." The relative paths are within the 200-unit budget, so it is always the root that is too deep.

**The dialog** shows a Preflight panel above Export: the blockers, the drive warnings, and one expandable line each for the skipped files, the re-encodes at risk, the renamed items (old → new) and the paths too long, all counted over the current selection.

#### Per-filesystem limits

S11 (#587) finalizes this table.

| Filesystem | Largest file | Name length | Notes |
|---|---|---|---|
| FAT32 | 4 GiB − 1 bytes | 255 UTF-16 units | Larger files are skipped (preflight and run time). Case-insensitive |
| exFAT | 16 EiB | 255 UTF-16 units | Case-insensitive. Some Linux setups mount it read-only |
| NTFS | 16 TiB and up | 255 UTF-16 units | Read-only on macOS without a third-party driver (the write probe decides) |
| APFS | 8 EiB | 255 UTF-8 bytes | Usually case-insensitive |
| HFS+ | 8 EiB | 255 UTF-16 units | Usually case-insensitive |
| ext4 | 16 TiB | 255 bytes | Case-sensitive |
| Windows paths | — | MAX_PATH 259 UTF-16 units for the whole path | Reported, not prevented (`absoluteOverflow`) |

### Merge on export (#576)

An unmerged download (auto-merge off, or a merge that failed) is a `.mp4` + `.ass` pair. The export can copy it as both files, or merge it into one `.mkv` on the target, which plays better in VLC on someone else's PC.

**The option** is per job: `unmerged: 'copy-as-is' | 'merge'` and `codec` on `export:start` (and on `export:plan`, so the preflight names and sizes follow the choice). The dialog shows it only when the selection has unmerged pairs: "Unmerged episodes (N): Copy .mp4 + .ass as they are · Merge into MKV". It also shows it when the selected pairs are all already on the drive as an `.mkv` an export merged (#623), titled "Unmerged episodes: all already on the drive", so the codec the "won't be re-encoded" note is about stays in view. Merge needs ffmpeg **on the exporting PC** (`checkFfmpeg`; ffmpeg is not bundled, owner decision 1 on #563). `export:plan` reports it as `merge: { available, encoders }`. With ffmpeg, Merge is the dialog's default; without it, Merge is disabled with "ffmpeg isn't installed on this PC. Download it in Settings → Merging", and `start` treats a `merge` request as `copy-as-is`. When `unmerged` is left out, `start` copies as-is. Choosing Merge also says "Other PCs need ffmpeg to play .mkv files", since a reader without ffmpeg can't play `.mkv` (S7a warns when it opens a library).

**The codec** defaults to `copy` (no re-encode), never the Merging tab's `videoCodec`: a re-encode here is an explicit choice. The list is the Merging tab's (`src/shared/video-codecs.ts`): `copy` plus the HEVC encoders `checkFfmpeg` reports. `start` refuses a codec this PC's ffmpeg doesn't have. **Resolution is never reduced**: the merge arguments carry no scale filter, `-s` or `-vf`; a re-encode changes only the codec. A hardware encoder that fails mid-file fails that item and the job goes on; no other codec is tried.

**One `.mkv` item.** A merged pair is one manifest item with `path` ending `.mkv` and no `subtitlePath`, named by the v1 rule with the `.mkv` extension. The subtitle stream's language and title come from the same `subtitleMeta` the download queue uses (`src/main/lib/subtitle-meta.ts`), so an exported MKV looks like a local one.

**The merge** goes through `DownloadManager.mergeForExport` (`docs/ffmpeg.md`, "The ffmpeg mutex and export merges"), the queue's own `runFfmpeg`: one ffmpeg at a time, low CPU priority, the player hold, and `destroy()`'s kill and unlink. ffmpeg writes `<dest>.anime-dl-tmp.mkv` on the **target** (the `.mkv` extension picks the muxer); then the job fsyncs and hashes it and gives it the copy's rename and verify. The local `.mp4` and `.ass` are never modified or deleted. While another merge holds the ffmpeg, the card says "Waiting for a download merge"; then "Merging 47%"; a copied file says "Copying". Downloads says "Download merges wait until the export's current merge finishes" while an export merges.

**Player hold.** `mergeForExport` checks the hold after it gets the ffmpeg and before ffprobe, so nothing probes the target while the player is open. A `'held'` merge puts the job in "Paused while the player is open"; its own `onRelease` listener (the one S6a adds per run) resumes the same file, and `resumeHeldMerges` stays registered beside it. The export never sets the queue's `heldRequest`.

**Races.** A Scan & merge (or a download merge) can turn the pair into an `.mkv` while the export waits: `mergeForExport` returns `'gone'`, the job re-resolves the item and copies the `.mkv` it now finds. Pause and Cancel kill only the export's ffmpeg (`cancelExportMerge`) and delete its temp file, and while the export is still "Waiting for a download merge" they take it out of the ffmpeg queue at once instead of waiting for that merge; the download queue's Cancel never touches it. A quit (`destroy()`) kills it and deletes the target's `.anime-dl-tmp.mkv`; nothing is recorded, and the job shows as paused at the next boot, whose resume also deletes any `.anime-dl-tmp.mkv` a crash left.

**Sizes.** A `copy` merge is about the pair's sum, so the preflight's FAT32 check applies to that sum and the free-space bytes count it. A re-encode's size is unknown up front: the dialog says "size will change", the free-space check uses the sum plus 10% (`mergedBytes`), and on FAT32 a re-encoded item whose source is over the limit is listed in `mayBeSkipped`. An output that still hits the limit is caught by the run-time size rule above (`EFBIG`, "File too large", or the temp file at the FAT32 limit): its temp file is deleted, the item is `skipped: too-large-for-filesystem`, and the job continues.

**Re-export (#623).** A merged `.mkv`'s size is neither the `.mp4`'s nor the pair's, so size alone can't say the library has it. Each merge records what it actually read and wrote in the job (`sources`, [Storage](./storage.md)) at the point it finishes, so a resume after a restart still has it, and the item gets it as `source` ([`manifest.json`](#manifestjson)). An item whose `.mkv` came from the `'gone'` race (a download merge made it first, and the job copied it) gets no `source`. `presentKeys` (`plan.ts`) then counts an item as present when the key matches **and** either `item.size` equals the local video's size (copied items, unchanged) **or** the local item is an unmerged pair, `source.outputSize === item.size`, and `source.size` / `source.subtitleSize` equal the local `.mp4`'s and `.ass`'s sizes.
- **It doesn't depend on the merge choice or the codec.** A pair copied as-is is present whether Merge is on or not, and a merged one is too, so the tree doesn't flip as the user changes the selects (each change re-plans). A re-export that asks for another codec keeps the existing file: nothing already on the drive is re-encoded. The dialog says "N episodes are already on the drive as MKV and won't be re-encoded" when Merge is on with a codec other than `copy` and some selected pairs are present that way (`ExportTarget.presentMerged`).
- **`outputSize` ties `source` to the file it was written for.** A PC on minor 0 keeps `source` in the unknown-field bag, and its writer puts the drive's unknown fields back by `itemKey` even onto an item it replaced completely. Such a PC still re-exports a merged item (its sizes never match) and writes its own files over it, carrying the old `source` onto them; `outputSize` then differs from the new `size`, so the stale `source` is ignored. A minor-1 PC that copies as-is over a merged item writes no `source`: the writer never carries back a known field the caller left out.
- **A re-download** changes the `.mp4`'s (or the `.ass`'s) size, so that item is merged again and replaced, with a new `source`.
- **A pair later merged locally** (Scan & merge, or a download merge) is a local `.mkv` whose size differs from the exported `.mkv`'s, so the next re-export copies it over the exported one. That is accepted: it is a different file, not this rule failing.

### Pre-fetch (#577)

An episode in a title's cached episode list with no download in any translation (`notDownloaded` in the tree) can be selected too. The export enqueues its download, waits for it, and copies it once it is ready; the other items keep copying meanwhile. Downloads land in the hot root and are registered as usual, so they stay on this PC afterwards, and cancelling the export doesn't cancel them (the dialog says so).

**When it can be selected.** `export:plan` reports a gate, `prefetch: 'ok' | 'offline' | 'no-token' | 'unavailable'`: offline (`offlineService.isOffline()`, #567) the missing episodes stay disabled with "Needs internet to download"; with an empty `token` setting they show "API token is required for downloads" and the start refuses with the detail page's "API token is required for downloads. Set it in Settings."; `unavailable` is a service built without a download queue. Each missing episode carries `options`: the cached translations (`animeCache[animeId].episodes`, active ones, the best height per type and author), the title's own downloaded translation (its most common `translationType` + author, as the detail page picks a row's translation) first, picked from a select when there are several. An episode the cache has no translations for stays disabled with "Open the title once online to refresh".

**Already on the drive.** A not-downloaded episode whose key (`animeId:episodeInt:translationId`, for any of its options) is in the target's manifest is on the drive: exported earlier, then deleted here to free space. `export:plan` reports those keys as `ExportTarget.presentMissing`; the tree shows "On the drive", the title node leaves it out, and it isn't counted. `start` leaves out a pick whose key the drive has: it is never enqueued, counted or written. The key alone decides, unlike `presence` for a downloaded item, which also compares sizes: there is no local file to compare with. A key another PC adds while the job runs is never written over: a ready item is named against every library item (the manifest read again if it changed), and just before its copy an entry with its key at another path fails it as "Already on the drive".

**Size: a real source or "unknown".** `qualityProbes` holds video heights and is only used as the download's `height`. The estimate (`estimatePrefetchSize`, `plan.ts`) is the bytes per second of the title's downloaded episodes by the same author (their `stat`ed sizes over their cached `Translation.duration`, read as plain seconds or as a clock such as `24:00`) times this episode's duration; without durations, their median size; without such siblings, "size unknown". The tree shows "Will be downloaded first (~350 MB)" or "(size unknown)". The estimates count on the target and on this PC (the hot root's `statfs`, `ExportPlan.localFree`), each line adding "+ N episodes of unknown size"; both are checked at start. Every pre-fetched item's real size is checked against the target's free space again just before its copy: one that doesn't fit fails with "Not enough space on the drive", and the job goes on.

**Enqueue in main** (`prefetch-request.ts`), as the detail page does it (`use-episode-downloads.ts`): the token check, then per title `addDownloadedAnime` (`src/main/lib/downloaded-anime.ts`, the body of the `DOWNLOADED_ANIME_ADD` handler, which now calls it) with the `downloadedAnime`, `library` or cached-details record, then `downloadManager.enqueue` with the same `DownloadRequest`: `animeName` by `romaji || ru || title` (so the folder is the detail page's), `height` from `qualityProbes` or the declared height, `author` = `authorsSummary`, `translationType` = `type`. The job file keeps each item (`prefetch`, [Storage](./storage.md)); nothing is ever enqueued again.

**Readiness is one function**, `evaluatePrefetchItem` (`prefetch-readiness.ts`), a pure function of the queue rows (`video-<tr>`, `sub-<tr>`), the merge status, "a merge is expected", "a merge is in flight or held", the files in the hot and cold roots, the offline flag and the clock. It runs on every `onVideoDownloaded` and `onMergeComplete` event (the [listener lists](./data-flow.md), which the job subscribes to while it runs and unsubscribes from when it ends, pauses or is cancelled), on a 3 s tick while an item waits, and when a job runs, at resume and after a boot; at boot it records failures and each item's state for the card. Events only make it run sooner; several ways an item becomes ready fire none. In order:

| Step | State | Decision |
|---|---|---|
| 1 | Video row `queued` / `downloading` / `paused` | wait for the download ("Waiting for connection" while offline) |
| | Video row `failed` / `cancelled` | failed, with the row's `error` / "Download cancelled" |
| 2 | Subtitle row still going | wait; `failed` or `cancelled`: video only, "Subtitles failed to download" |
| 7 | No video row and no files | failed, "Download no longer queued" (files without rows go on) |
| 3 | `'deferred'` or `'merging'` | wait for the merge (the only two waits on the status) |
| 4 | `'completed'`, or an `.mkv` on disk | ready: the `.mkv` |
| 5 | `'failed'` | ready: the pair |
| 6 | `null` or `'pending'`, no merge expected | ready: the pair |
| | … a merge expected, and one in flight or held | wait |
| | … a merge expected, nothing in flight or held | ready: the pair, after two such evaluations ≥ 3 s apart and ≥ 5 s past `doneAt` |

"A merge is expected" is episode completion's own predicate, `isMergeExpected({ autoMerge, ffmpegInfo, ffmpegPath })` (`lib/episode-completion.ts`, used by both of its tails), re-read at every evaluation and only after `ffmpegReady`, so a mid-job toggle of auto-merge is followed and boot latency never looks like a missing merge. "In flight or held" is `DownloadManager.isMergeCycleActive()` (a cycle or a Scan & merge runs, or waits for the ffmpeg mutex), `hasHeldMerge()` (a held request, read without consuming it), or the player open. `'pending'` gets step 6's rule because only a merge pass clears it: a kill mid-merge leaves it (`loadQueue`, whose `dropTruncatedMerge` deletes the partial `.mkv` before any evaluation), and `finalizeDeferred` sets it with no merge to follow when none is expected. The job never starts a merge itself. The grace after `doneAt` (when the rows were first seen finished, kept in the job file) covers the 100 ms `episodeComplete` timer and the awaits before a cycle sets `merging`; a cancelled merge, or a `'pending'` a kill left, is given up on after it.

**One source for the files.** The decision's "an `.mkv` is on disk" and the copy's source come from the same check of the names `enqueue` gave the files, in the hot and then the cold root: the `.mkv` in either root, else the `.mp4` with its `.ass`. It needs no `downloadedEpisodes` entry (a kill can lose the store's last coalesced write). The two can still disagree when a status outranks the disk, `'completed'` with only the pair here: the item is given up on after three such evaluations ("Merged, but its .mkv isn't on this PC"), so the job always ends.

**Copying a ready item.** It is planned exactly like a downloaded one: resolved on disk, named by the v1 rule against the library and the job's other items, and copied (or merged on export) by the same per-item step, so the re-resolve before each file and [Merge on export](#merge-on-export-576) apply unchanged. A pair arrives unmerged when auto-merge is off: with *Merge into MKV* it goes through `mergeForExport` into one `.mkv` on the target, leaving the local pair and the queue's merge alone; with *Copy as they are* both files are copied. A pair is guarded on both sides: just before its copy the evaluation runs again, and after the copy, before the item joins the manifest, a merge status of `'merging'` or `'completed'`, or a source `.mp4` that is gone, deletes the copied files from the target and puts the item back to waiting, so the `.mkv` is copied instead. A source an auto-move took to cold mid-copy (`ENOENT`) is resolved again and copied once more.

**Kill and resume.** The job file keeps each item's translation, state and `doneAt`; the queue and merge statuses come from `queue.json`, the files from the hot and cold roots, so a resume decides from what is there, not from events it missed. A failed queue row fails its item with that row's `error`; "Download no longer queued" is only for an item with no row and no files.

**The job card** says "Downloading N episodes before copying", with each item's state (waiting for download, "Downloading 42%", waiting for connection, waiting for merge, copying), and "Waiting for N downloads" when only pre-fetched items are left.

## Opening a library (#578)

`AttachedLibraryService` (`src/main/services/attached-library/`) owns every attached library. It persists `attachedLibraries` (`libraryId → { root, name, mode, owner, access, accessReason?, claim?, lastSeenAt, lastSyncAt }`, see `docs/settings.md`), keeps each manifest and its `meta/` snapshots in memory, and re-reads every persisted root at startup, after each manifest write by an export into it (#616), and when the availability poller finds it back or at a new path (#581, see [Drive detection](#drive-detection-581)). The export job calls `onLibraryWritten(libraryId, root)` right after each successful `writeManifest`, fire-and-forget, so a pause, cancel or lost drive after a checkpoint still shows what landed, and a failing or slow re-read can't fail or stall the copy. `refresh(libraryId, root)` takes the startup path (`reopen`, without `reconcileClaims`), acts only when `realpath(root)` is the attached copy's, runs one at a time per library (a call during a read re-runs once when it settles), waits for the startup reopen so an older startup read never lands after it, and fires `onChanged`. The startup reopen re-fetches `attachedLibraries` after each read, so an `attach` made meanwhile is kept, and it skips a library that `attach` opened meanwhile; a root that no longer holds the library keeps the old copy. **Its roots are never storage roots:** they are not in `ROOT_KEYS`, never handed to `coldStorageService`, never scanned by `episode-file-scan.ts` or the usage scan, and never added to the player's `dirsToCheck`, so cleanup and cold-storage moves can't touch a drive. The service is the only thing that knows these paths.

**Only the merge writes state to a library (#584).** Opening, the writability check and playing read only; a test snapshots the tree and spies on every write-capable `fs.promises` call under the root.

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

   The role is derived again on every read. A claim lasts while the PC has no account: a login as the same id makes it plain ownership, as a different id the library turns foreign; either way the claim is dropped (S9 keeps the library base and merges later). A claim never pushes to Shikimori. `owner` and `claim` libraries merge with this PC on attach, on every availability transition and on Sync now ([Merge](#merge-584)).
6. **ffmpeg.** ffmpeg isn't bundled (owner decision 1): every PC that uses a Shared Library downloads ffmpeg, ffprobe and fpcalc once while online, or through Prepare for offline (S12 #592). After attaching, `checkFfmpeg()` runs; with ffmpeg missing and `.mkv` items, the result carries `ffmpegMissing: { mkvCount }` and the open flow and the library's section show "ffmpeg isn't installed on this PC, so N MKV episodes can't play. MP4 episodes with .ass subtitles still play. Connect to the internet once to download it, or use Prepare for offline." `.mkv` needs ffmpeg (the MSE remux); `.mp4` + `.ass` doesn't.

### Play from drive

Titles render from the snapshot (`meta/<animeId>.json`, `posters/<animeId>.jpg` through `anime-poster://`, which falls back to the drive after the local poster cache; a drive poster is capped at 2 MB, checked when the library is opened and again each time it is served, and read through one handle that stops past the cap). Library → Shared Libraries shows each library's titles; the detail page's attached form lists the drive's episodes and translations with no network and no `animeCache` entry, and a title that is also downloaded keeps its normal page with an "On <library>" group for the episodes only the drive has. `player:find-local-file` with the anime id resolves local first, then the drive's `items[].path`, `realpath`-checked on every call through `paths.ts` `resolveItem`; see `docs/player.md`. `checkItem(libraryId, item)` (ok / missing / wrong size / outside the root) is the same check for S12's integrity step.

**Long paths when spawning ffmpeg.** Node's `fs` calls already use `\\?\` on Windows, but a spawned ffmpeg or ffprobe gets a plain argument. `spawnPathFor(abs)` (`spawn-path.ts`) returns `path.toNamespacedPath(abs)` for a path under an attached root and every other path unchanged; the player's remux / transcode sessions and legacy remux take their file argument through it. A no-op off Windows. S8 uses the same helper.

## Drive detection (#581)

Electron has no mount or unmount event, and a drive's letter or mount path changes between plugs, so `services/attached-library/poller.ts` polls, and matches on `libraryId`, never on the path. It ticks every 10 s and on window focus, starting once the startup re-read is in and the window has loaded (so a found-on-a-drive event at startup reaches a subscribed renderer), and stops on quit, when each available library's `lastSeenAt` is saved.

1. **Known roots.** Each attached library's last `root` gets a `stat` of `.anime-dl/manifest.json`. Unchanged since the last read: seen (the first tick takes the startup read as current). Changed, or the library was unavailable: the service's `reopenAt`, the same `reopen()` and `commit()` as the startup read and `refresh`, which re-reads it and checks the `libraryId`. A manifest that doesn't hold the library is read again only once it changes. Gone: **unavailable**, `lastSeenAt` kept as the last time it was seen. The in-memory copy stays for S8 (#582), but `availableSnapshots` (S3b's search) drops it.
2. **Mount candidates.** `mount-candidates.ts` (S6a's list: `D:`–`Z:`, `/Volumes/*`, `/media/$USER/*`, `/run/media/$USER/*`, `/mnt/*`) is scanned with `discoverLibraries`, at each candidate and one level below. A newly mounted candidate is scanned once, to offer its unknown libraries; every candidate is scanned while an attached library is unavailable. A known `libraryId` found at a new path moves there (`root` saved) and becomes available. Two drives holding copies of one library: the latest seen wins, and S9's `generation` check catches a rollback.
3. **Relative-path probe** (#620). Step 2 looks only one level below a candidate, so a library exported into a subfolder (`K:\Anime\<name>`, `/media/u/STICK/Anime/<name>`) needs this third lookup after its drive comes back under another letter or mount name. For each **unavailable** library, `relativeToOldMount` (`mount-candidates.ts`) takes its last root's path below the mount it was on:
   - **Windows:** below the drive, for `D:`–`Z:` roots only (the candidates' letters). A `C:\…` or UNC `\\server\share\…` root gets no probe.
   - **Linux and macOS, and every OS with `ANIME_DL_MOUNT_PARENTS`:** the old mount is gone after an unplug, so the root is matched against the candidate parents (`mountParents`, the one list the candidates are built from, override included). The old mount is the parent plus the next folder, so `/media/u/STICK/Anime/Lib` gives `Anime/Lib`. A root under no parent (a hand-opened folder elsewhere) gets no probe; Re-locate… covers it.
   - Only a path at least two folders below the mount is probed (step 2 covers depth 0 and 1), and never at the old root itself (step 1 covers it). Whether a path is `\`- or `/`-separated comes from the root's shape, not the host OS.

   Each candidate's scan job then makes one `stat` of `<candidate>/<that path>/.anime-dl/manifest.json`, after matching and re-finding the candidate's own discovered libraries and before its offer. On a hit it identifies the folder (cached by the manifest's signature, like step 2's finds) and calls `reopenAt` only when the folder holds that `libraryId` and the library is still unavailable: a different library at the same path on another drive is refused, and isn't read again until its manifest changes. The probe runs inside the candidate's job, in-flight slot and 1 s budget, so it adds one `stat` per candidate, per unavailable library, per tick, and never scans deeper.
4. **Unknown libraries** on a newly mounted volume raise one `shared-library:found` per volume, listing them all: the toast "Shared Library '<name>' (<nickname>) found on <volume>" with Open (the open flow on those libraries, no picker), Not now, and Don't ask for this drive. The poller's finds are kept apart from the open flow's discovery: Open attaches with `from: 'found'`, the root the poller found, and a background find of a replica on another drive never changes which root a hand-opened dialog attaches. A volume is offered at most once per mount; "Don't ask" is remembered by `libraryId` in `sharedLibraryPromptDismissed`.

**The cost guard is async.** Every filesystem call in `poller.ts` is `fs.promises` (a test reads the file for `*Sync` calls). Each check races the 1 s budget (`withBudget`), so a sleeping disk or a hung mount never blocks the main process. A call past its budget still occupies one of libuv's four threadpool threads, shared with all file I/O including the `anime-video://` streams, so its path stays in the poller's in-flight set and is skipped until the call settles, and no more than 2 calls are outstanding in total, which leaves two threads for playback and downloads. `mount-candidates.ts` likewise never issues a second check of a path whose first is still pending.

**Network shares are unsupported** (NAS is out of the epic's scope), and excluded from polling: `classifyMounts()` in `mount-candidates.ts` marks network mounts and the candidate list drops them, for S6a's resume search too.

| OS | Source | Network |
|---|---|---|
| Linux | `/proc/self/mountinfo`, a file read (the deepest mount holding the path) | `nfs`, `nfs4`, `cifs`, `smb3`, `smbfs`, `9p`, `davfs`, `afs`, `ceph`, `glusterfs`, `fuse.sshfs`, `fuse.rclone`, `fuse.davfs2` |
| macOS | `/sbin/mount` | `smbfs`, `nfs`, `afpfs`, `webdav`, `ftp` |
| Windows | `Win32_LogicalDisk` through one `powershell -NoProfile` call, 5 s timeout | `DriveType` 4 |

It runs only when the candidate set gains a path it hasn't classified, and each verdict is kept until its path disappears. If it fails (no PowerShell, or a cold PowerShell past its 5 s timeout on the first launch after a boot) or can't place a path, the path is still a candidate, probed under the budget. A failed run doesn't count as done: the same set is classified again once 60 s have passed (`CLASSIFY_RETRY_MS`), so a mapped network letter drops out after the retry, and a PC where PowerShell is blocked spawns it at most once a minute. A library on a network share opened by hand still opens and plays, and its known-root check still runs under the budget, but it is never auto-detected. Unpackaged runs (e2e, manual checks) can point the candidates at test folders with `ANIME_DL_MOUNT_PARENTS` (`path.delimiter`-separated parents whose children are the candidates).

## Forget and Re-locate (#581)

**Forget** (`shared-library:forget`, the ⋯ menu in Library → Shared Libraries and in Settings → Storage) never touches the drive:

1. It waits for any S9 (#584) sync run on that library (the service's `syncIdle` dependency), and any poller re-read or refresh of it.
2. It awaits each forget hook's `pendingCount(libraryId)` and sums `libraryChanges` and `resolutions` separately. A hook whose count throws is logged and counts 0.
3. If either sum is above 0 without `confirmDropPending`, it returns `{ needsConfirm: true, pendingCount }` and changes nothing. The dialog first asks "Forget <name>? The drive isn't changed."; on `needsConfirm` it shows "Forget <name>? N changes from this library and M review-screen choices for it will be discarded. Your watch state on this PC isn't changed, and the drive isn't changed." (a zero part left out), and its Forget sends `confirmDropPending: true`.
4. It removes the `attachedLibraries` entry (and its claim) and the `sharedLibraryPromptDismissed` entry, and drops the in-memory copy.
5. It awaits every hook's `onForgotten(libraryId)`; one that rejects is logged and the rest still run. The IPC call resolves after all of them settled.

**The forget-hook contract.** `attachedLibraryService.registerForgetHook({ pendingCount?(libraryId), onForgotten(libraryId) })` returns an unsubscribe handle; it is multi-listener (`createListenerSet`). `pendingCount` returns `{ libraryChanges, resolutions }`, sync or as a promise, reads no drive and makes no network call, and its two numbers never overlap. `onForgotten` deletes the per-library data its slice owns, is idempotent, and never touches the drive. Until S9 registers its hook, both counts are 0 and Forget never warns. S9 (#584) registers one hook (its pending-store provenance, the queue lock, the revert-to-newer rule and the conflicts are specified and tested there); S8 (#582) registers one that deletes `userData/shared-library-cache/<libraryId>/`.

**Re-locate** (`shared-library:relocate`) picks a folder and accepts it only when it, or a folder directly inside it, holds the same `libraryId`; that root is re-read through `reopenAt`, saved, and available.

## Lifecycle (#582)

How the rest of the app behaves as a library's availability changes.

**Availability transitions.** A transition is a read that makes a library available when it wasn't: the startup re-read, an attach, and a poller or Re-locate `reopenAt` of an unavailable library. Going unavailable (`markUnavailable`) is the other one. `attachedLibraryService.onAvailabilityChanged(listener)` reports each as `{ libraryId, available, access, accessReason?, becameWritable }`, after the record is saved, and returns an unsubscribe handle (multi-listener; a listener that throws is logged). It also fires when `access` turns from read-only to read-write. S9 (#584) merges on these. A `refresh` after an export's write, and a poll that finds the manifest unchanged, are not transitions.

**Read-only mounts: one non-writing check, then demotion at write time.** Nothing is written to a drive to learn whether it is writable.

1. Every transition re-runs `checkWritable(root)`, the same `access(<root>/.anime-dl, W_OK)` as the open flow. `EROFS`, `EACCES` and `EPERM` give `access: 'read-only'`, `accessReason: 'mount'`; a success makes it read-write again. An inconclusive check (`EIO`, anything else) is logged and keeps a `mount` or `write-failed` demotion. The reader's `version`, `size` and `interrupted` come first and are never cleared by this check.
2. `access(W_OK)` can say writable when the medium isn't (Windows ignores write protection for directories; some FUSE mounts lie). `attachedLibraryService.reportWriteFailure(libraryId, err)` is S9's contract: when a write under the root fails with `EROFS`, `EACCES` or `EPERM`, S9 calls it, keeps the library's changes pending and stops writing to it. The library becomes `access: 'read-only'`, `accessReason: 'write-failed'`, saved and broadcast, until its next transition re-checks it; a non-transition re-read keeps it. Other errors (`ENOSPC`, `EIO`) don't demote, and a library that is already read-only (a `version` one included) is left as it is. It never throws.
3. A read-only library still plays. Its header in the Shared Libraries tab and its row in Settings → Storage show "Read-only on this computer", with the reason as the tooltip: the drive is mounted read-only, a write failed, or the library's format is newer than this app.

**Unplugged titles.** An unavailable library's titles stay listed: dimmed cards with "Drive not connected" (the tooltip names the library and when it was last seen), Play and Copy disabled, and on the attached detail page the same chip with the drive's episodes listed and their Play disabled. In the session the drive went away, they render from the copy read before. After a restart they render from the **snapshot cache** (`snapshot-cache.ts`, `userData/shared-library-cache/<libraryId>/`, see [Storage](./storage.md#shared-library-snapshot-cache-userdatashared-library-cache-582)): the manifest, every title's `meta/` snapshot, and the posters, refreshed from each fresh read whose `generation` differs from the cached one (or whose posters were evicted). `anime-poster://` serves an unavailable library's poster from the cache. Forget deletes the library's cache dir through its forget hook.

**A claim PC's rates.** A claim PC has no Shikimori session or rate cache, so on it an attached title's card and detail page read the rate (score, status, episodes) from the library base `sync-bases/library-<libraryId>.json` (S9 #584), plugged in or not; `shared-library:list` and `shared-library:get-title` add it as `rate`. With no base yet, no rate shows. The snapshot cache never holds rate values.

**Mid-play removal.** On POSIX an open fd keeps reading a renamed or unmounted file, so a removal surfaces on the next open. `classifyMissing(path)` says `drive-disconnected` for a path under an attached root that can no longer be `stat`ed, and `reportUnreadable(path, err)` does the same from an error already in hand (`ENOENT`, `EIO`, `ENXIO`, `ENODEV`, `EBUSY`); both log one `drive-disconnected` line per library until it is seen again, and a local file is never reported. The player's side is in [Player](./player.md#a-drive-disconnected-mid-episode-582).

**Never a storage root.** The attached roots live only in this service: no `ROOT_KEYS` setting, no `coldStorageService` root, no cleanup, cold-storage move, usage scan, episode-file scan, `download:scan-merge` or player `dirsToCheck` ever receives one, before or after a re-plug at a new path (`test/services/attached-roots-never-scanned.test.ts`).

## Merge (#584)

The merge runner (`src/main/services/sync-runner/`) reconciles watch state in up to three places, this PC, each owned or claimed library, and Shikimori, against each PC's **own last common base** per party (`sync-bases/library-<libraryId>.json`, `sync-bases/shikimori-<ownerId>.json`). It is the first and only writer of state to a drive. The engine is pure: `merge3(base | null, a, b, FIELD_TABLE, { now, scope, skip?, order? })` in `src/main/lib/sync-merge/` returns side A after the merge (this PC), side B after it (the library or Shikimori), the next base, the changed paths on each side, the conflicts and the clamps.

- **The rules are S4's field table**, applied as written ([Watch Progress](./watch-progress.md#the-syncdoc-and-the-merge-field-table-572)). "Changed" is a value difference from the base. A conflict leaves the field as it was on both sides and the base where it was, so it comes back until it is resolved. Clocks more than 120 s in the future are clamped to now on input, and each clamp is logged.
- **Scope.** Only titles in the library's `titles[]` (and, for a title's Sync now, only that title) take part. Every other title is untouched on both sides: its drive entry is written back as the drive had it, and its base entry is kept byte for byte, so the merge resumes from it if the title comes back into scope.
- **The first merge with no base** is the field table's no-base form: equal values are unchanged; a value on one side only is taken silently (absence is "never had it", which is how an S5 empty-state library, `stateGeneration: null`, merges); position, stars, priority and order go to the later `at`, a tie to this PC; `watched: true` wins; `episodes` takes the max; differing `status`, `score` or `rewatches` are conflicts; `dismissed` is a union. For the Shikimori leg the base is the Shikimori side, so only this PC's pending results are pushed.

**Order: local ↔ library first, then the result ↔ Shikimori.** Per available owned or claimed library (foreign, *videos only* and read-only libraries are never written):

1. Read the pair with S5's reader (`'interrupted'` is `error: 'unreadable'`), and load the library base.
2. **Rollback check.** When `state.generation` is below the base's `stateGeneration`, the drive is an older replica (logged). A replica field whose `at` isn't newer than the base's clock for that field counts as the base's value; one edited after the copy still applies. `dismissed` (no clock) takes the base's.
3. `merge3(base, local, library)`. The local side is S4's projection; on a claim PC its rates are the library base (it has no session).
4. **The raise** (owner decision 5), only on the owner's logged-in PC and only with a base (guard 1): the episodes the library flips to watched (whole numbers only) give one `nextWatchedRate(mergedRate, highestEpisode)` (`src/main/lib/shikimori-rate.ts`, shared with S0's auto-mark). A **forward raise** (`episodes` up) always goes through and reaches the drive in the same run. A **rewatch raise** (the merged rate is `completed`) keeps only flips newer than the rate's Shikimori clock (the cached `serverUpdatedAt`, or an `origin: 'shikimori'` field clock that came through the library; guard 2), and stays **unconfirmed**: written to the pending store with `unconfirmedRewatch: true`, patched into the cache for display, and kept off the drive until a drain settle confirms it.
5. Apply locally through `applySyncDoc`, with the library's plain unknown keys at the doc and title levels. Rate fields go to the pending store, never only to the cache. A field left unapplied (a star with no `AnimeSearchResult`) keeps its base, so it is retried.
6. Write the drive with `writeState`, only when side B changed or a tombstone expired: owner- or claim-checked, state then manifest, the writer's own `generation` and `lastWriter`. Tombstones older than 365 days or for titles out of scope are dropped (`pruneDocTombstones`). The writer carries the drive's unknown fields by path. `EROFS`, `EACCES` or `EPERM` call `attachedLibraryService.reportWriteFailure(libraryId, err)` (S8), which demotes the library to read-only; `ENOSPC`, `EIO` and anything else are logged as `error: 'io'`. Either way the local apply stands and the library's changes stay pending as the projection-vs-base difference.
7. Store the new base with the drive's `stateGeneration`, only after the write succeeded (or when nothing needed writing). `attachedLibraryService.markSynced` records `lastSyncAt`, and `refresh` re-reads the library after a write.

**The Shikimori leg** runs once per owner, logged in as that owner and online, over the union of that owner's in-scope MAL ids, after the library legs: `drainNow()` first, so its entries never consolidate behind an older user entry; any MAL id still in the live queue is skipped for this run ("waiting for queued edits"). Then one `getUserAnimeRates`, whose `updated_at` is the Shikimori-side clock, and:

- **Path F** cancels an unconfirmed rewatch raise older than the fresh row: the pending field goes, the cache is reverted to that row (with `shikimori:rate-updated`), and a `rewatch-superseded` log entry says "your rewatch didn't count because Shikimori changed after it". Forward raises are never cancelled.
- `merge3(shikimoriBase, local, shikimori)`. Shikimori-side changes are applied to the cache and clear their pending field (path B). Local changes are queued as one **field-scoped** entry per MAL id (`fields`, a fresh `before` = the row just read, per-field `origin.provenance`), and their base waits for the drain's settle. A field whose merge result equals the row clears its pending value and advances the base at once (path A). Conflicts keep both.
- After the leg, a pending field exists only with a queued push whose `after` differs from the server, or a held conflict.

**Pending per owner.** `userData/sync-pending/<ownerId>.json` holds `{ [malId]: { [field]: { value, clock, provenance, prePatch, unconfirmedRewatch?, drops? } } }`: every rate value a library leg, a raise or (S10) a resolution produced, written (tmp + rename) before the cache is patched. It is the durable copy: the projection reads a pending value while its clock is at least the field's `syncMeta` stamp, so a wholesale rate refresh can't make the next library leg write the server's old value back. A newer user edit wins at once and the runner deletes the field (path D). `prePatch` is the cache's server value before any pending patch; an overwrite (library M, then L) carries the first one forward. It is cleared by paths A, B, D, F, a drain settle that confirms it (path C), and Forget (E); never by logout, an account switch or S0b's Discard. Three consecutive 4xx drops of a field make a held conflict ("Shikimori rejected this change"). A wholesale refresh newer than the patch is kept when a field is dropped; otherwise the cache goes back to the newer of `prePatch` and the Shikimori base. While another account is logged in, an owner's libraries are foreign: neither merged nor written, and their bases and pending file stay.

**Conflicts** are kept in `userData/sync-state/conflicts.json`, one record per `(ownerScope, animeId, fieldPath)` with every party (`local`, `library:<id>`, `shikimori`), each leg's base, each party's clock, a `suggestion` (the newest `at`, none on a tie or a "both rose" rewatch), and `firstSeenRunId` / `lastSeenRunId`. A later run updates the record in place; a leg that no longer conflicts drops its party, and a record with no non-local party left is removed and logged "resolved elsewhere". S10 (#585) shows and resolves them.

**Triggers.** Attach (`shared-library:attach`), every availability transition to available or to writable (S8's `onAvailabilityChanged`), the online edge (S1a), login (after S0b's restore in exchange-code), Sync now (`shared-library:sync-now`, the Shared Libraries tab header for every library and the detail page for one title), and S12's Prepare for offline through `runAll('prepare')`. Runs are single-flight per library: a second caller joins the run in flight and gets its result. `runAll` / `runLibrary` / `runTitle` resolve to a `SyncRunResult`: per library, `drive` (`ok`, `skipped`: `unavailable` / `read-only` / `videos-only` / `foreign`, `error`: `write-failed-read-only` / `io` / `unreadable`) and `shikimori` (`ok`, `skipped`: `offline` / `logged-out` / `claim` / `foreign`, `error`: `auth` / `network` / `api`), with counts, `waitingMalIds` and `rewatchesSuperseded`. The same object is the `result` of the run's record in `userData/sync-log/<yyyy-mm>.jsonl` (each month's file bounded by size), and `sync:run-finished` broadcasts it. Until S10, each library row shows "N changes synced, M need review".

**Forget** registers one forget hook. `pendingCount(libraryId)` is `{ libraryChanges, resolutions }`: the in-scope fields where this PC differs from the library base (minus resolution fields), the pending fields with that library's provenance, and its held conflicts; and the pending fields with a resolution provenance naming it. `onForgotten` runs under the drain's `withQueueLock`: it strips those fields from the live queue and every parked bucket (`stripProvenance`; user entries are never touched), deletes them from every owner's pending file and reverts their cached values, deletes the library base, and drops the library's party from the conflicts. It keeps the Shikimori base, other libraries' fields and this PC's own watch state, never touches the drive, and is a no-op the second time. A re-attach starts with no base, so it raises nothing.

## Tests

`test/lib/shared-library/`: the golden and edge-case trees under `test/fixtures/shared-library/v1/` (byte-compared, so excluded from Prettier), the schema fingerprint `test/fixtures/shared-library/schema-v1.json`, and over-cap trees built at test time with sparse files. `write.test.ts` injects a crash at every mutating `fs.promises` call of every write and checks the tree reads as a matching pair after each one.

`test/services/shared-library-export-preflight.test.ts` (#575): CI can't make FAT32 or NTFS filesystems, so the type probe is injected, and the write probe where a test needs it to turn read-only between plan and start; the read-only parent is a real `chmod 0555` (skipped on Windows and as root). The probe parsers read the samples under `test/fixtures/fs-type-probe/` (excluded from Prettier). `get-volume-ntfs.txt`, `get-volume-no-volume.txt`, `findmnt-ext4.json` and `findmnt-9p.json` are captured from real machines; the FAT32 and exFAT `Get-Volume` lines, `findmnt-vfat.json`, and the macOS `df` and `diskutil` samples are written by hand in those tools' formats, since no such volume was at hand.

The merge (#584): `test/lib/sync-merge/` (the engine table for every rule, the no-base table, the raise), `test/services/sync-runner.test.ts` (both legs over real trees with the real drain against a fake Shikimori, `test/helpers/fake-shikimori.ts`: the three data-loss musts, the pending lifecycle, the raise and its false-rewatch guards, conflicts, Forget, write failures, the `runAll` result, never written) and `test/integration/shared-library-merge.test.ts` (an owner PC and a claim PC on one drive).
