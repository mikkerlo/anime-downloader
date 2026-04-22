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
- [x] Conflict-Aware Automatic Sync for Offline Changes — background sync worker drains `shikimoriUpdateQueue` on 60s timer + post-success hooks + boot, consolidates per malId, progress-only override on server drift, recreate on server deletion, `shikimori:sync-status` broadcast + "Retry now" button in AnimeDetailView
- [x] Gradual Background Pre-fetching of Shikimori Detailed Info — throttled (2s) worker drains missing/stale `shikimoriAnimeDetails` for Watching+Planned entries, triggered post-rate-refresh and lazily on `shikimori:get-anime-details`; AnimeDetailView Shikimori panel surfaces genres + collapsible description when cached

---

## Planned

## ~~1. Shikimori Series Chronology in Anime Detail View~~ (done)

**Priority:** Medium | **Effort:** Medium

**Motivation:** Users often watch anime series with multiple seasons, OVAs, or movies. Providing a "Chronology" section directly on the anime page makes it easy to see the watch order, track progress across the entire franchise, and quickly navigate between entries.

**Tasks:**
- **Main Process (`src/main/shikimori.ts`)**:
  - Add `ShikiRelated` interface and `getRelatedAnime(shikiId: number)` function using the `/api/animes/:id/related` endpoint.
  - Ensure it filters for `anime` targets and handles Shikimori's rate limits.
- **Main Process (`src/main/index.ts`)**:
  - Implement `shikimori:get-related` IPC handler.
  - Use `lookupByMalIds` (our internal Shikimori ID resolver) to resolve the related anime to Smotret-Anime search results for deep linking.
- **Preload (`src/preload/index.ts` & `src/preload/types.d.ts`)**:
  - Expose `shikimoriGetRelated` to the renderer.
- **Renderer (`src/renderer/src/components/AnimeDetailView.vue`)**:
  - Fetch related anime on mount after the main anime data is loaded.
  - Cross-reference with `shikimoriUserRates` cache to determine watched/unwatched status for each related entry.
  - Add a "Chronology" section after the anime description.
  - Display entries with title, kind (TV/Movie/OVA), and a status badge (e.g., "Watched", "Watching", "Planned").
  - Make entries clickable to navigate to the corresponding `AnimeDetailView`.
  - Show a "Not available" badge for entries that don't have a Smotret-Anime match.

**Blockers & Risks:**
- **API Latency:** Fetching related items adds another round-trip on mount; should be non-blocking and show a subtle loading state.
- **Resolution Accuracy:** `lookupByMalIds` might not find a match if the anime is missing from Smotret-Anime or if the Shikimori mapping is incorrect.

## ~~2. Centralized Shikimori Cache & Surgical UI Updates~~ (done)

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

## ~~3. Offline Shikimori Support: Queuing & Status Indicators~~ (done)

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

## ~~4. Conflict-Aware Automatic Sync for Offline Changes~~ (done)

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

## ~~5. Gradual Background Pre-fetching of Shikimori Detailed Info~~ (done)

**Priority:** Medium | **Effort:** Small

**Motivation:** Ensure all anime in the Shikimori watchlist have their full Shikimori-side details (detailed descriptions, genres, and metadata) cached for a seamless offline experience without risking Smotret-Anime IP bans.

**Tasks:**
- Implement a throttled background loop in `shikimori:get-anime-rates` that triggers after the initial list load.
- Gradually fetch detailed anime info from Shikimori API (e.g., one every 2 seconds) for each item in the list.
- Store these details in the persistent cache to allow the Shikimori tab and Anime Detail view to show full information even when offline.

**Blockers & Risks:**
- **Shikimori Rate Limits:** Must strictly adhere to Shikimori's "5 requests per second" limit; the loop should be conservative (1-2 per second) to account for concurrent user actions.
- **Cache Size:** Fetching full details for very large lists (2000+ entries) can grow the `electron-store` file significantly; may need to limit pre-fetching to "Watching" and "Planned" statuses only.

## ~~6. HEVC → H.264 transcode fallback for platforms without an HEVC decoder~~ (done)

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

---

## 7. Watch Together (Syncplay)

**Priority:** High | **Effort:** Large

**Motivation:** Let users watch anime in sync with friends over the Internet. Two users on this app should stay in sync even when they watch different translations, qualities, or a CDN stream vs a local MKV — sync is anchored to playback *position* (seconds), not the underlying media file. Use the [Syncplay](https://syncplay.pl) protocol so we can reuse the existing public server infrastructure (`syncplay.pl:8995–8999` and community servers).

**Protocol notes (read first):**
- Syncplay is JSON-over-TCP with newline-delimited messages. Opportunistic STARTTLS is available from server 1.6.3+ — upgrade the socket when `TLS` feature is advertised in `Hello`.
- Handshake: client sends `{"Hello": {username, password?, room: {name}, version}}`, server replies with its own `Hello` (version, motd, possibly rewritten username). Only after that may the client send `State`/`ignoringOnTheFly`.
- `State` messages carry `{playstate: {position, paused, setBy, doSeek}, ping: {clientRtt, serverRtt, clientLatencyCalculation}, ignoringOnTheFly?}`. They are sent on discrete events (play/pause/seek) **and** as a ~1 s heartbeat so the server can relay drift to other clients. Do **not** wire every `timeupdate` — it fires 4× per second and floods the server.
- `ignoringOnTheFly: {server: N}` / `{client: M}` is the anti-race mechanism: when a client makes a local change (e.g. pause) it increments its counter and tags subsequent `State`s with `client: M`; when the server relays a change it tags with `server: N`. Each side echoes the other's counter back until the numbers match. Incoming `State`s that carry a still-unacknowledged counter must not trigger local video commands, otherwise local and remote changes ping-pong. Implement this in `src/main/syncplay.ts`; the renderer never sees the raw protocol.
- File identity: Syncplay clients announce the active file via `{"Set": {"file": {"name": ..., "duration": ..., "size": ...}}}`. Mismatched files surface as a "different file" warning in other clients but do not block sync. We advertise our **canonical anime name + episode int** (`"{animeName} - {episodeInt}"`) as `name` plus `duration` from the probed video. This keeps two of our users matching regardless of CDN stream vs local MKV vs translation, and gives mpv/VLC users a human-readable label. We also send Syncplay's optional `features` dict with our own `animeDlAppMeta: {animeId, malId, episodeInt, translationId}` so room-mate instances of this app can auto-navigate on episode change.

**Plan:**
1. **Main: Syncplay TCP client (`src/main/syncplay.ts`).**
   - Open `net.Socket` to `host:port` (default `syncplay.pl:8999`). After `Hello` reply, detect `TLS` feature and upgrade via `tls.connect({ socket })` when advertised and user hasn't disabled TLS.
   - Newline-delimited JSON parser with backpressure tolerance (buffer until `\n`).
   - State machine: `idle → connecting → hello-sent → ready → disconnected`. Auto-reconnect with exponential backoff (max 5 attempts) on transport error; abort reconnect on 4xx-style protocol errors (version rejected, banned).
   - Implement `Hello`, `Set` (user/room/file/ready/features), `List`, `State`, `Chat` (receive only, for toast text), `Error`. Stub `Chat` send path but don't expose in v1 UI.
   - Heartbeat: every 1 s, send `State` with current `playstate` (from the last known renderer snapshot) + `ping.clientLatencyCalculation = Date.now()/1000`. Measure RTT from server's echo. Compensate received `position` by `serverRtt/2` when applying remotely.
   - `ignoringOnTheFly` bookkeeping: track `clientIgnoreCounter` and last-seen `serverIgnoreCounter`. Drop inbound `State` if its `ignoringOnTheFly.client` ≠ our current counter (means our local change hasn't been acknowledged yet).
   - Emit typed events to `index.ts`: `remote-playstate` (paused, position, setBy, doSeek), `room-users` (list), `room-event` (join/leave/ready/chat text for toasts), `connection-status`, `error`.
2. **Main: IPC wiring (`src/main/index.ts`, 4-file pattern).**
   - Handlers: `syncplay:connect({host, port, room, password?, username})`, `syncplay:disconnect`, `syncplay:set-file({animeId, malId, episodeInt, translationId, canonicalName, duration})`, `syncplay:local-state({paused, position, cause: 'play'|'pause'|'seek'})`, `syncplay:get-status`.
   - Events to renderer: `syncplay:connection-status`, `syncplay:remote-state` (apply to video), `syncplay:room-users`, `syncplay:room-event` (toast text), `syncplay:remote-episode-change` (fired when room `Set.file.features.animeDlAppMeta.episodeInt` changes).
   - `syncplay:local-state` increments the `ignoringOnTheFly` counter inside `syncplay.ts` before sending; response from server must echo it back before we accept new remote states.
3. **Main: persist session intent.** New electron-store keys: `syncplay: { lastHost, lastPort, lastRoom, username, preferTls, autoReconnect }`. Connection itself is **not** persisted across app restarts — user must rejoin explicitly.
4. **Preload.** `src/preload/index.ts` exposes `api.syncplay.{connect, disconnect, setFile, sendLocalState, getStatus, on(event, cb)}`. `src/preload/types.d.ts` adds the signatures.
5. **Renderer: `SettingsView.vue` → new "Watch Together" tab.** Fields: host, port (default 8999), default room, username (defaults to Shikimori nickname from `shikimoriUser` if present, else prompt), password (optional), prefer TLS toggle, auto-reconnect toggle. "Test connection" button that calls `syncplay:connect` then `disconnect` and reports success/error.
6. **Renderer: `PlayerView.vue` Syncplay button.**
   - New button in the player controls bar (icon: two-people). Opens a popover with: room input, Connect/Disconnect, current user list, connection status.
   - On connect: call `syncplay:connect`, then immediately `syncplay:set-file` with the current episode's `{animeId, malId, episodeInt, translationId, canonicalName, duration}`.
   - On episode change (next/prev button, auto-advance, or translation/quality switch): call `syncplay:set-file` with the new payload. Position is reset to 0 in the next `local-state` send.
7. **Renderer: local → remote wiring.**
   - Listen on `videoRef.value` for `play`, `pause`, `seeked` (NOT `seeking`). Each fires `syncplay:local-state`. Do **not** wire `timeupdate` — the main-side heartbeat re-reads position via a cached snapshot updated on a 1 s `setInterval` in the renderer that pushes `{position, paused}` to main via an unthrottled `syncplay:local-snapshot` IPC (fire-and-forget). This keeps the renderer → main chatter cheap and gives main a fresh position to put in its heartbeat.
   - Suppress echo: whenever we apply a remote `play/pause/seek`, set a `suppressNextLocalEvent` flag for ~200 ms so our own `play`/`pause`/`seeked` handler doesn't fire an outbound `syncplay:local-state`. Main-side `ignoringOnTheFly` is the real anti-ping-pong; this flag is the renderer-side belt-and-suspenders for the brief window before the counter round-trips.
8. **Renderer: remote → local wiring.**
   - On `syncplay:remote-state`: if `paused` differs, call `video.play()` / `video.pause()`. If `doSeek` is true or `|remote.position - local.position| > 1.0`, set `video.currentTime = remote.position + rttCompensation` (already applied in main). Account for buffering: if not enough buffer at the target position (MSE path), pause until buffered then resume.
   - On `syncplay:remote-episode-change` with `animeDlAppMeta`: if `animeId` matches current anime, auto-navigate to `episodeInt` using the same path as the prev/next button (`App.vue`'s existing player navigation). If `animeId` differs, show a toast "Host switched to {otherAnime} — not loaded" (no cross-anime auto-nav in v1, since `AnimeDetailView` data isn't loaded).
   - On `syncplay:room-event`: show toast with `event.text` (e.g. "Bob joined", "Alice paused at 14:32").
9. **UX: event toasts.** Reuse the existing toast system in `PlayerView.vue` (the same one used for resume-position). No persistent chat panel, no text input in v1.
10. **Error surfaces.** Version-mismatch, banned, room-password-required, and network-dropped all raise toasts via `syncplay:room-event`. The player Syncplay popover shows connection status (green/yellow/red dot).
11. **DESIGN.md update.** Add a new "Watch Together" section next to "Shikimori Integration": protocol summary, the file-identity convention (canonical name + `animeDlAppMeta` features dict), the `ignoringOnTheFly` bookkeeping, heartbeat cadence, and the remote-episode auto-nav behavior. List all new IPC handlers/events in the IPC Handlers table. Add the `syncplay` settings group to the Settings table.
12. **Testing matrix.**
    - Two instances of this app in the same room, same episode → play/pause/seek sync within ~500 ms.
    - One instance on CDN stream, other on local MKV of same episode → still syncs on position.
    - User A advances to next episode → User B auto-navigates via `remote-episode-change`.
    - User A switches translation mid-episode → re-sends `Set.file` with same canonical name + new `translationId`; position sync continues.
    - Interop smoke test: connect one mpv+Syncplay client to the same room playing the same file; mpv pauses/plays/seeks propagate to our player and vice versa.
    - Network drop → toast "Disconnected from room", auto-reconnect fires, ready state resumes.
    - Wrong password → error toast, no retry storm.

**Blockers & Risks:**
- **Protocol edge cases.** `ignoringOnTheFly` bugs manifest as pause/play ping-pong — the hardest failure mode to debug. Log every counter increment + every inbound state with its counter tag in dev builds behind a `SYNCPLAY_DEBUG` env flag.
- **MSE buffering on seek.** Our MKV MSE path respawns ffmpeg on unbuffered seek (see DESIGN.md "Stream MKV Playback"). A remote seek lands on unbuffered territory → pipeline restart → 1–3 s of buffering before play resumes. Need a "catching up…" overlay so the user understands the delay.
- **Position divergence on transcode.** The HEVC→H.264 transcode path introduces variable encode latency. Position reported by `<video>.currentTime` is presentation time, not source time, so this is actually fine — but verify that two transcoding clients don't drift.
- **TLS optional.** Public Syncplay servers support opportunistic TLS; we must handle both plaintext and upgraded connections in the same state machine without duplicating code.
- **Clock skew.** The `clientLatencyCalculation` timestamp is in "seconds since epoch" as a float; rely on `Date.now()/1000` consistently on both machines — do not use `performance.now()` for this field.
