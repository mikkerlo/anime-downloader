// What changes when the app goes offline or comes back (#567). `index.ts`
// hands these two edges to the OfflineService as its `onOffline` / `onOnline`.

export const AUTO_DOWNLOAD_STAGGER_MS = 5_000
export const PREFETCH_STAGGER_MS = 10_000

/** One tracker's part of the online edge (#693). */
export interface KickoffTracker {
  /** `run()`'s label: `'<Name> queue drain'`. */
  drainLabel: string
  /** Drains the live queue of the signed-in user; parked queues stay parked. */
  drain: () => Promise<unknown> | unknown
  /** `'<Name> details prefetch'`; Shikimori's is `'details prefetch'`. */
  prefetchLabel: string
  /** Fired at the `PREFETCH_STAGGER_MS` mark. An entry without one schedules no timer. */
  prefetch?: () => Promise<unknown> | unknown
}

export interface OfflineKickoffDeps {
  /** Read at each online edge: Shikimori's entry, then one per other connected tracker. */
  trackers: () => readonly KickoffTracker[]
  suspendDownloads: () => void
  resumeDownloads: () => void
  suspendSyncplay: () => void
  resumeSyncplay: () => void
  /** Retries the first-launch ffmpeg/fpcalc install the boot task skipped. */
  retryBinaries: () => Promise<unknown> | unknown
  runAutoDownloadTick: () => Promise<unknown> | unknown
}

export interface OfflineKickoff {
  onOnline(): void
  onOffline(): void
}

function run(label: string, fn: () => Promise<unknown> | unknown): void {
  try {
    void Promise.resolve(fn()).catch((err) => console.warn(`[offline] ${label} failed:`, err))
  } catch (err) {
    console.warn(`[offline] ${label} failed:`, err)
  }
}

/**
 * Online: every tracker's queue drain, the download pump, Syncplay and the
 * binaries go at once; the auto-download tick and the details prefetches are
 * staggered behind them so a reconnect is not one burst of every background
 * job. Every prefetch fires at the same mark, and each drain runs in its own
 * `run()`, so one tracker's throw never skips another's. Each job has its own
 * single-flight guard as well.
 */
export function createOfflineKickoff(deps: OfflineKickoffDeps): OfflineKickoff {
  const timers = new Set<ReturnType<typeof setTimeout>>()

  function later(label: string, ms: number, fn: () => Promise<unknown> | unknown): void {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run(label, fn)
    }, ms)
    timers.add(timer)
  }

  return {
    onOnline() {
      let trackers: readonly KickoffTracker[] = []
      try {
        trackers = deps.trackers()
      } catch (err) {
        console.warn('[offline] tracker list failed:', err)
      }
      for (const t of trackers) run(t.drainLabel, t.drain)
      run('download resume', deps.resumeDownloads)
      run('Syncplay resume', deps.resumeSyncplay)
      run('binary install retry', deps.retryBinaries)
      later('auto-download tick', AUTO_DOWNLOAD_STAGGER_MS, deps.runAutoDownloadTick)
      for (const t of trackers) {
        if (t.prefetch) later(t.prefetchLabel, PREFETCH_STAGGER_MS, t.prefetch)
      }
    },
    onOffline() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      run('download suspend', deps.suspendDownloads)
      run('Syncplay suspend', deps.suspendSyncplay)
    }
  }
}
