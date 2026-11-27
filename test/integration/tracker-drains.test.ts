// Every connected tracker through the boot drain and the online kick-off (#693):
// Shikimori's real sync service over `fake-shikimori.ts` next to an AniList
// generic instance over `fake-tracker.ts`, both with queued entries, composed
// with the same helpers `src/main/index.ts` calls (`bootDrain(edgeTrackers(…))`
// and `kickoffTrackers(…)`). One tracker's failure never stops the other's
// drain: an expired session or a 401 (asynchronous, inside the drain's
// promise) and a synchronous throw, which only the per-tracker guards contain.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { InMemoryStorage } from '../helpers/in-memory-storage'

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi
}))

import { ShikiAuthError } from '../../src/main/shikimori'
import { fakeApi, server } from '../helpers/fake-shikimori'
import { createGenericTracker } from '../helpers/generic-tracker'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import { bootDrain, edgeTrackers, kickoffTrackers } from '../../src/main/services/trackers/edges'
import { createOfflineService } from '../../src/main/services/offline'
import { createOfflineKickoff } from '../../src/main/services/offline/kickoff'

type Svc = TrackerSyncService<unknown, unknown>

const entry = (malId: number, queuedAt: number) => ({
  malId,
  rateId: null,
  queuedAt,
  before: { episodes: 0, status: 'watching', score: 0, rewatches: 0 },
  after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 }
})

const ANILIST_USER = { id: 1, nickname: 'anilist-user', avatar: null }

function rig(opts: { offline?: boolean; anilistConnected?: boolean } = {}) {
  const connected = opts.anilistConnected ?? true
  const store = new InMemoryStorage({
    workOffline: opts.offline ?? false,
    shikimoriCredentials: { access_token: 'tok', refresh_token: 'r' },
    shikimoriUser: { id: 7, nickname: 'me' },
    shikimoriUpdateQueue: [entry(10, 1), entry(11, 2)],
    shikimoriParkedQueues: {},
    shikimoriUserRates: [],
    shikimoriAnimeDetails: {},
    anilistCredentials: connected ? { v: 1, enc: 'plain', data: 'blob' } : null,
    anilistUser: connected ? ANILIST_USER : null,
    anilistUpdateQueue: connected ? [entry(1, 1), entry(2, 2)] : [],
    anilistParkedQueues: {},
    anilistUserRates: []
  })
  // `offline` is read through a late binding, as `index.ts` does.
  const ref: { isOffline: () => boolean } = { isOffline: () => opts.offline ?? false }
  const shiki = createShikimoriSyncService({
    store,
    broadcast: () => {},
    syncStatusChannel: 's',
    offlineQueueChangedChannel: 'q',
    rateUpdatedChannel: 'r',
    animeDetailsUpdatedChannel: 'd',
    isOffline: () => ref.isOffline()
  })
  const anilist = createGenericTracker('anilist', store as never, {
    isOffline: () => ref.isOffline()
  })
  const fan = createTrackerFanOut({
    store: store as never,
    trackers: [{ sync: shiki.tracker as Svc }, { sync: anilist.sync }]
  })
  const prefetch = vi.fn(async () => undefined)
  const kickoff = createOfflineKickoff({
    trackers: () => kickoffTrackers(store, fan.syncServices(), prefetch),
    suspendDownloads: vi.fn(),
    resumeDownloads: vi.fn(),
    suspendSyncplay: vi.fn(),
    resumeSyncplay: vi.fn(),
    retryBinaries: vi.fn(),
    runAutoDownloadTick: vi.fn()
  })
  const offline = createOfflineService({
    store,
    probeUrls: () => [],
    onOnline: kickoff.onOnline,
    onOffline: kickoff.onOffline
  })
  ref.isOffline = offline.isOffline
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  return {
    store,
    shiki: shiki.tracker as Svc,
    anilist: anilist.sync,
    alFake: anilist.fake,
    prefetch,
    warn,
    boot: () => bootDrain(edgeTrackers(store, fan.syncServices())),
    goOnline: () => offline.setManual(false),
    goOffline: () => offline.setManual(true),
    stop: () => fan.syncServices().forEach((s) => s.stopSyncTimer())
  }
}

type Rig = ReturnType<typeof rig>
let current: Rig | null = null
const make = (opts?: Parameters<typeof rig>[0]): Rig => (current = rig(opts))

const queue = (r: Rig, key: 'shikimoriUpdateQueue' | 'anilistUpdateQueue'): number[] =>
  (r.store.get(key) as { malId: number }[]).map((q) => q.malId)

/** The drain sleeps 250 ms between items. */
const settle = () => vi.advanceTimersByTimeAsync(5_000)

beforeEach(() => {
  vi.useFakeTimers()
  server.reset()
  fakeApi.ensureFreshToken.mockReset().mockResolvedValue('tok')
})

afterEach(() => {
  current?.stop()
  current = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('one tracker’s expired session doesn’t stop another’s drain', () => {
  it('Shikimori’s session expired at boot: AniList’s queue still drains', async () => {
    fakeApi.ensureFreshToken.mockRejectedValue(
      new ShikiAuthError('Shikimori session expired', 400, 'invalid_grant')
    )
    const r = make()
    r.boot()
    await settle()
    expect(queue(r, 'anilistUpdateQueue')).toEqual([])
    expect([...r.alFake.rows.keys()].sort()).toEqual([1, 2])
    expect(queue(r, 'shikimoriUpdateQueue')).toEqual([10, 11])
  })

  it('Shikimori’s session expired on the online edge: AniList’s queue still drains', async () => {
    fakeApi.ensureFreshToken.mockRejectedValue(
      new ShikiAuthError('Shikimori session expired', 400, 'invalid_grant')
    )
    const r = make({ offline: true })
    r.boot()
    await settle()
    expect(queue(r, 'anilistUpdateQueue')).toEqual([1, 2])
    r.goOnline()
    await settle()
    expect(queue(r, 'anilistUpdateQueue')).toEqual([])
    expect(queue(r, 'shikimoriUpdateQueue')).toEqual([10, 11])
  })

  it('AniList answers 401 at boot: Shikimori’s queue still drains', async () => {
    const r = make()
    r.alFake.fail('auth', { member: 'auth' })
    r.boot()
    await settle()
    expect(queue(r, 'shikimoriUpdateQueue')).toEqual([])
    expect([...server.rows.keys()].sort()).toEqual([10, 11])
    expect(queue(r, 'anilistUpdateQueue')).toEqual([1, 2])
  })

  it('AniList answers 401 on the online edge: Shikimori’s queue still drains', async () => {
    const r = make({ offline: true })
    r.alFake.fail('auth', { member: 'auth' })
    r.goOnline()
    await settle()
    expect(queue(r, 'shikimoriUpdateQueue')).toEqual([])
    expect(queue(r, 'anilistUpdateQueue')).toEqual([1, 2])
  })
})

describe('a synchronous throw from one tracker never skips the next', () => {
  it('in the kick-off: Shikimori’s drain throws before it returns a promise; AniList’s still drains', async () => {
    const r = make({ offline: true })
    vi.spyOn(r.shiki, 'syncQueue').mockImplementation(() => {
      throw new Error('sync boom')
    })
    r.goOnline()
    await settle()
    expect(r.shiki.syncQueue).toHaveBeenCalledTimes(1)
    expect(queue(r, 'anilistUpdateQueue')).toEqual([])
    expect(r.warn).toHaveBeenCalledWith(
      '[offline] Shikimori queue drain failed:',
      expect.any(Error)
    )
  })

  it('at boot: Shikimori’s getQueueLength() throws; AniList still starts its timer and drains', async () => {
    const r = make()
    vi.spyOn(r.shiki, 'getQueueLength').mockImplementation(() => {
      throw new Error('sync boom')
    })
    const timer = vi.spyOn(r.anilist, 'startSyncTimer')
    r.boot()
    await settle()
    expect(timer).toHaveBeenCalledTimes(1)
    expect(queue(r, 'anilistUpdateQueue')).toEqual([])
    expect(queue(r, 'shikimoriUpdateQueue')).toEqual([10, 11])
    expect(r.warn).toHaveBeenCalledWith(
      '[trackers] Shikimori boot drain failed:',
      expect.any(Error)
    )
  })

  it('at boot: Shikimori’s startSyncTimer() throws; AniList still starts its timer and drains', async () => {
    const r = make()
    vi.spyOn(r.shiki, 'startSyncTimer').mockImplementation(() => {
      throw new Error('sync boom')
    })
    const timer = vi.spyOn(r.anilist, 'startSyncTimer')
    r.boot()
    await settle()
    expect(timer).toHaveBeenCalledTimes(1)
    expect(queue(r, 'anilistUpdateQueue')).toEqual([])
    expect(queue(r, 'shikimoriUpdateQueue')).toEqual([10, 11])
  })
})

describe('the tracker list is read when each edge fires', () => {
  it('a tracker connected after start-up joins the next online edge', async () => {
    const r = make({ offline: true, anilistConnected: false })
    const drain = vi.spyOn(r.anilist, 'syncQueue')
    r.boot()
    r.goOnline()
    await settle()
    expect(drain).not.toHaveBeenCalled()
    expect(queue(r, 'shikimoriUpdateQueue')).toEqual([])

    r.goOffline()
    r.store.set('anilistCredentials', { v: 1, enc: 'plain', data: 'blob' })
    r.store.set('anilistUser', ANILIST_USER)
    r.store.set('anilistUpdateQueue', [entry(3, 5)])
    r.goOnline()
    await settle()
    expect(drain).toHaveBeenCalledTimes(1)
    expect(queue(r, 'anilistUpdateQueue')).toEqual([])
    expect([...r.alFake.rows.keys()]).toEqual([3])
  })

  it('a disconnected tracker is left out of boot and the online edge; Shikimori’s prefetch alone is staggered', async () => {
    const r = make({ offline: true, anilistConnected: false })
    // A live queue with no user: only the connected filter keeps it out.
    r.store.set('anilistUpdateQueue', [entry(1, 1)])
    const timer = vi.spyOn(r.anilist, 'startSyncTimer')
    const drain = vi.spyOn(r.anilist, 'syncQueue')
    r.boot()
    r.goOnline()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(timer).not.toHaveBeenCalled()
    expect(drain).not.toHaveBeenCalled()
    expect(r.prefetch).toHaveBeenCalledTimes(1)
  })
})

describe('the wiring in src/main/index.ts (source pin)', () => {
  it('boot and the online edge go through the helpers this file composes', () => {
    // `index.ts` boots Electron at module scope and can't be imported here.
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'main', 'index.ts'),
      'utf-8'
    )
    expect(src).toContain('bootDrain(edgeTrackers(store, trackerFanOut.syncServices()))')
    expect(src).toContain(
      'kickoffTrackers(\n        store,\n        trackerFanOut.syncServices(),\n        () => shikimoriSyncService.prefetchShikimoriDetails(),'
    )
    // AniList's details prefetch rides on its kick-off entry (#703).
    expect(src).toContain('{ anilist: () => anilistProvider.prefetchDetails() }')
    expect(src).not.toContain('shikimoriSyncService.startSyncTimer()')
  })
})
