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

- `moveEpisodeToColdStorage()`: Moves a single episode's files (.mkv, .mp4, .ass) from hot → cold. Skips files with .part (in-progress). Uses `fs.rename` with `fs.copyFile` + `fs.unlink` fallback for cross-filesystem moves.
- `moveAllFilesToColdStorage()`: Scans hot dir for all finished files and moves them to cold. Reports progress via `storage:move-to-cold-progress` IPC.

### Auto-move triggers

- If merge disabled: after `onEpisodeComplete` callback
- If merge enabled: after `onMergeComplete` callback
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
