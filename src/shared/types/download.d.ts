// Shared domain types — download queue, merging, auto-downloader.
// Ambient globals (see anime.ts header). Part of #84 Phase 1 slice 1a.

interface EpisodeMeta {
  translationType: string
  author: string
  quality: number
  translationId: number
}

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

interface DownloadProgressItem {
  id: string
  translationId: number
  kind: 'video' | 'subtitle'
  url: string
  filename: string
  animeName: string
  episodeLabel: string
  quality: number
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled'
  bytesReceived: number
  totalBytes: number
  speed: number
  error?: string
}

interface EpisodeGroup {
  translationId: number
  animeName: string
  animeId: number
  episodeInt: string
  episodeLabel: string
  quality: number
  translationType: string
  author: string
  video: DownloadProgressItem | null
  subtitle: DownloadProgressItem | null
  mergeStatus: 'pending' | 'merging' | 'completed' | 'failed'
  // True when there is a real `mergeStatuses` entry (merge was started, even
  // if it crashed and was restored as `pending` on the next boot). False when
  // the group has never been merged — UI uses this to distinguish "ready for
  // merge" (clearable) from crash-recovered "pending" (preserve so the user
  // can retry via Merge finished).
  hasMergeEntry: boolean
  mergePercent?: number
  mergeError?: string
}

interface ScanMergeProgress {
  current: number
  total: number
  file: string
  percent: number
}

interface AutoDownloadSubscription {
  animeId: number
  malId: number
  animeName: string
  subscribedAt: number
  lastEnqueuedEpisodeInt: number
  lastCheckedAt: number
  initialEpisodesAired?: number
}

interface AutoDlOutcome {
  animeId: number
  animeName: string
  episodeInt: string
  outcome:
    | 'enqueued'
    | 'no-translation'
    | 'no-episode'
    | 'already-downloaded'
    | 'already-queued'
    | 'embed-failed'
    | 'no-episodes-aired'
    | 'cap-reached'
    | 'error'
  message?: string
}

interface AutoDlTickResult {
  ranAt: number
  reason: 'startup' | 'timer' | 'rates-refreshed' | 'manual'
  enqueued: number
  skipped: number
  errors: number
  details: AutoDlOutcome[]
}
