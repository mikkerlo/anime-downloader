// The Shikimori broadcast bridge (#694): the double-emit table. Each Shikimori
// emitter of the four rate, queue and status broadcasts, wired as `index.ts`
// wires it (the bridge as its `broadcast`), sends the `shikimori:*` event with
// today's payload and then its `tracker:*` twin with `trackerId: 'shikimori'`,
// exactly once each. The sync-runner's rows are in `sync-runner.test.ts` and
// `sync-runner-resolve.test.ts` (`makePc({ bridge })`); the last block pins the
// `index.ts` wiring itself, which no test can boot.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { ipcMain } from 'electron'

const auth = vi.hoisted(() => ({ exchangeCode: vi.fn(), getUser: vi.fn() }))

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi,
  exchangeCode: (...a: unknown[]) => auth.exchangeCode(...a),
  getUser: (...a: unknown[]) => auth.getUser(...a)
}))

import { EVENT_CHANNELS, CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { T0, fakeApi, iso, server } from '../helpers/fake-shikimori'
import {
  TRACKER_EVENTS,
  expectQueueTwin,
  expectRateTwin,
  onlyTwin,
  twinsOf
} from '../helpers/tracker-events'
import { shikimoriOnlyTrackers } from '../helpers/tracker-fan-out'
import { register } from '../../src/main/ipc/shikimori.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { createRunnerRateRefresh } from '../../src/main/services/sync-runner/rate-refresh'
import { queuedAfterOf } from '../../src/main/services/trackers/rates'
import { createShikimoriEventBridge } from '../../src/main/trackers/events'
import { shikimoriRateCache } from '../../src/main/trackers/shikimori.provider'
import type { RateValues } from '../../src/main/lib/shikimori-rate'
import type { QueuedShikimoriUpdate } from '../../src/main/lib/shikimori-queue'

const USER = { id: 7, nickname: 'me', avatar: '' }
const OTHER = { id: 8, nickname: 'other', avatar: '' }
const MAL = 42
const SR = EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED
const SRR = EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED
const SS = EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS
const SQ = EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED

const rv = (episodes: number, score = 7): RateValues => ({
  episodes,
  status: 'watching',
  score,
  rewatches: 0
})

const shikiRow = (malId: number, v: RateValues) => ({
  rate: { id: malId * 10, target_id: malId, ...v, updated_at: iso(T0) },
  shikiAnime: { id: malId, name: `#${malId}` },
  smotretAnime: null
})

const queueOf = (store: InMemoryStorage) =>
  store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]

/** `index.ts`'s Shikimori wiring on one store: the bridge into the sync service and the router. */
function rig(initial: Record<string, unknown> = {}) {
  const store = new InMemoryStorage({
    shikimoriUser: USER,
    shikimoriCredentials: { access_token: 'a', refresh_token: 'r', token_type: 'Bearer' },
    shikimoriUserRates: [],
    shikimoriUpdateQueue: [],
    shikimoriParkedQueues: {},
    shikimoriAnimeDetails: {},
    shikimoriRecommendations: [],
    shikimoriProfile: null,
    shikimoriFriends: [],
    shikimoriSessionExpired: false,
    trackerPrimary: null,
    trackerMirror: {},
    syncMeta: { titles: {}, rates: {} },
    ...initial
  })
  const raw = vi.fn()
  const offline = { value: false }
  const bridge = createShikimoriEventBridge({
    broadcast: raw,
    channels: TRACKER_EVENTS,
    needsSetup: () => sync.tracker.needsSetup(),
    queuedAfter: () => queuedAfterOf(queueOf(store))
  })
  const sync = createShikimoriSyncService({
    store: store as never,
    broadcast: bridge,
    syncStatusChannel: SS,
    offlineQueueChangedChannel: SQ,
    rateUpdatedChannel: SR,
    animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
    ratesRefreshedChannel: SRR,
    isOffline: () => offline.value
  })
  const wiring = shikimoriOnlyTrackers(store as never, sync, () => offline.value)
  ;(ipcMain.handle as unknown as Mock).mockClear()
  register({
    store,
    shikimoriSyncService: sync,
    ...wiring,
    lookupByMalIds: async () => ({}),
    maybeBroadcastCleanupPrompt: async () => {},
    runAutoDownloadTick: async () => ({}),
    broadcast: bridge,
    offlineService: { isOffline: () => offline.value }
  } as unknown as AppDeps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  return {
    store,
    raw,
    bridge,
    sync,
    offline,
    ...wiring,
    invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args),
    calls: () => raw.mock.calls as unknown[][]
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0 + 5_000_000)
  server.reset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the bridge: what each twin carries', () => {
  const bridgeOn = (opts: { needsSetup?: boolean; queue?: QueuedShikimoriUpdate[] } = {}) => {
    const raw = vi.fn()
    const bridge = createShikimoriEventBridge({
      broadcast: raw,
      channels: TRACKER_EVENTS,
      needsSetup: () => opts.needsSetup ?? false,
      queuedAfter: () => queuedAfterOf(opts.queue ?? [])
    })
    return { raw, bridge }
  }

  it('a status with "Needs setup" set: the twin carries needsSetup: true, and the legacy payload has no needsSetup', () => {
    const { raw, bridge } = bridgeOn({ needsSetup: true })
    const status = {
      state: 'idle',
      queueLength: 2,
      lastSyncAt: 5,
      lastSyncError: null,
      sessionExpired: false
    }
    bridge(SS, status)
    const { legacy, twin } = onlyTwin(raw.mock.calls, SS)
    expect(legacy).toBe(status)
    expect(legacy).not.toHaveProperty('needsSetup')
    expect(twin).toEqual({ trackerId: 'shikimori', status: { ...status, needsSetup: true } })
  })

  it("the queue twin's overlay is read from the store at emit time, the last after per title; the length is the payload's", () => {
    const entry = (malId: number, episodes: number, queuedAt: number) =>
      ({ malId, rateId: null, before: rv(0), after: rv(episodes), queuedAt }) as never
    const { raw, bridge } = bridgeOn({ queue: [entry(1, 3, 1), entry(2, 9, 2), entry(1, 4, 3)] })
    bridge(SQ, { length: 3 })
    expectQueueTwin(onlyTwin(raw.mock.calls, SQ), { 1: rv(4), 2: rv(9) })
  })

  it('a rates refresh: the twin has every row normalized, and the rows themselves as raw', () => {
    const { raw, bridge } = bridgeOn()
    const rows = [shikiRow(1, rv(3)), shikiRow(2, rv(5))]
    bridge(SRR, rows)
    const { legacy, twin } = onlyTwin(raw.mock.calls, SRR)
    expect(twin).toEqual({
      trackerId: 'shikimori',
      entries: rows.map((r) => shikimoriRateCache.entryOf(r as never)),
      raw: rows
    })
    expect(twin.raw).toBe(legacy)
    expect((twin.entries as { values: RateValues }[])[1].values).toEqual(rv(5))
  })

  it('pass-through: shikimori:anime-details-updated goes out once, with no tracker:* event; so does any other channel', () => {
    const { raw, bridge } = bridgeOn()
    const payload = { malId: 1, details: { id: 1 } }
    bridge(EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED, payload)
    bridge(EVENT_CHANNELS.SYNC_RUN_FINISHED, { ok: true })
    expect(raw.mock.calls).toEqual([
      [EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED, payload],
      [EVENT_CHANNELS.SYNC_RUN_FINISHED, { ok: true }]
    ])
  })

  it('a payload the mapping cannot read: the legacy event still goes out, and the emitter sees no throw', () => {
    const { raw, bridge } = bridgeOn()
    expect(() => bridge(SR, null)).not.toThrow()
    expect(raw.mock.calls).toEqual([[SR, null]])
  })
})

describe('the double-emit table: the router and the sync service (#694)', () => {
  it('sendRate (a live update-rate): the patched row, then its twin', async () => {
    const r = rig({ shikimoriUserRates: [shikiRow(MAL, rv(3))] })
    server.set(MAL, rv(3))

    await r.invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, MAL, 4, 'watching', 7, 0)

    const patch = onlyTwin(r.calls(), SR)
    expect(patch.legacy).toEqual((r.store.get('shikimoriUserRates') as unknown[])[0])
    expect((patch.legacy as { rate: RateValues }).rate.episodes).toBe(4)
    expectRateTwin(patch)
  })

  it('queueRate, live queue (offline): the patch, the queue change with the overlay and the status, each with its twin', async () => {
    const r = rig({ shikimoriUserRates: [shikiRow(MAL, rv(3))] })
    fakeApi.ensureFreshToken.mockRejectedValueOnce(new TypeError('fetch failed'))

    await r.invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, MAL, 4, 'watching', 7, 0)

    expect(queueOf(r.store)).toHaveLength(1)
    const calls = r.calls()
    expectRateTwin(onlyTwin(calls, SR))
    const changed = onlyTwin(calls, SQ)
    expect(changed.legacy).toEqual({ length: 1 })
    expectQueueTwin(changed, { [MAL]: rv(4) })
    const status = onlyTwin(calls, SS)
    expect(status.twin).toEqual({
      trackerId: 'shikimori',
      status: { ...(status.legacy as object), needsSetup: false }
    })
    r.sync.stopSyncTimer()
  })

  it("queueRate, parked (a switch during the read): the live queue's length, then its twin", async () => {
    const r = rig({ shikimoriUserRates: [shikiRow(MAL, rv(3))] })
    fakeApi.getUserRate.mockImplementationOnce(async () => {
      r.store.set('shikimoriUser', OTHER)
      throw new TypeError('fetch failed')
    })

    await r.invoke(CHANNELS.SHIKIMORI_UPDATE_RATE, MAL, 4, 'watching', 7, 0)

    expect(Object.keys(r.store.get('shikimoriParkedQueues') as object)).toEqual(['7'])
    const changed = onlyTwin(r.calls(), SQ)
    expect(changed.legacy).toEqual({ length: 0 })
    expectQueueTwin(changed, {})
    expect(twinsOf(r.calls(), SR)).toEqual([])
  })

  it('exchange-code: the restored queue length and the status, each with its twin', async () => {
    const r = rig({
      shikimoriUser: null,
      shikimoriCredentials: null,
      shikimoriParkedQueues: {
        '7': {
          nickname: 'me',
          parkedAt: 1,
          entries: [{ malId: MAL, rateId: null, before: rv(0), after: rv(2), queuedAt: 1 }]
        }
      }
    })
    auth.exchangeCode.mockResolvedValue({ access_token: 'b', refresh_token: 'r2' })
    auth.getUser.mockResolvedValue(USER)
    // The restore's background refresh: an empty list, which keeps the restored entry.
    fakeApi.ensureFreshToken.mockRejectedValue(new TypeError('fetch failed'))

    await r.invoke(CHANNELS.SHIKIMORI_EXCHANGE_CODE, 'code')

    const changed = onlyTwin(r.calls(), SQ)
    expect(changed.legacy).toEqual({ length: 1 })
    expectQueueTwin(changed, { [MAL]: rv(2) })
    expect(twinsOf(r.calls(), SS).length).toBeGreaterThan(0)
    r.sync.stopSyncTimer()
  })

  it('logout: the emptied queue and the status, each with its twin', async () => {
    const r = rig()
    await r.invoke(CHANNELS.SHIKIMORI_LOGOUT)
    const changed = onlyTwin(r.calls(), SQ)
    expect(changed.legacy).toEqual({ length: 0 })
    expectQueueTwin(changed, {})
    expect(onlyTwin(r.calls(), SS).twin).toMatchObject({
      trackerId: 'shikimori',
      status: { queueLength: 0, needsSetup: false }
    })
  })

  it("the drain: reconcileCacheFromRate's patch, then dropConsumedEntries' queue change, each with its twin, in that order", async () => {
    const r = rig({
      shikimoriUserRates: [shikiRow(MAL, rv(4))],
      shikimoriUpdateQueue: [
        { malId: MAL, rateId: MAL * 10, before: rv(3), after: rv(4), queuedAt: 1 }
      ]
    })
    server.set(MAL, rv(3))

    await r.sync.drainNow()

    const calls = r.calls()
    const patch = onlyTwin(calls, SR)
    expectRateTwin(patch)
    const changed = onlyTwin(calls, SQ)
    expectQueueTwin(changed, {})
    expect(changed.legacy).toEqual({ length: 0 })
    const at = (ch: string) => calls.findIndex(([c]) => c === ch)
    expect(at(SR)).toBeLessThan(at(SQ))
    // The drain's syncing and idle statuses, each with its twin.
    expect(twinsOf(calls, SS)).toHaveLength(2)
  })

  it("refreshRates (the sync service's): the new rows, then their twin with raw being those rows", async () => {
    const r = rig()
    server.set(MAL, rv(6))

    await r.sync.refreshRates({ keepQueued: false })

    const refreshed = onlyTwin(r.calls(), SRR)
    expect(refreshed.legacy).toEqual(r.store.get('shikimoriUserRates'))
    expect(refreshed.twin.raw).toBe(refreshed.legacy)
    expect(refreshed.twin.entries).toEqual([
      expect.objectContaining({ trackerId: 'shikimori', malId: MAL, values: rv(6) })
    ])
  })

  it('broadcastSyncStatus: the five-field status, then the twin with needsSetup', () => {
    const r = rig()
    r.sync.broadcastSyncStatus()
    const { legacy, twin } = onlyTwin(r.calls(), SS)
    expect(Object.keys(legacy as object)).toEqual([
      'state',
      'queueLength',
      'lastSyncAt',
      'lastSyncError',
      'sessionExpired'
    ])
    expect(twin).toEqual({
      trackerId: 'shikimori',
      status: { ...(legacy as object), needsSetup: false }
    })
  })

  it("the runner's wholesale refresh (createRunnerRateRefresh, index.ts's): the rows, then their twin", async () => {
    const r = rig()
    server.set(MAL, rv(6))

    await createRunnerRateRefresh({
      store: r.store as never,
      lookupByMalIds: async () => ({}),
      broadcast: r.bridge
    })()

    const refreshed = onlyTwin(r.calls(), SRR)
    expect(refreshed.legacy).toEqual(r.store.get('shikimoriUserRates'))
    expect(refreshed.twin).toEqual({
      trackerId: 'shikimori',
      entries: [expect.objectContaining({ malId: MAL, values: rv(6) })],
      raw: refreshed.legacy
    })
  })

  it('a write through services/trackers (applyChange) emits exactly one tracker:rate-updated: the instance and the bridge never both do', async () => {
    const r = rig({ shikimoriUserRates: [shikiRow(MAL, rv(3))] })
    server.set(MAL, rv(3))

    await r.trackers.applyChange(
      MAL,
      { kind: 'set', values: rv(5) },
      { target: 'shikimori', cause: 'user' }
    )

    expect(r.calls().filter(([c]) => c === EVENT_CHANNELS.TRACKER_RATE_UPDATED)).toHaveLength(1)
    expectRateTwin(onlyTwin(r.calls(), SR))
  })
})

// `index.ts` boots the app, so no test can import it: these pin that every
// Shikimori emitter it builds is handed the bridge, and that none of the four
// broadcasts goes to the bare `broadcastToAll`.
describe('index.ts hands the bridge to every Shikimori emitter (#694)', () => {
  const INDEX = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8')

  /** The object literal passed to the first `callee({` call. */
  function argsOf(callee: string): string {
    const start = INDEX.indexOf(`${callee}({`)
    expect(start, `${callee}({ in index.ts`).toBeGreaterThan(-1)
    let depth = 0
    for (let i = start + callee.length + 1; i < INDEX.length; i++) {
      if (INDEX[i] === '{') depth++
      else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1)
    }
    throw new Error(`unbalanced ${callee}`)
  }

  it.each([
    'createShikimoriSyncService',
    'createSyncRunner',
    'createRunnerRateRefresh',
    'registerIpcRouters'
  ])('%s gets broadcast: shikimoriBroadcast', (callee) => {
    const args = argsOf(callee)
    expect(args).toMatch(/\bbroadcast: shikimoriBroadcast\b/)
    expect(args).not.toMatch(/\bbroadcast: broadcastToAll\b/)
  })

  it('the bridge wraps broadcastToAll, and no bridged channel is sent to broadcastToAll directly', () => {
    expect(argsOf('createShikimoriEventBridge')).toMatch(/\bbroadcast: broadcastToAll\b/)
    const direct =
      /broadcastToAll\(\s*EVENT_CHANNELS\.SHIKIMORI_(?:RATE_UPDATED|RATES_REFRESHED|SYNC_STATUS|OFFLINE_QUEUE_CHANGED)\b/
    expect(INDEX).not.toMatch(direct)
  })
})
