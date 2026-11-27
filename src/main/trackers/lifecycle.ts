// The account lifecycle per tracker (#695, epic #688): sign-in, account switch
// and sign-out, with #588's park/restore rules keyed by each tracker's own
// store keys. Moved out of `SHIKIMORI_EXCHANGE_CODE` / `SHIKIMORI_LOGOUT`
// (`ipc/shikimori.ipc.ts`), which now delegate here, and shared with the
// `tracker:*` account channels. `docs/trackers.md` § Accounts and sign-in
// describes the rules.
//
// A login writes nothing until the provider's user read resolves and, for
// AniList and MAL, until `vault.encrypt` resolves. Then one synchronous block
// runs, with no `await` in it: the head checks, the park and reset on a
// switch, the credential commit, the user, the expired flag and the session
// generation bump, then the restore. That way a drain tick can never send one
// account's queue with another's token.
//
// #696 (T3c) keeps `trackerPrimary` non-null whenever 2 or more trackers are
// connected: a second connect writes the existing primary with the commit, and
// a logout of the primary writes its successor in the step that clears the
// user. Every accounts-state change reaches the renderer through
// `notifyAccountsChanged()`.

import {
  mergeQueues,
  parkEntries,
  takeParked,
  UNKNOWN_OWNER,
  type ParkedQueues,
  type QueuedTrackerUpdate
} from '../lib/shikimori-queue'
import { TRACKER_IDS, type TrackerRates } from '../services/trackers/rates'
import type { PersistedStoreKey } from '../store/keys'
import type { StorageService } from '../store/types'
import { getClientConfig } from './client-config'
import { VAULT_KEYS, type CredentialVault, type VaultKey } from './credential-vault'
import { TRACKER_KEYS } from './keys'
import { resolvePrimary, storedPrimary as readStoredPrimary } from './primary'

/** `shikimori`, `anilist`, `mal`: the primary fallback's and the accounts list's order. */
const ORDER = TRACKER_IDS

/**
 * What belongs to the signed-in account, per tracker: cleared on a logout and
 * on an account switch, where B would otherwise inherit A's list (#588).
 * T11b, T11d and T12 add their keys here.
 */
export const USER_SCOPED_STATE: Readonly<
  Record<TrackerId, readonly { key: PersistedStoreKey; empty: () => unknown }[]>
> = {
  shikimori: [
    { key: 'shikimoriUserRates', empty: () => [] },
    { key: 'shikimoriAnimeDetails', empty: () => ({}) },
    { key: 'shikimoriProfile', empty: () => null },
    { key: 'shikimoriFriends', empty: () => [] },
    { key: 'shikimoriRecommendations', empty: () => [] }
  ],
  anilist: [
    { key: 'anilistUserRates', empty: () => [] },
    { key: 'anilistAnimeDetails', empty: () => ({}) }
  ],
  mal: [
    { key: 'myanimelistUserRates', empty: () => [] },
    { key: 'myanimelistAnimeDetails', empty: () => ({}) }
  ]
}

/**
 * The timer, drain and status steps of one tracker. Shikimori's router sets
 * its own (today's `sync.*` calls). Any other tracker uses its sync instance,
 * looked up through `services/trackers` at call time; with no instance every
 * step is skipped.
 */
export interface TrackerSessionSteps {
  /** Runs after the registry's keys are cleared (Shikimori: the prefetch abort and the snapshots). */
  resetExtra?(): void
  startTimer(): void
  drain(): void
  stopTimer(): void
  broadcastStatus(): void
  broadcastQueue(length: number): void
  /** After a committed login's restore and steps (Shikimori: the Shared Library login run). */
  afterLogin?(): void
}

/** The attempt a new-path login belongs to (`trackers/auth-session.ts`). */
export interface LoginAttempt {
  /** False once the attempt was cancelled, logged out or superseded by a new `BEGIN`. */
  isCurrent(): boolean
}

export type LoginOutcome = { status: 'connected'; user: TrackerUser } | { status: 'cancelled' }

export interface TrackerLogoutRequest {
  pending?: 'keep' | 'discard'
  /**
   * The `SHIKIMORI_LOGOUT` alias: clears even when nothing is connected, as
   * 6.x does. The `tracker:logout` path makes that case a no-op instead.
   */
  clearWhenSignedOut?: boolean
}

export interface TrackerLifecycleDeps {
  store: StorageService
  /** Used only for AniList and MAL; a Shikimori-only profile never reaches it. */
  vault: CredentialVault
  trackerRates: Pick<TrackerRates, 'instance' | 'refreshInBackground'>
  /** Drops any attempt held for the tracker (`auth-session.ts`'s `cancel`). */
  cancelAttempt?: (trackerId: TrackerId) => void
  now?: () => number
  /** With `accountsChangedChannel`, what `notifyAccountsChanged()` emits on; without both it emits nothing. */
  broadcast?: (channel: string, ...args: unknown[]) => void
  /** `EVENT_CHANNELS.TRACKER_ACCOUNTS_CHANGED`, passed in by `index.ts` (#696). */
  accountsChangedChannel?: string
  /**
   * The `afterLogin` step of any tracker whose steps set none (AniList, MAL,
   * registered or not): the Shared Library login run (#714), which drops a
   * claim and merges the owner's libraries. Shikimori's router sets its own.
   */
  afterLogin?: (trackerId: TrackerId) => void
}

export interface TrackerLifecycle {
  /**
   * Signs in. `load` runs the exchange and the user read and writes nothing.
   * With `attempt` (every `tracker:*` completion), the head of the
   * synchronous block refuses the commit when the attempt is no longer
   * current or a logout bumped the generation since the call began, and
   * resolves `cancelled` having written nothing. Without one (the
   * `SHIKIMORI_EXCHANGE_CODE` alias) the login is unguarded, as in 6.x.
   * Rejects with what `load` or `vault.encrypt` rejects with.
   */
  completeLogin(
    trackerId: TrackerId,
    load: () => Promise<{ credentials: unknown; user: TrackerUser }>,
    opts?: { attempt?: LoginAttempt }
  ): Promise<LoginOutcome>
  /**
   * Signs out. Synchronous: a vault credential is cleared with a null commit,
   * never decrypted. Logging out the primary writes its successor in the step
   * that clears the user, and asks for a choice when 2 or more remain (#696).
   */
  logout(trackerId: TrackerId, opts?: TrackerLogoutRequest): TrackerLogoutResult
  /**
   * The tracker's session generation, in memory: bumped by every committed
   * login and every logout that had something to clear. T6's refresh
   * compares it before storing new tokens.
   */
  generation(trackerId: TrackerId): number
  account(trackerId: TrackerId): TrackerAccount
  /** The one builder behind `tracker:list-accounts` and `tracker:accounts-changed`. */
  accountsState(): TrackerAccountsState
  /**
   * The stored primary if connected, else the first connected tracker in
   * `shikimori`, `anilist`, `mal` order, else null (#696 § 0).
   */
  primary(): TrackerId | null
  /**
   * Broadcasts `tracker:accounts-changed` with `accountsState()`: the one seam
   * every emit site calls (#696 § 6), this module's own and the session-expiry,
   * vault and "Needs setup" hooks `index.ts` and the providers wire to it.
   */
  notifyAccountsChanged(): void
  setSteps(trackerId: TrackerId, steps: TrackerSessionSteps): void
}

const VAULT_KEY_SET: ReadonlySet<string> = new Set(VAULT_KEYS)

function vaultKeyOf(trackerId: TrackerId): VaultKey | null {
  const key = TRACKER_KEYS[trackerId].credentials
  return VAULT_KEY_SET.has(key) ? (key as VaultKey) : null
}

const NO_STEPS: TrackerSessionSteps = {
  startTimer: () => {},
  drain: () => {},
  stopTimer: () => {},
  broadcastStatus: () => {},
  broadcastQueue: () => {}
}

export function createTrackerLifecycle(deps: TrackerLifecycleDeps): TrackerLifecycle {
  const { store, vault, trackerRates } = deps
  const now = deps.now ?? Date.now
  const generations = new Map<TrackerId, number>()
  const registered = new Map<TrackerId, TrackerSessionSteps>()

  const generation = (id: TrackerId): number => generations.get(id) ?? 0
  const bump = (id: TrackerId): void => void generations.set(id, generation(id) + 1)

  function stepsOf(id: TrackerId): TrackerSessionSteps {
    const afterLogin = deps.afterLogin
    const login = afterLogin ? { afterLogin: () => afterLogin(id) } : {}
    // Registered steps (Shikimori's router; AniList's and MAL's once #703 and
    // #702 set theirs) keep their own `afterLogin`; without one, the Shared
    // Library login run still fires (#714).
    const own = registered.get(id)
    if (own) return own.afterLogin ? own : { ...own, ...login }
    const t = trackerRates.instance(id)
    if (!t) return { ...NO_STEPS, ...login }
    return {
      startTimer: () => t.startSyncTimer(),
      drain: () => void t.syncQueue(),
      stopTimer: () => t.stopSyncTimer(),
      broadcastStatus: () => t.broadcastSyncStatus(),
      broadcastQueue: () => t.broadcastQueueChanged(),
      ...login
    }
  }

  const userOf = (id: TrackerId): TrackerUser | null =>
    (store.get(TRACKER_KEYS[id].user) as TrackerUser | null | undefined) ?? null

  const liveQueue = (id: TrackerId): QueuedTrackerUpdate[] =>
    (store.get(TRACKER_KEYS[id].updateQueue) as QueuedTrackerUpdate[] | undefined) ?? []

  const parked = (id: TrackerId): ParkedQueues =>
    (store.get(TRACKER_KEYS[id].parkedQueues) as ParkedQueues | undefined) ?? {}

  const ownerKey = (user: TrackerUser): { id: string; nickname: string } => ({
    id: String(user.id),
    nickname: user.nickname
  })

  function resetUserScopedState(id: TrackerId): void {
    for (const { key, empty } of USER_SCOPED_STATE[id]) store.set(key, empty())
    stepsOf(id).resetExtra?.()
  }

  async function completeLogin(
    id: TrackerId,
    load: () => Promise<{ credentials: unknown; user: TrackerUser }>,
    opts: { attempt?: LoginAttempt } = {}
  ): Promise<LoginOutcome> {
    const keys = TRACKER_KEYS[id]
    // Captured before the first await: a logout while the exchange, the user
    // read or the encrypt is pending bumps it.
    const startGeneration = generation(id)
    const { attempt } = opts
    const { credentials, user } = await load()
    const credKey = vaultKeyOf(id)
    const blob = credKey ? await vault.encrypt(credentials) : null

    // ---- One synchronous block from here: no await below. ----
    // The head checks. The stale-attempt check refuses an overtaken sign-in;
    // T5b's second-tracker check (#701) goes beside it, so a refusal also
    // parks nothing, and #696's primary write goes with the commit.
    if (attempt && (!attempt.isCurrent() || generation(id) !== startGeneration)) {
      return { status: 'cancelled' }
    }

    const steps = stepsOf(id)
    const prev = userOf(id)
    // #696 § 5: a tracker joining one already connected, with no primary
    // stored, keeps that one primary; the fallback order would otherwise hand
    // the role to the newcomer. Read before this tracker's user is written.
    const keepPrimary = prev === null && storedPrimary() === null ? primary() : null
    const live = liveQueue(id)
    const switched = prev !== null && prev.id !== user.id
    if (switched || (!prev && live.length > 0)) {
      // Ownerless entries can't be replayed for whoever signs in, so they wait
      // in a bucket that is never restored automatically.
      const owner = prev ? ownerKey(prev) : { id: UNKNOWN_OWNER, nickname: '' }
      store.set(keys.parkedQueues, parkEntries(parked(id), owner, live, now()))
      store.set(keys.updateQueue, [])
    }
    if (switched) resetUserScopedState(id)

    if (credKey) vault.commit(credKey, blob)
    else store.set(keys.credentials, credentials)
    if (keepPrimary) store.set('trackerPrimary', keepPrimary)
    store.set(keys.user, user)
    // A fresh session ends the expired state, and the queue the expiry
    // retained can drain now (#244).
    store.set(keys.sessionExpired, false)
    bump(id)

    const restored = takeParked(parked(id), String(user.id))
    const queue = mergeQueues(liveQueue(id), restored.entries)
    if (restored.entries.length > 0) {
      store.set(keys.updateQueue, queue)
      store.set(keys.parkedQueues, restored.parked)
    }
    steps.broadcastQueue(queue.length)
    if (switched || restored.entries.length > 0) trackerRates.refreshInBackground(id)

    steps.startTimer()
    steps.drain()
    steps.broadcastStatus()
    steps.afterLogin?.()
    notifyAccountsChanged()
    return { status: 'connected', user }
  }

  /**
   * #696 § 4: the logged-out primary's successor, written right after its
   * user is cleared, in the same synchronous step: the first remaining
   * connected tracker, or null when none is left (written only if it isn't
   * already, so a Shikimori-only logout writes nothing).
   */
  function succeedPrimary(): TrackerLogoutResult {
    const remaining = ORDER.filter((t) => userOf(t) !== null)
    const next = remaining[0] ?? null
    if (storedPrimary() !== next) store.set('trackerPrimary', next)
    return remaining.length >= 2 ? { needsPrimaryChoice: { candidates: remaining } } : {}
  }

  function logout(id: TrackerId, opts: TrackerLogoutRequest = {}): TrackerLogoutResult {
    const keys = TRACKER_KEYS[id]
    deps.cancelAttempt?.(id)
    const user = userOf(id)
    const connected = user !== null || store.get(keys.credentials) != null
    // Never connected: nothing to clear, no vault, no generation bump.
    if (!connected && !opts.clearWhenSignedOut) return {}
    const wasPrimary = user !== null && primary() === id

    if (user && opts.pending !== 'discard') {
      store.set(keys.parkedQueues, parkEntries(parked(id), ownerKey(user), liveQueue(id), now()))
    }
    const credKey = vaultKeyOf(id)
    if (credKey) vault.commit(credKey, null)
    else store.set(keys.credentials, null)
    store.set(keys.user, null)
    const result = wasPrimary ? succeedPrimary() : {}
    store.set(keys.updateQueue, [])
    resetUserScopedState(id)
    // Or disconnecting while expired would leave a sticky flag with no user.
    store.set(keys.sessionExpired, false)
    if (connected) bump(id)
    const steps = stepsOf(id)
    steps.stopTimer()
    steps.broadcastQueue(0)
    steps.broadcastStatus()
    notifyAccountsChanged()
    return result
  }

  function account(id: TrackerId): TrackerAccount {
    const keys = TRACKER_KEYS[id]
    const user = userOf(id)
    const hasCredentials = store.get(keys.credentials) != null
    const credKey = vaultKeyOf(id)
    // `isLocked` only for a stored blob, so a profile with no AniList or MAL
    // credential never calls the vault.
    const locked = hasCredentials && credKey !== null && vault.isLocked(credKey)
    const missingClientId = id === 'mal' && !getClientConfig(store).clientId
    return {
      trackerId: id,
      user,
      hasCredentials,
      sessionExpired: user !== null && !hasCredentials,
      needsSetup: missingClientId || (trackerRates.instance(id)?.needsSetup() ?? false),
      credentialState: !hasCredentials ? 'none' : locked ? 'locked' : 'ok'
    }
  }

  const storedPrimary = (): TrackerId | null => readStoredPrimary(store)
  // #696's § 0 rule, shared with the fan-out through `index.ts`.
  const primary = (): TrackerId | null => resolvePrimary(store)

  function accountsState(): TrackerAccountsState {
    return {
      accounts: ORDER.map(account),
      primary: primary(),
      mirror: (store.get('trackerMirror') as TrackerAccountsState['mirror'] | undefined) ?? {},
      featureSources:
        (store.get('trackerFeatureSource') as TrackerAccountsState['featureSources'] | undefined) ??
        {}
    }
  }

  function notifyAccountsChanged(): void {
    if (!deps.broadcast || !deps.accountsChangedChannel) return
    // Through the returned object, so a field added over the builder reaches it.
    deps.broadcast(deps.accountsChangedChannel, lifecycle.accountsState())
  }

  const lifecycle: TrackerLifecycle = {
    completeLogin,
    logout,
    generation,
    account,
    accountsState,
    primary,
    notifyAccountsChanged,
    setSteps: (id, steps) => void registered.set(id, steps)
  }
  return lifecycle
}
