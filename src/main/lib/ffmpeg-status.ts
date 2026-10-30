// What auto-merge and the export read about ffmpeg (#592). It replaces the
// boot-time `ffmpegReady` promise, which resolved once: on a PC that booted
// offline it stayed `{ available: false }`, so an ffmpeg installed later never
// merged until a restart.
//
// `get()` is pending until the first `refresh()` (the boot install's), then
// returns the latest check. A `refresh()` also settles every caller still
// waiting on the first `get()`.

export interface FfmpegStatus<T> {
  get(): Promise<T>
  /** Re-runs the check; the result is what `get()` returns from now on. */
  refresh(): Promise<T>
}

export function createFfmpegStatus<T>(check: () => Promise<T>): FfmpegStatus<T> {
  let settleFirst: ((value: Promise<T>) => void) | null = null
  let current = new Promise<T>((resolve) => {
    settleFirst = resolve
  })
  return {
    get: () => current,
    refresh() {
      const next = check()
      current = next
      if (settleFirst) {
        settleFirst(next)
        settleFirst = null
      }
      return next
    }
  }
}
