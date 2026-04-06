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
- [x] ~~Pause All / Resume All buttons in Downloads~~ (was marked done prematurely, re-added as TODO #4)

---

## ~~1. Keyboard shortcuts~~

~~**Priority:** Low | **Effort:** Small~~

~~**Plan:**~~
~~1. In `App.vue`, add a global `keydown` listener in `onMounted`~~
~~2. `Escape` — if in AnimeDetailView, emit `back` (navigate to list); could use a ref like `currentView` to decide context~~
~~3. `Ctrl+F` / `Cmd+F` — switch to Search tab and focus the search input (emit an event or use a ref)~~
~~4. Potentially `Ctrl+D` — switch to Downloads tab~~
~~5. Clean up listener in `onUnmounted`~~

---

## ~~2. System notifications on download/merge complete~~

~~**Priority:** Low | **Effort:** Small~~

~~Useful when app is in background or minimized.~~

~~**Plan:**~~
~~1. In `src/main/download-manager.ts`, after `checkEpisodeComplete()` detects a completed episode (and after merge if auto-merge is on), use Electron's `Notification` API~~
~~2. For merge completion, similar notification in the merge callback~~
~~3. Only show when the app window is not focused — check `BrowserWindow.getFocusedWindow() === null`~~
~~4. Optionally add a setting to disable notifications~~

---

## 3. Episode range selection

**Priority:** Low | **Effort:** Small

**Plan:**
1. In `AnimeDetailView.vue`, add a "Select range" button next to "Download All/Page"
2. On click, show two inputs (from episode, to episode) — pre-filled with the current page range if paginated
3. "Download range" button filters `episodeRows` to the selected range and enqueues only those
4. Could also add quick presets like "First 12", "First 24" for common season lengths

---

## ~~4. Pause All / Resume All buttons in Downloads~~

~~**Priority:** Medium | **Effort:** Small~~

~~Previously marked done but never implemented. Individual pause/resume per item exists, but there are no bulk buttons.~~

~~**Plan:**~~
~~1. In `src/main/download-manager.ts`, add `pauseAll()` and `resumeAll()` methods~~
~~2. Add IPC handlers in `src/main/index.ts`~~
~~3. Expose in `src/preload/index.ts`~~
~~4. Add types in `src/preload/index.d.ts`~~
~~5. In `src/renderer/src/components/DownloadsView.vue`: Pause All / Resume All buttons in topbar~~
~~6. Update `DESIGN.md` IPC table with the two new channels~~

---

## 5. Download speed throttle / bandwidth limiting

**Priority:** Low | **Effort:** Medium

**Plan:**
1. Add `downloadSpeedLimit` setting to electron-store (number, bytes/sec, 0 = unlimited)
2. In `DownloadManager.startDownload()`, wrap the response stream in a `Transform` that throttles throughput — track bytes written per second and pause/resume the readable stream to stay under the limit
3. Add a slider or input in `SettingsView.vue` (General tab) with presets: Unlimited, 1 MB/s, 5 MB/s, 10 MB/s, Custom
4. Apply limit changes to active downloads (update the throttle transform dynamically)

---

