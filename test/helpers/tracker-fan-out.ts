// The production fan-out (#692) for a harness that registers the Shikimori
// router: Shikimori alone, as `src/main/index.ts` builds it. The router sets
// Shikimori's primary branch on it at registration.
import type { StorageService } from '../../src/main/store/types'
import { createTrackerFanOut, type TrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates, type TrackerRates } from '../../src/main/services/trackers/rates'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import type { CredentialVault } from '../../src/main/trackers/credential-vault'
import { createTrackerLifecycle, type TrackerLifecycle } from '../../src/main/trackers/lifecycle'
import {
  createTrackerAuthSessions,
  type TrackerAuthSessions
} from '../../src/main/trackers/auth-session'
import { createShikimoriProvider } from '../../src/main/trackers/shikimori.provider'

type ShikimoriSync = {
  tracker: TrackerSyncService<never, never> | TrackerSyncService<unknown, unknown>
}

export function shikimoriOnlyFanOut(store: StorageService, sync: ShikimoriSync): TrackerFanOut {
  return createTrackerFanOut({
    store,
    trackers: [{ sync: sync.tracker as TrackerSyncService<unknown, unknown> }]
  })
}

/**
 * A vault every member of which throws: a Shikimori-only path that reaches the
 * vault fails the test it runs in (#690, #695).
 */
export function forbiddenVault(): CredentialVault {
  return new Proxy({} as CredentialVault, {
    get(_target, member) {
      return () => {
        throw new Error(`a Shikimori-only path called the credential vault's ${String(member)}`)
      }
    }
  })
}

/**
 * The fan-out plus the `tracker:*` rates service on it (#694), and the account
 * lifecycle and sign-in attempts (#695), as `index.ts` builds them: the
 * `AppDeps` members `trackers`, `trackerRates`, `trackerLifecycle` and
 * `trackerAuth`. The vault is `forbiddenVault()`; a sign-in never opens a
 * browser.
 */
export function shikimoriOnlyTrackers(
  store: StorageService,
  sync: ShikimoriSync,
  isOffline?: () => boolean
): {
  trackers: TrackerFanOut
  trackerRates: TrackerRates
  trackerLifecycle: TrackerLifecycle
  trackerAuth: TrackerAuthSessions
} {
  const trackers = shikimoriOnlyFanOut(store, sync)
  const trackerRates = createTrackerRates({ store, trackers, isOffline })
  return { trackers, trackerRates, ...trackerAccounts(store, trackerRates, isOffline) }
}

/**
 * The `AppDeps` members `trackerLifecycle` and `trackerAuth` (#695) over a
 * harness's own `trackerRates`, as `index.ts` builds them: Shikimori's
 * provider, `forbiddenVault()`, and an `openExternal` that opens nothing.
 */
export function trackerAccounts(
  store: StorageService,
  trackerRates: TrackerRates,
  isOffline?: () => boolean
): { trackerLifecycle: TrackerLifecycle; trackerAuth: TrackerAuthSessions } {
  const trackerLifecycle = createTrackerLifecycle({
    store,
    vault: forbiddenVault(),
    trackerRates,
    cancelAttempt: (id) => trackerAuth.cancel(id)
  })
  const trackerAuth = createTrackerAuthSessions({
    lifecycle: trackerLifecycle,
    providers: { shikimori: createShikimoriProvider({ store }) },
    isOffline: isOffline ?? (() => false),
    openExternal: async () => {}
  })
  return { trackerLifecycle, trackerAuth }
}
