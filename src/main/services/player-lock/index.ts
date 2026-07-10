import * as path from 'path'

/**
 * Tracks which local files the built-in player currently has open (#63).
 * While a file is locked the DownloadManager must not rename its `.part` or
 * hand it to ffmpeg — on Windows either would EPERM, and everywhere the
 * player's anime-video:// URL would break. Lock keys are resolved paths with
 * any `.part` suffix stripped, so the lock survives the rename transition.
 */
export interface PlayerLockService {
  open(filePath: string): void
  close(filePath: string): void
  isLocked(filePath: string): boolean
  /** Releases everything — window closed / renderer gone. */
  closeAll(): void
  /** Fires after any lock fully releases (deferred finalize hook). */
  onRelease(cb: () => void): void
}

function keyFor(filePath: string): string {
  const base = filePath.endsWith('.part') ? filePath.slice(0, -'.part'.length) : filePath
  return path.resolve(base)
}

export function createPlayerLockService(): PlayerLockService {
  // key → refcount; the player can briefly hold a file twice while switching.
  const locks = new Map<string, number>()
  let releaseCallback: (() => void) | null = null

  return {
    open(filePath: string): void {
      const key = keyFor(filePath)
      locks.set(key, (locks.get(key) ?? 0) + 1)
    },
    close(filePath: string): void {
      const key = keyFor(filePath)
      const count = locks.get(key)
      if (count === undefined) return
      if (count <= 1) {
        locks.delete(key)
        releaseCallback?.()
      } else {
        locks.set(key, count - 1)
      }
    },
    isLocked(filePath: string): boolean {
      return locks.has(keyFor(filePath))
    },
    closeAll(): void {
      if (locks.size === 0) return
      locks.clear()
      releaseCallback?.()
    },
    onRelease(cb: () => void): void {
      releaseCallback = cb
    }
  }
}
