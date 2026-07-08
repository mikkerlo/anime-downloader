/**
 * Canonical list of persisted `electron-store` keys.
 *
 * This is a rename guard: `index.ts` asserts at compile time that the keys of
 * its `STORE_DEFAULTS` exactly equal this tuple, and a unit test pins the tuple
 * itself. Silently renaming a persisted key would orphan users' existing data,
 * so both ends must change together and deliberately.
 */
export const PERSISTED_STORE_KEYS = [
  'token',
  'translationType',
  'downloadDir',
  'library',
  'autoMerge',
  'videoCodec',
  'downloadedAnime',
  'downloadedEpisodes',
  'animeCache',
  'lastUpdateCheck',
  'notificationMode',
  'downloadSpeedLimit',
  'concurrentDownloads',
  'keyboardShortcuts',
  'shikimoriCredentials',
  'shikimoriUser',
  'storageMode',
  'hotStorageDir',
  'coldStorageDir',
  'autoMoveToCold',
  'malIdMap',
  'playerMode',
  'playerVolume',
  'playerMuted',
  'anime4kPreset',
  'hevcTranscodeOnPlay',
  'prefetchNextEpisode',
  'watchProgress',
  'watchProgressMigrationV2',
  'autoCleanupWatchedDays',
  'autoCleanupConfirm',
  'autoCleanupLastRun',
  'cleanupLog',
  'shikimoriUserRates',
  'shikimoriUpdateQueue',
  'shikimoriAnimeDetails',
  'autoDownloadSubscriptions',
  'autoDownloadEnabled',
  'recentAnimeMeta',
  'skipDetections',
  'skipFingerprintCache',
  'enableLocalSkipDetection',
  'calendarView',
  'syncplay',
  'mp4StreamingStats',
  'autoCleanupSnoozedAnimeIds',
  'dismissedContinueWatching',
  'shikimoriProfile',
  'shikimoriFriends',
  'shikimoriRecommendations'
] as const

export type PersistedStoreKey = (typeof PERSISTED_STORE_KEYS)[number]
