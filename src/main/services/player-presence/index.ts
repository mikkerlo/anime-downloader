import type { WebContents } from 'electron'
import { createListenerSet } from '../../lib/listener-set'

/**
 * The part of a renderer's `WebContents` the presence service needs — the
 * `player:view-opened` handler passes `event.sender` straight in.
 */
export type PresenceSender = Pick<WebContents, 'id' | 'once' | 'on'>

/**
 * Whether any built-in player view is open (#516), refcounted per renderer.
 * While one is, `DownloadManager` starts no new merge; `onRelease` fires on the
 * 1 → 0 edge so the held merges can resume.
 *
 * A missed release would strand every merge until restart, so release does not
 * rely on `player:view-closed` alone: each sender's count is also dropped when
 * its renderer is destroyed, crashes (`render-process-gone`) or navigates
 * (`did-navigate`, which fires on reload too) — none of which runs the
 * component's `onBeforeUnmount`.
 */
export interface PlayerPresenceService {
  open(sender: PresenceSender): void
  close(senderId: number): void
  /** Drops every count `senderId` holds — its renderer went away. */
  releaseSender(senderId: number): void
  isOpen(): boolean
  /**
   * Adds a listener for the last open view's release, after any added before
   * it (the merge hold's `resumeHeldMerges`, a Shared Library export's per-file
   * hold, #574). Returns its unsubscribe. A listener that throws is logged and
   * the rest still run.
   */
  onRelease(cb: () => void): () => void
}

export function createPlayerPresenceService(): PlayerPresenceService {
  const counts = new Map<number, number>()
  // Senders whose lifecycle listeners are already attached. Attached once per
  // sender, not per open: one player open per episode would otherwise stack
  // three listeners each time and trip MaxListenersExceededWarning.
  const wired = new Set<number>()
  const release = createListenerSet<[]>('player-presence')

  function drop(senderId: number): void {
    counts.delete(senderId)
    if (counts.size === 0) release.emit()
  }

  function releaseSender(senderId: number): void {
    if (!counts.has(senderId)) return
    drop(senderId)
  }

  return {
    open(sender: PresenceSender): void {
      const id = sender.id
      if (!wired.has(id)) {
        wired.add(id)
        sender.once('destroyed', () => {
          wired.delete(id)
          releaseSender(id)
        })
        sender.on('render-process-gone', () => releaseSender(id))
        sender.on('did-navigate', () => releaseSender(id))
      }
      counts.set(id, (counts.get(id) ?? 0) + 1)
    },
    close(senderId: number): void {
      const count = counts.get(senderId)
      if (count === undefined) return
      if (count <= 1) drop(senderId)
      else counts.set(senderId, count - 1)
    },
    releaseSender,
    isOpen(): boolean {
      return counts.size > 0
    },
    onRelease(cb: () => void): () => void {
      return release.add(cb)
    }
  }
}
