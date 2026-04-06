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

---

## 1. Episode range selection

**Priority:** Low | **Effort:** Small

**Plan:**
1. In `AnimeDetailView.vue`, add a "Select range" button next to "Download All/Page"
2. On click, show two inputs (from episode, to episode) — pre-filled with the current page range if paginated
3. "Download range" button filters `episodeRows` to the selected range and enqueues only those
4. Could also add quick presets like "First 12", "First 24" for common season lengths

---

## 2. Download speed throttle / bandwidth limiting

**Priority:** Low | **Effort:** Medium

**Plan:**
1. Add `downloadSpeedLimit` setting to electron-store (number, bytes/sec, 0 = unlimited)
2. In `DownloadManager.startDownload()`, wrap the response stream in a `Transform` that throttles throughput — track bytes written per second and pause/resume the readable stream to stay under the limit
3. Add a slider or input in `SettingsView.vue` (General tab) with presets: Unlimited, 1 MB/s, 5 MB/s, 10 MB/s, Custom
4. Apply limit changes to active downloads (update the throttle transform dynamically)

---
