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

## 4. Remember Selected Translation per Episode

**Priority:** High | **Effort:** Small

**Motivation:** If a user watched an episode partially and changed the translation from the default, the app should remember the specific translation when they return, instead of reverting to the global default. It must save the choice immediately upon switching and prefer downloaded files over remembered streams.

**Plan:**
1. **Types (`src/preload/types.d.ts` & `src/main/index.ts`):**
   - Add `translationId?: number` to the `WatchProgressEntry` interface and the corresponding electron-store type definition.
2. **IPC Wiring (`src/preload/index.ts` & `src/preload/types.d.ts` & `src/main/index.ts`):**
   - Update `watchProgressSave` signature to accept `translationId?: number`.
   - In the `watch-progress:save` handler in `main/index.ts`, persist the `translationId` along with `position` and `duration` if it is provided.
3. **Renderer: `PlayerView.vue`:**
   - In `saveProgress()` and `markWatched()`, pass `props.translationId` to `watchProgressSave`.
   - In `onTranslationChange()` (or the watcher for translation switches), immediately call `watchProgressSave` with the new translation ID so the choice is remembered even if playback progress hasn't advanced yet.
4. **Renderer: `AnimeDetailView.vue`:**
   - Update the `selectedTr` initialization logic in the `episodeRows` computed property.
   - Insert a new priority level (Priority 4, *after* preferring any downloaded translation but *before* the global default) that checks `watchProgress.value[ep.episodeInt]?.translationId`. If a match is found in the episode's available translations, use it as the `selectedTr`.
   - This ensures that downloaded files still win over a remembered stream, satisfying the conflict resolution rule.

---

## 5. Continue Watching Home View

**Priority:** High | **Effort:** Medium

**Motivation:** The app launches into Search, but for a returning user the highest-value action is "resume the episode I was on" or "start the next episode of a show I'm following". A dedicated home view surfaces those entries up-front and gives the app a real landing page. The data already exists — we just don't expose it.

**Data sources (no new external calls in v1):**
- `watchProgress` (electron-store): partial entries (`watched !== true` AND `position > 5` AND `position / duration < 0.95`). These become "Resume" rows.
- `shikimoriUserRates` filtered to `status === 'watching' || 'rewatching'`, joined with `shikimoriAnimeDetails` (already prefetched) and `malIdMap` (smotret-anime entry). For each: compute `nextEpisodeInt = rate.episodes + 1`. If `nextEpisodeInt <= details.episodes_aired`, this becomes a "Next up" row. The next-episode lookup is a count, not an ID — translations are resolved lazily on click in AnimeDetailView, same as the prev/next button flow.
- Deduplicate: if an anime has both a "Resume" entry (partial progress on episode N) AND would generate a "Next up" entry (rate.episodes points at N-1), the Resume row wins.

**Plan:**
1. **Main: new IPC `home:get-continue-watching`.**
   - In `src/main/index.ts`, add a handler that builds the merged list described above.
   - Output shape: `Array<{ kind: 'resume' | 'next', animeId: number, animeName: string, posterUrl: string, episodeInt: string, episodeLabel: string, position?: number, duration?: number, updatedAt?: number, malId?: number }>` sorted by `updatedAt` desc (resume rows use `watchProgress.updatedAt`; next-up rows use `rate.updated_at` parsed to ms — fall back to `Date.now()` if missing).
   - Cap at 24 rows. Resolve `posterUrl` via `downloadedAnime` / `library` / `malIdMap` cache (no network in this handler — if we can't resolve a poster locally, return `''` and let the renderer show a placeholder).
   - Episode label: prefer the cached anime's `episodes[].fullName` if loaded in `animeCache`, else fall back to `Episode N`.
2. **Preload (4-file pattern).**
   - `src/preload/index.ts`: expose `homeGetContinueWatching: () => ipcRenderer.invoke('home:get-continue-watching')`.
   - `src/preload/types.d.ts`: add the signature + a `ContinueWatchingEntry` interface.
3. **Renderer: new `HomeView.vue`.**
   - Grid of large cards (similar visual weight to `AnimeCard.vue` but landscape). Each card shows poster (left), title + episode label (right), a thin progress bar for `resume` rows, and a `Next ›` chip for `next` rows.
   - Click → emit `open-anime` with `{ animeId, focusEpisodeInt: episodeInt }`. AnimeDetailView already loads progress; extend it to scroll the focus episode into view (`scrollIntoView({ block: 'center' })` after `episodeRows` resolves).
   - Re-fetch on `mounted` and on `shikimori:rates-refreshed` / `watch-progress-updated` window events for live freshness without a manual refresh.
   - Empty state: a friendly "Nothing to resume — try Search" CTA that switches view.
4. **Renderer: make Home the default view.**
   - `src/renderer/src/App.vue`: change `currentView = ref('search')` → `'home'`. Add `home: null` to `animeByView` and `animeHistoryByView`. Wire `<HomeView v-show="currentView === 'home' && !activeAnimeId" @open-anime="openAnime" />` into the template.
   - The `focusSearch` shortcut (Ctrl+F) still navigates to Search — Search remains a sidebar entry, not removed.
5. **Renderer: `Sidebar.vue`.**
   - Prepend `{ id: 'home', label: 'Home', icon: <house path> }` to `baseItems`. Always visible (not gated on Shikimori login — Resume rows work without Shikimori).
6. **Renderer: `AnimeDetailView.vue` — focus episode.**
   - Add an optional `focusEpisodeInt?: string` prop. After `episodeRows` is non-empty + `episodes-list` rendered, if `focusEpisodeInt` matches a row's `episodeInt`, switch to its page (account for pagination — recompute `currentPage` from the row index) and call `scrollIntoView` on the row element. Clear the prop on first apply so re-renders don't re-scroll.
7. **DESIGN.md update.** Add a "Home / Continue Watching" subsection under Data Flow describing the merge logic and the dedup rule. Add `home:get-continue-watching` to the IPC Handlers table. Update the App.vue route summary to mention `home` as the default view.

**Blockers & Risks:**
- **Sparse data on first launch.** A brand-new install with no Shikimori login and no watch history shows an empty state immediately, which is a worse first impression than Search. Mitigation: when both sources are empty, fall back to rendering Search inside the Home view (or show the empty-state CTA already specified). Decision: empty CTA — wiring Search inside Home complicates the searchView state-persistence guarantee.
- **Stale poster URLs.** smotret-anime CDN poster URLs occasionally rotate. The Home view relies on cached `posterUrl` — if it 404s the card shows broken poster + title fallback. Acceptable; the user can click through and AnimeDetailView's mount triggers a fresh `getAnime` which refreshes the cache.
- **Order stability.** Resume rows reorder every 5 s during active playback (each `watch-progress-updated` event refetches). Mitigation: debounce the refetch to 1 s on `watch-progress-updated`; the natural ordering is "most recent first" anyway, so reorder churn is minimal.
- **Pagination + focus episode.** AnimeDetailView paginates at 30 episodes/page. Picking the right page for a given `episodeInt` requires the episode index in the unpaginated list. Implementation: after `episodeRows` resolves, find row, compute `Math.floor(rowIndex / 30)`, set `currentPage`, then `nextTick(() => scrollIntoView())`.

---

## 6. Airing Calendar

**Priority:** Medium | **Effort:** Medium

**Motivation:** Users following currently-airing seasonal shows need to know when the next episode drops. Right now there's no view for this — they'd have to remember air days per show. A weekly grid (Mon–Sun) of upcoming episodes for shows in their Watching+Planned list answers "what should I watch this week?" in one glance.

**Data source:** Shikimori `GET /api/calendar` is a public, unauthenticated endpoint that returns `[{ next_episode_at: string, duration: number, anime: { id, name, russian, image, kind, ... } }]` for currently-airing series across the entire site. We filter client-side to MAL IDs the user tracks as `watching` / `rewatching` / `planned`.

**Plan:**
1. **Main: new IPC `shikimori:get-calendar`.**
   - In `src/main/shikimori.ts`, add `export async function getCalendar(): Promise<ShikiCalendarEntry[]>` that hits `/api/calendar` (no auth header — public endpoint). Define `ShikiCalendarEntry` to mirror the response.
   - In `src/main/index.ts`, add an `ipcMain.handle('shikimori:get-calendar')` that:
     a. Loads `shikimoriUserRates` from store; builds the set of MAL IDs where status ∈ {`watching`, `rewatching`, `planned`}.
     b. Calls `getCalendar()`.
     c. Filters entries by MAL ID set, resolves each to a smotret-anime entry via existing `lookupByMalIds` (reuses `malIdMap` cache so clickthrough goes straight to AnimeDetailView).
     d. Returns `Array<{ malId, animeId | null, name, russian, posterUrl, kind, episodeInt: rate.episodes + 1, nextEpisodeAt: string (ISO), userStatus }>`.
   - In-memory 5-min cache (same pattern as Friends Activity in `FriendsActivityView.vue`'s 5-min in-memory store, but moved into main since the data is small and shared).
2. **Preload (4-file pattern).**
   - Expose `shikimoriGetCalendar: () => ipcRenderer.invoke('shikimori:get-calendar')`. Add `CalendarEntry` to types.
3. **Renderer: new `CalendarView.vue`.**
   - 7-column grid (Mon–Sun) of the **current week**, where "current week" starts on user's locale-Monday (`Intl.Locale` weekInfo, or fall back to ISO Monday). Today's column is highlighted.
   - Each column lists episodes sorted by `nextEpisodeAt` ascending. Card shows poster thumbnail (40×56), title, episode number, time-of-day (`HH:mm` in user's local TZ — convert from the server's UTC `next_episode_at`). A user-status chip (Watching / Planned) on the corner.
   - Entries with `nextEpisodeAt` past today render in the column for their air weekday; entries earlier in the week with no future air date are excluded (not shown as "yesterday's episode" — the calendar is forward-looking).
   - Clickthrough on `animeId !== null` opens AnimeDetailView via existing `open-anime`. `animeId === null` rows show a "Not on smotret-anime" badge and are non-clickable (same convention as Chronology rows that fail `lookupByMalIds`).
   - Empty week → friendly "No new episodes this week — your watching list is up to date" message.
   - Refresh button + automatic refresh on view re-mount (cache layer in main absorbs the cost).
4. **Renderer: `Sidebar.vue`.**
   - Add `calendarItem = { id: 'calendar', label: 'Calendar', icon: <calendar svg> }` next to `friendsItem`. Gate on `props.shikimoriLoggedIn` — same pattern as Shikimori / Friends entries (calendar is meaningful only with a synced watching list).
5. **Renderer: `App.vue`.**
   - Add `calendar: null` to `animeByView` / `animeHistoryByView`. Wire `<CalendarView v-show="currentView === 'calendar' && !activeAnimeId" @open-anime="openAnime" />`.
6. **DESIGN.md update.** New "Airing Calendar" subsection describing the data flow (calendar endpoint → MAL filter → smotret resolve), the "current-week, forward-looking" rule, and the 5-min cache. Add `shikimori:get-calendar` to the IPC table.

**Blockers & Risks:**
- **MAL set drift.** The user could mark an anime Watching mid-week; the calendar cache would stale-out the new entry until invalidation. Mitigation: invalidate the calendar cache on `shikimori:rate-updated` and `shikimori:rates-refreshed` so a status flip surfaces in the next view mount.
- **Time zone correctness.** Shikimori's `next_episode_at` is a string with explicit offset (e.g. `2024-04-26T15:30:00+09:00`). Render via `new Date(...).toLocaleString('default', { weekday, hour, minute })` — the platform converts to local TZ. Do **not** strip the offset.
- **Locale week start.** ISO uses Monday; some locales (US) start on Sunday. Use `Intl.Locale(navigator.language).getWeekInfo().firstDay` where supported, else fall back to Monday. Don't hard-code Monday-only.
- **Schedule gaps.** Some entries have null `next_episode_at` (between-cours, on-hiatus shows). Filter them out of the grid — they'd otherwise crash the date math.
- **Public-endpoint abuse.** `/api/calendar` returns the entire site's airing list (~100s of entries). Body is small but worth avoiding the network when nothing changed; the 5-min main-side cache + invalidate-on-rate-change covers this.

---

## 7. Auto-Skip Intro / Outro (Aniskip)

**Priority:** Medium | **Effort:** Medium

**Motivation:** Binge-watching a long-running show with the same OP/ED every episode is a friction point that every modern player solves. The community-maintained [aniskip](https://aniskip.com) database already has crowdsourced timestamps for most popular series, keyed by MAL ID + episode number. We can show a "Skip Intro" / "Skip Outro" overlay button when playback enters a known interval — manual click in v1, opt-in auto-skip behind a setting.

**API:** `GET https://api.aniskip.com/v2/skip-times/{malId}/{episodeNumber}?types[]=op&types[]=ed&episodeLength={seconds}` returns `{ found: boolean, results: Array<{ skipType: 'op'|'ed', interval: { startTime: number, endTime: number }, episodeLength: number, skipId: string }> }`. Times are in seconds. The `episodeLength` argument is matched against the database — pass `Math.round(video.duration)`; aniskip returns no results if its stored episodeLength differs by >5 s, so the call is naturally a no-op for re-edits.

**Plan:**
1. **Main: new module `src/main/aniskip.ts`.**
   - `export async function getSkipTimes(malId: number, episode: number, duration: number): Promise<SkipTime[]>`.
   - 30 s timeout via `AbortController`. On 404 / network error / `found: false`, return `[]` (silently — this is best-effort UX).
   - No retry logic; aniskip is fire-and-forget.
2. **Main: persistent cache in electron-store.**
   - New key `aniskipCache: Record<string, { times: SkipTime[]; fetchedAt: number }>`, key shape `${malId}:${episode}:${roundedDuration}`. TTL 30 days; expired entries refetched on next ask.
   - In `src/main/index.ts`, add `ipcMain.handle('aniskip:get-skip-times', async (_e, malId, episode, duration) => { ... })` that's cache-first, calls `getSkipTimes` on miss, persists, returns the array.
   - Cache cleared via existing "Clear cache" Debug actions where appropriate (or just let TTL handle it).
3. **Preload (4-file pattern).**
   - Expose `aniskipGetSkipTimes: (malId, episode, duration) => ipcRenderer.invoke('aniskip:get-skip-times', malId, episode, duration)`. Add `SkipTime` to types.
4. **Renderer: `PlayerView.vue` integration.**
   - On player mount (after `loadedmetadata` resolves with `video.duration`): if `props.malId > 0` and `props.episodeLabel` parses to an integer episode, call `aniskipGetSkipTimes(malId, episodeInt, Math.round(duration.value))`. Store the resulting `skipTimes: ref<SkipTime[]>([])`.
   - Refresh on episode change (same hook as the existing prev/next episode logic — see DESIGN.md "Episode Navigation").
   - In the `currentTime` watcher, compute `activeSkip = skipTimes.value.find(s => currentTime.value >= s.interval.startTime && currentTime.value < s.interval.endTime - 1)` (the `-1` keeps the button from flashing for a single frame at the very end).
   - Render an overlay button in the bottom-right of the video area when `activeSkip` is non-null, label `Skip Intro` / `Skip Outro` per `skipType`. Click → `seek(activeSkip.interval.endTime)`.
   - Auto-skip path (gated on the setting from step 5): when `activeSkip` becomes non-null AND `autoSkip === true`, after a 250 ms grace (so a manual skip-back doesn't immediately re-fire) call `seek(activeSkip.interval.endTime)`. Track `lastAutoSkippedId` so we don't re-skip if the user seeks backward into the same interval.
5. **Settings: new "Auto-skip" controls in `SettingsView.vue` (Player tab).**
   - Toggle: `autoSkipIntro` (default `false`). Toggle: `autoSkipOutro` (default `false`). Both persisted via `setSetting`.
   - Disabled when toggle is off, the manual button still appears — the toggle only controls *automatic* skipping.
   - Settings type addition: `autoSkipIntro: boolean`, `autoSkipOutro: boolean` in the store schema (`src/main/index.ts`).
6. **Renderer: cache settings in PlayerView.**
   - `playerSettings` ref includes the two new toggles, refreshed on player mount via `getSetting`. The `currentTime` watcher consults the cached values.
7. **Pre-fetch on library add and on episode download.** The silent-`[]` fallback handles transient outages, but for offline playback (e.g. travelling with downloaded episodes) we want the skip overlays to keep working. New main-side worker `prefetchAniskipForAnime(malId, episodeRange)`:
   - Triggered on `library:add` for the freshly-added anime (`episodeRange = 1..details.episodes_aired`, capped to e.g. 100 to avoid runaway calls on long-running shows). Triggered on download completion for the specific episode (`episodeRange = [episodeInt]`).
   - Throttled to ~1 req/s with `setTimeout` between calls so we don't hammer aniskip.com when adding a long-running show.
   - Re-uses the existing `aniskip:get-skip-times` cache path; pre-fetch is just "warm the cache". A subsequent player open finds it ready.
   - Skips silently when `malId <= 0`, when the cache entry is fresh (<30 days), or when the network call fails (logged once per anime).
8. **DESIGN.md update.** New "Aniskip Skip-Intro / Skip-Outro" subsection under Built-in Video Player. Document: the API, the cache (30-day TTL, key shape), button-overlay default, auto-skip toggle, and the library/download pre-fetch worker. Add `aniskip:get-skip-times` to the IPC table and `aniskipCache` / `autoSkipIntro` / `autoSkipOutro` to the Settings table.

**Blockers & Risks:**
- **Database coverage.** Aniskip's GitHub repo star count understates adoption — the API is the upstream that drives skip plugins for mpv, Jellyfin, and Plex, so coverage is strong on popular shows and thin/absent on niche/older ones. A missing entry naturally degrades to "no button shown" thanks to the silent-`[]` fallback, so coverage gaps are not a blocker, just an honest limit.
- **Bad timestamps.** Aniskip is crowdsourced — occasional bad submissions skip into spoilers. That's exactly why v1 default is button-only, not auto-skip; users opt in once they trust the database for a given show. Worth mentioning in the Settings tooltip ("Community-contributed timestamps; occasionally inaccurate").
- **Episode number parsing.** `episodeLabel` in the player is the smotret-anime label (often "Episode 5" or "5"). `episodeInt` is already passed through as a string; parse it via `parseInt(episodeInt, 10)`. Fractional `.5` recap episodes won't have aniskip data — return early.
- **`malId === 0`.** Many smotret-anime entries lack a MAL link (e.g. niche or older shows). Skip the API call entirely when `malId <= 0`.
- **Network loss.** Mitigated for downloaded/library anime by the pre-fetch worker (step 7) — skip data is warmed into the cache when the user adds the anime or finishes a download, so offline playback still gets overlays. For everything else, the silent-`[]` fallback in main keeps the player usable; it just won't show a skip button.
- **Privacy.** Each play sends `malId + episode + duration` to aniskip.com. Document this in the Settings tooltip; the cache means a given episode is only sent once per 30 days. No PII.
- **Outro near end-credits cliffhanger.** Some shows put plot in the post-credits stinger. Auto-skip past the outro would skip the stinger. Mitigation: aniskip's `ed` interval typically ends *before* the stinger — verify this when QA-ing; if intervals are too aggressive, treat outro skip as button-only even when auto-skip is on (i.e. `autoSkipOutro` ignored, only `autoSkipIntro` honored). Decision pending QA.

---

## 8. Storage Dashboard & Auto-Cleanup of Watched Episodes

**Priority:** Medium | **Effort:** Medium

**Motivation:** Downloaded anime accumulates indefinitely. Users have no way to see *what's eating disk space* or to automatically free space after they've finished watching. A Storage tab in Settings answers "what's on disk and where?" and an opt-in cleanup rule ("delete watched episodes after 30 days") closes the loop without manual housekeeping.

**Plan:**
1. **Schema additions to `watchProgress`.**
   - Add an explicit `watchedAt?: number` field (epoch ms) recorded the first time `watched` flips false→true. Distinct from `updatedAt`, which keeps mutating during heartbeats.
   - In `src/main/index.ts` `watch-progress:save` handler: when `watched === true` AND `prev?.watched !== true`, set `watchedAt = Date.now()`. Otherwise carry `prev?.watchedAt` forward unchanged. (Don't overwrite on rewatches — first-watched timestamp is the policy anchor.)
   - Update the store type definition + `WatchProgressEntry` in `src/preload/types.d.ts`.
2. **Main: new IPC `storage:get-usage`.**
   - Scans hot dir + cold dir (when advanced mode) and returns:
     ```ts
     { totalBytes: number, perAnime: Array<{ animeId: number, animeName: string, bytes: number, fileCount: number, episodes: Array<{ episodeInt: string, files: { mkv?: { path, size }, mp4?: { path, size }, ass?: { path, size } }, watched: boolean, watchedAt?: number }> }> }
     ```
   - Implementation: `fs.readdirSync` each anime folder, group files by sanitized anime name → match against `downloadedAnime` keys, group within an anime by parsing episode number from filename (regex matches the `{name} - {NN} [Author].ext` shape used in `download-manager.ts`), sum sizes via `fs.statSync(path).size`. Cross-reference each `(animeId, episodeInt)` against `watchProgress` for the watched flag + `watchedAt`.
   - Sorted: anime by `bytes` desc; episodes by `episodeInt` asc.
   - Long-running on big libraries — async with `fs.promises`. Fire `storage:usage-progress` IPC events with `{ scanned, total }` if the library has >50 anime, so the UI can show a progress bar. Result returned via the regular handle when complete.
3. **Main: new auto-cleanup worker.**
   - Settings: `autoCleanupWatchedDays: number` (0 = off, default 0). `autoCleanupConfirm: boolean` (default `true` — first run shows a confirm modal listing what will be deleted).
   - Worker `runWatchedCleanup(force = false): Promise<{ deletedCount, freedBytes, items }>`:
     a. Read `autoCleanupWatchedDays`. If 0 and not `force`, return early.
     b. Walk `watchProgress` for entries with `watched === true` AND `(now - watchedAt) > days * 86400_000`.
     c. For each, parse `${animeId}:${episodeInt}` and call the existing `file:delete-episode` flow (or a shared internal helper) to remove all translations of that episode (from hot + cold). Sum freed bytes from the pre-delete file sizes.
     d. Emit a `storage:cleanup-finished` IPC event with the result; broadcast `file:episodes-changed` for any anime that lost files.
   - Trigger cadence: on app start (after a 60 s warmup), and once per 24 hours via `setInterval`. Plus an on-demand `storage:run-cleanup` IPC for the "Run now" button.
   - First-time gate: if `autoCleanupConfirm === true` AND a scheduled run would delete >0 episodes, instead emit `storage:cleanup-pending` with the candidate list; the renderer shows a modal; on confirm, the renderer calls `storage:run-cleanup` with `force: true` and then `setSetting('autoCleanupConfirm', false)`. Subsequent runs are silent.
4. **Preload (4-file pattern).**
   - Expose: `storageGetUsage`, `storageRunCleanup`, `onStorageUsageProgress`, `onStorageCleanupFinished`, `onStorageCleanupPending`. Add types.
5. **Renderer: new "Storage" tab in `SettingsView.vue`.**
   - Top: total bytes used (large number), counts `(N anime · M episodes · K files)`, refresh button.
   - Anime list: each row collapsible. Header shows poster thumb, title, total bytes, file count, expand chevron. Body lists episodes with size, watched checkmark + relative `watchedAt`, and a per-episode delete button (uses existing `file:delete-episode`).
   - Below the list: "Auto-cleanup" panel. Number input for `autoCleanupWatchedDays` (0–365; 0 = off). Helper text: "Delete watched episodes older than N days". Status line: last run, episodes deleted, bytes freed (persist in store as `autoCleanupLastRun`). "Run cleanup now" button → `storageRunCleanup` (still respects the confirm modal on first run).
   - Confirm modal (shown on first scheduled or manual run when `autoCleanupConfirm === true`): lists candidate anime + episode counts; buttons `Delete` / `Cancel`. On Delete, persists `autoCleanupConfirm = false` + invokes `storageRunCleanup({ force: true })`.
6. **Migration for existing `watchProgress` entries without `watchedAt`.**
   - On boot, one-time pass: for each entry with `watched === true` AND `watchedAt == null`, set `watchedAt = updatedAt`. Mark migration done via `watchProgressMigrationV2: true` setting so we don't re-run.
7. **DESIGN.md update.** New "Storage Dashboard & Auto-Cleanup" section. Document: the `watchedAt` field, the cleanup worker cadence + confirm-modal flow, the `storage:get-usage` shape, the migration. Add new IPC channels to the table and new settings to the Settings table.

**Blockers & Risks:**
- **Cleanup trust.** Deleting files automatically is the riskiest action this app does. The default is **off**, the first run is gated on a confirm modal, and even after enabling, every deletion goes through the same `file:delete-episode` path that the user already uses manually — no parallel deletion code path. Mitigation: also log every deletion to a `cleanupLog` setting (rolling, last 100 entries) that the Storage tab can show as "Recent cleanups".
- **`watchedAt` accuracy on legacy data.** Pre-migration entries get `watchedAt = updatedAt`, which is roughly correct (the last save when watched was set), but for entries where the user re-opened the episode after marking it watched, `updatedAt` could be much later than when they actually finished. Acceptable — errs on the side of *not* deleting.
- **In-progress downloads.** Cleanup must skip episodes with active downloads or `.part` files. The existing `moveEpisodeToColdStorage` already skips `.part`-suffixed files; reuse the same guard.
- **Multi-translation episodes.** When watched is set on a `(animeId, episodeInt)`, all translations of that episode get deleted together by the existing `file:delete-episode` (without `translationId`). That's the right behavior — once the user is done with that episode, every author's version of it is fair game. Worth calling out in the Settings helper text.
- **Scan performance.** `storage:get-usage` on a library of 100+ anime with 1000+ files takes seconds, not ms. Justifies the progress IPC + async impl. Don't block the Settings tab open on this — render the tab immediately, populate when the scan resolves.
- **Cold storage interaction.** On systems with hot/cold split, `storage:get-usage` reports both dirs (separately broken out, e.g. `bytesHot` / `bytesCold`). Cleanup deletes from whichever location holds the file (existing `file:delete-episode` already handles both).
