// AniList's primary branch (#703): queue-first, through the AniList instance's
// drain. The real fan-out, the real AniList provider, sync instance and
// limiter against a stateful fixture account, and a generic MyAnimeList
// instance as the mirror.
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  ALICE,
  anilistFixture,
  createAniListWorld,
  createTestAniList,
  type AniListWorld,
  type WorldEntry
} from '../helpers/anilist-server'
import { createGenericTracker } from '../helpers/generic-tracker'
import { createAniListSyncService } from '../../src/main/trackers/anilist/sync'
import { createAniListPrimary } from '../../src/main/services/trackers/anilist-primary'
import { createTrackerFanOut, type FanOutTracker } from '../../src/main/services/trackers/fan-out'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import type { QueuedTrackerUpdate } from '../../src/main/lib/shikimori-queue'
import type { RateValues } from '../../src/main/lib/shikimori-rate'
import { rateClockKey } from '../../src/main/store/sync-meta'

type Svc = TrackerSyncService<unknown, unknown>

let world: AniListWorld | null = null
afterEach(() => {
  world?.server.restore()
  world = null
})

const v = (
  episodes: number,
  score: number,
  status: RateValues['status'] = 'watching'
): RateValues => ({ episodes, status, score, rewatches: 0 })

const ENTRY: WorldEntry = {
  id: 9001,
  mediaId: 101,
  idMal: 1,
  status: 'CURRENT',
  score: 90,
  progress: 7,
  repeat: 0,
  updatedAt: 1
}

async function primaryRig(
  opts: {
    entries?: WorldEntry[]
    media?: Record<number, number[]>
    writer?: boolean
    mal?: boolean
  } = {}
) {
  world = createAniListWorld({ entries: opts.entries ?? [ENTRY], media: opts.media })
  const t = await createTestAniList({
    provider: {
      lookupByMalIds: async (ids) =>
        Object.fromEntries(ids.map((id) => [id, { id: 4200 + id }])) as never
    }
  })
  const sync = createAniListSyncService(t.provider, {
    store: t.store as never,
    broadcast: () => {},
    syncStatusChannel: 's',
    offlineQueueChangedChannel: 'q',
    rateUpdatedChannel: 'r',
    ratesRefreshedChannel: 'rr'
  }) as unknown as Svc
  const cleanup = vi.fn(async () => {})
  const primary = createAniListPrimary({
    store: t.store as never,
    sync,
    maybeBroadcastCleanupPrompt: cleanup
  })
  const trackers: FanOutTracker[] = [
    { sync, ...(opts.writer === false ? {} : { writePrimary: (m, c) => primary.write(m, c) }) }
  ]
  let mal: ReturnType<typeof createGenericTracker<'mal'>> | null = null
  if (opts.mal) {
    mal = createGenericTracker('mal', t.store as never)
    t.store.set('myanimelistUser', { id: 77, nickname: 'm', avatar: null })
    t.store.set('myanimelistUserRates', [{ malId: 1, remoteId: 31, values: v(3, 5) }])
    trackers.push({ sync: mal.sync })
  }
  const fan = createTrackerFanOut({ store: t.store as never, trackers, log: { warn: () => {} } })
  return { t, sync, fan, cleanup, mal, world: world! }
}

const queue = (t: { store: { get(k: string): unknown } }) =>
  t.store.get('anilistUpdateQueue') as QueuedTrackerUpdate[]

describe('AniList as the primary', () => {
  it('a mark-watched goes through AniList’s own writer: queued, then drained with progress only', async () => {
    const r = await primaryRig()
    await r.sync.refreshRates({ keepQueued: false })
    expect(r.fan.primary()).toBe('anilist')
    const out = await r.fan.applyChange(
      1,
      { kind: 'mark-watched', episode: 8 },
      { target: 'anilist', cause: 'user' }
    )
    expect(out).toEqual({ kind: 'primary', result: v(8, 9), after: v(8, 9) })
    expect(queue(r.t)).toEqual([
      expect.objectContaining({
        malId: 1,
        rateId: 9001,
        before: v(7, 9),
        after: v(8, 9),
        fields: ['episodes']
      })
    ])
    expect(queue(r.t)[0]).not.toHaveProperty('via')
    // The enqueue patched the cache in the same step.
    expect(r.sync.cachedRate(1)!.values).toEqual(v(8, 9))
    expect(r.t.store.get('syncMeta')).toMatchObject({
      rates: { [rateClockKey('anilist', ALICE.id, 1)]: expect.anything() }
    })
    await r.sync.drainNow()
    expect(r.world.saves()).toEqual([{ mediaId: 101, progress: 8 }])
    expect(queue(r.t)).toEqual([])
  })

  it('without the writer the fan-out refuses: "AniList has no primary write path" (the mutation control)', async () => {
    const r = await primaryRig({ writer: false })
    await expect(
      r.fan.applyChange(
        1,
        { kind: 'mark-watched', episode: 8 },
        { target: 'anilist', cause: 'user' }
      )
    ).rejects.toThrow('AniList has no primary write path')
  })

  it('a mark-watched never lowers a higher server progress after the drain', async () => {
    const r = await primaryRig()
    await r.sync.refreshRates({ keepQueued: false })
    // Watched further on anilist.co since the last refresh.
    r.world.entries.get(101)!.progress = 9
    await r.fan.applyChange(
      1,
      { kind: 'mark-watched', episode: 8 },
      { target: 'anilist', cause: 'user' }
    )
    await r.sync.drainNow()
    expect(r.world.saves()).toEqual([])
    expect(r.world.entries.get(101)!.progress).toBe(9)
    expect(r.sync.cachedRate(1)!.values.episodes).toBe(9)
    expect(queue(r.t)).toEqual([])
  })

  it('a title with no row takes the create rule: every field, created on the drain', async () => {
    const r = await primaryRig({ entries: [], media: { 5: [505] } })
    await r.fan.applyChange(
      5,
      { kind: 'mark-watched', episode: 1 },
      { target: 'anilist', cause: 'user' }
    )
    expect(queue(r.t)[0]).toMatchObject({
      rateId: null,
      fields: ['episodes', 'status', 'score', 'rewatches']
    })
    await r.sync.drainNow()
    expect(r.world.saves()).toEqual([
      { mediaId: 505, status: 'CURRENT', progress: 1, scoreRaw: 0, repeat: 0 }
    ])
  })

  it('a cold cache (the list not loaded yet) reads the live entry once and queues against it', async () => {
    const r = await primaryRig()
    const out = await r.fan.applyChange(
      1,
      { kind: 'mark-watched', episode: 8 },
      { target: 'anilist', cause: 'user' }
    )
    expect(out).toEqual({ kind: 'primary', result: v(8, 9), after: v(8, 9) })
    expect(r.world.server.of('MediaList')).toHaveLength(1)
    expect(queue(r.t)).toEqual([
      expect.objectContaining({
        rateId: 9001,
        before: v(7, 9),
        after: v(8, 9),
        fields: ['episodes']
      })
    ])
    await r.sync.drainNow()
    expect(r.world.saves()).toEqual([{ mediaId: 101, progress: 8 }])
    expect(r.world.entries.get(101)).toMatchObject({ progress: 8, score: 90 })
  })

  it('offline with a cold cache: the create rule, queued without a read', async () => {
    const r = await primaryRig()
    r.world.inject('IdMap', { throws: new TypeError('fetch failed') })
    await r.fan.applyChange(
      1,
      { kind: 'mark-watched', episode: 8 },
      { target: 'anilist', cause: 'user' }
    )
    expect(queue(r.t)).toEqual([
      expect.objectContaining({
        rateId: null,
        fields: ['episodes', 'status', 'score', 'rewatches']
      })
    ])
  })

  it.each([
    ['an HTTP 400 Invalid token', { status: 400, body: anilistFixture('invalid-token-400') }],
    ['an HTTP 401', { status: 401, body: anilistFixture('invalid-token-401') }]
  ] as const)(
    'a cold cache whose live read finds the token refused (%s): the create rule, queued, not thrown (#740)',
    async (_name, reply) => {
      const r = await primaryRig()
      r.world.inject('MediaList', reply)
      const out = await r.fan.applyChange(
        1,
        { kind: 'set', values: v(8, 9) },
        { target: 'anilist', cause: 'user' }
      )
      expect(out).toMatchObject({ kind: 'primary', after: v(8, 9) })
      expect(r.world.server.of('MediaList')).toHaveLength(1)
      expect(queue(r.t)).toEqual([
        expect.objectContaining({
          malId: 1,
          rateId: null,
          after: v(8, 9),
          fields: ['episodes', 'status', 'score', 'rewatches']
        })
      ])
      await vi.waitFor(() => expect(r.t.store.get('anilistSessionExpired')).toBe(true))
    }
  )

  it('a switch during the cold read parks the change for the account it was made on', async () => {
    const r = await primaryRig()
    r.world.inject('MediaList', {
      body: {
        data: {
          MediaList: {
            id: 9001,
            status: 'CURRENT',
            score: 90,
            progress: 7,
            repeat: 0,
            updatedAt: 1
          }
        }
      }
    })
    const pending = r.fan.applyChange(
      1,
      { kind: 'mark-watched', episode: 8 },
      { target: 'anilist', cause: 'user' }
    )
    r.t.store.set('anilistUser', { ...ALICE, id: 6002, nickname: 'bob' })
    await pending
    expect(queue(r.t)).toEqual([])
    const parked = r.t.store.get('anilistParkedQueues') as Record<
      string,
      { entries: QueuedTrackerUpdate[] }
    >
    expect(parked[String(ALICE.id)].entries).toEqual([
      expect.objectContaining({ malId: 1, after: v(8, 9), fields: ['episodes'] })
    ])
  })

  it('a set with nothing to change queues nothing and still returns the values', async () => {
    const r = await primaryRig()
    await r.sync.refreshRates({ keepQueued: false })
    const out = await r.fan.applyChange(
      1,
      { kind: 'set', values: v(7, 9) },
      { target: 'anilist', cause: 'user' }
    )
    expect(out).toMatchObject({ kind: 'primary', after: v(7, 9) })
    expect(queue(r.t)).toEqual([])
  })

  it('refuses a set for a title not on AniList; a mark-watched for one is null', async () => {
    const r = await primaryRig({ media: { 2: [] } })
    await r.t.provider.idMap.resolve([2], { priority: 'interactive' })
    await expect(
      r.fan.applyChange(2, { kind: 'set', values: v(1, 0) }, { target: 'anilist', cause: 'user' })
    ).rejects.toThrow('isn’t on AniList')
    expect(
      await r.fan.applyChange(
        2,
        { kind: 'mark-watched', episode: 1 },
        { target: 'anilist', cause: 'user' }
      )
    ).toEqual({ kind: 'primary', result: null })
    expect(queue(r.t)).toEqual([])
  })
})

describe('the mirrors and the cleanup prompt', () => {
  it('the returned basis and after feed the mirrors as Shikimori’s do: only the field the user changed', async () => {
    const r = await primaryRig({ mal: true })
    await r.sync.refreshRates({ keepQueued: false })
    await r.fan.applyChange(
      1,
      { kind: 'set', values: v(7, 6) },
      { target: 'anilist', cause: 'user' }
    )
    const malQueue = r.t.store.get('myanimelistUpdateQueue') as QueuedTrackerUpdate[]
    expect(malQueue).toEqual([
      expect.objectContaining({
        malId: 1,
        before: v(3, 5),
        after: v(3, 6),
        fields: ['score'],
        via: 'mirror'
      })
    ])
  })

  it('a change to completed calls maybeBroadcastCleanupPrompt once, with the AniList entry’s own smotretAnime', async () => {
    const r = await primaryRig()
    await r.sync.refreshRates({ keepQueued: false })
    await r.fan.applyChange(
      1,
      { kind: 'set', values: v(26, 9, 'completed') },
      { target: 'anilist', cause: 'user' }
    )
    // The smotret join the list refresh stored on the row, never null: the
    // fallback lookup (`malIdMap`, `lookupByMalIds`) can't stand in for it.
    expect(r.cleanup).toHaveBeenCalledTimes(1)
    expect(r.cleanup).toHaveBeenCalledWith({ id: 4201 }, 1, 'completed', 'watching')
  })
})
