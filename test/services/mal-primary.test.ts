// MyAnimeList as the primary (#702): the fan-out's `applyChange` for a 'user'
// change runs MAL's primary branch (`services/trackers/mal-primary.ts`, set by
// `createMalTracker().registerPrimary`), shaped after Shikimori's: sent live,
// queued on a failure the queue survives, and the cleanup prompt with the MAL
// row's own `smotretAnime`. Red on main: the fan-out throws "MyAnimeList has
// no primary write path".
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CHANNELS } from '../../src/shared/ipc/channels'
import type { QueuedTrackerUpdate } from '../../src/main/lib/shikimori-queue'
import {
  installFakeMal,
  malFixture,
  malFixtureText,
  type FakeMal,
  type MalCall
} from '../helpers/fake-mal'
import { malTrackerRig } from '../helpers/mal-tracker'

let fake: FakeMal

beforeEach(() => {
  fake = installFakeMal()
})

afterEach(() => {
  fake.restore()
})

const SMOTRET = { id: 4242, title: 'Frieren on smotret', myAnimeListId: 52991 }

/** MAL's list row for 52991, cached with its smotret join. */
const cachedRow = (status: 'watching' | 'completed', episodes: number, numEpisodes = 28) => ({
  node: {
    id: 52991,
    title: 'Sousou no Frieren',
    num_episodes: numEpisodes,
    status: 'finished_airing'
  },
  list_status: { status, score: 0, num_episodes_watched: episodes, is_rewatching: false },
  smotretAnime: SMOTRET
})

/** The entry read answers `episodes` watched; `numEpisodes` is the title's total when given. */
function serveEntry(episodes: number, status = 'watching', numEpisodes?: number): void {
  fake.on('GET', '/v2/anime/52991', {
    json: {
      id: 52991,
      ...(numEpisodes === undefined ? {} : { num_episodes: numEpisodes }),
      my_list_status: {
        status,
        score: 0,
        num_episodes_watched: episodes,
        is_rewatching: false,
        num_times_rewatched: 0
      }
    }
  })
  fake.on('PATCH', '/v2/anime/52991/my_list_status', (call: MalCall) => ({
    json: {
      status: call.form!.status ?? status,
      score: Number(call.form!.score ?? 0),
      num_episodes_watched: Number(call.form!.num_watched_episodes ?? episodes),
      is_rewatching: call.form!.is_rewatching === 'true',
      num_times_rewatched: 0
    }
  }))
}

const rig = (opts: Parameters<typeof malTrackerRig>[0] = {}) =>
  malTrackerRig({
    ...opts,
    seed: { myanimelistUserRates: [cachedRow('watching', 3)], ...opts.seed }
  })

const set = (episodes: number, status: 'watching' | 'completed' = 'watching') => ({
  kind: 'set' as const,
  values: { episodes, status, score: 0, rewatches: 0 }
})

describe('MyAnimeList as the primary', () => {
  it('a user change is sent live to MAL with only the changed fields, and patches the MAL cache', async () => {
    serveEntry(3)
    const r = await rig()
    expect(r.lifecycle.primary()).toBe('mal')
    const outcome = await r.fan.applyChange(52991, set(4), { target: 'mal', cause: 'user' })
    expect(outcome).toMatchObject({ kind: 'primary', after: { episodes: 4 } })
    const patch = fake.callsTo('PATCH', '/v2/anime/52991/my_list_status')
    expect(patch).toHaveLength(1)
    expect(patch[0].form).toEqual({ num_watched_episodes: '4' })
    expect(r.queue()).toEqual([])
    const row = (r.store.get('myanimelistUserRates') as ReturnType<typeof cachedRow>[])[0]
    expect(row.list_status.num_episodes_watched).toBe(4)
    expect(r.broadcast.mock.calls.some(([c]) => c === 'tracker:rate-updated')).toBe(true)
  })

  it('tracker:update-rate and tracker:mark-episode-watched reach MAL through the router', async () => {
    serveEntry(3)
    const r = await rig()
    expect(
      await r.invoke(CHANNELS.TRACKER_UPDATE_RATE, 52991, {
        episodes: 5,
        status: 'watching',
        score: 0,
        rewatches: 0
      })
    ).toMatchObject({ episodes: 5 })
    serveEntry(5)
    expect(await r.invoke(CHANNELS.TRACKER_MARK_EPISODE_WATCHED, 52991, 6)).toMatchObject({
      episodes: 6,
      status: 'watching'
    })
    expect(fake.callsTo('PATCH', '/v2/anime/52991/my_list_status').map((c) => c.form)).toEqual([
      { num_watched_episodes: '5' },
      { num_watched_episodes: '6' }
    ])
  })

  it.each([
    [
      'a network failure',
      () =>
        fake.on('PATCH', /my_list_status$/, () => {
          throw new TypeError('fetch failed')
        })
    ],
    ['a 503', () => fake.on('PATCH', /my_list_status$/, { status: 503, text: '' })],
    [
      'a DoS 403',
      () =>
        fake.on('PATCH', /my_list_status$/, {
          status: 403,
          text: malFixtureText('error-dos-detected.html')
        })
    ]
  ])('%s queues the change against the cached row', async (_name, fail) => {
    serveEntry(3)
    fail()
    const r = await rig()
    const outcome = await r.fan.applyChange(52991, set(4), { target: 'mal', cause: 'user' })
    expect(outcome).toMatchObject({ kind: 'primary', after: { episodes: 4 } })
    expect(r.queue()).toEqual([
      expect.objectContaining({
        malId: 52991,
        rateId: 52991,
        before: { episodes: 3, status: 'watching', score: 0, rewatches: 0 },
        after: { episodes: 4, status: 'watching', score: 0, rewatches: 0 }
      }) as QueuedTrackerUpdate
    ])
    const row = (r.store.get('myanimelistUserRates') as ReturnType<typeof cachedRow>[])[0]
    expect(row.list_status.num_episodes_watched).toBe(4)
  })

  it('an item-class failure (a 404) throws and queues nothing', async () => {
    serveEntry(3)
    fake.on('PATCH', /my_list_status$/, {
      status: 404,
      text: malFixtureText('error-not-found.json')
    })
    const r = await rig()
    await expect(
      r.fan.applyChange(52991, set(4), { target: 'mal', cause: 'user' })
    ).rejects.toThrow(/404/)
    expect(r.queue()).toEqual([])
  })

  it('offline mark-watched queues from the cache', async () => {
    fake.on('GET', '/v2/anime/52991', () => {
      throw new TypeError('fetch failed')
    })
    const r = await rig()
    const outcome = await r.fan.applyChange(
      52991,
      { kind: 'mark-watched', episode: 4 },
      { target: 'mal', cause: 'user' }
    )
    expect(outcome).toMatchObject({ kind: 'primary', after: { episodes: 4, status: 'watching' } })
    expect(r.queue()).toHaveLength(1)
  })

  // T4c's moved row: the primary's own entry, never the null fallback.
  it('a change that completes the title runs the cleanup prompt with the MAL row’s smotretAnime', async () => {
    serveEntry(27)
    const r = await rig({ seed: { myanimelistUserRates: [cachedRow('watching', 27)] } })
    await r.fan.applyChange(52991, set(28, 'completed'), { target: 'mal', cause: 'user' })
    expect(r.cleanupPrompt).toHaveBeenCalledTimes(1)
    expect(r.cleanupPrompt).toHaveBeenCalledWith(SMOTRET, 52991, 'completed', 'watching')
  })

  it('a queued completion prompts with the MAL row too', async () => {
    serveEntry(27)
    fake.on('PATCH', /my_list_status$/, { status: 503, text: '' })
    const r = await rig({ seed: { myanimelistUserRates: [cachedRow('watching', 27)] } })
    await r.fan.applyChange(52991, set(28, 'completed'), { target: 'mal', cause: 'user' })
    expect(r.cleanupPrompt).toHaveBeenCalledWith(SMOTRET, 52991, 'completed', 'watching')
  })

  // The mutation: without `registerPrimary` (its `setPrimaryWriter('mal', …)`) this is main's throw.
  it('without the primary writer the fan-out refuses: what main does', async () => {
    serveEntry(3)
    const r = await rig({ registerPrimary: false })
    await expect(
      r.fan.applyChange(52991, set(4), { target: 'mal', cause: 'user' })
    ).rejects.toThrow('MyAnimeList has no primary write path')
  })
})

// #744 (1): MAL stores at most the title's total, so a mark past it is clamped
// before `nextWatchedRate`, before `send` and before `queue`. Red on main: main
// sends, queues and resolves the 13 MAL never stores.
describe('a mark past the episode total', () => {
  const PATCH_PATH = '/v2/anime/52991/my_list_status'
  const mark = (r: Awaited<ReturnType<typeof rig>>, episode: number) =>
    r.invoke(CHANNELS.TRACKER_MARK_EPISODE_WATCHED, 52991, episode)
  const cached = (r: Awaited<ReturnType<typeof rig>>) =>
    (r.store.get('myanimelistUserRates') as ReturnType<typeof cachedRow>[])[0]
  const offlineEntry = () =>
    fake.on('GET', '/v2/anime/52991', () => {
      throw new TypeError('fetch failed')
    })

  it('watching 12/12 of 12, mark 13: null, no PATCH, nothing queued on MAL or a mirror', async () => {
    serveEntry(12, 'watching', 12)
    const r = await rig({
      mirror: true,
      seed: { myanimelistUserRates: [cachedRow('watching', 12, 12)] }
    })
    expect(r.lifecycle.primary()).toBe('mal')
    expect(await mark(r, 13)).toBeNull()
    expect(fake.callsTo('PATCH', PATCH_PATH)).toHaveLength(0)
    expect(r.queue()).toEqual([])
    expect(r.mirrorQueue()).toEqual([])
  })

  it('watching 10 of 12, mark 13: one PATCH at 12, and it resolves 12; the mirror keeps the user’s 13', async () => {
    serveEntry(10, 'watching', 12)
    const r = await rig({
      mirror: true,
      seed: { myanimelistUserRates: [cachedRow('watching', 10, 12)] }
    })
    expect(await mark(r, 13)).toEqual({ episodes: 12, status: 'watching', score: 0, rewatches: 0 })
    expect(fake.callsTo('PATCH', PATCH_PATH).map((c) => c.form)).toEqual([
      { num_watched_episodes: '12' }
    ])
    expect(cached(r).list_status.num_episodes_watched).toBe(12)
    // MAL-local by design: the mirror's value is `nextWatchedRate(before, 13)`, not MAL's total.
    expect(r.mirrorQueue().map((q) => q.after.episodes)).toEqual([13])
  })

  it('completed 12/12 of 12, mark 13: null, no PATCH, no rewatch', async () => {
    serveEntry(12, 'completed', 12)
    const r = await rig({ seed: { myanimelistUserRates: [cachedRow('completed', 12, 12)] } })
    expect(await mark(r, 13)).toBeNull()
    expect(fake.callsTo('PATCH', PATCH_PATH)).toHaveLength(0)
    expect(r.queue()).toEqual([])
    expect(cached(r).list_status).toEqual(cachedRow('completed', 12, 12).list_status)
  })

  it('a title off the list (total 28), mark 30: the create PATCH is at 28, watching', async () => {
    serveEntry(0)
    // Later routes win: the entry read is the fixture's `{ num_episodes: 28, my_list_status: null }`.
    fake.on('GET', '/v2/anime/52991', { json: malFixture('anime-entry-not-listed.json') })
    // The refresh a title new to the list runs.
    fake.on('GET', '/v2/users/@me/animelist', { json: { data: [] } })
    const r = await rig({ seed: { myanimelistUserRates: [] } })
    expect(await mark(r, 30)).toMatchObject({ episodes: 28, status: 'watching' })
    const patch = fake.callsTo('PATCH', PATCH_PATH)
    expect(patch).toHaveLength(1)
    expect(patch[0].form).toMatchObject({
      num_watched_episodes: '28',
      status: 'watching',
      is_rewatching: 'false'
    })
  })

  it('a queueable PATCH failure queues the clamped 12', async () => {
    serveEntry(10, 'watching', 12)
    fake.on('PATCH', /my_list_status$/, { status: 503, text: '' })
    const r = await rig({ seed: { myanimelistUserRates: [cachedRow('watching', 10, 12)] } })
    expect(await mark(r, 13)).toMatchObject({ episodes: 12 })
    expect(r.queue().map((q) => q.after.episodes)).toEqual([12])
  })

  it('offline, cached watching 10 of 12, mark 13: one queued entry at 12', async () => {
    offlineEntry()
    const r = await rig({ seed: { myanimelistUserRates: [cachedRow('watching', 10, 12)] } })
    expect(await mark(r, 13)).toMatchObject({ episodes: 12, status: 'watching' })
    expect(r.queue()).toHaveLength(1)
    expect(r.queue()[0].after.episodes).toBe(12)
  })

  it('offline, cached watching 12/12 of 12, mark 13: null, nothing queued', async () => {
    offlineEntry()
    const r = await rig({ seed: { myanimelistUserRates: [cachedRow('watching', 12, 12)] } })
    expect(await mark(r, 13)).toBeNull()
    expect(r.queue()).toEqual([])
  })

  // Guards: green on main, each red under the mutation named.
  it('guard: num_episodes 0 (MAL’s unknown) never clamps: PATCH 13, resolves 13', async () => {
    serveEntry(12, 'watching', 0)
    const r = await rig({ seed: { myanimelistUserRates: [cachedRow('watching', 12, 0)] } })
    expect(await mark(r, 13)).toMatchObject({ episodes: 13 })
    expect(fake.callsTo('PATCH', PATCH_PATH).map((c) => c.form)).toEqual([
      { num_watched_episodes: '13' }
    ])
  })

  it('guard: offline, a cached num_episodes 0 never clamps: 13 is queued', async () => {
    offlineEntry()
    const r = await rig({ seed: { myanimelistUserRates: [cachedRow('watching', 12, 0)] } })
    expect(await mark(r, 13)).toMatchObject({ episodes: 13 })
    expect(r.queue().map((q) => q.after.episodes)).toEqual([13])
  })

  it('guard: offline with no cached row has no total: 13 is queued unclamped', async () => {
    offlineEntry()
    const r = await rig({ seed: { myanimelistUserRates: [] } })
    expect(await mark(r, 13)).toMatchObject({ episodes: 13 })
    expect(r.queue().map((q) => q.after.episodes)).toEqual([13])
  })

  it('guard: completed 12/12 of 12, mark 12 (at the total) starts the rewatch at 12 as before', async () => {
    serveEntry(12, 'completed', 12)
    const r = await rig({ seed: { myanimelistUserRates: [cachedRow('completed', 12, 12)] } })
    expect(await mark(r, 12)).toMatchObject({ episodes: 12, status: 'rewatching' })
    const patch = fake.callsTo('PATCH', PATCH_PATH)
    expect(patch).toHaveLength(1)
    expect(patch[0].form).toMatchObject({ status: 'watching', is_rewatching: 'true' })
  })
})
