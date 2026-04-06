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

---

## 1. Advanced File Management — Hot/Cold Storage

**Priority:** Medium | **Effort:** Large

Support two storage paths: a "hot" path (for active downloads, in-progress merges) and a "cold" path (for finished media). In simple mode (default), behavior is unchanged — one download dir. In advanced mode, downloads land in hot storage and finished files are moved to cold storage either automatically or on demand.

**Plan:**

### Settings changes

1. Add new settings to `electron-store` defaults in `src/main/index.ts`:
   - `storageMode`: `'simple' | 'advanced'` (default `'simple'`)
   - `hotStorageDir`: `string` (default `''`, falls back to current `downloadDir` / `Downloads/anime-dl`)
   - `coldStorageDir`: `string` (default `''`, must be set when advanced mode is enabled)
   - `autoMoveToCold`: `boolean` (default `false`) — auto-move after final step completes
   - Keep existing `downloadDir` as the simple-mode path; in advanced mode, `hotStorageDir` replaces it

2. Add a new **"Storage"** tab in `src/renderer/src/components/SettingsView.vue` (between General and Merging):
   - Mode toggle: Simple / Advanced
   - In simple mode: show single download directory picker (moved from General tab)
   - In advanced mode: show hot storage dir picker, cold storage dir picker, auto-move toggle, "Move all to cold storage" button
   - Remove download directory from General tab

3. IPC changes (4-file pattern: `main/index.ts`, `preload/index.ts`, `preload/index.d.ts`, component):
   - `storage:move-to-cold` — invoke: move all finished files from hot to cold storage
   - `storage:move-to-cold-progress` — send: progress callback (current/total files)

### Main process changes

4. Update `getDownloadDir()` in `src/main/index.ts`:
   - In simple mode: return `downloadDir` (unchanged)
   - In advanced mode: return `hotStorageDir` (this is where downloads land)
   - Add `getColdStorageDir()` helper for advanced mode

5. Add `moveFilesToColdStorage()` function in `src/main/index.ts`:
   - Scan hot storage for finished files (.mkv, .mp4, .ass — no .part files)
   - Move each file to matching anime subfolder in cold storage (create if needed)
   - Use `fs.rename` (same filesystem) with `fs.copyFile` + `fs.unlink` fallback (cross-filesystem)
   - Broadcast progress via `storage:move-to-cold-progress`

6. Wire auto-move: in `DownloadManager` callbacks (`onEpisodeComplete`, `onMergeComplete`):
   - If `storageMode === 'advanced'` and `autoMoveToCold === true`:
     - If merge is enabled (`autoMerge`): move after merge completes
     - If merge is disabled: move after download completes
   - Move only the specific episode's files, not everything

7. Update `DownloadManager.setDownloadDir()` — when storage mode changes, update the download dir to point to hot storage

### File scanning changes

8. Update `file:check-episodes` handler in `src/main/index.ts`:
   - In advanced mode, check **both** hot and cold storage dirs
   - Prefer cold storage result if file exists in both (cold = final location)
   - Return the actual `filePath` so open/show-in-folder works regardless of location

9. Update `file:delete-episode` handler:
   - In advanced mode, delete from **both** hot and cold storage

10. Update `downloaded-anime-delete` handler:
    - In advanced mode, delete anime folder from **both** hot and cold storage

11. Update `scanAndMerge` in `src/main/download-manager.ts`:
    - In advanced mode, scan both hot and cold dirs for unmerged .mp4 files

### Edge cases & gotchas

- Cross-filesystem moves (hot on SSD, cold on HDD): `fs.rename` will fail, need copy+delete fallback
- Switching from advanced to simple mode: leave files where they are, just stop scanning cold path
- Cold storage dir validation: warn if same as hot dir, warn if not set when enabling advanced mode
- In-progress downloads (.part files) must never be moved to cold storage
- The `download:pick-dir` handler currently sets `downloadDir` + calls `setDownloadDir()` — in advanced mode, need separate pickers for hot/cold that set the correct setting key

---

## 2. Shikimori Integration — OAuth + Episode Tracking

**Priority:** High | **Effort:** Large

Integrate with [Shikimori](https://shikimori.one) anime list service so users can update their watch status and episode progress directly from the app. Uses OAuth 2.0 for auth. Shikimori uses MAL (MyAnimeList) IDs — the smotret-anime API exposes `myAnimeListId` on series objects, which serves as the shared key.

This is the first phase: API client module, OAuth flow, and manual episode/status updates from AnimeDetailView. Auto-sync on download/open can be added later.

**Plan:**

### Shikimori API client

1. Create `src/main/shikimori.ts` — standalone module with all Shikimori API methods:
   - Types: `ShikiCredentials`, `ShikiUser`, `ShikiUserRate`, `ShikiUserRateStatus`
   - `getAuthUrl(clientId, redirectUri)` — build OAuth authorize URL
   - `exchangeCode(clientId, clientSecret, code, redirectUri)` → `ShikiCredentials`
   - `refreshToken(clientId, clientSecret, refreshToken)` → `ShikiCredentials`
   - `ensureFreshToken(store)` — check `created_at + expires_in > now`, refresh if expired
   - `getUser(accessToken)` → `ShikiUser` (GET `/api/users/whoami`)
   - `getAnimeRate(accessToken, malId)` → `ShikiUserRate | null` (GET `/api/animes/{malId}`, extract `user_rate`)
   - `createUserRate(accessToken, userId, malId, episodes, status)` → `ShikiUserRate`
   - `updateUserRate(accessToken, userRateId, episodes, status)` → `ShikiUserRate`
   - All methods throw a typed `ShikiApiError` with status code on failure
   - Hardcode `client_id` and `client_secret` in the module (shipped with the app)

### OAuth flow

2. Implement OAuth login in main process (`src/main/index.ts`):
   - Register a custom protocol handler (`anime-dl://`) for the OAuth redirect URI
   - On `shikimori:login` IPC: open Shikimori authorize URL in external browser via `shell.openExternal`
   - On protocol callback: extract `code` param, exchange for tokens, store credentials
   - On `shikimori:logout` IPC: clear stored credentials and user info

3. Add new settings to `electron-store` defaults in `src/main/index.ts`:
   - `shikimoriCredentials`: `ShikiCredentials | null` (default `null`) — OAuth tokens
   - `shikimoriUser`: `ShikiUser | null` (default `null`) — cached user profile (id, nickname, avatar)

### Fetching MAL ID from smotret-anime

4. Extend the `get-anime` API call to request `myAnimeListId` from smotret-anime:
   - Update `apiRequest` call in `get-anime` handler to include `myAnimeListId` in response
   - Add `myAnimeListId?: number` to `AnimeDetail` interface in `src/main/index.ts` and `src/preload/index.d.ts`
   - Cache `myAnimeListId` in the anime cache entry

### IPC handlers (4-file pattern)

5. Add new IPC handlers in `src/main/index.ts`:
   - `shikimori:login` — invoke: start OAuth flow (open browser)
   - `shikimori:logout` — invoke: clear credentials
   - `shikimori:get-user` — invoke: return cached `ShikiUser | null`
   - `shikimori:get-rate` — invoke(malId): fetch user's rate for anime from Shikimori
   - `shikimori:update-rate` — invoke(malId, episodes, status): create or update user rate
   - Update `src/preload/index.ts` and `src/preload/index.d.ts` with all new methods

### UI — Settings tab

6. Add Shikimori section in `src/renderer/src/components/SettingsView.vue` (General tab):
   - Not logged in: "Connect Shikimori" button → triggers `shikimori:login`
   - Logged in: show avatar + nickname + "Disconnect" button
   - Status indicator: connected / not connected

### UI — AnimeDetailView

7. Add Shikimori panel in `src/renderer/src/components/AnimeDetailView.vue`:
   - Only visible when user is logged into Shikimori AND anime has a `myAnimeListId`
   - Show current status from Shikimori (planned/watching/completed/on_hold/dropped) as a dropdown
   - Show watched episode count as an editable number input (0 to totalEpisodes)
   - "Save to Shikimori" button to push changes (or auto-save with debounce)
   - On mount: fetch rate from Shikimori via `shikimori:get-rate(myAnimeListId)`
   - Link to anime page on Shikimori: `https://shikimori.one/animes/{malId}`
   - Status update logic: if current status is `completed`, changing episodes sets status to `rewatching`; if status is not `watching`/`rewatching`, set to `watching`

### Edge cases & gotchas

- Token refresh: tokens expire in 24h — `ensureFreshToken()` must be called before every API request
- Custom protocol registration: use `app.setAsDefaultProtocolClient('anime-dl')` in main process; handle deep link on macOS (`open-url` event) and Windows/Linux (second-instance args)
- Not all anime on smotret-anime have a `myAnimeListId` — gracefully hide Shikimori panel when missing
- Rate limiting: Shikimori has rate limits (5 req/sec, 90 req/min) — add basic retry-after handling
- Cross-platform protocol handling differs: macOS uses `open-url` event, Windows/Linux parse argv in `second-instance` event
