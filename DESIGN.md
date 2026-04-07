# Anime DL App - Design Document

Electron + Vue 3 + TypeScript desktop app for downloading anime from smotret-anime.ru.

## Architecture

```
src/
  main/           Electron main process (Node.js)
  preload/        IPC bridge (contextBridge)
  renderer/       Vue 3 frontend
```

### Process Model

```
Renderer (Vue)  --ipcRenderer.invoke-->  Preload (bridge)  --ipcMain.handle-->  Main (Node)
                <--webContents.send----                                          |
                                                                                 |
                                                              DownloadManager    |
                                                              electron-store     |
                                                              ffbinaries/ffmpeg  |
                                                              smotret-anime API  |
```

## File Map

| File | Role |
|------|------|
| `src/main/index.ts` | App lifecycle, IPC handlers, API proxy, ffmpeg auto-download, settings |
| `src/main/download-manager.ts` | Download queue, concurrent downloads, progress, ffmpeg merge, scan-merge |
| `src/main/shikimori.ts` | Shikimori API client: OAuth, token refresh, user rates, anime list |
| `src/main/ffmpeg-static.d.ts` | Type declaration for ffbinaries module |
| `src/preload/index.ts` | contextBridge API exposure to renderer |
| `src/preload/index.d.ts` | Shared TypeScript interfaces for IPC communication |
| `src/renderer/src/main.ts` | Vue app entry point |
| `src/renderer/src/App.vue` | Root component, per-view navigation state, anime prefs persistence |
| `src/renderer/src/components/Sidebar.vue` | Navigation menu |
| `src/renderer/src/components/SearchView.vue` | Anime search + results grid (persistent across tab switches) |
| `src/renderer/src/components/AnimeCard.vue` | Reusable anime poster card |
| `src/renderer/src/components/LibraryView.vue` | Starred + downloaded anime collection, folder deletion |
| `src/renderer/src/components/AnimeDetailView.vue` | Episode list, translations, download/open/delete per episode, dequeue, download progress |
| `src/renderer/src/components/DownloadsView.vue` | Real-time download queue with progress, merge controls |
| `src/renderer/src/components/ShikimoriView.vue` | Shikimori anime list: browse watchlist, status filter, MAL ID resolution |
| `src/renderer/src/components/PlayerView.vue` | Built-in video player with Anime4K WebGPU shaders, keyboard controls |
| `src/renderer/src/components/SettingsView.vue` | General + Connectors + Merging + Player + Debug settings tabs |

## Data Flow

### Anime Search & Browse

```
SearchView  -->  window.api.searchAnime(query)
            -->  ipcMain 'search-anime'
            -->  fetch smotret-anime.ru/api/series/?query=...
            <--  AnimeSearchResult[]
            -->  AnimeCard grid
            -->  click card --> AnimeDetailView
```

SearchView uses `v-show` (never destroyed) so search state persists across tab switches.

### Navigation State

```
App.vue manages per-view anime selection:
  animeByView = { search: null | animeId, library: null | animeId }
  animePrefs  = { [animeId]: { translationType, author } }

Each view (search, library) tracks its own selected anime independently.
AnimeDetailView receives initialPrefs and emits prefsChanged to persist
translation type and author selections across re-mounts.
```

### Episode Loading & Translation Selection

```
AnimeDetailView  -->  getAnime(id) --> full anime with episode list
                 -->  getEpisode(id) x N (batches of 5) --> translations per episode
                 -->  all active translations shown (no quality minimum)
                 -->  best quality per author+type deduplication
                 -->  checkFileStatus() --> which episodes exist on disk
                 -->  downloadedEpisodesGet(animeId) --> translation metadata for files

Episode list is paginated (30 per page) when anime has >30 TV episodes.
Only translations for the visible page are fetched (in batches of 5).
Cached translations are reused when revisiting a page.

Per-episode translation selector with priority chain:
  1. Downloaded file on disk → locked to saved translation
  2. In download queue → locked to queued translation
  3. User per-episode override → user's manual pick
  4. Global default → matching type + author from top dropdowns

Global dropdowns set defaults; each episode can override independently.
Translation type dropdown shows episode counts: "Russian Subtitles (10/12)".
Each episode row shows colored type chip (RU SUB, EN DUB, etc.) + quality badge.
Dropdown groups translations by type (user's selected type first), sorted by quality desc.
```

### Quality Probing

```
AnimeDetailView probes actual stream quality from the embed API:
  1. On episode load + on translation type/author change
  2. Collects all visible translation IDs
  3. Probes embed API in batches of 5 → returns best stream height
  4. Stores in realQuality Map (translationId → actual height)
  5. All quality displays and download requests use probed height
  6. If reported height ≠ actual height, reports mismatch to main process
     (stored in-memory Map, dumpable to JSON from Debug tab)

getRealHeight(tr) = realQuality.get(tr.id) ?? tr.height
```

### Download Pipeline

```
1. User clicks DL / Download All
2. downloadEnqueue(DownloadRequest[]) — includes animeId, translationType, author
3. DownloadManager.enqueue():
   a. fetchEmbed(translationId) --> stream URLs + subtitlesUrl from embed API
   b. Select best quality stream URL <= requested height
   c. Create DownloadItem for video (stream URL) + subtitle (ass URL)
   d. Add to queue
4. Episode metadata saved to electron-store (translationType, author, quality)
5. Anime added to downloadedAnime store (appears in library)
6. processQueue(): run up to 2 concurrent downloads
7. startDownload():
   a. HTTP fetch with Range header (resume support)
   b. Handle 416 (Range Not Satisfiable): delete .part, retry from zero
   c. Pipe through Transform (speed tracking) to .part file
   d. On complete: rename .part --> final, check episode complete
   e. On failure: retry up to 3x with exponential backoff
8. broadcastProgress() every 500ms --> renderer updates
9. checkEpisodeComplete() --> trigger auto-merge if enabled
10. persistQueue() on every state change --> queue.json in userData
    - Atomic writes (tmp + rename) to prevent corruption
    - Debounced via queueMicrotask for bulk operations
    - Periodic persist every 5s while downloads are active
11. On app start: loadQueue() restores items from queue.json
    - In-progress/queued items restored as paused (URLs expire)
    - Active merges reset to pending
    - .part files resumed via existing Range header logic
```

### Merge Pipeline

```
mergeCompleted(ffmpegPath, videoCodec):
  For each EpisodeGroup where video=completed:
    1. Probe input duration via ffprobe (for accurate progress)
    2. With subtitle:  ffmpeg -i video.mp4 -i subs.ass -map 0:v -map 0:a -map 1:s
                       -c:v [copy|libx265|hevc_nvenc|...] -c:a copy -c:s ass
                       -disposition:s:0 default -metadata:s:s:0 language=<lang>
                       -metadata:s:s:0 title=<author> output.mkv
       Without:        ffmpeg -i video.mp4 -c:v [codec] -c:a copy output.mkv
    3. Subtitle language derived from translationType (subRu/voiceRu → rus, subEn/voiceEn → eng, else und)
    4. Subtitle track title set to translator name (authorsSummary)
    5. Progress calculated from timemark/duration (works for all codecs including GPU)
    6. Delete source .mp4 and .ass after successful merge
    7. Sequential merging (one at a time) enforced via lock
    8. Merge can be cancelled (kills ffmpeg process, cleans up partial output)

scanAndMerge(ffmpegPath, videoCodec):
  Scans all download folders for .mp4 without matching .mkv
  Merges with .ass subtitle if available
  Reports per-file progress via IPC callback
  Available from Settings > Debug tab

fixMetadata(ffmpegPath, ffprobePath):
  Scans downloaded MKVs with stored episode metadata
  Re-muxes with -c copy to set subtitle language, title, and default disposition
  Uses temp file + atomic rename to avoid corruption
  Available from Settings > Debug tab
```

### File Management

```
AnimeDetailView checks disk on mount:
  fileCheckEpisodes(animeName, episodeInts[])
    --> for each episode: check .mkv first, then .mp4
    --> returns { episodeInt: { type, filePath } }

  downloadedEpisodesGet(animeId)
    --> returns { episodeInt: { translationType, author, quality, translationId } }

Actions per episode:
  Open     --> shell.openPath(filePath)       cross-platform default player
  Folder   --> shell.showItemInFolder(path)   cross-platform file explorer
  Delete   --> fs.unlink .mkv, .mp4, .ass     also cleans episode metadata
  Cancel   --> cancelByEpisode(animeName, episodeLabel)  cancel queued/active download
```

### Library

```
Two sources merged and deduplicated:
  library         - manually starred anime (toggle from search)
  downloadedAnime - auto-added when downloads are enqueued

LibraryView shows both with indicators:
  Starred anime: star toggle
  Downloaded anime: "Remove files" button (deletes folder + store entry)
```

## IPC Handlers

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `validate-token` | invoke | Validate API token against smotret-anime.ru |
| `search-anime` | invoke | Search anime by query |
| `get-anime` | invoke | Fetch anime details by ID |
| `get-episode` | invoke | Fetch episode translations |
| `probe-embed-quality` | invoke | Probe embed API for actual stream height |
| `report-quality-mismatch` | invoke | Report a detected quality mismatch (stored in memory) |
| `get-quality-mismatch-count` | invoke | Get number of collected mismatches |
| `dump-quality-mismatches` | invoke | Write mismatches to JSON file in download dir |
| `library-get` | invoke | List all starred + downloaded anime (merged) |
| `library-toggle` | invoke | Add/remove from starred library |
| `library-has` | invoke | Check if anime is starred |
| `library-is-downloaded` | invoke | Check if anime has downloads |
| `library-get-status` | invoke | Batch check starred + downloaded status for multiple anime IDs |
| `downloaded-anime-add` | invoke | Mark anime as having downloads |
| `downloaded-anime-delete` | invoke | Remove anime + delete folder |
| `downloaded-episodes-get` | invoke | Get translation metadata per episode |
| `get-setting` | invoke | Read setting value |
| `set-setting` | invoke | Write setting value |
| `download:enqueue` | invoke | Queue download requests + save episode metadata |
| `download:pause` | invoke | Pause a download |
| `download:resume` | invoke | Resume paused/failed download |
| `download:restart` | invoke | Restart from scratch (re-fetch embed URLs) |
| `download:cancel` | invoke | Cancel and cleanup download |
| `download:cancel-by-episode` | invoke | Cancel downloads for anime/episode |
| `download:cancel-merge` | invoke | Cancel active ffmpeg merge process |
| `download:get-queue` | invoke | Get episode groups |
| `download:clear-completed` | invoke | Remove finished items (skips unmerged) |
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
| `app:version` | invoke | Get app version from package.json |
| `update:check` | invoke | Check GitHub for newer version via electron-updater |
| `update:download` | invoke | Download available update |
| `update:install` | invoke | Quit and install downloaded update |
| `update:status` | send | Update check/download progress and status |
| `cache-get-poster` | invoke | Get base64-encoded cached poster for offline anime |
| `file:check-episodes` | invoke | Check which episodes exist on disk |
| `file:open` | invoke | Open file with default app |
| `file:show-in-folder` | invoke | Reveal file in explorer |
| `file:delete-episode` | invoke | Delete episode files + clean metadata |
| `shikimori:get-auth-url` | invoke | Get Shikimori OAuth authorize URL |
| `shikimori:exchange-code` | invoke | Exchange OAuth code for tokens, fetch user |
| `shikimori:logout` | invoke | Clear Shikimori credentials and user |
| `shikimori:get-user` | invoke | Get cached Shikimori user profile |
| `shikimori:get-rate` | invoke | Fetch user's anime rate from Shikimori by MAL ID |
| `shikimori:update-rate` | invoke | Create or update user rate (episodes, status, score) |
| `shikimori:get-anime-rates` | invoke | Fetch user's anime list from Shikimori, resolve MAL IDs to smotret-anime |
| `storage:pick-hot-dir` | invoke | Open folder picker for hot storage directory |
| `storage:pick-cold-dir` | invoke | Open folder picker for cold storage directory |
| `storage:move-to-cold` | invoke | Move all finished files from hot to cold storage |
| `storage:move-to-cold-progress` | send | Progress broadcast for move operation |
| `player:get-stream-url` | invoke | Fetch CDN stream URL + subtitle content (ASS→VTT) + all available stream qualities for a translation |
| `player:get-local-subtitles` | invoke | Read local .ass file alongside video, convert to VTT |
| `shell:open-external` | invoke | Open URL in default browser (returns success boolean) |

## Key Types

```typescript
// Download states
type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled'
type MergeStatus = 'pending' | 'merging' | 'completed' | 'failed'

// What renderer receives from progress broadcasts
interface EpisodeGroup {
  translationId: number
  animeName: string
  episodeLabel: string
  quality: number
  video: DownloadProgressItem | null
  subtitle: DownloadProgressItem | null
  mergeStatus: MergeStatus
  mergePercent?: number
  mergeError?: string
}

// What gets queued for download
interface DownloadRequest {
  translationId: number
  height: number
  animeName: string
  episodeLabel: string
  episodeInt: string
  animeId: number
  translationType: string
  author: string
}

// Persisted per-episode translation info
interface EpisodeMeta {
  translationType: string
  author: string
  quality: number
  translationId: number
}
```

## Settings (electron-store)

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
| `keyboardShortcuts` | object | `{back:'Escape', focusSearch:'CmdOrCtrl+F', goDownloads:'CmdOrCtrl+D'}` | Configurable keyboard shortcut bindings |
| `shikimoriCredentials` | object\|null | `null` | Shikimori OAuth tokens (access_token, refresh_token, created_at, expires_in) |
| `shikimoriUser` | object\|null | `null` | Cached Shikimori user profile (id, nickname, avatar) |
| `storageMode` | string | `'simple'` | Storage mode: `simple` (single dir) or `advanced` (hot/cold split) |
| `hotStorageDir` | string | `''` | Hot storage path for active downloads (advanced mode) |
| `coldStorageDir` | string | `''` | Cold storage path for finished files (advanced mode) |
| `autoMoveToCold` | boolean | `false` | Auto-move finished files to cold storage |
| `malIdMap` | object | `{}` | Persistent cache of MAL ID → smotret-anime entry for Shikimori list resolution |
| `playerMode` | string | `'system'` | Default player: `system` (OS default) or `builtin` (in-app HTML5 player) |
| `anime4kPreset` | string | `'off'` | Anime4K shader preset: `off`, `mode-a` (1080p), `mode-b` (720p), `mode-c` (480p) |

## Hot/Cold Storage

In advanced storage mode, files are managed across two directories:

- **Hot storage**: Where downloads land and in-progress files live (replaces `downloadDir` in advanced mode)
- **Cold storage**: Where finished files are moved for long-term storage

### File movement

- `moveEpisodeToColdStorage()`: Moves a single episode's files (.mkv, .mp4, .ass) from hot → cold. Skips files with .part (in-progress). Uses `fs.rename` with `fs.copyFile` + `fs.unlink` fallback for cross-filesystem moves.
- `moveAllFilesToColdStorage()`: Scans hot dir for all finished files and moves them to cold. Reports progress via `storage:move-to-cold-progress` IPC.

### Auto-move triggers

- If merge disabled: after `onEpisodeComplete` callback
- If merge enabled: after `onMergeComplete` callback
- Manual: "Move all to cold storage" button in Settings > Storage

### File scanning

In advanced mode, `file:check-episodes`, `file:delete-episode`, and `downloaded-anime-delete` check/delete from both hot and cold dirs. Cold storage takes priority when a file exists in both locations. `scanAndMerge` also scans both directories.

## Built-in Video Player

In-app HTML5 video player with optional Anime4K WebGPU upscaling shaders. Uses `anime4k-webgpu` npm package for GPU-accelerated real-time upscaling.

### Custom Protocol

`anime-video://` protocol registered via `protocol.handle` serves local video files to the `<video>` element. The `stream: true` privilege enables HTTP range requests for seeking. The handler manually parses `Range` headers and returns 206 Partial Content responses using `fs.createReadStream({ start, end })` for proper seeking support. Files are encoded as `anime-video://{encodeURIComponent(filePath)}`.

### Video Playback

- **Local .mp4**: Served via `anime-video://` protocol
- **Local .mkv**: Not supported by HTML5 video — streams from CDN instead (shows warning banner)
- **Non-downloaded episodes**: Streams directly from smotret-anime CDN via `player:get-stream-url` IPC

### Anime4K WebGPU Pipeline

When shaders are enabled and WebGPU is available:
1. Video frames copied to GPU texture via `device.queue.copyExternalImageToTexture()`
2. Anime4K preset pipeline processes the texture (compute shaders)
3. Output rendered to canvas via fullscreen quad render pass
4. Frame loop driven by `video.requestVideoFrameCallback()`

Preset modes: Mode A (1080p source), Mode B (720p source), Mode C (480p source). Falls back to plain `<video>` when WebGPU is unavailable.

### Subtitles

ASS subtitles are converted to WebVTT in the main process and displayed via native HTML5 `<track>` element:
- **Local files**: `player:get-local-subtitles` reads `.ass` file alongside the `.mp4`, converts to VTT
- **Streaming**: `player:get-stream-url` fetches ASS from smotret-anime API, converts to VTT
- Conversion strips ASS style tags (`{\b1}`, `{\an8}`, etc.), converts `\N` newlines, and maps ASS timestamps to VTT format
- Subtitles positioned at `line:85%` to stay above player controls

### WebGPU Requirements

- `enable-unsafe-webgpu` CLI flag set before app ready
- `enable-features=Vulkan` for Linux Vulkan backend support
- GPU benchmark available in Settings > Debug (100 frames of Mode A at 720p→screen resolution)

## Auto-Update

Uses `electron-updater` with GitHub releases as the update source. The CI uploads `latest.yml` / `latest-linux.yml` / `latest-mac.yml` alongside platform artifacts — electron-updater reads these to determine available versions.

- `autoDownload = false` — user must explicitly click "Download update"
- Auto-checks on app launch if the last check was >24 hours ago (`lastUpdateCheck` setting)
- Manual check via Settings > General > "Check for updates" button
- Flow: check → show available version → download with progress bar → "Restart to update"
- Publish config in `package.json` points to `github:mikkerlo/anime-downloader`

## Shikimori Integration

Syncs anime watch status and episode progress with [Shikimori](https://shikimori.one). Uses MAL IDs as the shared key between smotret-anime and Shikimori (`myAnimeListId` field on anime series).

### OAuth Flow (OOB)

```
1. User clicks "Connect Shikimori" in Settings > General
2. App opens Shikimori authorize URL in external browser
3. User authorizes → Shikimori displays authorization code
4. User pastes code into app → exchangeCode() → tokens stored
5. Token auto-refresh: ensureFreshToken() checks expiry before each API call
```

### Module: `src/main/shikimori.ts`

Standalone API client with hardcoded client credentials. All methods throw `ShikiApiError` on failure. Rate limit handling: retries on 429 with `retry-after` header.

### AnimeDetailView Panel

Shown when user is logged in AND anime has `myAnimeListId`. Displays:
- Status dropdown (planned/watching/rewatching/completed/on_hold/dropped)
- Episode count input
- Score dropdown (1–10)
- Save button to push changes
- Link to anime on Shikimori
- Auto-status: episodes > 0 → watching (from planned) / rewatching (from completed); episodes = max → completed

## FFmpeg

Both `ffmpeg` and `ffprobe` are auto-downloaded on first app launch via `ffbinaries` (v6.1) to the app's userData directory. Platform is auto-detected. ffprobe is required for duration probing (used in merge progress calculation).

Available video codecs for merge (filtered by what ffmpeg reports):
- `copy` — no re-encode, fastest
- `libx265` — H.265 CPU
- `hevc_nvenc` — H.265 NVIDIA GPU
- `hevc_amf` — H.265 AMD GPU
- `hevc_qsv` — H.265 Intel QuickSync
- `hevc_videotoolbox` — H.265 macOS hardware

Merge progress is calculated from `timemark / probed_duration` (works for all codecs). Sequential merging enforced (one merge at a time). Active merge can be cancelled (kills ffmpeg, cleans partial output).

## File Layout on Disk

```
{downloadDir}/
  {sanitized anime name}/
    {anime name} - 01.mp4        raw video
    {anime name} - 01.ass        subtitles
    {anime name} - 01.mkv        merged (video + subs)
    {anime name} - 01.mp4.part   in-progress download
```

Filename sanitization: `[<>:"/\|?*]` replaced with `_`, whitespace normalized.

## API Endpoints (smotret-anime.ru)

| Endpoint | Usage |
|----------|-------|
| `GET /api/series/?query=&fields=` | Search anime |
| `GET /api/series/{id}` | Anime details |
| `GET /api/episodes/{id}` | Episode + translations |
| `GET /api/translations/embed/{id}?access_token=` | Stream URLs + subtitle info |
| `GET /translations/ass/{id}?download=1` | Subtitle file download |

The embed API returns `stream[]` with direct CDN URLs (used for downloads) and `download[]` with site redirect URLs (not used, causes 403).

## Build

```bash
npm run dev          # Development with hot reload
npm run build        # Compile to out/
npm run pack:win     # Build + package Windows portable exe
npm run pack:linux   # Build + package Linux AppImage
npm run pack:mac     # Build + package macOS zip
```

Dependencies: electron-vite bundles everything except electron-store (excluded from externalization to handle ESM). FFmpeg downloaded at runtime via ffbinaries.
