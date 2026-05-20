import { describe, it, expect } from 'vitest'
import { PERSISTED_STORE_KEYS } from '../../src/main/store/keys'

describe('PERSISTED_STORE_KEYS', () => {
  // Frozen reference list. Adding a persisted key MUST update both
  // PERSISTED_STORE_KEYS and this expected list in the same commit — that is
  // the deliberate change required to widen the persisted schema. Renames
  // additionally need a migration in src/main/store/migrate.ts.
  const EXPECTED = [
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
    'autoCleanupSnoozedAnimeIds'
  ] as const

  it('matches the frozen expected key set exactly (order and content)', () => {
    expect([...PERSISTED_STORE_KEYS]).toEqual([...EXPECTED])
  })

  it('contains no duplicates', () => {
    expect(new Set(PERSISTED_STORE_KEYS).size).toBe(PERSISTED_STORE_KEYS.length)
  })
})
