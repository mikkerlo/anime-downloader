# Renderer architecture

## Component layout

```
src/renderer/src/
  main.ts                      Vue app entry point (creates Pinia, mounts App)
  App.vue                      Root shell — routing/layout only after Phase 4
  components/
    views/                     Top-level route views (one per sidebar entry)
      HomeView.vue
      SearchView.vue
      LibraryView.vue
      AnimeDetailView.vue
      DownloadsView.vue
      ShikimoriView.vue
      FriendsActivityView.vue
      CalendarView.vue
      PlayerView.vue
      SettingsView.vue         (thin wrapper around settings/SettingsShell.vue)
    shared/                    Reusable atoms used across views
      AnimeCard.vue
      CleanupModal.vue
      Sidebar.vue
    detail/                    AnimeDetailView sub-components + injection keys
      AnimeDetailShell.vue (= views/AnimeDetailView.vue acts as shell)
      ChronologyPanel.vue
      FriendsPanel.vue
      ShikimoriPanel.vue
      SkipDetectionPanel.vue
      EpisodeList.vue
      EpisodeRow.vue
      keys.ts                  InjectionKey<...> symbols for provide/inject
      translation-types.ts     Shared TRANSLATION_TYPES + typeChip(type)
    player/                    PlayerView sub-components (controls bar)
      PlayerTitleBar.vue
      TranslationMenu.vue
      QualityMenu.vue
      Anime4KMenu.vue
      SyncplayMenu.vue
    settings/                  SettingsView shell + 8 tab components
      SettingsShell.vue
      GeneralTab.vue
      StorageTab.vue
      ConnectorsTab.vue
      MergingTab.vue
      PlayerTab.vue
      ShortcutsTab.vue
      WatchTogetherTab.vue
      DebugTab.vue
  composables/                 Reactive logic (15 modules — see below)
  stores/                      Pinia stores (5 stores — see below)
  assets/                      Shared CSS
    theme.css                  Global design tokens + base + shared primitives (imported once in main.ts)
    player-menus.css           Imported scoped into each component
    settings-tabs.css
```

`App.vue` (~145 lines post-Phase-4) is route+layout only. Cross-view state lives in Pinia stores; cross-cutting reactive logic lives in composables. Components communicate with stores directly, not via prop drilling.

## Pinia stores

The five stores in `src/renderer/src/stores/` own cross-view state and, where applicable, the disposable IPC subscriptions for their domain (Phase 4 ownership rule — see [IPC](./ipc.md#broadcast-subscription-contract-phase-4-slice-4a-111)).

| Store | File | State | Subscriptions owned |
|---|---|---|---|
| `useLibraryStore` | `library.ts` | `currentView`, `animeByView[view]`, `animeHistoryByView[view]`, `focusEpisodeIntForAnime` | — |
| `usePlayerStore` | `player.ts` | `playerState` (`PlayerPayload \| null`), `animePrefs` | — |
| `useSettingsStore` | `settings.ts` | `shortcuts`, `ffmpegDownloading`/`Progress`, `fpcalcDownloading`/`Progress`, `updateStatus` | `onFfmpegDownloadProgress`, `onFpcalcDownloadProgress`, `onUpdateStatus` (lifetime-scoped) |
| `useShikimoriStore` | `shikimori.ts` | `user`, `loggedIn` (computed), `rates`, `animeDetails`, `syncStatus`, `offlineQueueLength` | `onShikimoriRateUpdated`, `onShikimoriRatesRefreshed`, `onShikimoriAnimeDetailsUpdated`, `onShikimoriOfflineQueueChanged`, `onShikimoriSyncStatus` (lifetime-scoped) |
| `useDownloadsStore` | `downloads.ts` | `groups`, `scanMergeProgress`, `fixMetadataProgress` | `onDownloadProgress`, `onScanMergeProgress`, `onFixMetadataProgress` (lifetime-scoped) |

Stores singleton-own their broadcast subscriptions and never dispose them — they live for the app's lifetime. Component-local subscriptions (per-anime, per-player-instance) bind to `onUnmounted` instead. See [IPC](./ipc.md) for the full ownership rule and the CI gate.

## Composables

Global reactive logic that doesn't belong on a Pinia store goes into `src/renderer/src/composables/`. Composables that own broadcast subscriptions or DOM listeners bind those inside themselves; pure-logic composables defer lifecycle to the caller (so they're callable from Vitest).

### App-level

- **`useKeyboardShortcuts({ bindings, suppressWhen, onAction })`** — binds a window-level keydown listener against the settings store's resolved bindings and dispatches the small set of app-wide actions (`back` / `focusSearch` / `goDownloads`). App.vue invokes it once at setup; the composable owns the event-listener lifecycle. (Phase 4 slice 4e)

### AnimeDetailView

- **`useChronology()`** — Shikimori chronology panel state (related list, loading, collapsed) + `loadRelated(malId)` IPC action for the AnimeDetailView chronology section. (Phase 5 slice 5b.1)
- **`useAnimeDetailPrefs()`** — per-anime translation type + selected author refs plus `applyDownloadedTranslationDefault(snapshot)` (picks the most-frequent downloaded type+author combo) and `loadInitialTranslationType(initialPrefs)`. The component wires a `watch` that persists changes to `usePlayerStore.saveAnimePrefs`. (Phase 5 slice 5b.1)
- **`useEpisodeList({ anime, episodeMeta, fileStatus, downloadGroups, watchProgress, … })`** — the heart of AnimeDetailView's reactivity surface. Owns the episodes Map, current page, probed `realQuality` cache, episodeOverrides, and focusApplied. Exposes `filteredEpisodes`, `pagedEpisodes`, `episodeRows` (the 5-priority selection: queued ↦ override ↦ remembered ↦ downloaded ↦ default), helper computeds (`translationTypeCounts`, `availableAuthors`), helpers (`bestPerAuthor`, `getRealHeight`, `qualityLabel`), and actions (`loadPageEpisodes`, `goToPage`, `probeSelectedQualities`, `onEpisodeTranslationChange`, `applyFocusEpisode`, `resetEpisodeOverrides`). Lifecycle hooks are *not* registered here — the consumer wires `onMounted` / watchers — which keeps the composable callable from Vitest. (Phase 5 slice 5b.1)
- **`useEpisodeDownloads({ anime, episodeMeta, fileStatus, downloadGroups, watchProgress, …, shiki*, downloadsStore, playerStore, playerMode, … })`** — file-on-disk helpers, download orchestration, watch progress, and continue-watching. Owns only the transient flags `downloading` + `errorMessage`; the data refs live at the component level so both this composable and `useEpisodeList` can read them without circular construction. Exposes helpers (`episodeProgressPercent`, `isEpisodeWatched`, `getFileForTranslation`, `hasAnyFile`, `selectedTrHasFile`, `buildTranslationList`, `buildAllEpisodes`, `dlProgress`, `getGroup`, `downloadGroupChanged`), computeds (`continueTarget`, `continueReady`, `continueLabel`, `hasActiveDownloads`), actions (`loadWatchProgress`, `checkFileStatus`, `updateDownloadGroups`, `downloadAll`, `downloadEpisode`, `cancelEpisodeDownload`, `cancelAllDownloads`, `openFile`, `playStream`, `showInFolder`, `deleteFile`, `continueWatching`), and a subscription (`subscribeFileEpisodesChanged`). `continueTarget` implements the 4-priority continue-watching algorithm (Shikimori-completed → eps[0] rewatch; Shikimori reports N → eps[N+1]; most recent unfinished saved position; first ep after last watched; else last ep). (Phase 5 slice 5b.2)
- **`useShikimori({ anime, shikimoriStore })`** — Shikimori panel state: rate edit form refs (status/episodes/score/rewatches), shikiUser + shikiUserChecked, shikiLoading/Saving/Error, shikiDetails + descExpanded, friendsRates + friendsLoading + friendsCollapsed, syncState + lastSyncError. Actions: `loadShikimoriData(loadRelated)`, `shikiSave`, `triggerSyncNow`. Owns the auto-status nudge watcher on shikiEpisodes plus the two store-cache mirror watchers (rateByMalId, animeDetailsByMalId). (Phase 5 slice 5b.4)
- **`useSkipDetection({ getAnimeId, filteredEpisodes, fileStatus })`** — local skip-detection state: detections, analyzing flags, progress, errors, chapter inject lifecycle. Computeds: `skipEpisodeInputs` (filtered/prefers-mkv), `skipMkvEpisodeCount`, `skipProgressLabel`, `chapterInjectProgressLabel`. Actions: `loadSkipDetections`, `hydrateSkipStatus`, `runSkipAnalysis`, `cancelSkipAnalysis`, `injectChaptersToMkv`. Three `subscribe*` init functions for the per-animeId-filtered broadcasts. (Phase 5 slice 5b.4)

### PlayerView

- **`useMsePlayer({ getVideoEl, setSyncplayLocalReady })`** — headless MSE / MKV streaming state machine extracted from `PlayerView.vue`. Owns the MediaSource + SourceBuffer lifecycle, the append queue + ack backpressure (`STREAM_ACK_THRESHOLD = 1 MB`), the buffer-ahead throttle (`MAX_BUFFER_AHEAD = 60s`), the debounced (`RESPAWN_DEBOUNCE_MS = 250`) unbuffered-seek → ffmpeg respawn flow with `currentStreamGen` gating to drop chunks from a stale ffmpeg run, the HEVC transcode-on-stream flag (`transcodingHevc` + `transcodeSpeed`/`transcodeLabel`), and a buffer-ahead gate that pauses playback for ~3s of lead time post-respawn on the transcode path. Returns reactive state (`mseSrcUrl`, `mkvBuffering`, `transcodingHevc`, `transcodeSpeed`, `transcodeLabel`, `streamSessionId`, `remuxError`, `mseInitialSeek`, `hasActiveSession`) + actions (`startMseSession`, `setTranscoding`, `resetMseState`, `maybeRespawnForUnbufferedPosition`, `pumpAppendQueue`, `isPlayheadBuffered`, `subscribeStreamEvents`). Does NOT own the orchestration around it (HEVC-consent prompt, legacy full-remux fallback, watch-progress resume) — that stays in `PlayerView` because it crosses multiple subsystems. Lifecycle hooks are not registered inside the composable; the consumer calls `subscribeStreamEvents()` from `onMounted` and `resetMseState()` from `onBeforeUnmount`. The `await sb.remove()` step polls `sb.updating` rather than waiting for a single `updateend`, because `sb.abort()` queues its own async `updateend` that would otherwise resolve the wait prematurely and let the next `sb.timestampOffset` assignment throw `InvalidStateError` — the root cause of the rapid-back-to-back-seek stutter pattern. (Phase 5 slice 5d.1)
- **`useAnime4K({ getVideoEl, getCanvasEl })`** — Anime4K WebGPU upscaling pipeline. Owns the GPU device + render-loop lifecycle, exposes `anime4kPreset` / `webgpuAvailable` / `gpuName` refs, `anime4kActive` and `presetLabel` computeds, plus `initWebGPU`, `startPipeline`, `stopPipeline`, and `destroy` actions. The consumer wires the preset-changed `watch` (persisting to settings + driving start/stop) and the loadedmetadata-gated initial start. Lifecycle is caller-managed for testability. (Phase 5 slice 5d.2.a)
- **`usePlayerKeyboard({ shortcuts, webgpuAvailable, onAction })`** — owns the PlayerView's document-level `keydown` listener and the binding-matching logic (Space/k/Arrows/f/m/Escape + configurable prev/next episode + shader presets). Dispatches `PlayerAction` strings via the `onAction` callback so the consumer holds the component-local actions (`togglePlay`, `seekRelative`, etc.). Registers `onMounted` / `onBeforeUnmount` internally — like `keyboard-shortcuts.ts` for the App shell. Shares `matchesBinding` + `isMac` with the App composable. (Phase 5 slice 5d.2.a)
- **`useSubtitles({ getVideoEl, getStreamSessionId })`** — ASS/SSA subtitle rendering for PlayerView. Owns the `SubtitlesOctopus` (libass-wasm) instance, the `activeSubtitleContent` ref, `initSubtitles(video)` / `destroySubtitles()`, a `redrawAfterFullscreen()` workaround for libass's resize-without-redraw bug, and `subscribeStreamSubtitles()` for the `player:stream-subtitles` IPC broadcast (gated by the caller-supplied session id). The consumer seeds `activeSubtitleContent` from props on mount and wires `onMounted` / `onBeforeUnmount` for the IPC sub + cleanup. (Phase 5 slice 5d.2.b)
- **`useRemux()`** — legacy MKV full-remux fallback state. Tiny composable (`remuxing` flag drives the loading overlay, `remuxedPath` feeds the `videoSrc` computed) + `runLegacyRemux(filePath)` that wraps the `player:remux-mkv` IPC + `clear()` for resets between sessions. Only used when MSE rejects the codecs and `prepareMkvForPlayback` falls back to a one-shot ffmpeg stream-copy to MP4. (Phase 5 slice 5d.2.b)
- **`useSkipMarkers({ getAnimeId, getCurrentEpisodeInt, getCurrentTime, isStreaming, activeStreamUrl, onSeek })`** — OP/ED skip-marker detection + skip button visibility for PlayerView. Owns the dual-mode detection (local playback reads stored per-episode boundaries via `skipDetectorGetDetections`; streamed playback runs `skipDetectorDetectStream` to fingerprint the live stream and match it against the locally-derived show signatures), the skip-button grace timer (debounces flicker when scrubbing through a band), the per-session "already-skipped" guard (so rewinding doesn't re-show the button), the request-id race guard on stream detection, the streaming reactivity watch (5-source: `isStreaming` / `activeStreamUrl` / episode-int / signature analyzedAt / source), and the `skip-detector:signature-updated` IPC subscription. `onMounted` + `onBeforeUnmount` are registered inside the composable (handles signature sub + cancel-in-flight on teardown). Exposes `loadSkipDetections`, `refreshStreamSkipDetection`, `cancelStreamDetection`, `onSkipClick`, `resetSkipUiState`. The consumer (PlayerView) only wires the episode-change reset because that path also touches prefetch state. Constants: `SKIP_GRACE_MS = 250`, `SKIP_LEAD_IN_SEC = 0.25`. (Phase 5 slice 5d.2.c)
- **`useSyncplayClient({ getVideoEl, getDuration, getAnimeId, getMalId, getAnimeName, getCurrentEpisodeInt, getActiveEpisodeLabel, activeTranslationId, activeEpisodeIndex, formatTime, onRemoteEpisodeChange })`** — Syncplay (Watch Together) client for PlayerView. Owns the connection state (`syncplayStatus`), room state (`syncplayRoomUsers`, `syncplayRoomInput`, `syncplayMenuOpen`), toast state (`syncplayToast`, `syncplayPausedBy`), internal local-ready/last-remote-playing flags, the suppress-window for echo-back prevention, the 1s snapshot heartbeat timer, all 6 IPC subscriptions (connection-status, remote-state, room-users, room-event, trace, remote-episode-change), the `applyRemoteState` apply pipeline (with seek + play-pause diff + suppress-window), the `applyReadyGate` (`shouldPlay = lastRemotePlaying && allUsersReady`), and the file-push + connection toggle helpers. Exposes `onLocalPlay` / `onLocalPause` / `onLocalCanPlay` so PlayerView's own video handlers can delegate the syncplay bookkeeping. The `onRemoteEpisodeChange` callback hands episode-change events back to PlayerView's navigator because the step-toward loop also touches `goToEpisode` + `activeEpisodeIndex`. `onMounted` loads status + saved room + installs the subs + starts the snapshot timer; `onBeforeUnmount` unsubs all 6 + clears 3 timers. Constant: `WAITING_DEBOUNCE_MS = 600`. (Phase 5 slice 5d.2.d)

### Settings

- **`useSettingsAutosave`** (`use-settings-autosave.ts`) — module-level singleton holding `savedVisible` + `showSaved` + `autoSave(key, value)`. Every tab calls `autoSave(...)` in its watchers; `SettingsShell` renders the toast. (Phase 5 slice 5a)

## Design system (Refined Dark)

`assets/theme.css` is the global styling foundation, imported once in `main.ts` (before `App.vue`). It defines the **Refined Dark** design language — the locked output of the [redesign epic #160](https://github.com/mikkerlo/anime-downloader/issues/160) (foundation: #161):

- **Tokens on `:root`** — surfaces (`--bg`, `--surface`, `--surface-2/3`), borders, text (`--text`, `--text-2/3`, `--text-faint`), accent (`--accent: #ef4d67` + `color-mix`-derived `--accent-hover/-soft/-line/-ink`), a status palette (`--st-blue/green/orange/purple/red`, `--star`), radii, regular-density spacing (`--gap`, `--pad-x/y`, `--row-pad`, `--poster-grid`), and font vars. Re-theming is a one-file edit; the multi-direction / density / Tweaks machinery from the design prototype was intentionally dropped.
- **Fonts are bundled, not CDN** — `main.ts` imports the needed weights of **Manrope** (`--font-ui`/`--font-display`) and **JetBrains Mono** (`--font-data`, used for speeds/sizes/ETAs/episode numbers) from `@fontsource/*`. The per-weight CSS ships every subset incl. **Cyrillic** (Russian titles). No network dependency, so the app's offline modes render correctly. A guard test (`test/renderer/theme-tokens.test.ts`) fails the build on any remote `url()` / `@import` / Google Fonts reference in renderer source.
- **Base + scrollbar** — the reset, `body`, `.app`, and themed scrollbar live here (moved out of `App.vue`).
- **Shared primitives** — global classes the redesigned chrome uses: the `.sidebar` family (logo mark, `.nav-group`/`.nav-item` + count pill, `.user-chip`), the `.acard` poster-grid card (with its `.poster-wrap`/`.star-btn`/`.score-badge`/`.watch-bar` nested **under `.acard`** so they don't leak onto the bare `.poster`/`.score-badge` classes other not-yet-restyled components still own), `.pbar`, `.pill-tabs`, `.select-wrap`, `.empty-state`, `.poster-grid`. Generic colliding primitives (`.btn`, `.chip`, bare `.poster`, `.topbar`) are deliberately **not** globalized yet — they're added by the per-screen redesign issues that adopt them, to avoid changing screens that haven't been restyled.

## Path aliases

`@shared`, `@main`, `@renderer` are wired in `electron.vite.config.ts` + `tsconfig.node.json` + `tsconfig.web.json` so cross-process imports don't churn relative paths and an ESLint boundary rule can keep `renderer/` from importing from `main/`.

Shared CSS (`assets/player-menus.css`, `assets/settings-tabs.css`) is imported scoped into each consumer via `<style scoped src="@renderer/assets/<file>.css">` so every component gets its own scoped copy without pulling Vue-specific tooling out of `<style>` blocks.
