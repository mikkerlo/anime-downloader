# TODO

[View all issues Ready for Implementation](https://github.com/mikkerlo/anime-downloader/issues?q=is%3Aopen+is%3Aissue+label%3A%22Ready+for+implementation%22)

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
- [x] Stream MKV Playback Without Full Remux Wait — fragmented MP4 piped to MSE SourceBuffer with on-the-fly ffmpeg respawn on unbuffered seek; legacy full-remux kept as fallback
- [x] HEVC (H.265) Support in MSE Streaming Path — `hevcCodecString` produces `hvc1.…` for Main / Main 10 / Main Still Picture; ffmpeg spawn emits `-tag:v hvc1` so Chromium MSE accepts the track; legacy full-remux fallback still fires when the platform has no HEVC decoder
- [x] HEVC → H.264 transcode fallback for platforms without an HEVC decoder — new `player:remux-mkv-stream-transcode` IPC re-encodes HEVC to H.264 through the existing MSE pipe; `pickH264Encoder` dry-runs `h264_vaapi` / `h264_nvenc` / `h264_qsv` / `libx264` at startup; `hevcTranscodeOnPlay` setting (ask / always / never) with consent modal and `shell:open-external-file` escape hatch
- [x] Centralized Shikimori Cache & Surgical UI Updates — persist `shikimoriUserRates` in electron-store, cache-first `get-anime-rates`, background API refresh with `shikimori:rates-refreshed` broadcast, surgical `shikimori:rate-updated` on rate changes
- [x] Offline Shikimori Support: Queuing & Status Indicators — intercept transport-level failures in `shikimori:update-rate`, persist `{before, after}` deltas to `shikimoriUpdateQueue`, optimistically update cache, broadcast `shikimori:offline-queue-changed`, show "Working offline" chip in AnimeDetailView
- [x] Conflict-Aware Automatic Sync for Offline Changes — background sync worker drains `shikimoriUpdateQueue` on 60s timer + post-success hooks + boot, consolidates per malId, progress-only override on server drift, recreate on server deletion, `shikimori:sync-status` broadcast + "Retry now" button in AnimeDetailView
- [x] Gradual Background Pre-fetching of Shikimori Detailed Info — throttled (2s) worker drains missing/stale `shikimoriAnimeDetails` for Watching+Planned entries, triggered post-rate-refresh and lazily on `shikimori:get-anime-details`; AnimeDetailView Shikimori panel surfaces genres + collapsible description when cached
- [x] Shikimori Series Chronology in Anime Detail View
- [x] Centralized Shikimori Cache & Surgical UI Updates
- [x] Offline Shikimori Support: Queuing & Status Indicators
- [x] Conflict-Aware Automatic Sync for Offline Changes
- [x] Gradual Background Pre-fetching of Shikimori Detailed Info
- [x] HEVC → H.264 transcode fallback for platforms without an HEVC decoder
