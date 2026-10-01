# Storage

## Store persistence (electron-store)

The main process is the store's only writer. `createStorageService` (`src/main/store/index.ts`) serves all reads from an in-memory snapshot taken once at startup, and coalesces disk writes (#204):

- `set`/`delete` update the snapshot immediately — reads are always consistent (read-your-writes), including dot-notation sub-key paths, which are applied to the snapshot directly.
- The first buffered write arms a `PERSIST_DEBOUNCE_MS` (500 ms) timer; further writes in the window ride along; the timer fires **one** full-file stringify+write. The window does not extend under a continuous writer, so disk staleness is bounded at 500 ms.
- **Crash-durability window:** a hard crash (not a normal quit) loses at most the last 500 ms of writes. That is acceptable for caches and watch positions; keys where it is not are listed in `writeThroughKeys` (`src/main/index.ts`: `shikimoriUpdateQueue`, `token`, `shikimoriCredentials`) and persist synchronously on every write.
- `flush()` persists anything still pending; `onBeforeQuit` calls it last, after service teardown, so writes made during teardown are captured.
- A timer-fired persist that fails (ENOSPC, EPERM/AV lock) is logged, not thrown — a timer callback has no caller to reject — and the pending writes stay dirty, so the next write or `flush()` retries them. Write-through persists still throw synchronously to the `set()` caller, as every persist did before #204.

External edits to `config.json` while the app runs are not observed (single-writer by design).

## Hot/Cold Storage

In advanced storage mode, files are managed across two directories:

- **Hot storage**: Where downloads land and in-progress files live (replaces `downloadDir` in advanced mode)
- **Cold storage**: Where finished files are moved for long-term storage

### Extension sets

Two named sets in `src/shared/episode-files.ts` (#429), imported as `@shared/episode-files` from main; it lives in `src/shared/` (the same placement as `src/shared/shikimori.ts`) so preload or the renderer can import it when they need to — today they use only the ambient `EpisodeFileEntry` type:

- `VIDEO_EXTS` = `['.mkv', '.mp4']` — the containers a playable episode file can be in. Used by `downloads:*`'s "is there a video here" check and by the player's file resolver.
- `EPISODE_ARTIFACT_EXTS` = `VIDEO_EXTS` + `['.ass']` — everything the downloader writes for one episode, so it is the set the delete and hot→cold move paths iterate.
- `extAlternation()` strips the leading dot and joins with `|`, because the constants carry dots for `endsWith` while a regex needs `mkv|mp4` inside `\.(…)$`. `VIDEO_EXT_RE`, `VIDEO_EXT_OR_PART_RE` (both `/i`), the two case-sensitive producer regexes in `src/main/lib/episode-file-scan.ts` and `FILENAME_EP_RE` in `src/main/lib/filename.ts` are all built from it, once at module scope.

Only the **lists** are shared, not the matching: each call site keeps the case handling it had. `sumShowFiles` (`src/main/index.ts`) is a deliberate fourth, wider set — `.mkv`, `.mp4`, `.ass`, `.srt`, lowercased first — because it estimates what `CLEANUP_EXECUTE`'s recursive directory removal reclaims rather than what the downloader wrote, so a side-loaded `.srt` belongs in it. It stays out of the shared constants; `test/lib/episode-files.test.ts` asserts it remains a superset of `EPISODE_ARTIFACT_EXTS`, so a new container cannot land in the delete lists and leave the cleanup estimate behind.

`EpisodeFileEntry` (the `file:check-episodes` / `file:episodes-changed` element type) is declared once as an ambient global in `src/shared/types/storage.d.ts`, alongside `EpisodeFileType` and `EpisodeArtifactExt`. It is deliberately **not** re-exported from `episode-files.ts`: an import would turn `src/preload/types.d.ts` into a module.

### File movement

- `moveEpisodeToColdStorage(animeName, episodeInt, author)`: Moves one episode's files (.mkv, .mp4, .ass) from hot → cold. Takes **`episodeInt`**, the field the on-disk `NN` is built from — not `episodeLabel`, whose `episodeFull` value can be `"1 серия"` and matched nothing at all (#416). Selects by **exact name**: `<anime> - NN [author].ext` as `enqueue` writes it (author tag appended unconditionally, so an empty author matches the `[]` form, as in `deleteEpisodeFiles`), plus the legacy untagged `<anime> - NN.ext` twin. The match is author-scoped, so a sibling translation of the same episode — which may still be mid-download — is left in hot, and exactness also stops episode `10` from sweeping `100` and `10.5` (the `padStart(2, '0')` prefix was unbounded past episode 9). It filters the hot directory listing rather than moving each candidate name blind, because a missing candidate is **normal** — no .mp4 survives a merge, and the legacy untagged twin usually does not exist at all. Iterating candidates would not abort the pass (#414 gave the loop a per-file `catch`), but each absent one would log a spurious `[cold] Failed to move … ENOENT`, i.e. normal operation surfacing as an error; `test/services/cold-storage.test.ts:375` asserts exactly one logged error and is the pin for that. Skips files with .part (in-progress). Uses `fs.rename` with `fs.copyFile` + `fs.unlink` fallback for cross-filesystem moves. A per-file failure is logged (`console.error`, naming the file) and the remaining files still move; only a failure to list the directory ends the pass (#414 — it used to abort on the first failure, silently, leaving everything behind it in hot). A hand-renamed file no longer matches: `moveAllFilesToColdStorage()` is the escape hatch.
- `moveFileToColdByRelPath()`: Moves exactly one file hot → cold, named by its **download-dir-relative** path — anime directory included, matching the `filename` fields the download manager builds. Narrower than the episode+author scope above, and resolves against the service's own `getDownloadDir()` / `getColdStorageDir()`. This is what the merge tail uses (#414), so a merge cannot sweep a sibling translation's unmerged sources.
- `moveAllFilesToColdStorage()`: Scans hot dir for all finished files and moves them to cold. Reports progress via `storage:move-to-cold-progress` IPC.

### Auto-move triggers

- If merge disabled: after `onEpisodeComplete` callback, and after the deferred-finalize pass (`#63` watch-while-downloading) — both in `src/main/lib/episode-completion.ts`, both passing the group's `episodeInt` + `author` to `moveEpisodeToColdStorage()`
- If merge enabled: after `onMergeComplete` callback, which fires after the merge sources are unlinked and moves only the merged `.mkv` (via `moveFileToColdByRelPath()`)
- Manual: "Move all to cold storage" button in Settings > Storage

### File scanning

In advanced mode, `file:check-episodes`, `file:delete-episode`, and `downloaded-anime-delete` check/delete from both hot and cold dirs. Cold storage takes priority when a file exists in both locations. `scanAndMerge` also scans both directories.

### Two root sets, and why they are not one (#421)

`createColdStorageService` exposes two lists of storage roots, and the difference is load-bearing:

- **`dirsForScan()`** — `getDownloadDir()` plus `coldStorageDir` **only in advanced mode**. Mode-scoped on purpose, because one of its callers is destructive: `CLEANUP_EXECUTE` iterates it and feeds each entry to a recursive `fs.rmSync`. Widening it would let a stale `coldStorageDir` be deleted while the app is in simple mode — trading a metadata bug for a file-loss bug. Its other callers are `deleteEpisodeFiles`, `episodeHasInProgressDownload`, `findCleanupCandidates` and `sumShowFiles` (`src/main/index.ts`).
- **`allConfiguredRoots()`** — every root the app has ever written into, regardless of mode: `downloadDir` (or `<downloads>/anime-dl` when it is empty), `hotStorageDir`, `coldStorageDir`; empties dropped, de-duplicated. Read-only by construction, and used by `episodeFileExists` — the predicate both metadata-deleting paths (`downloaded-episodes-get`'s GC and `pruneDownloadedEpisode`) trust. It reads the **stored keys directly** rather than routing through `getDownloadDir()`, which returns `hotStorageDir` in advanced mode and would drop `downloadDir` — the root that holds everything downloaded before the user switched modes. Nothing migrates those files: `moveAllFilesToColdStorage` only ever reads `getDownloadDir()`, and no main-side code reacts to a `storageMode` change at all.

`missingConfiguredRoot()` is the companion guard: the first configured, **non-empty stored** root (`downloadDir`, `hotStorageDir`, `coldStorageDir`) that is not on disk, or `null`. Both callers of `episodeFileExists` refuse to delete metadata while it returns a path, and log it — a root that is away answers a false `false` for every file inside it. The `downloadsFallbackDir` fallback is deliberately **not** in that check even though it is in the union: `downloadDir` defaults to `''`, and a profile that went straight to advanced mode never created `<downloads>/anime-dl`, so including it would report a missing root on every call and disable the GC permanently. Omitting it is safe by construction — a path that does not exist cannot contain a file.

Two caveats on the skip, both accepted rather than designed around:

- It is all-or-nothing per call, so genuinely stale entries survive too and phantom ⬇ rows can accumulate until the root returns. An absent drive comes back on its own; a root the user **deleted** does not — a `downloadDir` removed after switching to advanced mode, or a `hotStorageDir`/`coldStorageDir` left behind after switching back to simple. The escape hatch is `storage:clear-root` (#440), described below.
- On Linux, a `coldStorageDir` that *is* an fstab/SMB mountpoint still exists as an empty directory after unmount, so `fs.existsSync` passes and the skip does not fire. Point `coldStorageDir` at a subdirectory **below** the mountpoint to get the guard. Windows (the drive letter disappears) and udisks auto-mounts under `/media/<user>/` do not have this problem.

### Clearing a stale root (#440)

`''` already means "unset" on every read path — `allConfiguredRoots()` drops empties, `missingConfiguredRoot()` filters on `Boolean` before the `existsSync` walk, and `getDownloadDir()` falls back to `<downloads>/anime-dl` — so the exit from the guard is to write `''` for the stale key. What makes that a channel rather than a `set-setting` call is `DownloadManager`: its download directory is a cached field, written only by `storage:clear-root` and the two folder pickers, and every path the manager builds comes from it. A bare store write would leave the next download targeting the root just cleared, and the manager's recursive `mkdirSync` would recreate it wherever the parent survives (a dead `/media/<user>/<drive>/…` on Linux) — new files landing somewhere the app no longer reads.

- **`storage:clear-root`** takes one of `downloadDir` / `hotStorageDir` / `coldStorageDir`, writes `''`, and then re-syncs the manager with `setDownloadDir(getDownloadDir())`, the same call the pickers make. Clearing `coldStorageDir` also forces `autoMoveToCold` to `false` in the same handler: the mover already no-ops on an empty cold dir, so this is not about safety — a switch left disabled and still `true` would re-arm itself the moment a new cold dir is picked. Both channels reply with the full `StorageRootsState`.
- **`storage:get-missing-root`** is the read-only companion. It carries `missingConfiguredRoot()` *and* the three **raw stored** paths, because `get-setting` resolves `downloadDir` through `getDownloadDir()` and so answers with the fallback (or the hot dir, in advanced mode) for a key that was never set — the renderer cannot tell an unset root from a set one through that channel, and needs the unresolved form both to decide which rows have something to clear and to name which key holds the missing path.
- The Storage tab's missing-root notice sits in the `Locations` group **outside** the simple/advanced split, with a Clear button of its own. The stale root is usually the other mode's — a cold dir from an advanced-mode experiment, left behind after switching back — so its own row is not on screen, which is the whole case the notice exists for.
- Clearing is **not** metadata-neutral, and the confirm copy says both halves: no file is moved or deleted, *and* downloads stored there will disappear from the app until the folder is re-picked. A root that was merely unmounted still holds files, and the next GC pass drops their `downloadedEpisodes` entries — the loss the guard was preventing, which clearing is the user opting back into.

## File Layout on Disk

```
{downloadDir}/
  {sanitized anime name}/
    {anime name} - 01 [Author].mp4        raw video (author-tagged)
    {anime name} - 01 [Author].ass        subtitles
    {anime name} - 01 [Author].mkv        merged (video + subs)
    {anime name} - 01 [Author].mp4.part   in-progress download
    {anime name} - 01 [Author2].mkv       another translation
    {anime name} - 01.mkv                 legacy (no author tag)
```

Multiple translations per episode coexist via `[Author]` filename tags.
Legacy filenames (without author tag) are still detected and supported.

Filename sanitization: `[<>:"/\|?*]` replaced with `_`, whitespace normalized.
