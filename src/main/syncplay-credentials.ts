import type { StorageService } from './store/types'

export const SYNCPLAY_PASSWORD_KEY = 'syncplayPassword'

/**
 * Owns the Syncplay server password (#216).
 *
 * The point of routing it through main is the join flows: WatchTogetherView and
 * the in-player join send no password, so `syncplay:connect` injects this one
 * and every entry point authenticates the same way. The renderer can only write
 * it or ask whether one exists — it is never read back.
 *
 * Stored as-is under its own store key, alongside `shikimoriCredentials` and
 * `token`, which are persisted the same way. Deliberately *not* a field on the
 * `syncplay` settings object: the renderer overwrites that wholesale on every
 * settings save and would silently drop the password.
 */
export class SyncplayPasswordVault {
  constructor(private readonly store: StorageService) {}

  set(password: string): void {
    this.store.set(SYNCPLAY_PASSWORD_KEY, password)
  }

  get(): string {
    const stored = this.store.get(SYNCPLAY_PASSWORD_KEY)
    return typeof stored === 'string' ? stored : ''
  }

  has(): boolean {
    return this.get().length > 0
  }

  clear(): void {
    this.store.set(SYNCPLAY_PASSWORD_KEY, '')
  }
}
