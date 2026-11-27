// The MyAnimeList drain (#702) through `createTrackerSyncService`, with the
// real MAL provider (`createMalTracker`, as `index.ts` builds it) against
// `fake-mal.ts`: the error classes' effect on the queue, "Needs setup" and its
// two clearing calls from the `tracker:*` router, and its account-state
// broadcasts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CHANNELS } from '../../src/shared/ipc/channels'
import type { TrackerItemSettled } from '../../src/main/services/trackers/sync'
import {
  installFakeMal,
  malFixture,
  malFixtureText,
  oauth,
  type FakeMal,
  type MalCall
} from '../helpers/fake-mal'
import { malCreds, malTrackerRig, queued, type MalTrackerRig } from '../helpers/mal-tracker'

let fake: FakeMal

beforeEach(() => {
  fake = installFakeMal()
})

afterEach(() => {
  fake.restore()
})

const IDS = [101, 102, 103]
const ITEM = /^\/v2\/anime\/\d{3}$/

/** Every item's entry on MAL is at `before`; a PATCH echoes the written values. */
function serveItemsOk(): void {
  fake.on('GET', ITEM, (call) => ({
    json: {
      id: Number(call.url.pathname.split('/').at(-1)),
      my_list_status: {
        status: 'watching',
        score: 0,
        num_episodes_watched: 1,
        is_rewatching: false,
        num_times_rewatched: 0
      }
    }
  }))
  fake.on('PATCH', /^\/v2\/anime\/\d{3}\/my_list_status$/, (call: MalCall) => ({
    json: {
      status: 'watching',
      score: 0,
      num_episodes_watched: Number(call.form!.num_watched_episodes ?? 1),
      is_rewatching: false,
      num_times_rewatched: 0
    }
  }))
}

function serveInvalidClientId(): void {
  fake.on('GET', ITEM, { status: 400, text: malFixtureText('error-invalid-client-id.json') })
}

async function rigWithQueue(
  opts: Parameters<typeof malTrackerRig>[0] = {}
): Promise<MalTrackerRig & { settled: TrackerItemSettled<unknown>[] }> {
  const r = await malTrackerRig({
    ...opts,
    seed: { myanimelistUpdateQueue: IDS.map((id, i) => queued(id, 1000 + i)), ...opts.seed }
  })
  const settled: TrackerItemSettled<unknown>[] = []
  r.mal.sync.onItemSettled((e) => void settled.push(e as TrackerItemSettled<unknown>))
  return Object.assign(r, { settled })
}

const itemCalls = (): MalCall[] => fake.calls.filter((c) => ITEM.test(c.url.pathname))

describe('the MAL drain and its error classes', () => {
  // Red on main: no MAL provider, and today's policy drops an item on any other 4xx.
  it('a 400 Invalid client id aborts the MAL drain and keeps every queued entry', async () => {
    serveInvalidClientId()
    const r = await rigWithQueue()
    await r.mal.sync.syncQueue()
    expect(r.queue()).toHaveLength(3)
    expect(r.trackerRates.getSyncStatus('mal').needsSetup).toBe(true)
    expect(r.settled.filter((e) => e.outcome === 'dropped')).toEqual([])
    expect(itemCalls()).toHaveLength(1)
  })

  it('a 403 "DoS detected" stops the drain and keeps the queue; the next drain sends it', async () => {
    fake.on('GET', ITEM, { status: 403, text: malFixtureText('error-dos-detected.html') })
    const r = await rigWithQueue()
    await r.mal.sync.syncQueue()
    expect(r.queue()).toHaveLength(3)
    expect(r.mal.sync.needsSetup()).toBe(false)
    expect(r.mal.sync.getSyncStatus().lastSyncError).toBe('MyAnimeList rate limit — will retry')
    serveItemsOk()
    await r.mal.sync.syncQueue()
    expect(r.queue()).toHaveLength(0)
    expect(fake.callsTo('PATCH', /my_list_status$/)).toHaveLength(3)
  })

  it('a 404 on one item drops only that item', async () => {
    serveItemsOk()
    fake.on('GET', '/v2/anime/102', { status: 404, json: malFixture('error-not-found.json') })
    const r = await rigWithQueue()
    await r.mal.sync.syncQueue()
    expect(r.settled.map((e) => [e.malId, e.outcome])).toEqual([
      [101, 'applied'],
      [102, 'dropped'],
      [103, 'applied']
    ])
    expect(r.queue()).toHaveLength(0)
  })

  // #733 review: an edge page on a 2xx is MAL's fault, never the item's.
  it('an HTML 200 keeps the item as a server error instead of dropping it', async () => {
    serveItemsOk()
    fake.on('GET', '/v2/anime/102', {
      status: 200,
      text: '<html><body>Please wait while we check your browser</body></html>'
    })
    const r = await rigWithQueue()
    await r.mal.sync.syncQueue()
    expect(r.settled.map((e) => [e.malId, e.outcome])).toEqual([
      [101, 'applied'],
      [103, 'applied']
    ])
    expect(r.queue().map((q) => q.malId)).toEqual([102])
    expect(r.mal.sync.getSyncStatus().lastSyncError).toBe('MyAnimeList server error — will retry')
  })
})

describe('no drain while "Needs setup"', () => {
  async function needingSetup(): Promise<
    MalTrackerRig & { settled: TrackerItemSettled<unknown>[] }
  > {
    serveInvalidClientId()
    const r = await rigWithQueue()
    await r.mal.sync.syncQueue()
    expect(r.mal.sync.needsSetup()).toBe(true)
    return r
  }

  it('further ticks and drains send nothing to MAL', async () => {
    const r = await needingSetup()
    const before = fake.calls.length
    await r.mal.sync.syncQueue()
    await r.mal.sync.drainNow()
    await r.invoke(CHANNELS.TRACKER_TRIGGER_SYNC, 'mal')
    expect(fake.calls.length).toBe(before)
    expect(r.queue()).toHaveLength(3)
  })

  // Mutation: drop the router's clearNeedsSetup() call and this reds.
  it('a tracker:set-client-config save clears it once, and the queue drains', async () => {
    const r = await needingSetup()
    const clear = vi.spyOn(r.mal.sync, 'clearNeedsSetup')
    serveItemsOk()
    await r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: 'fixed-id' })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(r.mal.sync.needsSetup()).toBe(false)
    await vi.waitFor(() => expect(r.queue()).toHaveLength(0))
  })

  // Mutation: drop the Test's clearNeedsSetup() call and this reds.
  it('a tracker:test-client-config answered 200 clears it once, and the queue drains', async () => {
    const r = await needingSetup()
    const clear = vi.spyOn(r.mal.sync, 'clearNeedsSetup')
    serveItemsOk()
    fake.on('GET', '/v2/anime/1', { json: { id: 1, title: 'Cowboy Bebop' } })
    expect(await r.invoke(CHANNELS.TRACKER_TEST_CLIENT_CONFIG, 'mal')).toEqual({ ok: true })
    const test = fake.callsTo('GET', '/v2/anime/1')[0]
    expect(test.headers['x-mal-client-id']).toBe('cid-123')
    expect(test.headers.authorization).toBeUndefined()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(r.mal.sync.needsSetup()).toBe(false)
    await vi.waitFor(() => expect(r.queue()).toHaveLength(0))
  })

  it('a Test answered 400 Invalid client id leaves it set and the queue untouched', async () => {
    const r = await needingSetup()
    fake.on('GET', '/v2/anime/1', {
      status: 400,
      text: malFixtureText('error-invalid-client-id.json')
    })
    const before = itemCalls().length
    expect(await r.invoke(CHANNELS.TRACKER_TEST_CLIENT_CONFIG, 'mal')).toMatchObject({
      ok: false,
      kind: 'config'
    })
    expect(r.mal.sync.needsSetup()).toBe(true)
    expect(r.queue()).toHaveLength(3)
    expect(itemCalls().length).toBe(before)
  })

  it('a Test that can’t reach MAL is a network result', async () => {
    const r = await needingSetup()
    fake.on('GET', '/v2/anime/1', () => {
      throw new TypeError('fetch failed')
    })
    expect(await r.invoke(CHANNELS.TRACKER_TEST_CLIENT_CONFIG, 'mal')).toMatchObject({
      ok: false,
      kind: 'network'
    })
    expect(r.mal.sync.needsSetup()).toBe(true)
  })
})

describe('invalid_client on refresh goes through the token step', () => {
  it('one drain sets "Needs setup", keeps every entry, sends no item request, and the next tick makes none', async () => {
    fake.on('POST', oauth('/token'), {
      status: 401,
      text: malFixtureText('error-invalid-client.json')
    })
    serveItemsOk()
    const r = await rigWithQueue({ creds: malCreds({ expires_in: 100, obtainedAt: 0 }) })
    await r.mal.sync.syncQueue()
    expect(fake.callsTo('POST', oauth('/token'))).toHaveLength(1)
    expect(r.mal.sync.needsSetup()).toBe(true)
    expect(r.queue()).toHaveLength(3)
    expect(itemCalls()).toHaveLength(0)
    expect(r.store.get('myanimelistSessionExpired')).toBe(false)
    const before = fake.calls.length
    await r.mal.sync.syncQueue()
    expect(fake.calls.length).toBe(before)
  })
})

describe('"Needs setup" reaches tracker:accounts-changed', () => {
  // Mutation: drop the `onNeedsSetupChanged` wiring (`trackers/mal/index.ts`) and both rows red.
  it('the set and a clearNeedsSetup() each notify once, with tracker:list-accounts’ payload at that moment', async () => {
    serveInvalidClientId()
    const r = await rigWithQueue()
    const atEmit: TrackerAccountsState[] = []
    r.broadcast.mockImplementation((channel: string) => {
      if (channel === 'tracker:accounts-changed') atEmit.push(r.listAccounts())
    })
    await r.mal.sync.syncQueue()
    expect(r.notify).toHaveBeenCalledTimes(1)
    expect(r.accountsEmits()).toEqual(atEmit)
    expect(atEmit[0].accounts.find((a) => a.trackerId === 'mal')!.needsSetup).toBe(true)

    serveItemsOk()
    r.mal.sync.clearNeedsSetup()
    expect(r.notify).toHaveBeenCalledTimes(2)
    expect(r.accountsEmits()).toEqual(atEmit)
    expect(atEmit[1].accounts.find((a) => a.trackerId === 'mal')!.needsSetup).toBe(false)
  })

  it('a save that clears the instance’s flag broadcasts once, not twice', async () => {
    serveInvalidClientId()
    const r = await rigWithQueue()
    await r.mal.sync.syncQueue()
    r.notify.mockClear()
    serveItemsOk()
    await r.invoke(CHANNELS.TRACKER_SET_CLIENT_CONFIG, 'mal', { clientId: 'fixed-id' })
    expect(r.notify).toHaveBeenCalledTimes(1)
  })
})

describe('the MAL broadcasts are tracker:* only, in their tracker:* shape', () => {
  it('a drained item emits tracker:rate-updated before tracker:offline-queue-changed, with trackerId mal', async () => {
    serveItemsOk()
    const r = await rigWithQueue({
      seed: {
        myanimelistUserRates: [
          {
            node: { id: 101, title: 'One-oh-one', num_episodes: 12, status: 'finished_airing' },
            list_status: {
              status: 'watching',
              score: 0,
              num_episodes_watched: 1,
              is_rewatching: false
            },
            smotretAnime: null
          }
        ]
      }
    })
    await r.mal.sync.syncQueue()
    const channels = r.broadcast.mock.calls.map(([c]) => c as string)
    expect(channels.every((c) => c.startsWith('tracker:'))).toBe(true)
    const rate = r.broadcast.mock.calls.find(([c]) => c === 'tracker:rate-updated')!
    expect(rate[1]).toMatchObject({
      trackerId: 'mal',
      entry: { malId: 101, values: { episodes: 2, status: 'watching' } }
    })
    expect(channels.indexOf('tracker:rate-updated')).toBeLessThan(
      channels.indexOf('tracker:offline-queue-changed')
    )
    const status = r.broadcast.mock.calls.find(([c]) => c === 'tracker:sync-status')!
    expect(status[1]).toMatchObject({ trackerId: 'mal', status: { needsSetup: false } })
  })
})
