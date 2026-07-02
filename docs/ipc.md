# IPC Handlers

The single source of truth for channel names and payload/return types is `src/shared/ipc/channels.ts`. Both main (via `ipcMain.handle`/`webContents.send`) and renderer (via `window.api.*`) dereference the same symbols (`CHANNELS.*` and `EVENT_CHANNELS.*`), so renaming or removing a channel is a compile error rather than a silent miss. The per-domain routers in `src/main/ipc/*.ipc.ts` consume the contract; see [Architecture](./architecture.md) for the router-by-router file map.

**Slow-reply profiling:** `registerIpcRouters` (`src/main/ipc/index.ts`) intercepts `ipcMain.handle` for the duration of router registration, so every channel's handler is timed and any reply slower than `SLOW_IPC_MS` (`src/main/lib/perf.ts`, 100ms) is logged as `[perf] ipc <channel> took Nms`. The main process serializes all replies on one event loop, so these logs are the first place to look when the UI feels stalled. The store layer logs `[perf] store.*` the same way.

## Broadcast subscription contract (Phase 4 slice 4a, #111)

`send`-direction event channels expose `on*` subscribers on `window.api` of shape
`EventSubscriber<T> = (listener) => Unsubscribe` (see `src/shared/ipc/channels.ts`).
Each call registers a dedicated listener and returns a disposer that removes only
that listener — never `ipcRenderer.removeAllListeners`, which would clobber every
other subscriber on the channel. There are no `off*` methods on `window.api`.

**Ownership rule (Phase 4 slices 4b–4d):**

| Subscription kind | Owner | Disposal |
|---|---|---|
| Cross-view (download/scan-merge/fix-metadata progress, Shikimori rate/refresh/sync/details/offline-queue, ffmpeg/fpcalc/update status) | Pinia store (`useDownloadsStore`, `useShikimoriStore`, `useSettingsStore`) | Lifetime-scoped — singleton, never disposed |
| Anime-specific (file-episodes-changed, skip-detector progress/signature, chapter-inject progress, cleanup-prompt toast) | The consuming component | `onBeforeUnmount` / `onUnmounted` |
| Player-instance (player-stream chunks/end/error/progress/subtitles, syncplay session) | `PlayerView.vue` | `onBeforeUnmount` |

The CI step `npm run check:subscription-contract` greps `src/preload/` and
`src/renderer/` for `removeAllListeners(` or `window.api.off*(` calls and fails
the build if any survive (Phase 4 slice 4e).

Renderer composables that own broadcast subscriptions (e.g. `useShikimori`, `useSkipDetection`, `useMsePlayer`, `useSyncplayClient`) bind those subscriptions inside themselves and return disposers to the consumer; pure-logic composables defer lifecycle to the caller. The full composable inventory lives in [Renderer architecture](./renderer.md#composables).

## Channel reference

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `validate-token` | invoke | Validate API token against smotret-anime.ru |
| `search-anime` | invoke | Search anime by query |
| `get-anime` | invoke | Fetch anime details by ID |
| `get-anime-cache` | invoke | Read cached AnimeDetail for fast first paint (returns null if missing or older than 24h) |
| `get-episode` | invoke | Fetch episode translations (single episode) |
| `get-episodes-batch` | invoke | Bulk-fetch translations for a page of episodes in one request (collapses the per-episode cold-load waterfall, #155); caches each result, falls back to cached episodes on failure (via the shared `readCachedEpisodes` helper) |
| `get-episodes-batch-cached` | invoke | Cache-first read (#196): returns the already-cached translations for a page of episodes with no network, so the episode list paints instantly for previously-viewed anime; the renderer then background-refreshes via `get-episodes-batch` and patches. Shares `readCachedEpisodes` with the network-first fallback. Always `source: 'cache'`; empty `data` means nothing was cached |
| `probe-embed-quality` | invoke | Probe embed API for actual stream height |
| `report-quality-mismatch` | invoke | Report a detected quality mismatch (stored in memory) |
| `get-quality-mismatch-count` | invoke | Get number of collected mismatches |
| `dump-quality-mismatches` | invoke | Write mismatches to JSON file in download dir |
| `home:get-continue-watching` | invoke | Build merged Resume + Next-up list (capped at 24) for the Home view from local stores; no network |
| `library-get` | invoke | List all starred + downloaded anime (merged) |
| `library-toggle` | invoke | Add/remove from starred library |
| `library-has` | invoke | Check if anime is starred |
| `library-is-downloaded` | invoke | Check if anime has downloads |
| `library-get-status` | invoke | Batch check starred + downloaded status for multiple anime IDs |
| `downloaded-anime-add` | invoke | Mark anime as having downloads |
| `downloaded-anime-delete` | invoke | Remove anime + delete folder |
| `cleanup:get-size` | invoke | Sum bytes + file count for a show across hot+cold dirs (.mkv/.mp4/.ass/.srt) |
| `cleanup:get-active-downloads` | invoke | Count download groups still in flight for the given anime name |
| `cleanup:execute` | invoke | Delete the show's folder(s), drop its `downloadedAnime` + `downloadedEpisodes` entries, prune caches; preserves `library`/`watchProgress`/Shikimori rate |
| `cleanup:get-snoozed` | invoke | Return `Record<animeId, { animeName }>` of shows the user silenced from completion-cleanup prompts |
| `cleanup:set-snoozed` | invoke | Toggle a show's entry in `autoCleanupSnoozedAnimeIds` |
| `cleanup:prompt` | send | Broadcast when a Shikimori rate transitions to `completed` for a show with local files (and not snoozed); App.vue surfaces a toast |
| `downloaded-episodes-get` | invoke | Get translation metadata per episode (array of metas per episode, supports multiple translations) |
| `get-setting` | invoke | Read setting value |
| `set-setting` | invoke | Write setting value |
| `watch-progress:save` | invoke | Save playback position + optional watched flag + optional remembered translationId for an episode |
| `watch-progress:get` | invoke | Fetch saved progress for a single episode |
| `watch-progress:get-all` | invoke | Fetch all saved progress entries for an anime (keyed by episodeInt) |
| `download:enqueue` | invoke | Queue download requests + save episode metadata |
| `download:pause` | invoke | Pause a download |
| `download:resume` | invoke | Resume paused/failed download |
| `download:restart` | invoke | Restart from scratch (re-fetch embed URLs) |
| `download:cancel` | invoke | Cancel and cleanup download |
| `download:cancel-by-episode` | invoke | Cancel downloads for anime/episode |
| `download:cancel-merge` | invoke | Cancel active ffmpeg merge process |
| `download:get-queue` | invoke | Get episode groups |
| `download:clear-completed` | invoke | Remove cancelled/failed/merged/merge-failed/ready-for-merge groups; keeps mid-merge + crash-recovered |
| `download:merge` | invoke | Trigger ffmpeg merge for completed downloads |
| `download:scan-merge` | invoke | Scan folders and merge all unmerged files |
| `download:fix-metadata` | invoke | Re-mux MKVs to fix subtitle metadata |
| `download:pick-dir` | invoke | Open folder picker dialog |
| `download:progress` | send | Real-time download progress broadcast (500ms) |
| `scan-merge:progress` | send | Scan-merge per-file progress |
| `fix-metadata:progress` | send | Fix-metadata per-file progress |
| `download:pause-all` | invoke | Pause all downloading/queued items |
| `download:resume-all` | invoke | Resume all paused items |
| `download:restart-all-failed` | invoke | Restart all failed downloads (re-fetch URLs) |
| `ffmpeg:check` | invoke | Detect ffmpeg version + encoders |
| `ffmpeg:delete` | invoke | Delete downloaded ffmpeg/ffprobe binaries |
| `ffmpeg:download-progress` | send | FFmpeg/ffprobe download progress on first launch |
| `fpcalc:download-progress` | send | Chromaprint fpcalc download progress on first launch |
| `skip-detector:analyze-show` | invoke | Run Chromaprint fingerprinting + pairwise comparison for the given anime's downloaded episodes; persists per-episode OP/ED boundaries |
| `skip-detector:get-detections` | invoke | Returns cached `ShowSkipDetections` for an anime (or `null`) |
| `skip-detector:detect-stream` | invoke | Fingerprint the currently-playing remote stream on demand and return OP/ED ranges only when they confidently match the show's locally-derived signatures |
| `skip-detector:cancel-stream-detect` | invoke | Abort the caller's in-flight streamed skip detection request so ffmpeg/fpcalc workers do not continue after episode/player changes |
| `skip-detector:cancel` | invoke | Aborts an in-progress analysis (kills ffmpeg/fpcalc child processes) |
| `skip-detector:cache-stats` | invoke | Returns the current count of cached fingerprints across all shows |
| `skip-detector:analyze-progress` | send | Real-time analysis progress (`fingerprinting` / `comparing` / `done`, current/total) |
| `skip-detector:signature-updated` | send | Broadcast when an analysis (manual or background-triggered) completes; payload `{ animeId, perEpisode }` for open views to refresh without polling |
| `skip-detector:backfill-all` | invoke | Enqueue every downloaded show that has ≥2 episodes on disk and no cached signature; returns `{ queued, alreadyAnalyzed, skippedFewEpisodes, total }` so the UI can report what happened |
| `skip-detector:queue-status` | invoke | Snapshot `{ currentAnimeId, queueLength }` of the auto-analysis queue, polled by the Settings backfill control while a drain is in flight |
| `download:inject-chapters` | invoke | Manual per-anime: rewrite each merged MKV in place with OP/ED chapters (Intro/OP/Episode/ED/Outro) using the cached `skipDetections`. Triggers a fresh analysis if none exists. Returns `{ written, skipped, failed, total }` |
| `chapter-inject:progress` | send | Per-episode progress for `download:inject-chapters` (`analyzing` / `writing` / `done`, current/total) |
| `app:version` | invoke | Get app version from package.json |
| `update:check` | invoke | Check GitHub for newer version via electron-updater |
| `update:download` | invoke | Download available update |
| `update:install` | invoke | Quit and install downloaded update |
| `update:status` | send | Update check/download progress and status |
| `cache-get-poster` | invoke | Get base64-encoded cached poster for offline anime |
| `file:check-episodes` | invoke | Check which episodes exist on disk (session-cached, triggers background rescan on cache hit). Async first scan (#196): the first per-anime scan uses `fsPromises.readdir` off the main loop, deduped so concurrent misses share one scan; backed by `lib/episode-file-scan.ts` |
| `file:episodes-changed` | send | Background rescan detected file changes, pushes updated results to renderer |
| `file:open` | invoke | Open file with default app (verifies existence, returns error + invalidates cache if missing) |
| `file:show-in-folder` | invoke | Reveal file in explorer |
| `file:delete-episode` | invoke | Delete episode files for specific translation or all versions (invalidates file scan cache) |
| `shikimori:get-auth-url` | invoke | Get Shikimori OAuth authorize URL |
| `shikimori:exchange-code` | invoke | Exchange OAuth code for tokens, fetch user |
| `shikimori:logout` | invoke | Clear Shikimori credentials and user |
| `shikimori:get-user` | invoke | Get cached Shikimori user profile |
| `shikimori:get-profile` | invoke | Returns the cached `ShikimoriProfile` dashboard payload instantly (if available) + triggers a background refresh; first call fetches `/api/users/:id` stats and assembles it. `null` when logged out. Powers the ShikimoriView dashboard (#178) |
| `shikimori:profile-refreshed` | send | Profile dashboard payload re-assembled in background; ShikimoriView replaces its `profile` state |
| `shikimori:get-rate` | invoke | Fetch user's anime rate from Shikimori by MAL ID |
| `shikimori:update-rate` | invoke | Create or update user rate (episodes, status, score, rewatches); updates cached rates and broadcasts change |
| `shikimori:get-anime-rates` | invoke | Returns cached anime rates instantly (if available), triggers background API refresh; first call fetches from API |
| `shikimori:rate-updated` | send | Single rate entry changed (after update-rate); renderer views surgically update their local state |
| `shikimori:rates-refreshed` | send | Full rate list refreshed from API in background; renderer views replace their entries |
| `shikimori:anime-details-updated` | send | Single anime details payload cached/refreshed by prefetch worker; AnimeDetailView hydrates `shikiDetails` for the matching MAL ID |
| `shikimori:get-offline-queue-length` | invoke | Returns the number of rate updates currently queued for later sync (for initial UI hydration) |
| `shikimori:offline-queue-changed` | send | Queue length changed; renderers update the "Working offline" indicator |
| `shikimori:get-sync-status` | invoke | Returns `{ state, queueLength, lastSyncAt, lastSyncError }` for initial UI hydration of the sync indicator |
| `shikimori:trigger-sync` | invoke | Manually kicks off a drain attempt (fire-and-forget); powers the "Retry now" button |
| `shikimori:sync-status` | send | Sync worker state changed (idle ↔ syncing) or a drain just finished; renderers swap offline/syncing chip variants |
| `shikimori:get-anime-details` | invoke | Returns cached `ShikiAnimeDetails` for a MAL ID (or `null`); on cache miss fires the prefetch worker without blocking |
| `shikimori:trigger-detail-prefetch` | invoke | Manually kicks the detail prefetch worker (fire-and-forget) |
| `shikimori:get-friends` | invoke | Returns the cached `ShikiFriendCard[]` (friend list + presence + per-friend titles/mean/mutual + current watch) instantly (if available) + triggers a background refresh; first call fetches per-friend rates (batched, concurrency 2). `null` when logged out. Powers the Friends grid (#179) |
| `shikimori:friends-refreshed` | send | Friend cards re-assembled in background; FriendsView replaces its grid |
| `shikimori:get-friends-activity` | invoke | Fetch recent anime history for all Shikimori friends, merged + sorted, MAL IDs resolved |
| `shikimori:get-calendar` | invoke | Fetch Shikimori `/api/calendar`, filter to MAL IDs the user tracks as `watching`/`rewatching`/`planned`, resolve each via `lookupByMalIds`. 5-min in-memory main-side cache invalidated on `shikimori:rate-updated`/`shikimori:rates-refreshed`/logout. Optional `force` flag bypasses the cache |
| `shikimori:get-related` | invoke | Fetch franchise chronology for an anime via `/api/animes/:id/franchise`, resolve each related MAL ID to a smotret-anime entry |
| `auto-dl:get-subscription` | invoke | Get the auto-download subscription for a smotret-anime ID, or `null` |
| `auto-dl:set-subscription` | invoke | Toggle auto-download for a show. On enable, stamps `lastEnqueuedEpisodeInt` to the current `episodes_aired` (forward-only) and kicks a manual tick |
| `auto-dl:list-subscriptions` | invoke | List all current auto-download subscriptions |
| `auto-dl:trigger` | invoke | Run an auto-download tick now (manual reason) and return the result |
| `auto-dl:get-status` | invoke | Returns `{ lastResult, locked, enabled }` for the auto-downloader |
| `auto-dl:get-enabled` / `auto-dl:set-enabled` | invoke | Read/write the global master toggle |
| `auto-dl:tick-result` | send | Broadcast after each tick: `{ ranAt, reason, enqueued, skipped, errors, details }` |
| `auto-dl:enqueued` | send | Broadcast each time the tick enqueues an episode: `{ animeId, episodeInt, animeName }` |
| `storage:pick-hot-dir` | invoke | Open folder picker for hot storage directory |
| `storage:pick-cold-dir` | invoke | Open folder picker for cold storage directory |
| `storage:move-to-cold` | invoke | Move all finished files from hot to cold storage |
| `storage:move-to-cold-progress` | send | Progress broadcast for move operation |
| `player:get-stream-url` | invoke | Fetch CDN stream URL + raw ASS subtitle content + all available stream qualities for a translation |
| `player:get-local-subtitles` | invoke | Read local .ass file alongside video, return raw ASS content |
| `player:find-local-file` | invoke | Find local file path for a translation by animeName/episodeInt/translationId. Renderer also passes the friendly `episodeLabel` so any non-faststart sample recorded from this path uses the same labeling as the download path |
| `player:remux-mkv` | invoke | Legacy: remux MKV→MP4 via ffmpeg stream copy, await completion before returning (used as fallback when codecs aren't MSE-compatible) |
| `player:remux-mkv-stream` | invoke | ffprobe MKV + start fragmented-MP4 pipe from ffmpeg; returns `{ sessionId, duration, mimeType, hasSubtitlesPending, initialSeek }` (where `initialSeek` is the run's measured `sourceBuffer.timestampOffset`, see `docs/player.md`) for MSE consumption. Short-circuits to `{ requiresTranscode: true }` — before spawning anything — when the file is HEVC and `hevcTranscodeOnPlay` is `always` |
| `player:remux-mkv-stream-transcode` | invoke | Same as `player:remux-mkv-stream` but re-encodes video to H.264 (and audio to AAC when not already AAC) for platforms with no HEVC decoder |
| `player:stream-chunk` | event (main→renderer) | Fragmented-MP4 bytes from an active session, appended into the renderer's `SourceBuffer` |
| `player:stream-end` | event (main→renderer) | ffmpeg finished writing; renderer calls `mediaSource.endOfStream()` after draining its queue |
| `player:stream-error` | event (main→renderer) | ffmpeg exited non-zero or spawn failed; renderer falls back to legacy remux |
| `player:stream-ack` | invoke | Renderer reports bytes it has consumed from the session; main resumes ffmpeg stdout once pending bytes drop below the low watermark |
| `player:stream-subtitles` | event (main→renderer) | Subtitle `.ass` content extracted from an MKV stream session, pushed when extraction finishes |
| `player:cleanup-remux` | invoke | Kill any active stream sessions and delete all temp remuxed files |
| `shell:open-external` | invoke | Open URL in default browser (returns success boolean) |
| `shell:open-external-file` | invoke | Open a local file with the OS default app via `shell.openPath` (returns `{ ok, error? }`) |
| `syncplay:connect` | invoke | Open a TLS-only Syncplay connection with supplied `{host, port, room, username, password?, autoReconnect}` (TCP → STARTTLS probe → TLS handshake → `Hello`; aborts if the server refuses TLS or fails cert validation) and persist the session intent |
| `syncplay:disconnect` | invoke | Close the active Syncplay connection (cancels any pending auto-reconnect) |
| `syncplay:set-file` | invoke | Announce the currently-playing file to the room as `{canonicalName, duration, features.animeDlAppMeta:{animeId, malId, episodeInt, translationId}}` |
| `syncplay:local-state` | invoke | Emit a `State` message on a discrete local event (`play` / `pause` / `seek`); increments the client-side `ignoringOnTheFly` counter |
| `syncplay:local-snapshot` | invoke | Renderer pushes `{position, paused}` every ~1 s so main's heartbeat carries fresh position without wiring `timeupdate` across IPC |
| `syncplay:set-ready` | invoke | Send `Set: {ready: {isReady, manuallyInitiated:false}}` — flips buffering state so peers pause until everyone's ready |
| `syncplay:get-status` | invoke | Return the current `{state, host, port, room, username, tls, error?}` for initial hydration |
| `syncplay:connection-status` | send | State machine transitions (`idle` → `connecting` → `hello-sent` → `ready` → `reconnecting`/`disconnected`) |
| `syncplay:remote-state` | send | Remote `play`/`pause`/`seek` resolved to `{paused, position, setBy, doSeek}` with RTT-compensated position, after the `ignoringOnTheFly` counter round-trips |
| `syncplay:room-users` | send | Current room member list with each member's advertised file info and `animeDlAppMeta` (if available) |
| `syncplay:room-event` | send | Info/warn/error/chat messages rendered as a toast in the player (join/leave/chat/disconnect) |
| `syncplay:remote-episode-change` | send | Another room member (same anime) switched to a different episode; PlayerView auto-navigates via `goToEpisode` |
| `debug:get-mp4-stats` | invoke | Returns the persisted `mp4StreamingStats` snapshot (totals + recent non-faststart samples) for the Settings > Debug panel |
| `debug:get-player-diag-log` | invoke | Returns `{ path, exists }` for `userData/player-diag.log` (written while `playerDiagLogging` is on) so the Settings > Debug panel can surface and open it |
| `debug:reset-mp4-stats` | invoke | Zeroes `mp4StreamingStats` and clears the in-session de-duplication set so re-opening previously-checked files re-probes them |
