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
- [x] Start Translation Menu with Current Type — translation menu opens directly to current translation’s category
- [x] Friends Activity Feed — chronological feed of recent anime activity from Shikimori friends, globally sorted, top 50

---

## 3. Support Multiple Downloaded Translations and Mark in Menus

**Priority:** High | **Effort:** Medium

Enable the translation type menu for downloaded episodes by allowing multiple local versions to coexist and marking them in selection menus with a Chrome-style download icon. Currently, an episode is locked to its single downloaded version, which disables the player's translation menu and prevents switching to other (streaming) translations.

**Plan:**
1.  **Update Filename Scheme:** Modify `DownloadManager.enqueue` to include the author's name in the filename: `Anime - 01 [Author].mp4` and `Anime - 01 [Author].ass`. This ensures video and subtitle files remain matched when multiple versions exist.
2.  **Metadata Persistence:** Change `downloadedEpisodes` store key from `animeId:episodeInt` to `animeId:episodeInt:translationId` to track multiple versions independently. Update `downloaded-episodes-get` IPC to return all versions for an anime.
3.  **File Status Scan:** Update `file:check-episodes` IPC to return a map of all downloaded translation IDs for each episode, scanning both hot and cold storage for all variants. Ensure it still detects legacy filenames (without author tag).
4.  **Unlock Selection:** In `AnimeDetailView.vue`, remove the `isLocked` logic for downloaded episodes. Only lock the row if a download for *any* version of that episode is currently active or queued.
5.  **Mark Downloaded in Menus:**
    *   In `AnimeDetailView` per-episode `<select>`, add a Chrome-like down arrow icon (📥) and a distinct color (e.g., green) for downloaded options. Use `optgroup` or custom labels to indicate status.
    *   In `PlayerView.vue` translation menu, add the same icon/color indicator for downloaded versions.
6.  **Dynamic Action Buttons:** Update `AnimeDetailView` episode row to show "Open" only when the *currently selected* translation is available on disk; otherwise show "Play" (streaming) and "Download".
7.  **Player Integration:** Update `openFile` in `AnimeDetailView` to pass the correct `translationId` and full `translations` list to `PlayerView`.
8.  **Player Switching:** Modify `PlayerView.vue` to enable the translation menu even for local files, allowing seamless switching between multiple local files and streaming sources.
9.  **Files:** `src/main/index.ts`, `src/main/download-manager.ts`, `src/renderer/src/components/AnimeDetailView.vue`, `src/renderer/src/components/PlayerView.vue`.

---

## ~~4. Refactor Smotret-Anime API into a Dedicated Class~~

~~**Priority:** Medium | **Effort:** Small~~

Consolidate all Smotret-Anime API interaction logic into a single, maintainable class to reduce duplication and improve code organization. Currently, API calls and URL constructions are scattered across `index.ts` and `download-manager.ts`.

**Plan:**
1.  Create `src/main/smotret-api.ts`.
2.  Implement `SmotretApi` class with methods:
    *   `constructor(getToken: () => string)`
    *   `searchAnime(query: string)`
    *   `getAnime(id: number)`
    *   `getEpisode(id: number)`
    *   `getEmbed(translationId: number)`
    *   `getSubtitlesUrl(translationId: number)`
    *   `getFallbackVideoUrl(translationId: number, height: number)`
3.  Move shared interfaces/types related to the API (e.g., `AnimeDetail`, `Translation`, `EmbedData`) to `smotret-api.ts` or a shared types file.
4.  Instantiate `SmotretApi` in `main/index.ts`.
5.  Update IPC handlers in `index.ts` to use `smotretApi` instance.
6.  Inject `smotretApi` into `DownloadManager` and update its methods (e.g., `fetchEmbed`, `enqueue`) to use the class.
7.  Remove `apiRequest` and related constants (`API_BASE`, `USER_AGENT`) from `index.ts`.
8.  Files: `src/main/smotret-api.ts`, `src/main/index.ts`, `src/main/download-manager.ts`.
