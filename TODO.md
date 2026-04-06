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

---

## 1. Shikimori Anime List — Browse & Sync Your Watchlist

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

---

## 2. Built-in Video Player with Anime4K Shaders

**Priority:** Low | **Effort:** Large

Add an integrated video player powered by mpv (spawned as a subprocess) with support for Anime4K real-time upscaling shaders. Currently, "Open" uses `shell.openPath()` which launches the system default player with no shader support. The new player spawns mpv in a separate window, controlled via JSON IPC (`node-mpv`), with Anime4K GLSL shaders auto-downloaded from GitHub and configurable presets for different source resolutions.

**Plan:**

### mpv binary auto-download

1. Create `src/main/mpv-manager.ts` — module for mpv binary management (modeled after ffbinaries pattern in `src/main/index.ts` ~line 229):
   - `getMpvPath(): string | null` — check if mpv exists in userData or on system PATH
   - `downloadMpv(onProgress)` — download portable mpv binary to userData:
     - **Windows:** Download from SourceForge `mpv-player-windows` project (7z archive, ~30MB), extract `mpv.exe`
     - **Linux:** Download from mpv.io or GitHub builds (tar.gz), extract `mpv` binary; fallback to system `mpv` if installed via package manager
     - **macOS:** Download from mpv.io (tar.gz with mpv.app bundle), extract binary; fallback to Homebrew `mpv`
   - `deleteMpv()` — remove downloaded mpv binary (for re-download)
   - Store mpv binary in `app.getPath('userData')/mpv/` alongside ffmpeg binaries
   - Broadcast download progress via IPC (same pattern as `ffmpeg:download-progress`)

### Anime4K shader auto-download

2. Add shader management to `src/main/mpv-manager.ts`:
   - `getShadersPath(): string | null` — check if Anime4K shaders exist in userData
   - `downloadShaders(onProgress)` — download latest Anime4K release from `https://github.com/bloc97/Anime4K/releases`:
     - Use GitHub API `GET /repos/bloc97/Anime4K/releases/latest` to find the download URL
     - Download the GLSL zip asset, extract `.glsl` files to `userData/anime4k-shaders/`
   - `deleteShaders()` — remove downloaded shaders
   - `getShaderVersion(): string | null` — read cached version tag for display in Settings
   - Store shader version in electron-store setting `anime4kVersion`

### Shader presets

3. Define preset shader chains in `src/main/mpv-manager.ts`:
   - **Mode A (HQ):** Optimized for 1080p source — `Anime4K_Clamp_Highlights.glsl;Anime4K_Restore_CNN_VL.glsl;Anime4K_Upscale_CNN_x2_VL.glsl;Anime4K_AutoDownscalePre_x2.glsl;Anime4K_AutoDownscalePre_x4.glsl;Anime4K_Upscale_CNN_x2_M.glsl`
   - **Mode B:** Optimized for 720p source — `Anime4K_Clamp_Highlights.glsl;Anime4K_Restore_CNN_Soft_VL.glsl;Anime4K_Upscale_CNN_x2_VL.glsl;Anime4K_AutoDownscalePre_x2.glsl;Anime4K_AutoDownscalePre_x4.glsl;Anime4K_Upscale_CNN_x2_M.glsl`
   - **Mode C:** Optimized for 480p source — `Anime4K_Clamp_Highlights.glsl;Anime4K_Upscale_Denoise_CNN_x2_VL.glsl;Anime4K_AutoDownscalePre_x2.glsl;Anime4K_AutoDownscalePre_x4.glsl;Anime4K_Upscale_CNN_x2_L.glsl`
   - **Off:** No shaders
   - On Linux/macOS, replace `;` with `:` in shader path separators (mpv convention)

### node-mpv integration

4. Add `node-mpv` dependency (`npm install node-mpv`):
   - Create `src/main/player.ts` — player controller module:
     - `launchPlayer(filePath, options)` — spawn mpv via node-mpv with:
       - `--glsl-shaders=<shader-chain>` based on selected preset
       - `--hwdec=auto` for hardware decoding
       - `--force-window=yes`
       - `--title=<anime name> - <episode>`
       - Binary path from `getMpvPath()`
     - `isPlaying(): boolean` — check if mpv instance is alive
     - `quit()` — close mpv instance
     - `getProperty(name)` / `setProperty(name, value)` — proxy to node-mpv
     - Expose events: `timepos` (current position), `eof` (playback ended), `error`
   - Handle mpv process lifecycle: clean up on app quit, handle unexpected exits

### IPC handlers (4-file pattern)

5. Add new IPC handlers in `src/main/index.ts`:
   - `mpv:check` — invoke: check if mpv is available (downloaded or on PATH), return version string or null
   - `mpv:download` — invoke: trigger mpv binary download
   - `mpv:download-progress` — send: mpv download progress broadcast
   - `mpv:delete` — invoke: delete downloaded mpv binary
   - `mpv:play` — invoke(filePath, options): launch mpv with file and shader preset
   - `mpv:stop` — invoke: stop current playback
   - `mpv:get-status` — invoke: return playback state (playing/paused/stopped, position, duration)
   - `anime4k:check` — invoke: check if shaders are downloaded, return version or null
   - `anime4k:download` — invoke: trigger shader download from GitHub
   - `anime4k:download-progress` — send: shader download progress
   - `anime4k:delete` — invoke: delete downloaded shaders
   - Update `src/preload/index.ts` and `src/preload/index.d.ts` with all new methods

### Settings — Player tab

6. Add new **"Player"** tab in `src/renderer/src/components/SettingsView.vue` (between General and Merging):
   - **mpv status:** "mpv found (v0.38)" / "mpv not found" with Download/Delete buttons (same pattern as ffmpeg in Debug tab)
   - **Anime4K shaders:** "Shaders v4.0.1 installed" / "Not installed" with Download/Delete/Update buttons
   - **Shader preset:** dropdown — Off / Mode A (1080p) / Mode B (720p) / Mode C (480p)
   - **Hardware decoding:** toggle (default on) — `--hwdec=auto` vs `--hwdec=no`
   - **Default behavior:** dropdown — "Use built-in player" / "Use system default player" (controls what "Open" button does)

### Settings (electron-store)

7. Add new settings to `electron-store` defaults in `src/main/index.ts`:
   - `playerMode`: `'mpv' | 'system'` (default `'system'`) — what "Open" does
   - `anime4kPreset`: `'off' | 'mode-a' | 'mode-b' | 'mode-c'` (default `'off'`)
   - `anime4kVersion`: `string` (default `''`) — cached shader release tag
   - `mpvHwdec`: `boolean` (default `true`) — hardware decoding toggle

### AnimeDetailView changes

8. Update `openFile()` in `src/renderer/src/components/AnimeDetailView.vue` (~line 515):
   - Check `playerMode` setting
   - If `'mpv'`: call `window.api.mpvPlay(filePath, { anime, episode })` instead of `window.api.fileOpen(filePath)`
   - If `'system'`: keep current `window.api.fileOpen(filePath)` behavior
   - Add "Play with mpv" context option (right-click or secondary button) regardless of default mode

### Shikimori auto-sync on playback (optional enhancement)

9. When mpv playback reaches end-of-file for an episode:
   - If Shikimori is connected and anime has `myAnimeListId`:
     - Increment watched episode count via `shikimori:update-rate`
     - Auto-set status to "watching" if currently "planned"
   - This leverages the `eof` event from node-mpv IPC

### Edge cases & gotchas

- **mpv binary size:** Portable mpv is ~30-80MB depending on platform — show download progress, allow cancel
- **Windows 7z extraction:** mpv Windows builds are .7z archives — need a JS 7z extractor (e.g., `node-7z` or `7zip-min`) or ship with 7za.exe
- **Linux mpv availability:** Most Linux users already have mpv installed via package manager — check PATH first before offering download
- **macOS Gatekeeper:** Downloaded mpv binary may need `xattr -cr` to remove quarantine flag
- **Shader path separators:** mpv uses `;` on Windows and `:` on Linux/macOS to separate multiple shader paths in `--glsl-shaders`
- **GPU compatibility:** Anime4K shaders require OpenGL 4.x or Vulkan — may fail on old/integrated GPUs. Catch mpv shader compilation errors and suggest disabling shaders
- **Multiple instances:** Prevent launching multiple mpv instances simultaneously (or decide to allow it) — node-mpv manages a single instance by default
- **mpv IPC socket path:** node-mpv uses a Unix socket (Linux/macOS) or named pipe (Windows) — ensure path doesn't conflict with user's own mpv config
- **File paths with special characters:** Ensure anime filenames with CJK/special chars are properly escaped when passed to mpv
