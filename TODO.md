# TODO

## Done

- [x] Show progress/message during ffmpeg+ffprobe download on first launch
- [x] Add "Retry all failed" button in DownloadsView for all failed downloads at once
- [x] Offline library support — cache anime details locally for downloaded anime
- [x] Episode pagination for long anime (>30 episodes)
- [x] Extract shared utilities (`formatBytes`, `formatSpeed`, `formatEta`, `getAnimeName`) into `renderer/utils.ts`
- [x] Batch library status loading — single `library-get-status` IPC replacing per-anime round-trips
- [x] Auto-save settings with debounced watchers, removed Save button
- [x] Download queue persistence — queue saved to queue.json, restored on startup
- [x] API token validation — "Test" button in Settings validates token against embed API
- [x] Auto-update mechanism — check/download/install via electron-updater from GitHub releases
- [x] Keyboard shortcuts — configurable Escape/Ctrl+F/Ctrl+D with rebinding in Settings > Shortcuts
- [x] System notifications on download/merge complete — configurable Off/Each Episode/Queue Complete
- [x] Pause All / Resume All buttons in Downloads — bulk pause/resume for active/paused downloads
- [x] Download speed throttle / bandwidth limiting — configurable speed limit (presets + custom MB/s) and concurrent downloads (1–3) in Settings > General
- [x] Shikimori Integration — OAuth login, episode/status tracking, MAL ID resolution from AnimeDetailView
- [x] Advanced File Management — Hot/Cold storage mode with auto-move support
- [x] Custom Dark Scrollbar Styling — thin scrollbars matching dark theme
- [x] Shikimori Anime List — Browse & sync watchlist with status filters, MAL ID resolution, To Watch view
- [x] Built-in Video Player with Anime4K Shaders — HTML5 player with WebGPU upscaling, CDN streaming, subtitles, GPU benchmark
- [x] Quality Selector in Player — quality dropdown in built-in player controls for switching stream resolution
- [x] Translation Selector in Player — translation dropdown in built-in player controls for switching between available translations
- [x] MKV Local Playback Support — on-the-fly remux via ffmpeg (`-c copy`) to temp MP4, auto-cleanup on player close
- [x] ASS Subtitle Support in Player — native ASS rendering via libass-wasm (SubtitlesOctopus), preserving styled subtitles (colors, positioning, effects). TODO: migrate to JASSUB for better rendering (WebGL, multithreading) once its ES module workers work on Windows Electron file:// protocol
- [x] Friends' Status on Anime Page — Shikimori friends' watch status, score, and progress on anime detail page
- [x] Seek Time Preview in Player — timestamp tooltip on seek bar hover/drag
- [x] Start Translation Menu with Current Type — translation menu opens directly to current translation's category
- [x] Friends Activity Feed — chronological feed of recent anime activity from Shikimori friends, globally sorted, top 50
- [x] Support Multiple Downloaded Translations — multiple local versions per episode with author-tagged filenames, marked in menus
- [x] Refactor Smotret-Anime API into a Dedicated Class — consolidated API logic into `SmotretApi` class in `smotret-api.ts`

---

## 1. Stabilize Anime Detail View Layout During Loading

**Priority:** Medium | **Effort:** Medium

The anime detail page "jumps" as different sections load asynchronously — episodes appear, then file status shifts badges, then Shikimori/Friends panels pop in and push everything down. The page should show an overall spinner until the episode list + file status are ready, then show compact spinner rows for Shikimori/Friends that haven't resolved yet.

Additionally, `file:check-episodes` does a full `readdirSync` on every page load even though we already know what files were downloaded. We should cache file scan results in the main process for the session and only do a background rescan, verifying files exist on open rather than on every mount.

**Plan:**
1. **Overall loading state:** In `AnimeDetailView.vue`, keep the existing `loading` spinner visible until both `loadPageEpisodes()` and `checkFileStatus()` complete. Currently `loading` is set to `false` after `getAnime()` returns (line ~259), before episodes or files are loaded — move it after `checkFileStatus()` so the episode list, controls, pagination, and file badges all appear together instead of popping in one by one.
2. **Compact spinner rows for Shikimori/Friends:** The Shikimori panel (`shiki-panel`) and Friends panel (`friends-panel`) load async via `loadShikimoriData()`. They already show "Loading..." text, but the panels themselves (`v-if="shikiUser && anime.myAnimeListId"`) only appear after `shikiUser` resolves. Reserve the panels immediately (show them with a spinner row as soon as `anime.myAnimeListId` exists) rather than waiting for `shikiUser`. After `loadShikimoriData` resolves, replace spinner with controls or hide the panel if not logged in.
3. **Session-level file scan cache in main process:** Add an in-memory `Map<string, ...>` in `main/index.ts` (keyed by `animeName`) that caches the result of `file:check-episodes`. On first call per anime per session, do the full directory scan and cache. On subsequent calls, return the cached result immediately. Invalidate the cache entry when files change: after `file:delete-episode`, after download completion (in `downloadedEpisodesSet`), and after `storage:move-to-cold`.
4. **Verify file on open:** In the `file:open` handler, check `fs.existsSync(filePath)` before calling `shell.openPath`. If the file is gone (e.g., user deleted externally), invalidate the cache for that anime and return an error so the renderer can refresh file status and show a message.
5. **Background rescan:** After returning the cached result, optionally queue a background async rescan (using `fsPromises.readdir`) that updates the cache. If results differ from the cached version, send an IPC event to the renderer so it can refresh badges without a full page jump.
6. **Files:** `src/main/index.ts` (file scan cache, IPC handlers), `src/renderer/src/components/AnimeDetailView.vue` (loading state, panel placeholders).
