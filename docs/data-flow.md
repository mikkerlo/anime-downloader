# Data Flow

## Home / Continue Watching

`HomeView` is the default landing view. It calls `home:get-continue-watching`, which merges two local sources (no network) into a single, time-sorted list capped at 24 entries:

- **Resume rows** — entries in `watchProgress` where `watched !== true`, `position > 5`, `duration > 0`, and `position / duration < 0.95`. Collapsed to a single entry per anime: the most-recently-updated unfinished episode wins. Rows whose Shikimori rate status is `completed` are dropped — lingering local progress shouldn't drag a finished show back into Continue Watching.
- **Next-up rows** — entries in `shikimoriUserRates` with `status ∈ {watching, rewatching}` and `episodes_aired === 0 || rate.episodes + 1 <= episodes_aired`.

Dedup rule: if a `(animeId, _)` resume row exists, no Next-up row is emitted for that anime — Resume already represents the user's most recent intent on the show.

Sort order: descending Shikimori `rate.updated_at` — same rule as the ShikimoriView "To Watch" tab. Resume rows look up their Shikimori rate by `animeId` (via `smotretAnime.id` on cached rates) and inherit its `updated_at`; if the anime isn't tracked on Shikimori, the row falls back to its local `watchProgress.updatedAt`. Resume and Next-up rows are mixed in this single ordering.

Poster + name resolution priority for each row: `library` → `downloadedAnime` → `malIdMap` → for Next rows only, the cached `shikiAnime.image.preview/x96/original` (prefixed with the Shikimori host when relative). Episode label prefers `animeCache[animeId].animeDetail.episodes[*].episodeFull`, else `Episode N`.

`HomeView` re-fetches on mount, on a 1-second-debounced `watch-progress-updated` window event (dispatched by `PlayerView`), and on `shikimori:rates-refreshed` / `shikimori:rate-updated` IPC broadcasts. Click → emits `open-anime` with `{ animeId, focusEpisodeInt }`. `App.vue` keeps a `focusEpisodeIntForAnime` map so the value flows into `AnimeDetailView` as a prop. `AnimeDetailView` watches `focusEpisodeInt` + `filteredEpisodes`; once ready it switches `currentPage` (via existing `goToPage`) and calls `scrollIntoView` on the matching `.episode-row[data-ep-int]`. The view emits `focus-applied` once per `animeId` so re-renders don't re-scroll.

## Anime Search & Browse

```
SearchView  -->  window.api.searchAnime(query)
            -->  ipcMain 'search-anime'
            -->  fetch smotret-anime.ru/api/series/?query=...
            <--  AnimeSearchResult[]
            -->  AnimeCard grid
            -->  click card --> AnimeDetailView
```

SearchView uses `v-show` (never destroyed) so search state persists across tab switches.

## Navigation State

```
Pinia store `useLibraryStore` (src/renderer/src/stores/library.ts) owns:
  currentView                — active top-level view ('home' | 'search' | ...)
  animeByView[view]          — currently-opened anime per stacked view
  animeHistoryByView[view]   — back-stack per stacked view
  focusEpisodeIntForAnime    — episode to scroll to on AnimeDetailView mount
  actions: navigate, openAnime, closeAnime, clearFocusEpisode

Each stacked view (home, search, library, shikimori, friends, calendar)
tracks its own selected-anime stack. Components call store actions
directly — there is no @open-anime / @navigate emit chain through App.vue.

Slice 4c adds two more stores:
  usePlayerStore   — playerState (PlayerPayload | null), animePrefs.
                     Actions: openPlayer(payload), closePlayer,
                     saveAnimePrefs. AnimeDetailView calls openPlayer
                     directly with a typed payload; the old playFile
                     emit chain through App.vue is gone.
  useSettingsStore — shortcuts (resolved keyboard bindings),
                     ffmpegDownloading/Progress, fpcalcDownloading/Progress,
                     updateStatus (auto-updater banner). Owns three
                     lifetime-scoped IPC subscriptions
                     (onFfmpegDownloadProgress, onFpcalcDownloadProgress,
                     onUpdateStatus) — Pinia singleton, never disposed.
                     Action: loadShortcuts.

Slice 4d adds the last two stores:
  useShikimoriStore — user, loggedIn (computed), rates list,
                      animeDetails cache, syncStatus, offlineQueueLength.
                      Owns 5 lifetime-scoped IPC subscriptions:
                      onShikimoriRateUpdated (upserts into `rates`),
                      onShikimoriRatesRefreshed (replaces `rates`),
                      onShikimoriAnimeDetailsUpdated (upserts into
                      `animeDetails`), onShikimoriOfflineQueueChanged,
                      onShikimoriSyncStatus. Actions: refreshUser,
                      refreshRates, refreshSyncStatus,
                      refreshOfflineQueueLength, triggerSync. App.vue's
                      ad-hoc shikimoriGetUser probe + ShikimoriView's,
                      HomeView's, and AnimeDetailView's per-component
                      subscriptions are gone — consumers read the store
                      and (where they need side effects on rate changes)
                      watch its reactive state.
  useDownloadsStore — groups (current download queue snapshot),
                      scanMergeProgress, fixMetadataProgress. Owns
                      onDownloadProgress, onScanMergeProgress,
                      onFixMetadataProgress. Action: refreshQueue.
                      DownloadsView reads from store; AnimeDetailView
                      watches groups; SettingsView reads
                      scan/fix progress for its banners.
```

For the full store + composable inventory, see [Renderer architecture](./renderer.md).

## Episode Loading & Translation Selection

```
AnimeDetailView  -->  getAnimeCache(id) --> instant render if cached and fresh
                 -->  getAnime(id) --> full anime with episode list (background-refresh)
                 -->  getEpisodesBatchCached(ids) --> cached translations, instant paint
                 -->  getEpisodesBatch(ids) --> network refresh (background), patches rows
                 -->  all active translations shown (no quality minimum)
                 -->  best quality per author+type deduplication
                 -->  checkFileStatus() --> which episodes exist on disk
                 -->  downloadedEpisodesGet(animeId) --> translation metadata for files

Episode list is paginated (30 per page) when anime has >30 TV episodes.
Only translations for the visible page are fetched (in batches of 5).
Cached translations are reused when revisiting a page.

For starred or downloaded anime, the full AnimeDetail payload is cached in
`animeCache[animeId].animeDetail` with a 24h TTL. AnimeDetailView calls
`getAnimeCache(id)` on mount: on a hit, the page renders instantly from the
cache while a background `getAnime(id)` refreshes the data; on miss, the
spinner stays up until the API responds. A per-mount generation counter +
`disposed` flag prevent stale background fetches from polluting state when
the user rapidly switches anime. Cache writes are gated on starred OR
downloaded; unstarring evicts the cache entry if the anime isn't downloaded.

Cache-first, non-blocking open (#196): a cache-rendered open is fully
cache-first — episode translations paint from `get-episodes-batch-cached` (no
network) before `getEpisodesBatch` returns, then patch on the background
refresh. `getAnime` is fired as a non-blocking background refresh (not awaited
inline) so watch-progress / Shikimori / skip-detection mount-tail work doesn't
queue behind it; a *failing* background refresh keeps `dataSource: 'cache'` so
the offline chip never flips after a successful cache paint (the
`renderedFromCache` guard). `checkFileStatus` runs once per open. The cold open
(no cache, e.g. non-library anime — episodes are `isCachable`-gated too, so
they have no cache to serve) fetches the detail, then runs the episode batch +
file scan concurrently rather than stacking them. The first per-anime file scan
is async (`fsPromises.readdir`, `lib/episode-file-scan.ts`) so it never stalls
the single-threaded main process, and concurrent misses are deduped to one scan.

Per-episode translation selector with priority chain:
  1. In download queue → locked to queued translation
  2. User per-episode override → user's manual pick
  3. Global default → matching type + author from top dropdowns

Multiple downloaded translations coexist per episode.
Downloaded translations marked with ⬇ icon in select dropdown.
Episode row shows Open/folder/delete when selected translation has a local file.
Shows Play (stream) and Download buttons when selected translation has no local file.
A small ⬇ badge indicates other translations are downloaded even if current isn't.

Global dropdowns set defaults; each episode can override independently.
Translation type dropdown shows episode counts: "Russian Subtitles (10/12)".
Each episode row shows colored type chip (RU SUB, EN DUB, etc.) + quality badge.
Dropdown groups translations by type (user's selected type first), sorted by quality desc.
```

## Quality Probing

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

## Download Pipeline

```
1. User clicks DL / Download All
2. downloadEnqueue(DownloadRequest[]) — includes animeId, translationType, author
3. DownloadManager.enqueue():
   a. fetchEmbed(translationId) --> stream URLs + subtitlesUrl from embed API
   b. Select best quality stream URL <= requested height
   c. Create DownloadItem for video (stream URL) + subtitle (ass URL)
   d. Add to queue
4. Anime added to downloadedAnime store (appears in library)
5. Episode metadata (`downloadedEpisodes[animeId:episodeInt:translationId]`) is
   written by the `onEpisodeComplete` callback once the video is on disk — NOT
   at enqueue time. This prevents cancelled or never-finished downloads from
   leaving a stale ⬇ icon in the UI.
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

## Merge Pipeline

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

## File Management

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
  Cancel   --> cancelByEpisode(animeName, episodeLabel)  cancel queued/active download;
               snapshots cancelled translations and drops their
               `downloadedEpisodes` entries when no file landed on disk

Metadata invariants:
  `downloaded-episodes-get` cross-checks each `downloadedEpisodes` entry against
  disk (tagged `[Author]` .mkv/.mp4, plus legacy untagged, in hot + cold dirs).
  Entries with no matching file and no active download are filtered out and
  garbage-collected from the store. Combined with the late-write at completion,
  this makes the ⬇ icon a reliable signal that the file is actually present.

File scan cache (session-level, in-memory):
  fileCheckCache: Map<animeName, fullScanResult>
  - First call per anime: full readdirSync, result cached
  - Subsequent calls: return cached result, trigger async background rescan
  - Background rescan uses fsPromises.readdir; if results differ, updates cache
    and pushes file:episodes-changed IPC to renderer
  - Cache invalidated on: file:delete-episode, onEpisodeComplete, onMergeComplete
  - Cache cleared entirely on: storage:move-to-cold
  - file:open verifies existence; if missing, invalidates cache + returns error
```

## Completion-triggered cleanup

When `shikimori:update-rate` flips a status to `completed` (and the prior
status was not `completed`), main resolves the smotret-anime entry from the
cached rate (`smotretAnime` field), checks `downloadedAnime[animeId]` and
`autoCleanupSnoozedAnimeIds[animeId]`, and broadcasts `cleanup:prompt` with
`{ animeId, animeName, malId }`. The same broadcast fires on the offline
fallback path so the prompt still appears for offline status flips.

`App.vue` listens and shows a toast (auto-dismisses after 30 s) with three
actions: open `CleanupModal` → calls `cleanup:execute`; "Keep" → dismiss;
"Don't ask for this show" → `cleanup:set-snoozed`. `cleanup:execute` deletes
the show folder in every storage dir, drops `downloadedAnime[animeId]` and
every `downloadedEpisodes` entry whose key starts with `${animeId}:`, and
prunes the anime/skip caches. `library`, `watchProgress`, and the Shikimori
rate are left intact. If active downloads exist for the show, the modal
chains `download:cancel-by-episode` first.

A "Cleanup files…" button in the AnimeDetailView header (visible when
`library-is-downloaded`) opens the same modal manually. Settings > Storage >
Cleanup prompts lists snoozed shows with un-snooze + reset-all controls.

## Library

```
Two sources merged and deduplicated:
  library         - manually starred anime (toggle from search)
  downloadedAnime - auto-added when downloads are enqueued

LibraryView shows both with indicators:
  Starred anime: star toggle
  Downloaded anime: "Remove files" button (deletes folder + store entry)
```
