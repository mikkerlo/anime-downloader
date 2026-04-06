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

---

## ~~1. Download queue persistence~~

~~**Priority:** High | **Effort:** Medium~~

~~App crash or accidental close loses all queue state. No resume on restart.~~

~~**Plan:**~~
~~1. In `DownloadManager`, add a `persistQueue()` method that serializes the queue to a JSON file in `app.getPath('userData')/queue.json`. Store: `{ translationId, animeName, episodeLabel, episodeInt, animeId, height, translationType, author, status, bytesReceived }` for each item~~
~~2. Call `persistQueue()` on: enqueue, status change (start/pause/complete/fail), cancel, clear~~
~~3. On app start (`DownloadManager` constructor or init), load `queue.json` if it exists:~~
   ~~- Items with status `completed` + `mergeStatus === 'completed'` — skip (already done)~~
   ~~- Items with status `downloading` or `queued` — re-enqueue as fresh downloads (URLs expire, so must re-fetch embed)~~
   ~~- Items with status `paused` — restore as paused~~
   ~~- Items with status `failed` — restore as failed (user can retry)~~
   ~~- Items with `completed` video but `pending` merge — restore and trigger merge~~
~~4. Delete `queue.json` when queue is empty (all cleared)~~
~~5. Handle edge case: `.part` files may exist from interrupted downloads — the existing resume logic (Range headers + 416 handling) already covers this~~

---

## ~~2. API token validation~~

~~**Priority:** Medium | **Effort:** Small~~

~~No feedback until the first download fails. Users don't know if their token is valid.~~

~~**Plan:**~~
~~1. Add IPC handler `validate-token` in `src/main/index.ts` that calls a lightweight API endpoint (e.g. `GET /api/series/?query=test&limit=1`) with the provided token and returns `{ valid: boolean; error?: string }`~~
~~2. Add to preload: `validateToken: () => Promise<{ valid: boolean; error?: string }>`~~
~~3. In `SettingsView.vue`, add a "Test token" button next to the token input~~
~~4. On click: call `validateToken()`, show green checkmark or red error inline~~
~~5. Optionally auto-validate on token change (debounced, after auto-save fires)~~

---

## ~~3. Auto-update mechanism~~

~~**Priority:** Medium | **Effort:** Medium~~

~~The CI already creates GitHub releases with platform-specific artifacts via `softprops/action-gh-release`. We can use the GitHub API to check for new versions.~~

~~**Plan:**~~
~~1. Add a `checkForUpdate()` function in `src/main/index.ts`:~~
   ~~- Fetch `https://api.github.com/repos/{owner}/{repo}/releases/latest` (no auth needed for public repos)~~
   ~~- Compare `tag_name` (e.g. `v1.1.1`) against `app.getVersion()` from package.json~~
   ~~- If remote version is newer, return `{ available: true, version, releaseUrl, assets }` where `assets` is the list of download URLs filtered by current platform (`process.platform`: win32 → `.exe`, linux → `.AppImage`, darwin → `.dmg`)~~
   ~~- If same or older, return `{ available: false }`~~
~~2. Add IPC handler `update:check` and preload binding `updateCheck()`~~
~~3. In `SettingsView.vue` (General tab), add an "Updates" section:~~
   ~~- Show current version from package.json~~
   ~~- "Check for updates" button~~
   ~~- If update available: show new version + "Download" button that opens the asset URL in the default browser via `shell.openExternal(url)`~~
~~4. Optionally check on app start (once per day, store last check timestamp in electron-store) and show a subtle badge on the Settings sidebar icon if update is available~~
~~5. GitHub API rate limit is 60 req/hour for unauthenticated — more than enough for a desktop app checking once per launch~~
~~6. The repo owner/name should be a constant in main (e.g. `const GITHUB_REPO = 'mikkerlo/anime-dl-app'`) — update this to match the actual repo~~

~~**Future enhancement:** Full auto-download + replace using electron-updater, but the manual "open browser to download" approach is simpler and safer as a first step.~~

---

## 4. Keyboard shortcuts

**Priority:** Low | **Effort:** Small

**Plan:**
1. In `App.vue`, add a global `keydown` listener in `onMounted`
2. `Escape` — if in AnimeDetailView, emit `back` (navigate to list); could use a ref like `currentView` to decide context
3. `Ctrl+F` / `Cmd+F` — switch to Search tab and focus the search input (emit an event or use a ref)
4. Potentially `Ctrl+D` — switch to Downloads tab
5. Clean up listener in `onUnmounted`

---

## 5. System notifications on download/merge complete

**Priority:** Low | **Effort:** Small

Useful when app is in background or minimized.

**Plan:**
1. In `src/main/download-manager.ts`, after `checkEpisodeComplete()` detects a completed episode (and after merge if auto-merge is on), use Electron's `Notification` API:
   ```
   new Notification({ title: 'Download complete', body: `${animeName} - ${episodeLabel}` }).show()
   ```
2. For merge completion, similar notification in the merge callback
3. Only show when the app window is not focused — check `BrowserWindow.getFocusedWindow() === null`
4. Optionally add a setting to disable notifications

---

## 6. Episode range selection

**Priority:** Low | **Effort:** Small

**Plan:**
1. In `AnimeDetailView.vue`, add a "Select range" button next to "Download All/Page"
2. On click, show two inputs (from episode, to episode) — pre-filled with the current page range if paginated
3. "Download range" button filters `episodeRows` to the selected range and enqueues only those
4. Could also add quick presets like "First 12", "First 24" for common season lengths

---

## 7. Download speed throttle / bandwidth limiting

**Priority:** Low | **Effort:** Medium

**Plan:**
1. Add `downloadSpeedLimit` setting to electron-store (number, bytes/sec, 0 = unlimited)
2. In `DownloadManager.startDownload()`, wrap the response stream in a `Transform` that throttles throughput — track bytes written per second and pause/resume the readable stream to stay under the limit
3. Add a slider or input in `SettingsView.vue` (General tab) with presets: Unlimited, 1 MB/s, 5 MB/s, 10 MB/s, Custom
4. Apply limit changes to active downloads (update the throttle transform dynamically)

---

## 8. Pause All / Resume All buttons in Downloads

**Priority:** Low | **Effort:** Small

The Downloads view has per-item pause/resume buttons and bulk actions for "Retry all failed", "Merge finished", and "Clear finished" — but no way to pause or resume the entire queue at once. Useful when managing large download batches.

**Plan:**
1. In `src/main/download-manager.ts`, add two methods following the `restartAllFailed()` pattern (line ~367):
   - `pauseAll()` — iterate `this.queue`, call `this.pause(id)` for items with status `downloading` or `queued`, then `this.schedulePersist()`
   - `resumeAll()` — iterate `this.queue`, call `this.resume(id)` for items with status `paused`, then `this.schedulePersist()`
2. Add IPC handlers in `src/main/index.ts`:
   - `download:pause-all` → `downloadManager.pauseAll()`
   - `download:resume-all` → `downloadManager.resumeAll()`
3. Add preload bindings in `src/preload/index.ts`:
   - `downloadPauseAll: () => ipcRenderer.invoke('download:pause-all')`
   - `downloadResumeAll: () => ipcRenderer.invoke('download:resume-all')`
4. Add type declarations in `src/preload/index.d.ts`:
   - `downloadPauseAll: () => Promise<void>`
   - `downloadResumeAll: () => Promise<void>`
5. In `src/renderer/src/components/DownloadsView.vue`, add "Pause all" and "Resume all" buttons in the topbar (line ~87) next to existing bulk action buttons. Show/hide based on whether any items are active or paused
