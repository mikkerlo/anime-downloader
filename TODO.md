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
- [x] Shikimori Series Chronology in Anime Detail View
- [x] Centralized Shikimori Cache & Surgical UI Updates
- [x] Offline Shikimori Support: Queuing & Status Indicators
- [x] Conflict-Aware Automatic Sync for Offline Changes
- [x] Gradual Background Pre-fetching of Shikimori Detailed Info
- [x] HEVC → H.264 transcode fallback for platforms without an HEVC decoder

## Planned

## 1. Watch Together (Syncplay)

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

---

## 3. Add to Library from Anime Page

**Priority:** Medium | **Effort:** Small

**Motivation:** Users should be able to add anime to their library directly from the detail view, rather than having to go back to search results.

**Plan:**
1.  **Renderer: `AnimeDetailView.vue` state.**
    *   Add `isStarred` ref.
    *   In `onMounted`, initialize `isStarred` by calling `window.api.libraryHas(props.animeId)`.
2.  **Renderer: `AnimeDetailView.vue` logic.**
    *   Add `toggleStar()` function.
    *   It should call `window.api.libraryToggle(anime)`. To keep the store lean, strip the `AnimeDetail` object down to `AnimeSearchResult` fields (id, titles, posterUrlSmall, etc.) before passing it.
    *   Update `isStarred` based on the return value.
3.  **Renderer: `AnimeDetailView.vue` template.**
    *   Add the button in `.poster-col`, below the `.continue-btn`.
    *   Use the star icon from `AnimeCard.vue`.
    *   Show "Add to Library" when not starred, and "In Library" (with a filled star) when starred.
4.  **Renderer: `AnimeDetailView.vue` styling.**
    *   Add `.library-btn` styles. Use a style similar to `.continue-btn` but with a secondary color (e.g., `#0f3460` background, or transparent with border) to distinguish it from the primary action.
