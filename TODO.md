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
- [x] Previous / Next Episode Buttons in Player — prev/next navigation, auto-advance, configurable shortcuts
- [x] Auto-Track Watch Progress and Resume Playback — track watched progress, persist position, and update Shikimori
- [x] Configurable Anime4K Shader Shortcuts in Player — Ctrl+1/2/3 for Mode A/B/C and Ctrl+` for Off, rebindable in Settings

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
