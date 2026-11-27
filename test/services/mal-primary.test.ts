// MyAnimeList as the primary (#702): the fan-out's `applyChange` for a 'user'
// change runs MAL's primary branch (`services/trackers/mal-primary.ts`, set by
// `createMalTracker().registerPrimary`), shaped after Shikimori's: sent live,
// queued on a failure the queue survives, and the cleanup prompt with the MAL
// row's own `smotretAnime`. Red on main: the fan-out throws "MyAnimeList has
// no primary write path".
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CHANNELS } from '../../src/shared/ipc/channels'
import type { QueuedTrackerUpdate } from '../../src/main/lib/shikimori-queue'
import { installFakeMal, malFixtureText, type FakeMal, type MalCall } from '../helpers/fake-mal'
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
const cachedRow = (status: 'watching' | 'completed', episodes: number) => ({
  node: { id: 52991, title: 'Sousou no Frieren', num_episodes: 28, status: 'finished_airing' },
  list_status: { status, score: 0, num_episodes_watched: episodes, is_rewatching: false },
  smotretAnime: SMOTRET
})

function serveEntry(episodes: number, status = 'watching'): void {
  fake.on('GET', '/v2/anime/52991', {
    json: {
      id: 52991,
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

  // #701: the primary picker offers MAL only once its writer is registered.
  it('the accounts state lists MAL in primaryCapable after registerPrimary, and not without it', async () => {
    expect((await rig()).listAccounts().primaryCapable).toEqual(['mal'])
    expect((await rig({ registerPrimary: false })).listAccounts().primaryCapable).toEqual([])
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
