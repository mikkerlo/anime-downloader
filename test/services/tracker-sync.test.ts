// The generic tracker sync service (#691): one instance per tracker, driven by
// `fake-tracker.ts`'s personalities. Shikimori's own instance, through the
// real adapter and wrapper, is pinned by `shikimori-sync.test.ts` (frozen),
// the 6.0.21 goldens and `shikimori-offline-sync.test.ts`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const ensureFreshToken = vi.fn()
vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ensureFreshToken: (...a: unknown[]) => ensureFreshToken(...a)
}))

import { ShikiApiError, ShikiAuthError } from '../../src/main/shikimori'
import { createFakeTracker, type FakeTracker } from '../helpers/fake-tracker'
import {
  createTrackerSyncService,
  type TrackerSyncService,
  type TrackerSyncServiceDeps
} from '../../src/main/services/trackers/sync'
import {
  ANILIST_KEYS,
  MYANIMELIST_KEYS,
  SHIKIMORI_KEYS,
  type TrackerStoreKeys
} from '../../src/main/trackers/keys'
import {
  createShikimoriProvider,
  isShikimoriSessionGone,
  shikimoriRateCache
} from '../../src/main/trackers/shikimori.provider'
import { TRACKER_ERROR_POLICY, TrackerApiError } from '../../src/main/trackers/errors'
import { TRACKER_LABELS, type TrackerSyncProvider } from '../../src/main/trackers/types'
import type { RateValues } from '../../src/main/lib/shikimori-rate'
import { testRateCodec, type TestRow } from '../helpers/test-rate-codec'

const T = Date.UTC(2026, 10, 1)
const MIN = 60_000
const HOUR = 60 * MIN
const KEYS: Record<TrackerId, TrackerStoreKeys> = {
  shikimori: SHIKIMORI_KEYS,
  anilist: ANILIST_KEYS,
  mal: MYANIMELIST_KEYS
}

/** The rate cache the AniList and MAL personalities use here; T6/T7 bring the real ones. */
const testCodec = testRateCodec()

const vals = (episodes: number, score = 7): RateValues => ({
  episodes,
  status: 'watching',
  score,
  rewatches: 0
})

function queued(
  malId: number,
  before: RateValues,
  after: RateValues,
  queuedAt: number,
  extra: Record<string, unknown> = {}
) {
  return { malId, rateId: null, before, after, queuedAt, ...extra }
}

type Member = 'auth' | 'listEntries' | 'getEntry' | 'upsertEntry'

interface Rig<P extends TrackerId> {
  id: P
  fake: FakeTracker<P>
  store: InMemoryStorage
  keys: TrackerStoreKeys
  svc: TrackerSyncService<unknown, unknown>
  /** Every provider call, in order. */
  calls: Member[]
  /** The session each data call carried. */
  sessions: { member: Member; session: unknown }[]
  /** Every broadcast, in order. */
  events: [string, ...unknown[]][]
  ch: { status: string; queue: string; rate: string; refreshed: string }
  queue(): { malId: number; queuedAt: number; firstServerErrorAt?: number }[]
}

function rig<P extends TrackerId>(
  id: P,
  opts: {
    initial?: Record<string, unknown>
    deps?: Partial<TrackerSyncServiceDeps>
    provider?: Partial<
      TrackerSyncProvider<{ token: string; userId: number }, unknown, unknown, unknown>
    >
    store?: InMemoryStorage
  } = {}
): Rig<P> {
  const fake = createFakeTracker(id)
  const keys = KEYS[id]
  const store = opts.store ?? new InMemoryStorage()
  for (const [k, v] of Object.entries({
    [keys.credentials]: { v: 1, enc: 'plain', data: 'blob' },
    [keys.user]: { id: 1, nickname: 'me', avatar: null },
    [keys.updateQueue]: [],
    [keys.userRates]: [],
    [keys.parkedQueues]: {},
    ...opts.initial
  }))
    store.set(k, v)
  const calls: Member[] = []
  const sessions: { member: Member; session: unknown }[] = []
  const events: [string, ...unknown[]][] = []
  const ch = {
    status: `${id}:sync-status`,
    queue: `${id}:offline-queue-changed`,
    rate: `${id}:rate-updated`,
    refreshed: `${id}:rates-refreshed`
  }
  const p = fake.provider
  const provider = {
    ...p,
    // As every provider's `auth()` does: the user is checked after the refresh.
    async auth() {
      calls.push('auth')
      const session = await p.auth()
      if (!store.get(keys.user)) throw new Error(`Not logged in to ${TRACKER_LABELS[id]}`)
      return session
    },
    async listEntries(session: never, o?: never) {
      calls.push('listEntries')
      sessions.push({ member: 'listEntries', session })
      return p.listEntries(session, o)
    },
    async getEntry(session: never, ref: never) {
      calls.push('getEntry')
      sessions.push({ member: 'getEntry', session })
      return p.getEntry(session, ref)
    },
    async upsertEntry(session: never, ref: never, values: never, changed: never) {
      calls.push('upsertEntry')
      sessions.push({ member: 'upsertEntry', session })
      return p.upsertEntry(session, ref, values, changed)
    },
    rateCache: id === 'shikimori' ? shikimoriRateCache : testCodec,
    isSessionGone: id === 'shikimori' ? isShikimoriSessionGone : () => false,
    ...opts.provider
  }
  const svc = createTrackerSyncService(provider as never, keys, {
    store: store as never,
    broadcast: (channel, ...args) => events.push([channel, ...args]),
    syncStatusChannel: ch.status,
    offlineQueueChangedChannel: ch.queue,
    rateUpdatedChannel: ch.rate,
    ratesRefreshedChannel: ch.refreshed,
    ...opts.deps
  }) as TrackerSyncService<unknown, unknown>
  return {
    id,
    fake,
    store,
    keys,
    svc,
    calls,
    sessions,
    events,
    ch,
    queue: () => store.get(keys.updateQueue) as never
  }
}

/** One drain run, with the inter-item delays played out. */
async function drain(svc: TrackerSyncService<unknown, unknown>): Promise<void> {
  const run = svc.syncQueue()
  await vi.advanceTimersByTimeAsync(5_000)
  await run
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T)
  ensureFreshToken.mockReset()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  vi.useRealTimers()
})

describe('changedFields', () => {
  it('AniList receives only the episodes for an episode bump, and its POINT_100 85 stays 85', async () => {
    const r = rig('anilist')
    r.fake.set(1, { episodes: 3, status: 'watching', score: 9 }, { scoreRaw: 85 })
    r.store.set(r.keys.updateQueue, [queued(1, vals(3, 9), vals(4, 9), 1)])

    await drain(r.svc)

    expect(r.fake.upserts.map((u) => u.changedFields)).toEqual([['episodes']])
    expect(r.fake.rows.get(1)?.scoreRaw).toBe(85)
    expect(r.queue()).toEqual([])
  })

  it('the create branch passes every intended field: all four, or a scoped entry’s own', async () => {
    const r = rig('anilist')
    r.store.set(r.keys.updateQueue, [
      queued(1, vals(0), vals(1), 1),
      queued(2, vals(0), vals(2), 2, { fields: ['episodes'] })
    ])

    await drain(r.svc)

    expect(r.fake.upserts.map((u) => [u.ref, u.values, u.changedFields])).toEqual([
      [{ malId: 1, remoteId: null }, vals(1), ['episodes', 'status', 'score', 'rewatches']],
      [{ malId: 2, remoteId: null }, vals(2), ['episodes']]
    ])
  })
})

describe('the per-class policy (T0’s table), on the first of two queued items', () => {
  // The drain's branches read the table: an `abort` row keeps the item, and a
  // `continue` row drops it now, drops it after 24 h, or (no row today) keeps it.
  it('every abort row keeps its entry', () => {
    for (const [cls, policy] of Object.entries(TRACKER_ERROR_POLICY)) {
      if (policy.drain === 'abort') expect(policy.entry, cls).toBe('keep')
    }
  })

  const TWO = () => [queued(1, vals(3), vals(4), 1), queued(2, vals(3), vals(4), 2)]

  function seeded<P extends TrackerId>(id: P) {
    const r = rig(id, { initial: { [KEYS[id].updateQueue]: TWO() } })
    r.fake.set(1, vals(3))
    r.fake.set(2, vals(3))
    return r
  }

  it.each([
    ['network', 'anilist', 'network'],
    ['auth', 'anilist', 'auth'],
    ['rate-limit', 'anilist', 'rate-limit'],
    ['config', 'mal', 'config']
  ] as const)('%s aborts and keeps both entries', async (_class, id, reply) => {
    const r = seeded(id)
    r.fake.fail(reply as never, { member: 'getEntry' })

    await drain(r.svc)

    expect(r.calls).toEqual(['auth', 'getEntry'])
    expect(r.fake.upserts).toEqual([])
    expect(r.queue().map((e) => e.malId)).toEqual([1, 2])
    expect(r.svc.getSyncStatus().lastSyncAt).toBe(0)
  })

  it('server keeps the first entry and sends the second, and drops the first once its 24 h window expired', async () => {
    const r = seeded('anilist')
    r.fake.fail('server', { member: 'getEntry' })

    await drain(r.svc)

    expect(r.fake.upserts.map((u) => u.ref.malId)).toEqual([2])
    expect(r.queue()).toEqual([{ ...TWO()[0], firstServerErrorAt: T, lastServerErrorAt: T }])

    // A continuous run of 5xx answers, every 30 min, for just under 24 h: kept.
    let t = T
    for (; t < T + 24 * HOUR; t += 30 * MIN) {
      // Only these runs: a timer tick would send the item with no failure queued.
      r.svc.stopSyncTimer()
      vi.setSystemTime(t)
      r.fake.fail('server', { member: 'getEntry' })
      await drain(r.svc)
      expect(r.queue().map((e) => e.malId)).toEqual([1])
    }
    r.svc.stopSyncTimer()
    vi.setSystemTime(T + 24 * HOUR)
    r.fake.fail('server', { member: 'getEntry' })
    await drain(r.svc)
    expect(r.queue()).toEqual([])
    expect(r.fake.upserts.map((u) => u.ref.malId)).toEqual([2])
  })

  it('item drops the first entry and sends the second', async () => {
    const r = seeded('anilist')
    r.fake.fail('item', { member: 'getEntry' })
    const settled: unknown[] = []
    r.svc.onItemSettled((e) => settled.push(e))

    await drain(r.svc)

    expect(r.fake.upserts.map((u) => u.ref.malId)).toEqual([2])
    expect(r.queue()).toEqual([])
    expect(settled).toMatchObject([
      { malId: 1, outcome: 'dropped', rate: null, error: 'AniList API error: 404' },
      { malId: 2, outcome: 'applied' }
    ])
  })
})

describe('templated strings', () => {
  it.each([
    ['anilist', 'AniList'],
    ['shikimori', 'Shikimori']
  ] as const)('the %s instance names itself in the retry messages', async (id, label) => {
    const r = rig(id, { initial: { [KEYS[id].updateQueue]: [queued(1, vals(3), vals(4), 1)] } })
    r.fake.set(1, vals(3))

    r.fake.fail('rate-limit', { member: 'getEntry' })
    await drain(r.svc)
    expect(r.svc.getSyncStatus().lastSyncError).toBe(`${label} rate limit — will retry`)

    r.fake.fail('server', { member: 'getEntry' })
    await drain(r.svc)
    expect(r.svc.getSyncStatus().lastSyncError).toBe(`${label} server error — will retry`)
    expect(warn).toHaveBeenCalledWith(
      `[${id} sync] server error, keeping item`,
      1,
      expect.any(Number)
    )
  })

  it('refreshRates with no stored user rejects with “Not logged in to AniList”', async () => {
    const r = rig('anilist', { initial: { [ANILIST_KEYS.user]: null } })
    await expect(r.svc.refreshRates({ keepQueued: false })).rejects.toThrow(
      'Not logged in to AniList'
    )
  })

  it('refreshRates with no stored user rejects with “Not logged in to Shikimori” (the real adapter)', async () => {
    const store = new InMemoryStorage({ shikimoriUser: null, shikimoriUpdateQueue: [] })
    ensureFreshToken.mockResolvedValue('tok')
    const svc = createTrackerSyncService(
      createShikimoriProvider({ store: store as never }),
      SHIKIMORI_KEYS,
      {
        store: store as never,
        broadcast: () => {},
        syncStatusChannel: 's',
        offlineQueueChangedChannel: 'q',
        rateUpdatedChannel: 'r',
        ratesRefreshedChannel: 'f'
      }
    )
    await expect(svc.refreshRates({ keepQueued: false })).rejects.toThrow(
      'Not logged in to Shikimori'
    )
  })
})

describe('the session is pinned for the run (#588)', () => {
  it('every data call of one run carries the session from its single auth()', async () => {
    const r = rig('anilist', {
      initial: {
        [ANILIST_KEYS.updateQueue]: [queued(1, vals(3), vals(4), 1), queued(2, vals(0), vals(1), 2)]
      }
    })
    r.fake.set(1, vals(3))

    await drain(r.svc)

    expect(r.calls.filter((c) => c === 'auth')).toHaveLength(1)
    expect(r.sessions.map((s) => s.member)).toEqual([
      'getEntry',
      'upsertEntry',
      'getEntry',
      'upsertEntry'
    ])
    const A = { token: 'fake-access-token-anilist', userId: 1 }
    for (const s of r.sessions) expect(s.session).toEqual(A)
  })

  it('a switch to B while an item’s getEntry is pending: that item still goes out on A’s session, and the run stops', async () => {
    const gate = deferred()
    const r: Rig<'anilist'> = rig('anilist', {
      initial: {
        [ANILIST_KEYS.updateQueue]: [queued(1, vals(3), vals(4), 1), queued(2, vals(3), vals(4), 2)]
      },
      provider: {
        async getEntry(session, ref) {
          r.calls.push('getEntry')
          if (ref.malId === 1) await gate.promise
          return r.fake.provider.getEntry(session, ref)
        }
      }
    })
    r.fake.set(1, vals(3))
    r.fake.set(2, vals(3))

    const run = r.svc.syncQueue()
    await vi.advanceTimersByTimeAsync(0)
    // B signs in, A's queue is parked, and the tracker answers for B now.
    r.store.set(ANILIST_KEYS.user, { id: 2, nickname: 'b', avatar: null })
    r.store.set(ANILIST_KEYS.updateQueue, [])
    r.fake.user = { id: 2, nickname: 'b', avatar: null, token: 'token-b' }
    gate.resolve()
    await vi.advanceTimersByTimeAsync(5_000)
    await run

    expect(r.fake.upserts.map((u) => [u.ref.malId, u.session])).toEqual([
      [1, { token: 'fake-access-token-anilist', userId: 1 }]
    ])
  })
})

describe('a session for another account', () => {
  it('is an owner change: no data call goes out, the queue is kept, and nothing re-kicks while the owner is unchanged', async () => {
    const r: Rig<'anilist'> = rig('anilist', {
      initial: { [ANILIST_KEYS.updateQueue]: [queued(1, vals(3), vals(4), 1)] },
      provider: {
        async auth() {
          r.calls.push('auth')
          return { token: 'someone-elses-token', userId: 2 }
        }
      }
    })
    r.fake.set(1, vals(3))

    await drain(r.svc)

    expect(r.calls).toEqual(['auth'])
    expect(r.queue()).toHaveLength(1)
    expect(r.svc.getSyncStatus()).toMatchObject({ state: 'idle', lastSyncAt: 0 })
  })
})

describe('the token step', () => {
  async function tick(): Promise<void> {
    await vi.advanceTimersByTimeAsync(60_000)
  }

  function shikiWithAuthError(err: unknown) {
    const r = rig('shikimori', {
      initial: { shikimoriUpdateQueue: [queued(1, vals(3), vals(4), 1)] },
      provider: {
        async auth() {
          r.calls.push('auth')
          throw err
        }
      }
    })
    return r
  }

  it('a network-class refresh failure leaves lastSyncError unset', async () => {
    const r = shikiWithAuthError(new TypeError('fetch failed'))
    await drain(r.svc)
    expect(r.calls).toEqual(['auth'])
    expect(r.svc.getSyncStatus().lastSyncError).toBeNull()
  })

  it('a gone session (ShikiAuthError) stops the timer', async () => {
    const r = shikiWithAuthError(new ShikiAuthError('Shikimori session expired', 400))
    r.svc.startSyncTimer()
    await tick()
    await tick()
    expect(r.calls).toEqual(['auth'])
    expect(r.queue()).toHaveLength(1)
  })

  it('a ShikiApiError(403) from the refresh classifies as auth but leaves the timer running', async () => {
    const r = shikiWithAuthError(new ShikiApiError('Shikimori API error: 403', 403))
    r.svc.startSyncTimer()
    await tick()
    await tick()
    expect(r.calls).toEqual(['auth', 'auth'])
    expect(r.svc.getSyncStatus().lastSyncError).toBe('Shikimori API error: 403')
    r.svc.stopSyncTimer()
  })

  it('an auth-class item error leaves the timer running', async () => {
    const r = rig('shikimori', {
      initial: { shikimoriUpdateQueue: [queued(1, vals(3), vals(4), 1)] }
    })
    r.fake.set(1, vals(3))
    r.fake.fail('auth', { member: 'getEntry' })
    r.svc.startSyncTimer()
    await tick()
    expect(r.queue()).toHaveLength(1)
    await tick()
    expect(r.calls).toEqual(['auth', 'getEntry', 'auth', 'getEntry', 'upsertEntry'])
    expect(r.queue()).toEqual([])
  })

  it('config: MAL’s invalid_client on refresh sets “Needs setup”, keeps the queue, and the next tick sends nothing', async () => {
    const onNeedsSetupChanged = vi.fn()
    const r = rig('mal', {
      initial: { [MYANIMELIST_KEYS.updateQueue]: [queued(1, vals(3), vals(4), 1)] },
      deps: { onNeedsSetupChanged },
      provider: {
        async auth() {
          r.calls.push('auth')
          throw new TrackerApiError(
            'MAL token refresh failed: 401',
            'mal',
            401,
            '{"error":"invalid_client","message":"Client authentication failed"}'
          )
        }
      }
    })
    const seen: boolean[] = []
    onNeedsSetupChanged.mockImplementation(() => seen.push(r.svc.needsSetup()))
    r.svc.startSyncTimer()
    await tick()

    expect(r.svc.needsSetup()).toBe(true)
    expect(r.calls).toEqual(['auth'])
    expect(r.queue()).toHaveLength(1)
    expect(r.svc.getSyncStatus().lastSyncError).toBe('MAL token refresh failed: 401')
    expect(onNeedsSetupChanged.mock.calls).toEqual([['mal']])
    expect(seen).toEqual([true])

    await tick()
    await tick()
    expect(r.calls).toEqual(['auth'])
    r.svc.stopSyncTimer()
  })
})

describe('“Needs setup”', () => {
  function malWithConfigError(deps: Partial<TrackerSyncServiceDeps> = {}) {
    const r = rig('mal', {
      initial: {
        [MYANIMELIST_KEYS.updateQueue]: [
          queued(1, vals(3), vals(4), 1),
          queued(2, vals(3), vals(4), 2)
        ]
      },
      deps
    })
    r.fake.set(1, vals(3))
    r.fake.set(2, vals(3))
    r.fake.fail('config', { member: 'getEntry' })
    return r
  }

  it('MAL’s 400 “Invalid client id” aborts the drain, keeps every entry and sets it', async () => {
    const r = malWithConfigError()

    await drain(r.svc)

    expect(r.svc.needsSetup()).toBe(true)
    expect(r.queue().map((e) => e.malId)).toEqual([1, 2])
    expect(r.fake.upserts).toEqual([])
    expect(r.svc.getSyncStatus().lastSyncError).toBe('MAL API error: 400')
  })

  it('no drain while it is set: timer ticks and drainNow make zero provider calls; clearNeedsSetup() drains', async () => {
    const r = malWithConfigError()
    await drain(r.svc)
    expect(r.calls).toEqual(['auth', 'getEntry'])

    await vi.advanceTimersByTimeAsync(3 * 60_000)
    const now = r.svc.drainNow()
    await vi.advanceTimersByTimeAsync(5_000)
    await now
    expect(r.calls).toEqual(['auth', 'getEntry'])
    expect(r.queue().map((e) => e.malId)).toEqual([1, 2])

    r.svc.clearNeedsSetup()
    expect(r.svc.needsSetup()).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(r.fake.upserts.map((u) => u.ref.malId)).toEqual([1, 2])
    expect(r.queue()).toEqual([])
    r.svc.stopSyncTimer()
  })

  it('onNeedsSetupChanged: once on the set and once on the clear, each after the flag changed', async () => {
    const seen: boolean[] = []
    const onNeedsSetupChanged = vi.fn(() => seen.push(r.svc.needsSetup()))
    const r = malWithConfigError({ onNeedsSetupChanged })

    await drain(r.svc)
    expect(onNeedsSetupChanged.mock.calls).toEqual([['mal']])
    expect(seen).toEqual([true])

    // Skipped ticks are no transition.
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(onNeedsSetupChanged).toHaveBeenCalledTimes(1)

    r.svc.clearNeedsSetup()
    expect(onNeedsSetupChanged.mock.calls).toEqual([['mal'], ['mal']])
    expect(seen).toEqual([true, false])

    await vi.advanceTimersByTimeAsync(5_000)
    r.svc.clearNeedsSetup()
    expect(onNeedsSetupChanged).toHaveBeenCalledTimes(2)
    r.svc.stopSyncTimer()
  })

  it('an instance built without the dep drains as before', async () => {
    const r = rig('shikimori', {
      initial: { shikimoriUpdateQueue: [queued(1, vals(3), vals(4), 1)] }
    })
    r.fake.set(1, vals(3))
    await drain(r.svc)
    expect(r.svc.needsSetup()).toBe(false)
    expect(r.queue()).toEqual([])
  })
})

describe('the rate-cache hooks', () => {
  const cachedRow = (malId: number, episodes: number): TestRow => ({
    malId,
    remoteId: malId * 10,
    values: vals(episodes),
    updated_at: 'listed'
  })

  it('onRateUpdated: once per entry the drain writes into the cache, before the rate broadcast; not for an uncached title', async () => {
    const order: string[] = []
    const onRateUpdated = vi.fn((trackerId: TrackerId, malId: number) =>
      order.push(`hook:${trackerId}:${malId}`)
    )
    const r = rig('anilist', {
      initial: {
        [ANILIST_KEYS.userRates]: [cachedRow(1, 3)],
        [ANILIST_KEYS.updateQueue]: [queued(1, vals(3), vals(4), 1), queued(2, vals(0), vals(1), 2)]
      },
      deps: {
        onRateUpdated,
        broadcast: (channel) => order.push(channel)
      }
    })
    r.fake.set(1, vals(3))

    await drain(r.svc)

    expect(onRateUpdated.mock.calls).toEqual([['anilist', 1]])
    expect(order.filter((e) => e.startsWith('hook') || e === r.ch.rate)).toEqual([
      'hook:anilist:1',
      r.ch.rate
    ])
    expect(r.fake.upserts).toHaveLength(2)
  })

  it('onRatesRefreshed: once after refreshRates writes, before the refreshed broadcast; not for a null result', async () => {
    const order: string[] = []
    const onRatesRefreshed = vi.fn((trackerId: TrackerId) => order.push(`hook:${trackerId}`))
    let switchDuringList = false
    const r: Rig<'anilist'> = rig('anilist', {
      deps: { onRatesRefreshed, broadcast: (channel) => order.push(channel) },
      provider: {
        async listEntries(session, o) {
          const out = await r.fake.provider.listEntries(session, o)
          if (switchDuringList) r.store.set(ANILIST_KEYS.user, { id: 2 })
          return out
        }
      }
    })
    r.fake.set(1, vals(3))

    const result = await r.svc.refreshRates({ keepQueued: false })
    expect(result?.entries).toEqual([{ ...cachedRow(1, 3), remoteId: 1010 }])
    expect(r.store.get(ANILIST_KEYS.userRates)).toEqual(result?.entries)
    expect(onRatesRefreshed.mock.calls).toEqual([['anilist']])
    expect(order.filter((e) => e.startsWith('hook') || e === r.ch.refreshed)).toEqual([
      'hook:anilist',
      r.ch.refreshed
    ])

    switchDuringList = true
    await expect(r.svc.refreshRates({ keepQueued: false })).resolves.toBeNull()
    expect(onRatesRefreshed).toHaveBeenCalledTimes(1)
  })
})

describe('the exposed cache patch (§5)', () => {
  function patchRig() {
    const order: string[] = []
    const onRateUpdated = vi.fn(() => order.push('hook'))
    const row = {
      rate: { id: 10, target_id: 1, episodes: 3, status: 'watching', score: 7, rewatches: 0 },
      shikiAnime: { id: 1, name: '#1' },
      smotretAnime: null
    }
    const r = rig('shikimori', {
      initial: { shikimoriUserRates: [row], shikimoriRecommendations: ['kept'] },
      deps: {
        onRateUpdated,
        broadcast: (channel, ...args) => {
          order.push(channel)
          r.events.push([channel, ...args])
        }
      }
    })
    return { r, order, onRateUpdated, row }
  }

  it('writes the row, then calls onRateUpdated once, then broadcasts the patched row, and leaves the id alone', () => {
    const { r, order, onRateUpdated, row } = patchRig()

    const written = r.svc.patchCachedRate(1, 1, vals(5, 9))

    const expected = {
      ...row,
      rate: { ...row.rate, episodes: 5, score: 9, updated_at: new Date(T).toISOString() }
    }
    expect(written).toEqual(expected)
    expect(r.store.get('shikimoriUserRates')).toEqual([expected])
    expect(onRateUpdated.mock.calls).toEqual([['shikimori', 1]])
    expect(order).toEqual(['hook', r.ch.rate])
    expect(r.events).toEqual([[r.ch.rate, expected]])
    expect(r.store.get('shikimoriRecommendations')).toEqual(['kept'])
  })

  it('a settled rate’s id replaces the row’s', () => {
    const { r } = patchRig()
    r.svc.patchCachedRate(1, 1, vals(5), 99)
    expect((r.store.get('shikimoriUserRates') as { rate: { id: number } }[])[0].rate.id).toBe(99)
  })

  it('a title with no cached row: nothing written, no hook, no broadcast', () => {
    const { r, onRateUpdated, row } = patchRig()
    expect(r.svc.patchCachedRate(1, 2, vals(5))).toBeNull()
    expect(r.store.get('shikimoriUserRates')).toEqual([row])
    expect(onRateUpdated).not.toHaveBeenCalled()
    expect(r.events).toEqual([])
  })

  it('keeps the owner guard: another owner’s patch writes nothing, calls no hook and broadcasts nothing (#588)', () => {
    const { r, onRateUpdated, row } = patchRig()
    expect(r.svc.patchCachedRate(2, 1, vals(5))).toBeNull()
    expect(r.store.get('shikimoriUserRates')).toEqual([row])
    expect(onRateUpdated).not.toHaveBeenCalled()
    expect(r.events).toEqual([])
  })
})

describe('the emit order: the cache update before the queue change (#697)', () => {
  const row = {
    rate: { id: 10, target_id: 1, episodes: 3, status: 'watching', score: 7, rewatches: 0 },
    shikiAnime: { id: 1, name: '#1' },
    smotretAnime: null
  }

  it.each([
    ['update', true],
    ['create', false]
  ] as const)('on the %s branch', async (_branch, onServer) => {
    const r = rig('shikimori', {
      initial: {
        shikimoriUserRates: [row],
        shikimoriUpdateQueue: [queued(1, vals(3), vals(4), 1)]
      }
    })
    if (onServer) r.fake.set(1, vals(3))

    await drain(r.svc)

    expect(r.fake.upserts.map((u) => u.ref.remoteId)).toEqual([onServer ? 10 : null])
    const names = r.events.map((e) => e[0]).filter((c) => c === r.ch.rate || c === r.ch.queue)
    expect(names).toEqual([r.ch.rate, r.ch.queue])
  })

  // The settle passes the settled rate's id through (§5).
  it('a create over a stale cached row takes the created id', async () => {
    const stale = {
      rate: { id: 5, target_id: 1, episodes: 3, status: 'watching', score: 7, rewatches: 0 },
      shikiAnime: { id: 1, name: '#1' },
      smotretAnime: null
    }
    const r = rig('shikimori', {
      initial: {
        shikimoriUserRates: [stale],
        shikimoriUpdateQueue: [queued(1, vals(3), vals(4), 1)]
      }
    })
    await drain(r.svc)
    expect((r.store.get('shikimoriUserRates') as { rate: { id: number } }[])[0].rate.id).toBe(10)
  })
})

describe('two instances are independent', () => {
  it('separate queues, status, timers and locks', async () => {
    const store = new InMemoryStorage()
    const shiki = rig('shikimori', {
      store,
      initial: { shikimoriUpdateQueue: [queued(1, vals(3), vals(4), 1)] }
    })
    const anilist = rig('anilist', {
      store,
      initial: { [ANILIST_KEYS.updateQueue]: [queued(1, vals(3), vals(4), 1)] }
    })
    shiki.fake.set(1, vals(3))
    anilist.fake.set(1, vals(3))

    // A lock held on Shikimori never delays AniList's drain.
    const held = deferred()
    const lock = shiki.svc.withQueueLock(() => held.promise)
    void shiki.svc.syncQueue()
    const now = anilist.svc.drainNow()
    await vi.advanceTimersByTimeAsync(5_000)
    await now
    expect(anilist.queue()).toEqual([])
    expect(shiki.queue()).toHaveLength(1)
    expect(shiki.calls).toEqual([])

    // A failure on AniList stays on AniList.
    anilist.store.set(ANILIST_KEYS.updateQueue, [queued(1, vals(4), vals(5), 2)])
    anilist.fake.fail('rate-limit', { member: 'getEntry' })
    await drain(anilist.svc)
    expect(anilist.svc.getSyncStatus()).toMatchObject({
      queueLength: 1,
      lastSyncError: 'AniList rate limit — will retry'
    })
    expect(shiki.svc.getSyncStatus()).toMatchObject({ queueLength: 1, lastSyncError: null })

    // Releasing Shikimori's lock runs its deferred drain; AniList's timer is its own.
    anilist.svc.stopSyncTimer()
    held.resolve()
    await lock
    await vi.advanceTimersByTimeAsync(60_000)
    expect(shiki.queue()).toEqual([])
    expect(anilist.calls.filter((c) => c === 'auth')).toHaveLength(2)
    shiki.svc.stopSyncTimer()
  })
})

describe('via items (#692 § 4)', () => {
  it('colliding queuedAt across via: the first settle leaves the via entry queued, and it drains on the next pass', async () => {
    const r = rig('shikimori')
    r.fake.set(1, vals(5))
    const leg = queued(1, vals(5), vals(6), 100, { fields: ['episodes'] })
    const mirror = queued(1, vals(6), vals(6, 9), 100, { fields: ['score'], via: 'mirror' })
    r.store.set(r.keys.updateQueue, [leg, mirror])
    const settled: unknown[] = []
    r.svc.onItemSettled((e) => {
      settled.push(e)
      // The second item's read fails the way an offline drain does.
      if (settled.length === 1) r.fake.fail('network', { member: 'getEntry' })
    })

    await drain(r.svc)

    expect(settled).toHaveLength(1)
    expect(r.queue()).toEqual([mirror])
    expect(r.fake.rows.get(1)?.values).toEqual(vals(6))

    r.svc.stopSyncTimer()
    await drain(r.svc)
    expect(r.queue()).toEqual([])
    expect(r.fake.rows.get(1)?.values).toEqual(vals(6, 9))
    expect(settled[1]).toMatchObject({ via: 'mirror', consumedQueuedAts: [100] })
  })

  it('the settled event carries the item’s via, and an item with none has no via key', async () => {
    const r = rig('anilist')
    r.fake.set(1, vals(3))
    r.fake.set(2, vals(3))
    r.store.set(r.keys.updateQueue, [
      queued(1, vals(3), vals(4), 1, { fields: ['episodes'], via: 'copy' }),
      queued(2, vals(3), vals(4), 2)
    ])
    const settled: Record<string, unknown>[] = []
    r.svc.onItemSettled((e) => settled.push(e as never))

    await drain(r.svc)

    expect(settled.map((e) => e.via)).toEqual(['copy', undefined])
    expect('via' in settled[1]).toBe(false)
  })

  it('a via item with nothing to change makes no call; a non-via one keeps the drift-match PATCH', async () => {
    const r = rig('anilist')
    r.fake.set(1, vals(4))
    r.fake.set(2, vals(4))
    r.store.set(r.keys.updateQueue, [
      queued(1, vals(4), vals(4), 1, { fields: ['episodes'], via: 'mirror' }),
      queued(2, vals(4), vals(4), 2, { fields: ['episodes'] })
    ])

    await drain(r.svc)

    expect(r.fake.upserts.map((u) => [u.ref.malId, u.changedFields])).toEqual([[2, []]])
    expect(r.queue()).toEqual([])
  })
})

describe('the enqueue (#692 § 3)', () => {
  it('appends, then patches the cached row through the codec patch, then broadcasts the queue', () => {
    const order: string[] = []
    const r = rig('anilist', {
      initial: {
        [ANILIST_KEYS.userRates]: [
          { malId: 1, remoteId: 10, values: vals(5), updated_at: 'listed' }
        ]
      },
      deps: { onRateUpdated: (id, malId) => order.push(`hook:${id}:${malId}`) }
    })
    const entry = queued(1, vals(5), vals(6), 1, { fields: ['episodes'], via: 'mirror' })

    r.svc.enqueue(entry)

    expect(r.queue()).toEqual([entry])
    expect(r.svc.cachedRate(1)).toEqual({ remoteId: 10, values: vals(6) })
    expect(order).toEqual(['hook:anilist:1'])
    expect(r.events.map(([c]) => c)).toEqual([r.ch.rate, r.ch.queue])
    expect(r.events[1][1]).toEqual({ length: 1 })
  })

  it('with no cached row nothing is patched and only the queue is broadcast', () => {
    const r = rig('anilist')
    r.svc.enqueue(queued(1, vals(0), vals(1), 1))
    expect(r.store.get(ANILIST_KEYS.userRates)).toEqual([])
    expect(r.events.map(([c]) => c)).toEqual([r.ch.queue])
  })
})
