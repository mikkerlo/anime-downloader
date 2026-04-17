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
- [x] HEVC → H.264 transcode fallback for platforms without an HEVC decoder — new `player:remux-mkv-stream-transcode` IPC re-encodes HEVC to H.264 through the existing MSE pipe; `pickH264Encoder` dry-runs `h264_vaapi` / `h264_nvenc` / `h264_qsv` / `libx264` at startup; `hevcTranscodeOnPlay` setting (ask / always / never) with consent modal and `shell:open-external-file` escape hatch
- [x] Centralized Shikimori Cache & Surgical UI Updates — persist `shikimoriUserRates` in electron-store, cache-first `get-anime-rates`, background API refresh with `shikimori:rates-refreshed` broadcast, surgical `shikimori:rate-updated` on rate changes
- [x] Offline Shikimori Support: Queuing & Status Indicators — intercept transport-level failures in `shikimori:update-rate`, persist `{before, after}` deltas to `shikimoriUpdateQueue`, optimistically update cache, broadcast `shikimori:offline-queue-changed`, show "Working offline" chip in AnimeDetailView

---

## Planned

## ~~1. Centralized Shikimori Cache & Surgical UI Updates~~ (done)

**Priority:** High | **Effort:** Medium

**Motivation:** Move Shikimori data management to the main process to enable persistence and keep multiple views (Shikimori tab and Anime Detail) in sync without full refreshes.

**Tasks:**
- Add `shikimoriUserRates` to `electron-store` defaults.
- Update `shikimori:get-anime-rates` to serve from store immediately and refresh from API in the background.
- Implement `shikimori:rate-updated` IPC channel to broadcast changes to all renderer windows.
- Update `ShikimoriView.vue` to listen for broadcasts and surgically update its local list.

**Blockers & Risks:**
- **Schema Design:** Must define a robust schema for `shikimoriUserRates` that includes `updatedAt` to avoid stale cache issues.
- **IPC Overhead:** Broadcasting full rate objects for large lists (1000+ entries) may cause renderer lag; needs optimized payload or filtered broadcasts.

## ~~2. Offline Shikimori Support: Queuing & Status Indicators~~ (done)

**Priority:** High | **Effort:** Medium

**Motivation:** Allow users to update their watch progress while disconnected.

**Tasks:**
- Implement connectivity tracking in the main process via renderer `online`/`offline` events.
- Create `shikimoriUpdateQueue` in `electron-store` to persist pending changes.
- Update `shikimori:update-rate` to intercept changes while offline: save the `before` (cached) and `after` (requested) states and return success to the UI.
- Add a "Working Offline" indicator near the Shikimori status block in `AnimeDetailView.vue`.

**Blockers & Risks:**
- **Dependency:** Hard-blocked by **Item #1** (requires the centralized cache to record the `before` state).
- **False Positives:** `navigator.onLine` is notoriously unreliable; implementation must handle "lie-fi" (connected to Wi-Fi but no internet) to avoid lost requests.

## 3. Conflict-Aware Automatic Sync for Offline Changes

**Priority:** High | **Effort:** Medium

**Motivation:** Automatically and safely apply queued changes when the internet connection is restored.

**Tasks:**
- Implement a background sync worker that triggers on the `online` event.
- For each queued change, fetch the current state from Shikimori and compare it with the `before` state recorded during the offline change.
- **Conflict Resolution:** If the current state matches `before`, apply the `after` change. If they differ (manual change on Shikimori web), only apply the update if it represents progress (e.g., higher episode count) to avoid regressions.
- Clear successfully synced items from the queue.

**Blockers & Risks:**
- **Dependency:** Hard-blocked by **Item #2**.
- **Data Integrity:** Complex conflict resolution logic; incorrectly resolving a "watched 5" vs "watched 10" conflict could permanently corrupt user watch history on Shikimori.
- **Rate Limiting:** Sequential syncing after a long offline period might trigger Shikimori's 429 rate limits.

## 4. Gradual Background Pre-fetching of Shikimori Detailed Info

**Priority:** Medium | **Effort:** Small

**Motivation:** Ensure all anime in the Shikimori watchlist have their full Shikimori-side details (detailed descriptions, genres, and metadata) cached for a seamless offline experience without risking Smotret-Anime IP bans.

**Tasks:**
- Implement a throttled background loop in `shikimori:get-anime-rates` that triggers after the initial list load.
- Gradually fetch detailed anime info from Shikimori API (e.g., one every 2 seconds) for each item in the list.
- Store these details in the persistent cache to allow the Shikimori tab and Anime Detail view to show full information even when offline.

**Blockers & Risks:**
- **Shikimori Rate Limits:** Must strictly adhere to Shikimori's "5 requests per second" limit; the loop should be conservative (1-2 per second) to account for concurrent user actions.
- **Cache Size:** Fetching full details for very large lists (2000+ entries) can grow the `electron-store` file significantly; may need to limit pre-fetching to "Watching" and "Planned" statuses only.

## ~~5. HEVC → H.264 transcode fallback for platforms without an HEVC decoder~~ (done)

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

