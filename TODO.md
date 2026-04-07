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

---

## 1. MKV Local Playback Support

**Priority:** Medium | **Effort:** Medium

Add support for playing local .mkv files in the built-in player. Currently, .mkv files fall back to CDN streaming because HTML5 `<video>` in Chromium doesn't support MKV containers. Options include on-the-fly remux via ffmpeg to a temporary .mp4 or using WebCodecs API with a JavaScript MKV demuxer.

**Options:**
1. On-the-fly remux via ffmpeg (`-c copy`) to a temp .mp4 before playback — fast but needs temp disk space
2. WebCodecs API + JS MKV demuxer (e.g., `mkvdemux`) — no temp file, but complex and experimental
3. Register a custom streaming protocol that remuxes on-the-fly as the player reads

---

## 2. Translation Selector in Player

**Priority:** Medium | **Effort:** Medium

Allow switching between available translations without leaving the built-in player. Currently the player receives a single stream URL — switching translation requires closing the player, changing the dropdown in AnimeDetailView, and reopening.

**Plan:**
1. Pass available translations list to PlayerView via props (from AnimeDetailView's `episodeRows` data)
2. Add `translations` prop to PlayerView: `Array<{ id: number; label: string; type: string; height: number }>`
3. Update emit chain: AnimeDetailView → App.vue (`openPlayer`) → PlayerView props
4. Add translation dropdown button in PlayerView controls bar (next to Anime4K preset selector)
5. On translation switch: call `window.api.playerGetStreamUrl(newTranslationId, height)` to get new stream URL + subtitles
6. Update `<video>` src and subtitle track without remounting the component
7. IPC: reuse existing `player:get-stream-url` handler — no new IPC needed
8. Files: `AnimeDetailView.vue`, `App.vue`, `PlayerView.vue`, `preload/index.d.ts` (type update only)

---

## 3. Quality Selector in Player

**Priority:** Medium | **Effort:** Small

Add a quality selector dropdown in the built-in player controls. Currently the player always streams at the best available quality. Allow users to pick from available stream heights (e.g., 1080p, 720p, 480p).

**Plan:**
1. Extend `player:get-stream-url` to return all available stream heights (not just the best)
2. Add new IPC or extend return type: `{ streams: { height: number; url: string }[]; subtitleContent: string | null }`
3. Add quality dropdown in PlayerView controls bar showing available heights
4. Default to best (highest) quality
5. On quality switch: update `<video>` src to the selected stream URL, preserve playback position
6. Files: `main/index.ts`, `preload/index.d.ts`, `PlayerView.vue`

---

## 4. ASS Subtitle Support in Player

**Priority:** Medium | **Effort:** Medium

Replace the current ASS→WebVTT conversion with proper ASS rendering to preserve styled subtitles (colors, positioning, effects). The current approach strips all ASS formatting tags during conversion to VTT.

**Options:**
1. `jassub` (libass WASM) — full ASS support, but has Vite worker bundling issues in Electron (needs investigation)
2. `ass.js` / `assjs` — pure JS ASS renderer, simpler integration but less complete
3. Custom ASS parser that preserves basic styling (colors, bold, italic, position) in VTT cues

---

## 5. Seek Time Preview in Player

**Priority:** Low | **Effort:** Small

Show the target timestamp when hovering/dragging the seek bar. Currently seeking is blind — user can't see what time they're seeking to until they release.

**Plan:**
1. Add a time tooltip element positioned above the seek bar thumb
2. Show on `mousemove` / `input` events on the seek input
3. Calculate time from mouse position relative to seek bar width
4. Format as `MM:SS` or `H:MM:SS` depending on duration
5. Hide tooltip on `mouseleave`
6. Files: `PlayerView.vue` only (pure UI change)
