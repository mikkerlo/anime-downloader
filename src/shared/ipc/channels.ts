// Single source of truth for IPC channel names (epic #84, decision 1).
//
// Channel names live here once, as an `as const` object, and are dereferenced
// by symbol on both sides of the boundary — `main` registers handlers against
// these constants and `preload` builds `window.api` from them (wired in the
// Phase 1c slice). A rename becomes a compile error instead of a silent miss,
// retiring the error-prone "update the same string literal in 4 files" rule.
//
// This module is intentionally additive: nothing imports it yet, so Phase 1b
// is behavior-identical. The literals below are the exhaustive set extracted
// from the existing `src/main/index.ts` + `src/preload/index.ts` (verified by
// test/ipc-channels.test.ts).

/**
 * Request/response channels — renderer `ipcRenderer.invoke` (or fire-and-forget
 * `send`) handled by a single `ipcMain.handle`/`ipcMain.on` in main.
 */
export const CHANNELS = {
  // App
  APP_VERSION: 'app:version',

  // Updates
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',

  // Auto-downloader
  AUTO_DL_GET_ENABLED: 'auto-dl:get-enabled',
  AUTO_DL_GET_STATUS: 'auto-dl:get-status',
  AUTO_DL_GET_SUBSCRIPTION: 'auto-dl:get-subscription',
  AUTO_DL_LIST_SUBSCRIPTIONS: 'auto-dl:list-subscriptions',
  AUTO_DL_SET_ENABLED: 'auto-dl:set-enabled',
  AUTO_DL_SET_SUBSCRIPTION: 'auto-dl:set-subscription',
  AUTO_DL_TRIGGER: 'auto-dl:trigger',

  // Cleanup
  CLEANUP_EXECUTE: 'cleanup:execute',
  CLEANUP_GET_ACTIVE_DOWNLOADS: 'cleanup:get-active-downloads',
  CLEANUP_GET_SIZE: 'cleanup:get-size',
  CLEANUP_GET_SNOOZED: 'cleanup:get-snoozed',
  CLEANUP_SET_SNOOZED: 'cleanup:set-snoozed',

  // Debug
  DEBUG_GET_MP4_STATS: 'debug:get-mp4-stats',
  DEBUG_RESET_MP4_STATS: 'debug:reset-mp4-stats',

  // Downloads
  DOWNLOAD_CANCEL: 'download:cancel',
  DOWNLOAD_CANCEL_BY_EPISODE: 'download:cancel-by-episode',
  DOWNLOAD_CANCEL_MERGE: 'download:cancel-merge',
  DOWNLOAD_CLEAR_COMPLETED: 'download:clear-completed',
  DOWNLOAD_ENQUEUE: 'download:enqueue',
  DOWNLOAD_FIX_METADATA: 'download:fix-metadata',
  DOWNLOAD_GET_QUEUE: 'download:get-queue',
  DOWNLOAD_INJECT_CHAPTERS: 'download:inject-chapters',
  DOWNLOAD_MERGE: 'download:merge',
  DOWNLOAD_PAUSE: 'download:pause',
  DOWNLOAD_PAUSE_ALL: 'download:pause-all',
  DOWNLOAD_PICK_DIR: 'download:pick-dir',
  DOWNLOAD_RESTART: 'download:restart',
  DOWNLOAD_RESTART_ALL_FAILED: 'download:restart-all-failed',
  DOWNLOAD_RESUME: 'download:resume',
  DOWNLOAD_RESUME_ALL: 'download:resume-all',
  DOWNLOAD_SCAN_MERGE: 'download:scan-merge',

  // ffmpeg
  FFMPEG_CHECK: 'ffmpeg:check',
  FFMPEG_DELETE: 'ffmpeg:delete',

  // File management
  FILE_CHECK_EPISODES: 'file:check-episodes',
  FILE_DELETE_EPISODE: 'file:delete-episode',
  FILE_OPEN: 'file:open',
  FILE_SHOW_IN_FOLDER: 'file:show-in-folder',

  // Home
  HOME_GET_CONTINUE_WATCHING: 'home:get-continue-watching',

  // Player
  PLAYER_CLEANUP_REMUX: 'player:cleanup-remux',
  PLAYER_FIND_LOCAL_FILE: 'player:find-local-file',
  PLAYER_GET_LOCAL_SUBTITLES: 'player:get-local-subtitles',
  PLAYER_GET_STREAM_URL: 'player:get-stream-url',
  PLAYER_REMUX_MKV: 'player:remux-mkv',
  PLAYER_REMUX_MKV_STREAM: 'player:remux-mkv-stream',
  PLAYER_REMUX_MKV_STREAM_TRANSCODE: 'player:remux-mkv-stream-transcode',
  PLAYER_STREAM_ACK: 'player:stream-ack',
  PLAYER_STREAM_SEEK: 'player:stream-seek',
  PLAYER_STREAM_START: 'player:stream-start',

  // Shell
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  SHELL_OPEN_EXTERNAL_FILE: 'shell:open-external-file',

  // Shikimori
  SHIKIMORI_EXCHANGE_CODE: 'shikimori:exchange-code',
  SHIKIMORI_GET_ANIME_DETAILS: 'shikimori:get-anime-details',
  SHIKIMORI_GET_ANIME_RATES: 'shikimori:get-anime-rates',
  SHIKIMORI_GET_AUTH_URL: 'shikimori:get-auth-url',
  SHIKIMORI_GET_CALENDAR: 'shikimori:get-calendar',
  SHIKIMORI_GET_FRIENDS_ACTIVITY: 'shikimori:get-friends-activity',
  SHIKIMORI_GET_FRIENDS_RATES: 'shikimori:get-friends-rates',
  SHIKIMORI_GET_OFFLINE_QUEUE_LENGTH: 'shikimori:get-offline-queue-length',
  SHIKIMORI_GET_PROFILE: 'shikimori:get-profile',
  SHIKIMORI_GET_RATE: 'shikimori:get-rate',
  SHIKIMORI_GET_RELATED: 'shikimori:get-related',
  SHIKIMORI_GET_SYNC_STATUS: 'shikimori:get-sync-status',
  SHIKIMORI_GET_USER: 'shikimori:get-user',
  SHIKIMORI_LOGOUT: 'shikimori:logout',
  SHIKIMORI_TRIGGER_DETAIL_PREFETCH: 'shikimori:trigger-detail-prefetch',
  SHIKIMORI_TRIGGER_SYNC: 'shikimori:trigger-sync',
  SHIKIMORI_UPDATE_RATE: 'shikimori:update-rate',

  // Skip detection
  SKIP_DETECTOR_ANALYZE_SHOW: 'skip-detector:analyze-show',
  SKIP_DETECTOR_BACKFILL_ALL: 'skip-detector:backfill-all',
  SKIP_DETECTOR_CACHE_STATS: 'skip-detector:cache-stats',
  SKIP_DETECTOR_CANCEL: 'skip-detector:cancel',
  SKIP_DETECTOR_CANCEL_STREAM_DETECT: 'skip-detector:cancel-stream-detect',
  SKIP_DETECTOR_DETECT_STREAM: 'skip-detector:detect-stream',
  SKIP_DETECTOR_GET_DETECTIONS: 'skip-detector:get-detections',
  SKIP_DETECTOR_GET_STATUS: 'skip-detector:get-status',
  SKIP_DETECTOR_QUEUE_STATUS: 'skip-detector:queue-status',

  // Storage
  STORAGE_GET_USAGE: 'storage:get-usage',
  STORAGE_MOVE_TO_COLD: 'storage:move-to-cold',
  STORAGE_PICK_COLD_DIR: 'storage:pick-cold-dir',
  STORAGE_PICK_HOT_DIR: 'storage:pick-hot-dir',
  STORAGE_RUN_CLEANUP: 'storage:run-cleanup',

  // Syncplay
  SYNCPLAY_CONNECT: 'syncplay:connect',
  SYNCPLAY_DISCONNECT: 'syncplay:disconnect',
  SYNCPLAY_GET_STATUS: 'syncplay:get-status',
  SYNCPLAY_LOCAL_SNAPSHOT: 'syncplay:local-snapshot',
  SYNCPLAY_LOCAL_STATE: 'syncplay:local-state',
  SYNCPLAY_SET_FILE: 'syncplay:set-file',
  SYNCPLAY_SET_READY: 'syncplay:set-ready',

  // Watch progress
  WATCH_PROGRESS_GET: 'watch-progress:get',
  WATCH_PROGRESS_GET_ALL: 'watch-progress:get-all',
  WATCH_PROGRESS_SAVE: 'watch-progress:save',

  // Core / legacy un-namespaced
  CACHE_GET_POSTER: 'cache-get-poster',
  DOWNLOADED_ANIME_ADD: 'downloaded-anime-add',
  DOWNLOADED_ANIME_DELETE: 'downloaded-anime-delete',
  DOWNLOADED_EPISODES_GET: 'downloaded-episodes-get',
  DUMP_QUALITY_MISMATCHES: 'dump-quality-mismatches',
  GET_ANIME: 'get-anime',
  GET_ANIME_CACHE: 'get-anime-cache',
  GET_EPISODE: 'get-episode',
  GET_EPISODES_BATCH: 'get-episodes-batch',
  GET_QUALITY_MISMATCH_COUNT: 'get-quality-mismatch-count',
  GET_SETTING: 'get-setting',
  LIBRARY_GET: 'library-get',
  LIBRARY_GET_STATUS: 'library-get-status',
  LIBRARY_HAS: 'library-has',
  LIBRARY_IS_DOWNLOADED: 'library-is-downloaded',
  LIBRARY_TOGGLE: 'library-toggle',
  PROBE_EMBED_QUALITY: 'probe-embed-quality',
  PROBE_FULL_SCAN_DONE: 'probe-full-scan-done',
  PROBE_FULL_SCAN_NEEDED: 'probe-full-scan-needed',
  REPORT_QUALITY_MISMATCH: 'report-quality-mismatch',
  SEARCH_ANIME: 'search-anime',
  SET_ANIME_CACHE: 'set-anime-cache',
  SET_SETTING: 'set-setting',
  VALIDATE_TOKEN: 'validate-token'
} as const

/**
 * Broadcast channels — main `webContents.send`, observed by the renderer.
 * Their subscriptions must follow {@link EventSubscriber} (epic #84, decision 2).
 */
export const EVENT_CHANNELS = {
  // Updates
  UPDATE_STATUS: 'update:status',

  // Auto-downloader
  AUTO_DL_ENQUEUED: 'auto-dl:enqueued',
  AUTO_DL_TICK_RESULT: 'auto-dl:tick-result',

  // Cleanup
  CLEANUP_PROMPT: 'cleanup:prompt',

  // Downloads
  DOWNLOAD_PROGRESS: 'download:progress',

  // ffmpeg
  FFMPEG_DOWNLOAD_PROGRESS: 'ffmpeg:download-progress',

  // fpcalc
  FPCALC_DOWNLOAD_PROGRESS: 'fpcalc:download-progress',

  // Fix metadata
  FIX_METADATA_PROGRESS: 'fix-metadata:progress',

  // Scan-merge
  SCAN_MERGE_PROGRESS: 'scan-merge:progress',

  // Chapter injection
  CHAPTER_INJECT_PROGRESS: 'chapter-inject:progress',

  // File management
  FILE_EPISODES_CHANGED: 'file:episodes-changed',

  // Player
  PLAYER_STREAM_CHUNK: 'player:stream-chunk',
  PLAYER_STREAM_END: 'player:stream-end',
  PLAYER_STREAM_ERROR: 'player:stream-error',
  PLAYER_STREAM_PROGRESS: 'player:stream-progress',
  PLAYER_STREAM_SUBTITLES: 'player:stream-subtitles',

  // Shikimori
  SHIKIMORI_ANIME_DETAILS_UPDATED: 'shikimori:anime-details-updated',
  SHIKIMORI_OFFLINE_QUEUE_CHANGED: 'shikimori:offline-queue-changed',
  SHIKIMORI_PROFILE_REFRESHED: 'shikimori:profile-refreshed',
  SHIKIMORI_RATE_UPDATED: 'shikimori:rate-updated',
  SHIKIMORI_RATES_REFRESHED: 'shikimori:rates-refreshed',
  SHIKIMORI_SYNC_STATUS: 'shikimori:sync-status',

  // Skip detection
  SKIP_DETECTOR_ANALYZE_PROGRESS: 'skip-detector:analyze-progress',
  SKIP_DETECTOR_SIGNATURE_UPDATED: 'skip-detector:signature-updated',

  // Storage
  STORAGE_CLEANUP_FINISHED: 'storage:cleanup-finished',
  STORAGE_CLEANUP_PENDING: 'storage:cleanup-pending',
  STORAGE_MOVE_TO_COLD_PROGRESS: 'storage:move-to-cold-progress',
  STORAGE_USAGE_PROGRESS: 'storage:usage-progress',

  // Syncplay
  SYNCPLAY_CONNECTION_STATUS: 'syncplay:connection-status',
  SYNCPLAY_REMOTE_EPISODE_CHANGE: 'syncplay:remote-episode-change',
  SYNCPLAY_REMOTE_STATE: 'syncplay:remote-state',
  SYNCPLAY_ROOM_EVENT: 'syncplay:room-event',
  SYNCPLAY_ROOM_USERS: 'syncplay:room-users',
  SYNCPLAY_TRACE: 'syncplay:trace'
} as const

export type RequestChannel = (typeof CHANNELS)[keyof typeof CHANNELS]
export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS]

/**
 * Handle returned by every broadcast subscription. Calling it removes **only
 * the listener it was created for** — never `removeAllListeners` (epic #84,
 * decision 2), so independent subscribers on the same channel don't clobber
 * each other and nothing leaks if a caller forgets to unsubscribe before the
 * next subscribe.
 */
export type Unsubscribe = () => void

/**
 * Contract for a broadcast-channel subscription on `window.api`. Phase 1c
 * replaces the ad-hoc `on*`/`off*` pairs with functions of this shape;
 * renderer owners bind the returned {@link Unsubscribe} to `onUnmounted`
 * or a Pinia store's disposal (Phase 4).
 */
export type EventSubscriber<T> = (listener: (payload: T) => void) => Unsubscribe
