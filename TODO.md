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
- [x] Stream MKV Playback Without Full Remux Wait — fragmented MP4 piped to MSE SourceBuffer with on-the-fly ffmpeg respawn on unbuffered seek; legacy full-remux kept as fallback
- [x] HEVC (H.265) Support in MSE Streaming Path — `hevcCodecString` produces `hvc1.…` for Main / Main 10 / Main Still Picture; ffmpeg spawn emits `-tag:v hvc1` so Chromium MSE accepts the track; legacy full-remux fallback still fires when the platform has no HEVC decoder

---

## Planned

## 1. Centralized Shikimori Cache & Surgical Updates

**Priority:** Medium | **Effort:** Medium

**Motivation:** Currently, the Shikimori tab only loads data once on mount and doesn't reflect changes made in the Anime Detail view (like updating watched episodes or status). This leads to stale data and requires manual refreshes. A persistent cache will improve startup time and offline support, while a broadcast mechanism will keep all views in sync.

**Plan:**
1. **Persistent Storage:** Add `shikimoriUserRates` to `electron-store` defaults in `src/main/index.ts`.
2. **Main Process Cache Logic:**
   - Update `shikimori:get-anime-rates` to return cached data from the store if available.
   - Add `forceRefresh?: boolean` parameter to `shikimori:get-anime-rates` to allow manual re-fetch.
   - When fetching from API, update the store and resolve MAL IDs via `lookupByMalIds`.
3. **IPC Broadcasting:**
   - Create a new IPC channel `shikimori:rate-updated` (4-file pattern).
   - In `shikimori:update-rate` handler: after a successful update, update the corresponding entry in the store's `shikimoriUserRates` and broadcast the full `ShikiAnimeRateEntry` to all renderer windows.
4. **Renderer Integration:**
   - `src/preload/index.ts` & `src/preload/types.d.ts`: Expose `onShikimoriRateUpdated` listener.
   - `src/renderer/src/components/ShikimoriView.vue`: Subscribe to `shikimori:rate-updated`. On update, surgically replace the entry in the local `entries` ref.
   - `src/renderer/src/components/AnimeDetailView.vue`: (Optional) Use the cache for initial Shikimori data if it's already available in the main process to reduce API calls on mount.

## 2. HEVC → H.264 transcode fallback for platforms without an HEVC decoder

**Priority:** Medium | **Effort:** Large

**Problem:** On Linux, Chromium in Electron ships no software HEVC decoder. `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.…"')` returns `false` even with `PlatformHEVCDecoderSupport` enabled (the flag only unlocks *platform* decoders — VA-API on some Intel/AMD Linux systems; it doesn't add a software decoder). As a result the current legacy full-remux fallback in `player:remux-mkv` does `ffmpeg -c copy` and produces an MP4 that `<video>` still cannot decode — user sees a black screen with audio. The current PR just warns the user; this item replaces the warning with an actual working path.

**Linux-specific notes (read first):**
- Do **not** rely on the legacy `player:remux-mkv` to fix this. Its `-c copy` branch produces an unplayable MP4 on Linux for the same reason MSE rejected it — the codec didn't change.
- `PlatformHEVCDecoderSupport` only helps when the *system* has a VA-API/V4L2 HEVC decoder. On WSL2, containerized Linux, or machines without compatible GPU/drivers, the flag is a no-op. Treat `MediaSource.isTypeSupported('…hvc1…')` as the single source of truth.
- Feature-detect ffmpeg hardware encoders at startup (`ffmpeg -encoders | grep h264`) and cache results. `h264_vaapi` needs an init device (`-init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va -vf format=nv12,hwupload`) and fails silently if `/dev/dri/renderD128` isn't accessible — don't assume presence of the encoder name means it'll work; probe with a 1-frame encode of `testsrc`.
- `libx264 -preset ultrafast -tune zerolatency` is the portable default. On a mid-range CPU it sustains ~80–120 fps at 1080p, which keeps up with real-time playback but leaves little headroom — keep the backpressure high-watermark tighter (~16 MB) during transcode so we don't starve the encoder if the CPU is contended.

**Plan:**
1. **Gate at negotiation.** In `prepareMkvForPlayback` (`src/renderer/src/components/PlayerView.vue`), when the MSE `isTypeSupported` check fails AND the mime contains `hvc1`/`hev1`, branch to a new `prepareHevcTranscode()` path instead of calling `playerRemuxMkv` (legacy).
2. **New IPC channel** `player:remux-mkv-stream-transcode` (4-file pattern):
   - `src/main/index.ts` — new `ipcMain.handle`; reuses `MseSession` struct but spawns ffmpeg with `-c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -profile:v high -level 4.0 -c:a <copy-if-aac-else-aac-192k>` into the same fMP4 pipe. Reports back mime `video/mp4; codecs="avc1.640028, <audio>"`.
   - `src/preload/index.ts` — expose `playerRemuxMkvStreamTranscode(path, seek)`.
   - `src/preload/types.d.ts` — add the signature.
   - `PlayerView.vue` — call it from the new branch.
3. **Reuse existing plumbing.** Keep `spawnFfmpegForSession`, `player:stream-seek`, the generation-counter filter, `player:stream-chunk` / `-start` / `-ack` / `-end` / `-error`, and the subtitle extraction path unchanged — they're codec-agnostic. Only the argv differs.
4. **Audio strategy.** Extend `probeMkvForMse` (`src/main/index.ts`) to also return an `audioStrategy: 'copy' | 'transcode'` field based on `stream.codec_name`. AAC → copy; AC-3/E-AC-3/DTS/FLAC/TrueHD → `-c:a aac -b:a 192k`. The transcode handler uses this to compose its audio args.
5. **Encoder pick (new helper).** `pickH264Encoder()` in `src/main/index.ts`: on startup probe once, in priority order — `h264_vaapi` (Linux Intel/AMD, verify device), `h264_nvenc` (NVIDIA), `h264_qsv` (Intel QSV on Windows), `libx264` (universal fallback). Cache result. Must do a 1-frame dry-run encode, not just parse `-encoders` output.
6. **Consent UX.** New setting `hevcTranscodeOnPlay: 'ask' | 'always' | 'never'` (default `'ask'`) in `src/main/index.ts` defaults and `SettingsView.vue` → Player tab dropdown. When `'ask'` and MSE rejects HEVC, show a modal in `PlayerView.vue`: "Transcode this file", "Always transcode HEVC", "Open in external player". Persist the second choice to the setting.
7. **External-player escape hatch.** Add IPC `shell:open-external-file` (`shell.openPath`) exposed via preload; bind to the third modal button. Also the correct behavior when ffmpeg isn't bundled.
8. **Progress UX.** Replace the generic "Buffering…" toast with "Transcoding HEVC → H.264…" while the first MSE fragment for a transcode session is pending (track via a new reactive flag in `PlayerView.vue`). Include a cancel button that kills the session and closes the player.
9. **Settings surface.** In `SettingsView.vue` → Player tab, show current-platform decoder status ("HEVC decoder: available" / "not available") next to the new dropdown, computed from the same `hevcPlaybackSupported` check that gates the codec-change confirmation. Grey out the dropdown on platforms where HEVC already plays natively.
10. **DESIGN.md update.** Extend the "Local .mkv" section to describe the transcode branch, list the argv, and state that the legacy `player:remux-mkv` is now only used for non-HEVC fallback.
11. **Testing matrix.**
    - HEVC Main, Main 10, Main Still Picture on Linux → transcode path fires, video plays within ~3 s.
    - HEVC on Windows/macOS → native MSE path, unchanged.
    - H.264 MKV → unchanged (MSE stream-copy).
    - Seek during transcode → ffmpeg respawn at new timestamp, generation counter filters stale chunks correctly.
    - No hardware encoders available → falls back to `libx264`, still works (slower).
    - AC-3 / FLAC audio + HEVC → audio transcoded to AAC, plays back.
    - ffmpeg missing → modal defaults to "Open in external player".

**Why this replaces a simple warning:** mikkerlo's review on PR #27 accepted the warning-only solution on the assumption the legacy remux path would still make HEVC playable on Linux. It doesn't — Chromium has no decoder regardless of container. So the fix has to actually change the codec, not the container.

