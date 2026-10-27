// What changes when the app goes offline or comes back (#567). `index.ts`
// hands these two edges to the OfflineService as its `onOffline` / `onOnline`.

export const AUTO_DOWNLOAD_STAGGER_MS = 5_000
export const PREFETCH_STAGGER_MS = 10_000

export interface OfflineKickoffDeps {
  /** Drains the live queue of the signed-in user; parked queues stay parked. */
  syncShikimoriQueue: () => Promise<unknown> | unknown
  suspendDownloads: () => void
  resumeDownloads: () => void
  suspendSyncplay: () => void
  resumeSyncplay: () => void
  /** Retries the first-launch ffmpeg/fpcalc install the boot task skipped. */
  retryBinaries: () => Promise<unknown> | unknown
  runAutoDownloadTick: () => Promise<unknown> | unknown
  prefetchShikimoriDetails: () => Promise<unknown> | unknown
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
 * Online: the queue drain, the download pump, Syncplay and the binaries go at
 * once; the auto-download tick and the details prefetch are staggered behind
 * them so a reconnect is not one burst of every background job. Each has its
 * own single-flight guard as well.
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
      run('Shikimori queue drain', deps.syncShikimoriQueue)
      run('download resume', deps.resumeDownloads)
      run('Syncplay resume', deps.resumeSyncplay)
      run('binary install retry', deps.retryBinaries)
      later('auto-download tick', AUTO_DOWNLOAD_STAGGER_MS, deps.runAutoDownloadTick)
      later('details prefetch', PREFETCH_STAGGER_MS, deps.prefetchShikimoriDetails)
    },
    onOffline() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      run('download suspend', deps.suspendDownloads)
      run('Syncplay suspend', deps.suspendSyncplay)
    }
  }
}
