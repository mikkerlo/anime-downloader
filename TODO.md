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

## ~~2. Shikimori Integration — OAuth + Episode Tracking~~

**Priority:** High | **Effort:** Large

Integrate with [Shikimori](https://shikimori.one) anime list service so users can update their watch status and episode progress directly from the app. Uses OAuth 2.0 for auth. Shikimori uses MAL (MyAnimeList) IDs — the smotret-anime API exposes `myAnimeListId` on series objects, which serves as the shared key.

API docs: https://shikimori.io/api/doc

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

---

## 3. Custom Dark Scrollbar Styling

**Priority:** Medium | **Effort:** Small

The app uses default Chromium scrollbars which look jarring against the dark theme. Add thin, minimal custom scrollbar styles that blend with the existing color palette.

**Plan:**

### Global scrollbar styles

1. Add `::-webkit-scrollbar` rules to the global `<style>` block in `src/renderer/src/App.vue` (after the `body` rule ~line 150):
   - `::-webkit-scrollbar` — width: 8px, height: 8px (for horizontal)
   - `::-webkit-scrollbar-track` — background: `#1a1a2e` (matches body background)
   - `::-webkit-scrollbar-thumb` — background: `#2a2a4a`, border-radius: 4px
   - `::-webkit-scrollbar-thumb:hover` — background: `#3a3a5a`
   - `::-webkit-scrollbar-corner` — background: `#1a1a2e` (where horizontal and vertical meet)

### Scrollable areas affected

These components have `overflow-y: auto` and will inherit the global scrollbar:

- `src/renderer/src/components/SearchView.vue` — search results grid (~line 159)
- `src/renderer/src/components/AnimeDetailView.vue` — episode list (~line 797), left panel (~line 866)
- `src/renderer/src/components/DownloadsView.vue` — download queue list (~line 295)
- `src/renderer/src/components/SettingsView.vue` — settings content area (~line 780)
- `src/renderer/src/components/LibraryView.vue` — library grid (~line 97)

No per-component changes needed — global `::-webkit-scrollbar` in an unscoped `<style>` block applies everywhere.

### Dropdowns and selects

2. Also style `select` element scrollbars if needed — Chromium `<select>` dropdowns use OS-native rendering and won't be affected by `::-webkit-scrollbar`, so no action required there.

---

## 4. Shikimori Anime List — Browse & Sync Your Watchlist

**Priority:** Medium | **Effort:** Large

Phase 2 of Shikimori integration. Fetch the user's anime list from Shikimori and display it in a dedicated sidebar tab. Users can browse their planned/watching/on_hold/completed/dropped anime, see episode progress vs aired/total, and click through to the anime detail view for downloading. Shikimori anime are resolved to smotret-anime entries via batch MAL ID lookup (`GET /api/series?myAnimeListId[]=...`).

**Plan:**

### Shikimori API client additions

1. Add `getUserAnimeRates()` to `src/main/shikimori.ts`:
   - `GET /api/users/${userId}/anime_rates?status=${status}&limit=5000&censored=true`
   - Returns array of rate objects with nested `anime` (id, name, russian, image, episodes, episodes_aired, kind, status)
   - Add new types: `ShikiAnimeRate` (extends `ShikiUserRate` with nested `anime` object), `ShikiAnimeInfo` (id, name, russian, image urls, episodes, episodes_aired, kind, score, status, aired_on, released_on)
   - Support optional `status` filter param; when omitted, fetch all statuses
   - Respect rate limits (already handled by `shikiFetch` retry-on-429)

### MAL ID → smotret-anime resolution

2. Add batch MAL ID lookup in `src/main/index.ts`:
   - New function `lookupByMalIds(malIds: number[]): Promise<Map<number, AnimeSearchResult>>` 
   - Calls `GET /api/series?myAnimeListId[]=${id1}&myAnimeListId[]=${id2}&...&fields=id,title,titles,posterUrlSmall,numberOfEpisodes,type,typeTitle,year,season,myAnimeListId`
   - Batch in groups of 50 to avoid URL length limits
   - Returns a Map of MAL ID → `AnimeSearchResult` (with smotret-anime ID)
   - Cache results in `electron-store` under a new `malIdMap` setting (persistent across sessions) to avoid repeated lookups

### IPC handlers (4-file pattern)

3. Add new IPC handlers in `src/main/index.ts`:
   - `shikimori:get-anime-rates` — invoke(status?: string): fetch user's anime rates from Shikimori, resolve MAL IDs to smotret-anime entries via batch lookup, return merged results
   - Return type: `ShikiAnimeListEntry[]` — combines Shikimori rate data (status, episodes watched, score, updated_at) with smotret-anime data (id, title, poster, total episodes) where available
   - Update `src/preload/index.ts` and `src/preload/index.d.ts` with new method and types

### New ShikimoriView component

4. Create `src/renderer/src/components/ShikimoriView.vue`:
   - Only accessible when logged into Shikimori (sidebar item hidden/disabled otherwise)
   - Top bar with status filter dropdown: All / Planned / Watching / Rewatching / Completed / On Hold / Dropped
   - Anime grid using existing `AnimeCard` component (same layout as Library/Search)
   - Each card shows Shikimori episode progress badge: "5/12 ep" or "0/? ep" for unknown total
   - Sort by `updated_at` descending (recently changed first) — addresses "recently changed anime with unwatched episodes"
   - Optional indicator for anime with unwatched episodes (episodes_aired > user's episodes watched)
   - Click card → emit `openAnime(smotretAnimeId)` to navigate to `AnimeDetailView` (same as Library/Search)
   - For entries without a smotret-anime match: show with Shikimori poster, click shows a message that the anime isn't available on smotret-anime
   - Loading state while fetching rates + resolving MAL IDs
   - Refresh button to re-fetch from Shikimori

### Sidebar changes

5. Add "Shikimori" menu item in `src/renderer/src/components/Sidebar.vue`:
   - Insert between Library and Settings in the `menuItems` array
   - Use a suitable icon (e.g. a list/bookmark icon)
   - Conditionally show/hide based on whether user is logged into Shikimori (requires passing login state as prop or checking on mount)

### App.vue navigation

6. Update `src/renderer/src/App.vue`:
   - Add `'shikimori'` to the view routing logic
   - Add `ShikimoriView` component import and conditional rendering
   - Track per-view anime selection for the shikimori view (like search/library)

### Types

7. Add shared types to `src/preload/index.d.ts`:
   ```typescript
   interface ShikiAnimeInfo {
     id: number          // Shikimori/MAL ID
     name: string        // English/romaji title
     russian: string     // Russian title
     image: { original: string; preview: string; x96: string; x48: string }
     episodes: number    // total episodes
     episodes_aired: number
     kind: string        // tv, movie, ova, etc.
     score: string
     status: string      // released, ongoing, anons
   }

   interface ShikiAnimeListEntry {
     rate: ShikiUserRate          // user's rate (status, episodes, score)
     shikiAnime: ShikiAnimeInfo   // anime info from Shikimori
     smotretAnime?: AnimeSearchResult  // resolved smotret-anime entry (null if not found)
     updatedAt: string            // ISO date for sorting
   }
   ```

### Settings

8. Add new setting to `electron-store` defaults in `src/main/index.ts`:
   - `malIdMap`: `object` (default `{}`) — persistent cache of MAL ID → smotret-anime ID+title for faster subsequent loads

### Edge cases & gotchas

- The smotret-anime batch lookup `GET /api/series?myAnimeListId[]=...` supports multiple IDs but may have URL length limits — batch in groups of ~50
- Not all Shikimori anime will exist on smotret-anime — show these with Shikimori poster and a "not available" indicator
- Users with large lists (1000+ entries): the Shikimori API supports `limit=5000` so a single request should suffice for most users; show loading indicator
- `episodes_aired` from Shikimori can be used to detect unwatched episodes (`episodes_aired > rate.episodes`)
- The `malIdMap` cache should be updated when the user visits AnimeDetailView too (anime with `myAnimeListId` can be cached proactively)
- Sidebar visibility: either pass `shikiUser` as a prop to Sidebar, or have Sidebar call `shikimoriGetUser()` on mount
- Token expiry: `ensureFreshToken()` is already called before API requests in the existing handlers — follow the same pattern
