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
- [x] Stabilize Anime Detail View Layout During Loading — unified loading state and session-level file scan cache
- [x] Disable "Go Back" Global Shortcut While Player Is Open — player key events no longer propagate to App.vue

---

## 1. Stream MKV Playback Without Full Remux Wait

**Priority:** Medium | **Effort:** Large

Opening an MKV file in the built-in player currently remuxes the entire file to a temp MP4 via ffmpeg (`-c copy -movflags +faststart`) before playback can start. For a 1GB file this blocks for 10–20 seconds showing "Preparing MKV for playback...". Instead, pipe the ffmpeg remux output directly to the `anime-video://` protocol so playback starts within ~1 second while remux continues in the background.

**Plan:**
1. **Streaming remux process:** In `main/index.ts`, add a new IPC handler `player:remux-mkv-stream` that spawns ffmpeg with `-c copy -movflags +frag_keyframe+empty_moov -f mp4 pipe:1`, outputting a fragmented MP4 to stdout instead of a file. The `+frag_keyframe+empty_moov` movflags produce a streamable fragmented MP4 (moov atom at the start, no seek needed). Store the spawned child process and a reference to its stdout stream keyed by a session ID.
2. **Subtitle extraction:** Extract subtitles from the MKV in parallel (same as current `player:remux-mkv` subtitle logic at line ~1305). Return the subtitle content along with the session ID in the IPC response so the renderer can set up JASSUB immediately.
3. **Protocol handler update:** Modify the `anime-video://` protocol handler to detect a special URL scheme like `anime-video://stream/{sessionId}`. Instead of opening a file, pipe the buffered ffmpeg stdout data. Since fragmented MP4 doesn't require Range requests for initial playback, the handler can serve the stream as a 200 response with `Transfer-Encoding: chunked` or known content-length if available.
4. **Buffering for seek:** Write the ffmpeg output to both the protocol response and a temp file simultaneously (tee). Once the remux completes, seeking works via the temp file through normal Range request handling. Track how many bytes have been written so far; if a Range request asks for data beyond what's been written, either wait or return a partial response.
5. **PlayerView integration:** In `PlayerView.vue`, replace the `playerRemuxMkv` call in `onMounted` (line ~741) and translation switch (line ~630) with `playerRemuxMkvStream`. The video element gets the stream URL immediately, playback starts as data arrives. Show a subtle "Buffering..." indicator instead of the full remux overlay. Keep the existing `remuxing` overlay only as a fallback if the streaming approach fails.
6. **Cleanup:** On player close or translation switch, kill the ffmpeg child process and delete the temp file. Update `player:cleanup-remux` to also terminate any active streaming remux sessions.
7. **Seeking limitation:** While remux is in progress, seeking forward past the buffered position should either show a brief spinner or be disabled. Once remux finishes, full seeking works normally via the temp file.
8. **IPC changes (4 files):** Add `player:remux-mkv-stream` handler in `src/main/index.ts`, bridge in `src/preload/index.ts`, type in `src/preload/index.d.ts`, consumer in `src/renderer/src/components/PlayerView.vue`.
9. **Fallback:** If fragmented MP4 streaming fails (e.g., codec issues), fall back to the existing full-remux path so playback still works.

---

## 2. Configurable Anime4K Shader Shortcuts in Player

**Priority:** Medium | **Effort:** Small

Add keyboard shortcuts for switching Anime4K shader presets while watching: Ctrl+1 → Mode A, Ctrl+2 → Mode B, Ctrl+3 → Mode C, Ctrl+0 → Off. These should be configurable in Settings > Shortcuts alongside the existing global shortcuts.

**Plan:**
1. **Add default bindings:** In `SettingsView.vue`, extend `DEFAULT_SHORTCUTS` (line ~70) with four new entries: `shaderModeA: 'CmdOrCtrl+1'`, `shaderModeB: 'CmdOrCtrl+2'`, `shaderModeC: 'CmdOrCtrl+3'`, `shaderOff: 'CmdOrCtrl+0'`. Add matching entries in `SHORTCUT_LABELS` (line ~76) with descriptive labels like "Shader: Mode A" and hints like "Switch to Anime4K Mode A in player".
2. **Update store defaults:** In `main/index.ts`, extend the `keyboardShortcuts` store default (line ~57) with the four new keys so they persist across updates.
3. **Read shortcuts in PlayerView:** In `PlayerView.vue` `onMounted` (line ~736), load shortcuts from `window.api.getSetting('keyboardShortcuts')`. Store in a local ref.
4. **Handle in `onKeyDown`:** In `PlayerView.vue` `onKeyDown` (line ~276), before the existing `switch`, build a key string from the event (matching the `CmdOrCtrl+Key` format from `captureKey` in SettingsView). Compare against the loaded shortcut bindings. If matched, call `selectPreset('mode-a')` / `selectPreset('mode-b')` / `selectPreset('mode-c')` / `selectPreset('off')` and `preventDefault()`. Only act if `webgpuAvailable` is true.
5. **Files:** `src/renderer/src/components/SettingsView.vue` (defaults + labels), `src/renderer/src/components/PlayerView.vue` (shortcut handling), `src/main/index.ts` (store defaults).

---

## 3. Previous / Next Episode Buttons in Player

**Priority:** Medium | **Effort:** Medium

Add prev/next episode navigation buttons to the built-in player controls for seamless binge-watching without returning to the anime detail view.

**Translation resolution order for the target episode:** try downloaded file for same author → same translationId → best quality of current translation type → disable button if nothing available.

**Plan:**
1. **Pass episode list to player:** Extend the `playFile` emit in `AnimeDetailView.vue` (line ~673, ~684) to include the full `episodeRows` data: an ordered array of `{ episodeInt, episodeFull, translations, downloadedTrIds }` for all filtered episodes (not just the current page). Add a corresponding prop to `PlayerView.vue` and update `playerState` in `App.vue` `openPlayer` (line ~38).
2. **Resolve target episode:** Add a helper function `resolveEpisodePlayback(targetEpisode, currentTranslationId, currentType)` in `PlayerView.vue` that implements the priority chain: (a) find a downloaded file matching the current author via `playerFindLocalFile`, (b) find the same `translationId`, (c) find the best quality translation of the current type, (d) return null (button disabled). This function returns `{ translationId, isLocal, filePath?, streamUrl?, subtitleContent? }` or null.
3. **Computed prev/next availability:** Add computed properties `canPrev` / `canNext` that check whether the adjacent episode exists in the episode list and has a resolvable translation (call `resolveEpisodePlayback` reactively). Disable the buttons when null.
4. **Navigation handler:** Add `goToEpisode(direction: 'prev' | 'next')` that calls `resolveEpisodePlayback`, then either loads the local file (via `playerFindLocalFile` + optional MKV remux) or fetches a stream URL (via `playerGetStreamUrl`). Update all reactive state: `activeFilePath`, `activeStreamUrl`, `activeSubtitleContent`, `activeTranslationId`, episode label in the title bar. Clean up previous remux if switching from MKV.
5. **UI buttons:** Add prev/next buttons in the player controls bar (in the title bar area, next to the episode label). Use `‹` / `›` or skip-back/skip-forward SVG icons. Disable with reduced opacity when `!canPrev` / `!canNext`.
6. **Keyboard shortcuts:** Add `Shift+ArrowLeft` for prev and `Shift+ArrowRight` for next in `onKeyDown` (line ~276). Make them configurable via `keyboardShortcuts` store (add `playerPrevEpisode: 'Shift+ArrowLeft'` and `playerNextEpisode: 'Shift+ArrowRight'` to `DEFAULT_SHORTCUTS` in `SettingsView.vue`).
7. **Auto-advance on end (optional):** When the video fires the `ended` event and `canNext` is true, auto-navigate to the next episode after a brief delay (3s countdown with cancel).
8. **IPC changes:** None — reuses existing `playerFindLocalFile`, `playerGetStreamUrl`, `playerRemuxMkv` handlers.
9. **Files:** `src/renderer/src/components/AnimeDetailView.vue` (extend emit), `src/renderer/src/App.vue` (extend playerState + openPlayer + PlayerView props), `src/renderer/src/components/PlayerView.vue` (buttons, shortcuts, navigation logic), `src/renderer/src/components/SettingsView.vue` (shortcut defaults), `src/preload/index.d.ts` (update playFile emit type if needed).

---

## 4. Auto-Track Watch Progress and Resume Playback

**Priority:** Medium | **Effort:** Medium

Automatically track how many episodes the user has watched and where they stopped in each episode. Persist playback position locally for resume, and auto-update Shikimori episode count when an episode is considered "watched" (80%+ played AND at least 3 minutes of actual playback).

**Plan:**
1. **New store key `watchProgress`:** Add `watchProgress: {}` to electron-store defaults in `main/index.ts` (line ~42). Structure: `Record<string, { position: number; duration: number; updatedAt: number }>` keyed by `animeId:episodeInt`. Stores the last playback position in seconds, total duration, and timestamp.
2. **IPC handlers for watch progress:** Add two handlers in `main/index.ts`:
   - `watch-progress:save` — saves position/duration for a given animeId + episodeInt.
   - `watch-progress:get` — returns saved position for a given animeId + episodeInt (or null).
   Bridge in `preload/index.ts`, type in `preload/index.d.ts`.
3. **Pass `animeId` and `malId` to player:** Extend the `playFile` emit in `AnimeDetailView.vue` to include `animeId` (from `props.animeId`) and `malId` (from `anime.value.myAnimeListId`). Update `playerState` in `App.vue` and `PlayerView` props accordingly.
4. **Periodic position save in PlayerView:** In `PlayerView.vue`, add a `timeupdate` listener on the video element. Throttle to every 5 seconds. Call `window.api.watchProgressSave(animeId, episodeInt, currentTime, duration)`. Also save on `pause`, `beforeunmount`, and player close.
5. **Resume on open:** In `PlayerView.vue` `onMounted`, after the video is ready (`loadedmetadata` event), call `window.api.watchProgressGet(animeId, episodeInt)`. If a saved position exists and is < 95% of duration, seek to it. Show a brief "Resuming from X:XX" toast.
6. **Watched detection:** Track cumulative playback time in a local variable (increment on `timeupdate` only when video is playing, not paused/seeking). When `position / duration >= 0.8` AND `cumulativePlayTime >= 180` (3 minutes), mark the episode as "watched". Store a `watched: true` flag in `watchProgress` to avoid re-triggering.
7. **Shikimori auto-update:** When an episode is marked watched and `malId` is available, call `window.api.shikimoriUpdateRate(malId, episodeNumber, 'watching', 0)` to increment the episode count. Only update if `episodeNumber > current shikiEpisodes`. Need a new IPC `shikimori:get-rate` call first to check current count, or pass the current Shikimori episode count from `AnimeDetailView` via props.
8. **Visual indicator in AnimeDetailView:** Show a small progress bar or "watched" badge on episode rows using the stored `watchProgress` data. Load via `watch-progress:get-all` IPC (returns all entries for an animeId).
9. **IPC changes (4 files):** Add `watch-progress:save`, `watch-progress:get`, `watch-progress:get-all` in `src/main/index.ts`, bridge in `src/preload/index.ts`, types in `src/preload/index.d.ts`, consumed in `src/renderer/src/components/PlayerView.vue` and `src/renderer/src/components/AnimeDetailView.vue`.
