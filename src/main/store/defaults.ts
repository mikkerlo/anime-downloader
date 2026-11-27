import type * as shikimori from '../shikimori'
import type { AnimeSearchResult } from '../smotret-api'
import type { AnimeCacheEntry } from '../services/anime-cache'
import type { ParkedQueues } from '../lib/shikimori-queue'
import type { ShowSkipDetections, CachedFingerprint } from '../skip-detector'
import type { Mp4StreamingStats } from '../mp4-faststart'
import type { AutoDownloadSubscription } from '../index'
import type { VaultBlob } from '../trackers/credential-vault'
import type { MalClientConfig } from '../trackers/client-config'
import type { PersistedStoreKey } from './keys'

// The electron-store defaults. They live outside `src/main/index.ts` so a test
// can open the real storage service with them (`index.ts` boots the app when
// imported). `test/store/defaults.test.ts` pins every value against the 6.0.21
// dump in `test/fixtures/store-defaults-6.0.21.json`.
export const STORE_DEFAULTS = {
  token: '',
  translationType: 'subRu',
  downloadDir: '',
  library: {} as Record<string, AnimeSearchResult>,
  autoMerge: false,
  videoCodec: 'copy' as string,
  downloadedAnime: {} as Record<string, AnimeSearchResult>,
  downloadedEpisodes: {} as Record<
    string,
    { translationType: string; author: string; quality: number; translationId: number }
  >,
  animeCache: {} as Record<string, AnimeCacheEntry>,
  lastUpdateCheck: 0,
  notificationMode: 'off' as string,
  downloadSpeedLimit: 0,
  concurrentDownloads: 2,
  keyboardShortcuts: {
    back: 'Escape',
    focusSearch: 'CmdOrCtrl+F',
    goDownloads: 'CmdOrCtrl+D',
    playerPrevEpisode: 'Shift+ArrowLeft',
    playerNextEpisode: 'Shift+ArrowRight',
    shaderModeA: 'CmdOrCtrl+1',
    shaderModeB: 'CmdOrCtrl+2',
    shaderModeC: 'CmdOrCtrl+3',
    shaderOff: 'CmdOrCtrl+Backquote'
  } as Record<string, string>,
  shikimoriCredentials: null as shikimori.ShikiCredentials | null,
  shikimoriUser: null as shikimori.ShikiUser | null,
  storageMode: 'simple' as 'simple' | 'advanced',
  hotStorageDir: '' as string,
  coldStorageDir: '' as string,
  autoMoveToCold: false,
  malIdMap: {} as Record<string, AnimeSearchResult>,
  playerMode: 'system' as 'system' | 'builtin',
  playerVolume: 1 as number,
  playerMuted: false,
  anime4kPreset: 'off' as 'off' | 'mode-a' | 'mode-b' | 'mode-c',
  hevcTranscodeOnPlay: 'ask' as 'ask' | 'always' | 'never',
  prefetchNextEpisode: 'progress-50' as 'off' | 'open' | 'time-5min' | 'progress-50',
  watchProgress: {} as Record<string, WatchProgressEntry>,
  watchProgressMigrationV2: false,
  autoCleanupWatchedDays: 0,
  autoCleanupConfirm: true,
  autoCleanupLastRun: null as { ranAt: number; deletedCount: number; freedBytes: number } | null,
  cleanupLog: [] as {
    ranAt: number
    animeId: number
    animeName: string
    episodeInt: string
    bytes: number
  }[],
  shikimoriUserRates: [] as unknown[],
  shikimoriUpdateQueue: [] as unknown[],
  shikimoriParkedQueues: {} as ParkedQueues,
  shikimoriSessionExpired: false,
  shikimoriAnimeDetails: {} as Record<
    string,
    { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
  >,
  autoDownloadSubscriptions: {} as Record<string, AutoDownloadSubscription>,
  autoDownloadEnabled: true,
  recentAnimeMeta: {} as Record<string, AnimeSearchResult>,
  skipDetections: {} as Record<string, ShowSkipDetections>,
  skipFingerprintCache: {} as Record<string, CachedFingerprint>,
  enableLocalSkipDetection: true,
  calendarView: 'week' as 'week' | 'month',
  syncplay: {
    lastHost: 'syncplay.pl',
    lastPort: 8999,
    lastRoom: '',
    username: '',
    autoReconnect: true
  } as {
    lastHost: string
    lastPort: number
    lastRoom: string
    username: string
    autoReconnect: boolean
  },
  // Deliberately outside the `syncplay` object: the renderer overwrites that
  // wholesale on every settings save and would drop it (#216).
  syncplayPassword: '',
  mp4StreamingStats: {
    totalChecked: 0,
    faststartCount: 0,
    nonFaststartSamples: [] as {
      animeId: number
      animeName: string
      episodeInt: string
      episodeLabel: string
      filePath: string
      firstNonFtypBox: string
      checkedAt: number
    }[]
  } as Mp4StreamingStats,
  autoCleanupSnoozedAnimeIds: {} as Record<string, true>,
  dismissedContinueWatching: [] as string[],
  shikimoriProfile: null as ShikimoriProfile | null,
  shikimoriFriends: [] as ShikiFriendCard[],
  shikimoriRecommendations: [] as RecommendationEntry[],
  priorityAnimeIds: [] as string[],
  installId: '',
  syncMeta: { titles: {}, rates: {} } as SyncMeta,
  workOffline: false,
  attachedLibraries: {} as Record<string, AttachedLibraryRecord>,
  sharedLibraryPromptDismissed: [] as string[],
  prepareOfflineLastRun: null as PrepareOfflineLastRun | null,
  // AniList, MyAnimeList and the shared tracker choices (#690, epic #688). No
  // migration: conf merges these under an existing file at their defaults.
  // The two credential keys and `myanimelistClientSecret` hold only the
  // credential vault's blob (`trackers/credential-vault.ts`), never a secret.
  anilistCredentials: null as VaultBlob | null,
  anilistUser: null as TrackerUser | null,
  anilistSessionExpired: false,
  anilistUserRates: [] as unknown[],
  anilistUpdateQueue: [] as unknown[],
  anilistParkedQueues: {} as ParkedQueues,
  anilistAnimeDetails: {} as Record<string, unknown>,
  anilistIdMap: {} as Record<string, unknown>,
  // The Friends page's AniList cards (#712): a display cache, like `shikimoriFriends`.
  anilistFriends: [] as unknown[],
  myanimelistCredentials: null as VaultBlob | null,
  myanimelistUser: null as TrackerUser | null,
  myanimelistSessionExpired: false,
  myanimelistUserRates: [] as unknown[],
  myanimelistUpdateQueue: [] as unknown[],
  myanimelistParkedQueues: {} as ParkedQueues,
  myanimelistAnimeDetails: {} as Record<string, unknown>,
  myanimelistClientConfig: null as MalClientConfig | null,
  myanimelistClientSecret: null as VaultBlob | null,
  // Null until #696 (T3c) resolves it: the stored primary if connected, else
  // the first connected tracker. A missing `trackerMirror` entry means on; a
  // missing `trackerFeatureSource` entry means automatic.
  trackerPrimary: null as TrackerId | null,
  trackerMirror: {} as Partial<Record<TrackerId, boolean>>,
  trackerFeatureSource: {} as Record<string, TrackerId>
}

/**
 * Top-level keys persisted synchronously on every write instead of debounced:
 * queued offline edits and auth material, whose last write must survive a
 * crash inside the coalescing window. `myanimelistClientConfig` is not one: it
 * holds only the client ID, which is in every authorize URL.
 */
export const WRITE_THROUGH_KEYS = [
  'shikimoriUpdateQueue',
  'shikimoriParkedQueues',
  'token',
  'shikimoriCredentials',
  'anilistUpdateQueue',
  'anilistParkedQueues',
  'anilistCredentials',
  'myanimelistUpdateQueue',
  'myanimelistParkedQueues',
  'myanimelistCredentials',
  'myanimelistClientSecret'
] as const satisfies readonly PersistedStoreKey[]

// Compile-time guard: `STORE_DEFAULTS` keys must equal `PERSISTED_STORE_KEYS`.
// Renaming a default key without updating the tuple breaks this assertion,
// stopping the build before a release silently orphans user data.
type _AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _storeKeysInSync: _AssertExact<keyof typeof STORE_DEFAULTS & string, PersistedStoreKey> = true
void _storeKeysInSync
