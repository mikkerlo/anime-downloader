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

### File movement

- `moveEpisodeToColdStorage(animeName, episodeInt, author)`: Moves one episode's files (.mkv, .mp4, .ass) from hot → cold. Takes **`episodeInt`**, the field the on-disk `NN` is built from — not `episodeLabel`, whose `episodeFull` value can be `"1 серия"` and matched nothing at all (#416). Selects by **exact name**: `<anime> - NN [author].ext` as `enqueue` writes it (author tag appended unconditionally, so an empty author matches the `[]` form, as in `deleteEpisodeFiles`), plus the legacy untagged `<anime> - NN.ext` twin. The match is author-scoped, so a sibling translation of the same episode — which may still be mid-download — is left in hot, and exactness also stops episode `10` from sweeping `100` and `10.5` (the `padStart(2, '0')` prefix was unbounded past episode 9). It filters the hot directory listing rather than moving each candidate name blind, because a missing candidate is **normal** — no .mp4 survives a merge, and the legacy untagged twin usually does not exist at all. Iterating candidates would not abort the pass (#414 gave the loop a per-file `catch`), but each absent one would log a spurious `[cold] Failed to move … ENOENT`, i.e. normal operation surfacing as an error; `test/services/cold-storage.test.ts:290` asserts exactly one logged error and is the pin for that. Skips files with .part (in-progress). Uses `fs.rename` with `fs.copyFile` + `fs.unlink` fallback for cross-filesystem moves. A per-file failure is logged (`console.error`, naming the file) and the remaining files still move; only a failure to list the directory ends the pass (#414 — it used to abort on the first failure, silently, leaving everything behind it in hot). A hand-renamed file no longer matches: `moveAllFilesToColdStorage()` is the escape hatch.
- `moveFileToColdByRelPath()`: Moves exactly one file hot → cold, named by its **download-dir-relative** path — anime directory included, matching the `filename` fields the download manager builds. Narrower than the episode+author scope above, and resolves against the service's own `getDownloadDir()` / `getColdStorageDir()`. This is what the merge tail uses (#414), so a merge cannot sweep a sibling translation's unmerged sources.
- `moveAllFilesToColdStorage()`: Scans hot dir for all finished files and moves them to cold. Reports progress via `storage:move-to-cold-progress` IPC.

### Auto-move triggers

- If merge disabled: after `onEpisodeComplete` callback, and after the deferred-finalize pass (`#63` watch-while-downloading) — both in `src/main/lib/episode-completion.ts`, both passing the group's `episodeInt` + `author` to `moveEpisodeToColdStorage()`
- If merge enabled: after `onMergeComplete` callback, which fires after the merge sources are unlinked and moves only the merged `.mkv` (via `moveFileToColdByRelPath()`)
- Manual: "Move all to cold storage" button in Settings > Storage

### File scanning

In advanced mode, `file:check-episodes`, `file:delete-episode`, and `downloaded-anime-delete` check/delete from both hot and cold dirs. Cold storage takes priority when a file exists in both locations. `scanAndMerge` also scans both directories.

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
