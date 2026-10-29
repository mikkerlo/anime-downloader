// When a pre-fetched episode (#577) is ready to export: the one decision, run
// on every download / merge event, on a 3 s tick while an item waits, and when
// a job runs after a boot or a resume. Events only make it run sooner; they
// never decide it, because several ways an item becomes ready fire none (a
// subtitle that lands after its video, auto-merge on without ffmpeg, a failed
// or cancelled merge). docs/shared-library.md ("Pre-fetch") has the table.
//
// A pure function of what it is handed, so the live path, the resume path and
// a test all get the same answer for the same state.

import type { DownloadStatus, MergeStatus } from '../../download-manager'

/** The 3 s tick, and how far apart the two idle sightings of a cancelled merge must be. */
export const PREFETCH_TICK_MS = 3_000
/** How long after its downloads finished an expected merge that never started is given up on. */
export const MERGE_GRACE_MS = 5_000

export const NO_LONGER_QUEUED = 'Download no longer queued'
export const DOWNLOAD_CANCELLED = 'Download cancelled'
export const SUBTITLES_FAILED = 'Subtitles failed to download'

/** A download queue row (`getItem('video-<tr>')`, `getItem('sub-<tr>')`). */
export interface PrefetchRow {
  status: DownloadStatus
  error?: string
  bytesReceived: number
  totalBytes: number
  /** The stream height the download used. */
  quality?: number
}

export interface PrefetchState {
  video: PrefetchRow | null
  subtitle: PrefetchRow | null
  mergeStatus: MergeStatus | null
  /** `isMergeExpected(...)`, read for this evaluation after `ffmpegStatus.get()`. */
  mergeExpected: boolean
  /** `isMergeCycleActive()`, `hasHeldMerge()` or the player is open. */
  mergeInFlight: boolean
  /** The translation's files in the hot and cold roots: its `.mkv`, and its final `.mp4`. */
  files: { mkv: boolean; video: boolean }
  offline: boolean
  now: number
}

/** What an item carries between evaluations: `doneAt` is persisted, `idleSince` isn't. */
export interface PrefetchMemory {
  /** When its rows were first seen all finished. */
  doneAt?: number
  /** When "a merge is expected and nothing is in flight" was first seen, on consecutive evaluations. */
  idleSince?: number
}

export type PrefetchDecision =
  | { kind: 'wait'; on: 'download' | 'connection' | 'merge'; percent: number }
  | { kind: 'ready'; as: 'mkv' | 'pair'; warning: string | null }
  | { kind: 'failed'; reason: string }

const ACTIVE: ReadonlySet<DownloadStatus> = new Set(['queued', 'downloading', 'paused'])

function percentOf(row: PrefetchRow): number {
  return row.totalBytes > 0 ? Math.floor((row.bytesReceived / row.totalBytes) * 100) : 0
}

function waitDownload(row: PrefetchRow, offline: boolean): PrefetchDecision {
  // Offline (#567) leaves a queued download queued: it waits for the connection.
  const on = offline && row.status !== 'paused' ? 'connection' : 'download'
  return { kind: 'wait', on, percent: percentOf(row) }
}

export function evaluatePrefetchItem(
  s: PrefetchState,
  memory: PrefetchMemory
): { decision: PrefetchDecision; memory: PrefetchMemory } {
  const out = (
    decision: PrefetchDecision,
    m: PrefetchMemory = memory
  ): ReturnType<typeof evaluatePrefetchItem> => ({ decision, memory: m })

  // 1. The video row.
  if (s.video) {
    if (ACTIVE.has(s.video.status)) return out(waitDownload(s.video, s.offline))
    if (s.video.status === 'failed') {
      return out({ kind: 'failed', reason: s.video.error || 'Download failed' })
    }
    if (s.video.status === 'cancelled') return out({ kind: 'failed', reason: DOWNLOAD_CANCELLED })
  }
  // 2. The subtitle row: one still going is waited for; a failed one leaves the video.
  let warning: string | null = null
  if (s.subtitle) {
    if (ACTIVE.has(s.subtitle.status)) return out(waitDownload(s.subtitle, s.offline))
    if (s.subtitle.status === 'failed' || s.subtitle.status === 'cancelled') {
      warning = SUBTITLES_FAILED
    }
  }
  // 7. No video row: only files on disk keep the item going.
  const onDisk = s.files.mkv || s.files.video
  if (!s.video && !onDisk && s.mergeStatus !== 'deferred') {
    return out({ kind: 'failed', reason: NO_LONGER_QUEUED })
  }

  const m: PrefetchMemory = { ...memory, doneAt: memory.doneAt ?? s.now }

  // 3. The only two waits on the merge status.
  if (s.mergeStatus === 'deferred' || s.mergeStatus === 'merging') {
    return out({ kind: 'wait', on: 'merge', percent: 0 }, { ...m, idleSince: undefined })
  }
  // 4. Merged.
  if (s.mergeStatus === 'completed' || s.files.mkv) {
    return out({ kind: 'ready', as: 'mkv', warning }, { ...m, idleSince: undefined })
  }
  // 5. A failed merge leaves the pair.
  if (s.mergeStatus === 'failed') {
    return out({ kind: 'ready', as: 'pair', warning }, { ...m, idleSince: undefined })
  }
  // 6. `null` or `'pending'`: the job never starts a merge itself.
  if (!s.mergeExpected)
    return out({ kind: 'ready', as: 'pair', warning }, { ...m, idleSince: undefined })
  if (s.mergeInFlight) {
    return out({ kind: 'wait', on: 'merge', percent: 0 }, { ...m, idleSince: undefined })
  }
  // A merge is expected and nothing runs or is held: a cancelled merge, a pass
  // that skipped the group, or a `'pending'` a kill left. Given up on after two
  // idle sightings ≥ 3 s apart and ≥ 5 s past `doneAt`; the grace covers the
  // 100 ms `episodeComplete` timer and the awaits before `merging` is set.
  const idleSince = m.idleSince ?? s.now
  if (s.now - idleSince >= PREFETCH_TICK_MS && s.now - m.doneAt! >= MERGE_GRACE_MS) {
    return out({ kind: 'ready', as: 'pair', warning }, { ...m, idleSince })
  }
  return out({ kind: 'wait', on: 'merge', percent: 0 }, { ...m, idleSince })
}
