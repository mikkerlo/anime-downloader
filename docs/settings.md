# Settings (electron-store)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `token` | string | `''` | smotret-anime.ru API token |
| `translationType` | string | `'subRu'` | Default translation filter |
| `downloadDir` | string | `''` | Custom download path (falls back to Downloads/anime-dl) |
| `library` | object | `{}` | Map of starred anime by ID |
| `autoMerge` | boolean | `false` | Auto-merge when episode downloads complete |
| `videoCodec` | string | `'copy'` | FFmpeg video codec for merge |
| `downloadedAnime` | object | `{}` | Map of anime with downloaded files |
| `downloadedEpisodes` | object | `{}` | Per-episode translation metadata (key: `animeId:episodeInt`) |
| `animeCache` | object | `{}` | Offline cache: anime details, episodes, quality probes, posters |
| `lastUpdateCheck` | number | `0` | Timestamp of last successful update check |
| `notificationMode` | string | `'off'` | Desktop notification mode: `off`, `each` (per episode), `queue` (when queue empties) |
| `downloadSpeedLimit` | number | `0` | Download speed limit in bytes/sec (0 = unlimited), shared across active downloads |
| `concurrentDownloads` | number | `2` | Max simultaneous downloads (1–3) |
| `keyboardShortcuts` | object | `{back:'Escape', focusSearch:'CmdOrCtrl+F', goDownloads:'CmdOrCtrl+D', playerPrevEpisode:'Shift+ArrowLeft', playerNextEpisode:'Shift+ArrowRight', shaderModeA:'CmdOrCtrl+1', shaderModeB:'CmdOrCtrl+2', shaderModeC:'CmdOrCtrl+3', shaderOff:'CmdOrCtrl+0'}` | Configurable keyboard shortcut bindings |
| `shikimoriCredentials` | object\|null | `null` | Shikimori OAuth tokens (access_token, refresh_token, created_at, expires_in) |
| `shikimoriUser` | object\|null | `null` | Cached Shikimori user profile (id, nickname, avatar) |
| `storageMode` | string | `'simple'` | Storage mode: `simple` (single dir) or `advanced` (hot/cold split) |
| `hotStorageDir` | string | `''` | Hot storage path for active downloads (advanced mode) |
| `coldStorageDir` | string | `''` | Cold storage path for finished files (advanced mode) |
| `autoMoveToCold` | boolean | `false` | Auto-move finished files to cold storage |
| `malIdMap` | object | `{}` | Persistent cache of MAL ID → smotret-anime entry for Shikimori list resolution |
| `playerMode` | string | `'system'` | Default player: `system` (OS default) or `builtin` (in-app HTML5 player) |
| `anime4kPreset` | string | `'off'` | Anime4K shader preset: `off`, `mode-a` (1080p), `mode-b` (720p), `mode-c` (480p) |
| `hevcTranscodeOnPlay` | string | `'ask'` | HEVC fallback when the built-in player has no decoder: `ask` (show modal), `always` (transcode to H.264), `never` (open in external player) |
| `prefetchNextEpisode` | string | `'progress-50'` | Trigger for the player's next-episode pre-fetch: `off`, `open` (on player open), `time-5min` (after 5 min of real playback), `progress-50` (at 50% of duration). Skipped silently when the next episode is already on disk, in the queue, or — for auto-download-subscribed shows — strictly newer than the subscription's frozen `initialEpisodesAired` snapshot (so older/pre-subscription episodes still pre-fetch) |
| `watchProgress` | object | `{}` | Per-episode playback position + watched flag + last-used translationId (key: `animeId:episodeInt`) |
| `shikimoriUserRates` | array | `[]` | Cached Shikimori anime rate entries (served cache-first, background-refreshed) |
| `shikimoriUpdateQueue` | array | `[]` | Pending rate updates queued when the `update-rate` IPC failed due to a network error (for later sync) |
| `shikimoriAnimeDetails` | object | `{}` | Pre-fetched per-anime Shikimori details (description, genres, studios) keyed by MAL ID; populated by the throttled background worker |
| `skipDetections` | object | `{}` | Per-anime OP/ED boundaries from local Chromaprint analysis, keyed by `animeId`; `algorithm.source` is always `'local'` |
| `skipFingerprintCache` | object | `{}` | Per-file Chromaprint fingerprint cache, keyed by `animeId:episodeInt:fileSize:mtime` |
| `enableLocalSkipDetection` | boolean | `true` | Run Chromaprint OP/ED detection in the background after each download/merge completes; turn off to disable background CPU usage |
| `calendarView` | string | `'week'` | Default time range for the Airing Calendar tab: `week` (1×7 grid) or `month` (4×7 grid). Toggle in Settings > General |
| `syncplay` | object | `{ lastHost:'syncplay.pl', lastPort:8999, lastRoom:'', username:'', autoReconnect:true }` | Watch Together session intent (host/port/room/username + auto-reconnect toggle; TLS is always on). The connection itself is NOT persisted — users must rejoin after restart |
| `mp4StreamingStats` | object | `{ totalChecked:0, faststartCount:0, nonFaststartSamples:[] }` | Telemetry from the MP4 faststart probe: total files scanned, count that had `moov` before `mdat`, and up to 10 most-recent non-faststart samples (anime + episode + path + first non-`ftyp` box). Surfaced in Settings > Debug |
| `autoDownloadSubscriptions` | object | `{}` | Per-show auto-download subscriptions keyed by smotret-anime ID. Each entry: `{ animeId, malId, animeName, subscribedAt, lastEnqueuedEpisodeInt, lastCheckedAt }`. `lastEnqueuedEpisodeInt` is stamped to current `episodes_aired` at subscribe time so newly-subscribed shows never backfill |
| `autoDownloadEnabled` | boolean | `true` | Master toggle that gates the auto-download worker. When false, all ticks become no-ops; subscriptions are preserved |
| `autoCleanupSnoozedAnimeIds` | object | `{}` | Map of smotret-anime IDs (as strings) the user silenced from the Shikimori-completion cleanup prompt via "Don't ask for this show". Settings > Storage > Cleanup prompts manages the list |
| `dismissedContinueWatching` | array | `[]` | Keys (`animeId:episodeInt`) of Home continue-watching cards the user dismissed with the hover × . Persists across restarts; a card resurfaces once progress advances it to a newer episode whose key was never dismissed (#170) |
