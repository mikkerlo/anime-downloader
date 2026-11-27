// A `window.api` stub for the Settings → Trackers card tests (#700). It plays
// main's side of one tracker account: `useTrackersStore` reads the account and
// its sync status from it, the Shikimori facade its user, and a logout or a
// sign-in announces the new account state the way main's lifecycle does
// (`tracker:accounts-changed` before the reply).
import { vi } from 'vitest'

type Listener<T> = (data: T) => void

export interface FakeTrackerMain {
  user: TrackerUser | null
  sessionExpired: boolean
  needsSetup: boolean
  /** The `tracker:*` status's queue length: what the card names. */
  queueLength: number
  /** The `shikimori:get-sync-status` queue length, which the card must not read. */
  legacyQueueLength: number
}

const IDS: TrackerId[] = ['shikimori', 'anilist', 'mal']

export function createTrackerCardApi(trackerId: TrackerId = 'shikimori') {
  const main: FakeTrackerMain = {
    user: null,
    sessionExpired: false,
    needsSetup: false,
    queueLength: 0,
    legacyQueueLength: 0
  }
  const listeners = {
    accountsChanged: [] as Listener<TrackerAccountsState>[],
    queueChanged: [] as Listener<TrackerOfflineQueueChangedEvent>[],
    syncStatus: [] as Listener<TrackerSyncStatusEvent>[],
    legacyQueueChanged: [] as Listener<{ length: number }>[]
  }
  const sub =
    <T>(list: Listener<T>[]) =>
    (cb: Listener<T>) => {
      list.push(cb)
      return () => {
        const i = list.indexOf(cb)
        if (i >= 0) list.splice(i, 1)
      }
    }

  function accountsState(): TrackerAccountsState {
    return {
      accounts: IDS.map((id) => {
        const mine = id === trackerId
        const user = mine ? main.user : null
        return {
          trackerId: id,
          user,
          hasCredentials: user !== null && !main.sessionExpired,
          sessionExpired: mine && main.sessionExpired,
          needsSetup: mine && main.needsSetup,
          credentialState: user !== null && !main.sessionExpired ? 'ok' : 'none'
        }
      }),
      primary: main.user ? trackerId : null,
      mirror: {},
      featureSources: {}
    }
  }

  function status(): TrackerSyncStatus {
    return {
      state: 'idle',
      queueLength: main.queueLength,
      lastSyncAt: 0,
      lastSyncError: null,
      sessionExpired: main.sessionExpired,
      needsSetup: main.needsSetup
    }
  }

  function announceAccounts(): void {
    const next = accountsState()
    for (const cb of [...listeners.accountsChanged]) cb(next)
  }

  const api = {
    getSetting: vi.fn(async () => ''),
    setSetting: vi.fn(async () => undefined),
    shellOpenExternal: vi.fn(async () => false),
    // The trackers store.
    trackerListAccounts: vi.fn(async () => accountsState()),
    trackerGetSyncStatus: vi.fn(async () => status()),
    trackerGetRates: vi.fn(async (id: TrackerId) => ({
      trackerId: id,
      entries: [],
      queuedAfter: {}
    })),
    onTrackerAccountsChanged: vi.fn(sub(listeners.accountsChanged)),
    onTrackerOfflineQueueChanged: vi.fn(sub(listeners.queueChanged)),
    onTrackerSyncStatus: vi.fn(sub(listeners.syncStatus)),
    // The Shikimori facade.
    shikimoriGetUser: vi.fn(async () => (trackerId === 'shikimori' ? main.user : null)),
    shikimoriGetSyncStatus: vi.fn(async () => ({
      state: 'idle',
      queueLength: main.legacyQueueLength,
      lastSyncAt: 0,
      lastSyncError: null,
      sessionExpired: main.sessionExpired
    })),
    onShikimoriOfflineQueueChanged: vi.fn(sub(listeners.legacyQueueChanged)),
    // The card.
    trackerGetParkedQueues: vi.fn(async (): Promise<TrackerParkedQueueSummary[]> => []),
    trackerDiscardParkedQueue: vi.fn(async () => undefined),
    trackerLogout: vi.fn(async (): Promise<TrackerLogoutResult> => {
      main.user = null
      main.sessionExpired = false
      main.queueLength = 0
      announceAccounts()
      return {}
    }),
    // Shikimori's connect body. A sign-in leaves `sessionExpired` as it was,
    // so the reconnect cases can reopen the form afterwards.
    shikimoriGetAuthUrl: vi.fn(async () => 'https://shikimori.io/oauth/authorize?x=1'),
    shikimoriExchangeCode: vi.fn(async (): Promise<ShikiUser> => {
      throw new Error('no exchange stubbed')
    }),
    trackerBeginAuth: vi.fn(async (): Promise<TrackerAuthResult> => ({ status: 'cancelled' })),
    trackerCompleteAuth: vi.fn(async (): Promise<TrackerAuthResult> => ({ status: 'cancelled' }))
  }

  /** The next sign-in resolves `user`, after announcing it as main does. */
  function signInAs(user: ShikiUser): void {
    api.shikimoriExchangeCode.mockImplementation(async () => {
      main.user = user
      announceAccounts()
      return user
    })
  }

  const proxy = new Proxy(api as unknown as Record<string, unknown>, {
    get: (target, prop) => (prop in target ? target[prop as string] : () => () => {})
  })

  return {
    main,
    api,
    install(): void {
      ;(window as unknown as { api: unknown }).api = proxy
    },
    signInAs,
    announceAccounts,
    emitQueueChanged(id: TrackerId, length = 0): void {
      for (const cb of [...listeners.queueChanged]) cb({ trackerId: id, length, queuedAfter: {} })
    },
    /** The legacy `shikimori:offline-queue-changed`, which main sends before its twin. */
    emitShikimoriQueueChanged(length = 0): void {
      for (const cb of [...listeners.legacyQueueChanged]) cb({ length })
    }
  }
}
