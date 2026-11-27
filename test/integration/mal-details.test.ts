// MyAnimeList in T11a's details read (#706, #702): `tracker:get-details`
// answers from `myanimelistAnimeDetails` normalized (`cachedDetails`), a miss
// kicks the on-demand fetch for a title on the user's list (one at a time per
// title), and each write is broadcast on `tracker:details-updated`. Built as
// `index.ts` builds it (`createMalTracker`), over `fake-mal.ts`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { installFakeMal, malFixture, type FakeMal } from '../helpers/fake-mal'
import { malTrackerRig } from '../helpers/mal-tracker'

let fake: FakeMal

beforeEach(() => {
  fake = installFakeMal()
})

afterEach(() => {
  fake.restore()
})

const ON_LIST = {
  node: { id: 5114, title: 'Fullmetal Alchemist: Brotherhood' },
  list_status: { status: 'watching', score: 0, num_episodes_watched: 1, is_rewatching: false },
  smotretAnime: null
}

const NORMALIZED: TrackerDetails = {
  description: "Two brothers search for the Philosopher's Stone.",
  genres: ['Action', 'Adventure'],
  status: 'released',
  episodes: 64,
  episodesAired: 64,
  kind: 'tv'
}

const rig = () => malTrackerRig({ seed: { myanimelistUserRates: [ON_LIST] } })

const detailsEmits = (r: Awaited<ReturnType<typeof rig>>) =>
  r.broadcast.mock.calls.filter(([c]) => c === EVENT_CHANNELS.TRACKER_DETAILS_UPDATED)

describe('MyAnimeList details through tracker:get-details', () => {
  it('a miss for a list title fetches it once, and the write is broadcast normalized', async () => {
    fake.on('GET', '/v2/anime/5114', { json: malFixture('details.json') })
    const r = await rig()
    expect(await r.invoke(CHANNELS.TRACKER_GET_DETAILS, 5114, 'mal')).toBeNull()
    // A second miss while the first fetch is in flight joins it.
    expect(await r.invoke(CHANNELS.TRACKER_GET_DETAILS, 5114, 'mal')).toBeNull()
    await expect.poll(() => detailsEmits(r).length).toBe(1)
    expect(detailsEmits(r)[0][1]).toEqual({ trackerId: 'mal', malId: 5114, details: NORMALIZED })
    expect(fake.callsTo('GET', '/v2/anime/5114')).toHaveLength(1)
    // The next read answers from the cache, normalized, with no request.
    expect(await r.invoke(CHANNELS.TRACKER_GET_DETAILS, 5114, 'mal')).toEqual(NORMALIZED)
    expect(fake.callsTo('GET', '/v2/anime/5114')).toHaveLength(1)
  })

  it('a miss for a title off the list fetches nothing', async () => {
    fake.on('GET', '/v2/anime/21', { json: malFixture('details.json') })
    const r = await rig()
    expect(await r.invoke(CHANNELS.TRACKER_GET_DETAILS, 21, 'mal')).toBeNull()
    await new Promise((res) => setTimeout(res, 20))
    expect(fake.calls).toHaveLength(0)
    expect(detailsEmits(r)).toHaveLength(0)
  })
})
