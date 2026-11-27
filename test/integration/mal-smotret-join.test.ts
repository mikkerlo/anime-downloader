// A smotret failure during MyAnimeList's list read (#744): `tracker:get-rates`
// answers MAL's own entries, with the uncached titles unlinked and the
// `malIdMap` hits keeping their join. Built as `index.ts` builds it: the real
// `createMalIdLookup` handed to `createMalTracker` as `lookupByMalIds`, over a
// smotret stub that rejects. Red on main: the list read rejected with
// smotret's `API error: 404 Not Found` though MAL's own read succeeded.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { createMalIdLookup, type MalIdLookup } from '../../src/main/lib/mal-id-lookup'
import { installFakeMal, malFixture, api, type FakeMal } from '../helpers/fake-mal'
import { malTrackerRig } from '../helpers/mal-tracker'

let fake: FakeMal

beforeEach(() => {
  fake = installFakeMal()
  fake.on('GET', api('/users/@me/animelist'), (call) =>
    call.url.searchParams.get('offset') === '3'
      ? { json: malFixture('animelist-page2.json') }
      : { json: malFixture('animelist-page1.json') }
  )
})

afterEach(() => {
  fake.restore()
})

const smotret = (id: number, malId: number) => ({
  id,
  title: `smotret #${id}`,
  titles: {},
  posterUrlSmall: `https://smotret.test/${id}.jpg`,
  numberOfEpisodes: 12,
  type: 'tv',
  typeTitle: 'TV',
  year: 2020,
  season: '',
  myAnimeListId: malId
})

describe('MyAnimeList’s list read with smotret down', () => {
  it('answers every MAL entry: the cached joins kept, the uncached ones null', async () => {
    const smotretApi = {
      lookupByMalIds: vi.fn(async () => {
        throw new Error('API error: 404 Not Found')
      }),
      getAnime: vi.fn(async () => {
        throw new Error('unused')
      })
    }
    const log = { warn: vi.fn() }
    // Built on the rig's store, as `index.ts` builds it on the app's.
    let lookup: MalIdLookup | null = null
    const r = await malTrackerRig({
      seed: { malIdMap: { '5114': smotret(9001, 5114), '21': smotret(9002, 21) } },
      lookupByMalIds: (ids) => lookup!(ids)
    })
    lookup = createMalIdLookup({ store: r.store, smotretApi, rememberAnimeMeta: () => {}, log })

    const snapshot = await r.invoke<TrackerRatesSnapshot>(CHANNELS.TRACKER_GET_RATES, 'mal')
    const joins = Object.fromEntries(snapshot.entries.map((e) => [e.malId, e.smotretAnime]))
    expect(joins).toEqual({
      5114: smotret(9001, 5114),
      21: smotret(9002, 21),
      1535: null,
      52991: null
    })
    expect(smotretApi.lookupByMalIds).toHaveBeenCalledExactlyOnceWith([1535, 52991])
    expect(log.warn).toHaveBeenCalledTimes(1)
    // The rows are cached, and nothing was cached for the failed ids.
    expect((r.store.get('myanimelistUserRates') as unknown[]).length).toBe(4)
    expect(Object.keys(r.store.get('malIdMap') as object).sort()).toEqual(['21', '5114'])
  })
})
