/**
 * Threshold-gated wall-clock probes for main-process hot paths.
 *
 * The main process serializes every IPC reply and every synchronous fs/store
 * operation on one event loop, so a single slow handler stalls the whole
 * renderer. These helpers make such stalls visible in the console (dev and
 * prod) without a profiler attached: nothing is logged below the threshold,
 * so the steady-state cost is one `performance.now()` pair per call.
 */

/** A store get/set above this is a sign the persisted file is being re-parsed. */
export const SLOW_STORE_OP_MS = 25

/** An IPC reply above this is user-visible jank on the renderer side. */
export const SLOW_IPC_MS = 100

/** Logs `[perf] <label> <ms>` when the elapsed time since `t0` crosses `thresholdMs`. */
export function markSlow(label: string, t0: number, thresholdMs: number): void {
  const ms = performance.now() - t0
  if (ms >= thresholdMs) {
    console.warn(`[perf] ${label} took ${ms.toFixed(1)}ms`)
  }
}

/** Runs `fn`, logging it as slow when it crosses `thresholdMs`. Sync only. */
export function timeSlowSync<T>(label: string, thresholdMs: number, fn: () => T): T {
  const t0 = performance.now()
  try {
    return fn()
  } finally {
    markSlow(label, t0, thresholdMs)
  }
}
