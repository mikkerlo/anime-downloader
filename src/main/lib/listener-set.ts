// A list of listeners for one hook (#574). `playerPresenceService.onRelease`,
// `DownloadManager.onVideoDownloaded` and `DownloadManager.onMergeComplete`
// used to hold one callback each, so a second registration silently replaced
// the first. Each now appends and hands back an unsubscribe.

export interface ListenerSet<A extends unknown[]> {
  /** Appends `fn`; the returned function removes this registration only, and is idempotent. */
  add(fn: (...args: A) => void): () => void
  /**
   * Calls every listener in registration order, over a snapshot: a listener
   * that unsubscribes (itself or another) during the emit doesn't make the
   * loop skip the next one. A listener that throws is logged and the rest run.
   */
  emit(...args: A): void
  size(): number
}

export function createListenerSet<A extends unknown[]>(name = 'listener'): ListenerSet<A> {
  // One entry object per registration, so the same function added twice is two
  // registrations and each unsubscribe removes its own.
  let entries: { fn: (...args: A) => void }[] = []
  return {
    add(fn) {
      const entry = { fn }
      entries = [...entries, entry]
      return () => {
        entries = entries.filter((e) => e !== entry)
      }
    },
    emit(...args) {
      for (const entry of entries) {
        try {
          entry.fn(...args)
        } catch (err) {
          console.error(`[${name}] a listener threw:`, err)
        }
      }
    },
    size: () => entries.length
  }
}
