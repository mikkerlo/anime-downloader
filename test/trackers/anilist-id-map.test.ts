// The MAL → AniList id map (#703 § 4) through the real client and a fixture
// server: chunking, out-of-order matching, negative entries, the duplicate
// `idMal` rule, seeding from list reads and adult titles.
import { describe, it, expect, afterEach } from 'vitest'
import {
  anilistFixture,
  createAniListServer,
  createTestAniList,
  type AniListServer
} from '../helpers/anilist-server'
import { createAniListClient, deadTokenError } from '../../src/main/trackers/anilist/client'
import { createAniListLimiter } from '../../src/main/trackers/anilist/limiter'
import {
  createAniListIdMap,
  NEGATIVE_ENTRY_TTL_MS,
  type IdMapRecord
} from '../../src/main/trackers/anilist/id-map'
import { InMemoryStorage } from '../helpers/in-memory-storage'

let server: AniListServer | null = null
afterEach(() => {
  server?.restore()
  server = null
})

/** AniList id for MAL id n: 10000 + n. Replies list the media in reverse, omitting `omit`. */
function mappedServer(omit: ReadonlySet<number> = new Set()): AniListServer {
  server = createAniListServer((call) => {
    const ids = (call.variables.ids as number[]).filter((id) => !omit.has(id))
    return {
      body: {
        data: { Page: { media: ids.map((id) => ({ id: 10_000 + id, idMal: id })).reverse() } }
      }
    }
  })
  return server
}

function mapRig(opts: { now?: () => number; onList?: number[] } = {}) {
  const store = new InMemoryStorage({ anilistIdMap: {} })
  const client = createAniListClient({ limiter: createAniListLimiter({ deadTokenError }) })
  const idMap = createAniListIdMap({
    store: store as never,
    client,
    now: opts.now,
    listMediaIds: () => new Set(opts.onList ?? [])
  })
  return { store, idMap }
}

describe('the lookup', () => {
  it('120 ids → 3 requests (50, 50, 20), results out of order, every id mapped right', async () => {
    const s = mappedServer()
    const { idMap } = mapRig()
    const ids = Array.from({ length: 120 }, (_, i) => i + 1)
    const map = await idMap.resolve(ids, { priority: 'interactive' })
    expect(s.calls.map((c) => (c.variables.ids as number[]).length)).toEqual([50, 50, 20])
    for (const id of ids) expect(map.get(id)).toBe(10_000 + id)
    expect(s.calls.every((c) => c.query.includes('idMal_in: $ids') && c.token === null)).toBe(true)
  })

  it('answers known ids from the map: a second resolve sends nothing', async () => {
    const s = mappedServer()
    const { idMap } = mapRig()
    await idMap.resolve([1, 2], { priority: 'interactive' })
    await idMap.resolve([2, 1], { priority: 'interactive' })
    expect(s.calls).toHaveLength(1)
  })
})

describe('negative entries', () => {
  it('an omitted id becomes a negative entry, which expires after the TTL and is asked again', async () => {
    const clock = { t: 1_000 }
    const s = mappedServer(new Set([7]))
    const { idMap, store } = mapRig({ now: () => clock.t })
    expect((await idMap.resolve([7, 8], { priority: 'interactive' })).get(7)).toBeNull()
    expect((store.get('anilistIdMap') as IdMapRecord)['7']).toEqual({ anilistId: null, at: 1_000 })
    expect(idMap.known(7)).toBeNull()
    clock.t += NEGATIVE_ENTRY_TTL_MS - 1
    await idMap.resolve([7], { priority: 'interactive' })
    expect(s.calls).toHaveLength(1)
    clock.t += 1
    expect(idMap.known(7)).toBeUndefined()
    await idMap.resolve([7], { priority: 'interactive' })
    expect(s.calls).toHaveLength(2)
    expect(s.calls[1].variables).toEqual({ ids: [7] })
  })

  it('a lookup that fails with network records no negative entry', async () => {
    server = createAniListServer(() => ({ throws: new TypeError('fetch failed') }))
    const { idMap, store } = mapRig()
    await expect(idMap.resolve([7], { priority: 'interactive' })).rejects.toThrow('fetch failed')
    expect(store.get('anilistIdMap')).toEqual({})
    expect(idMap.known(7)).toBeUndefined()
  })

  it('a lookup that fails with a 5xx records none either', async () => {
    server = createAniListServer(() => ({ status: 502, body: {} }))
    const { idMap, store } = mapRig()
    await expect(idMap.resolve([7], { priority: 'interactive' })).rejects.toMatchObject({
      status: 502
    })
    expect(store.get('anilistIdMap')).toEqual({})
  })
})

describe('duplicate idMal', () => {
  it('two media for one MAL id: the one on the user’s list, otherwise the lowest id', async () => {
    server = createAniListServer(() => ({ body: anilistFixture('page-media-duplicate-idmal') }))
    const { idMap } = mapRig({ onList: [512] })
    const map = await idMap.resolve([50, 70], { priority: 'interactive' })
    expect(map.get(50)).toBe(512)
    expect(map.get(70)).toBe(720)
  })

  it('two list entries sharing an idMal normalize to one, the lowest media id, and the refresh log counts the other', async () => {
    const chunk = anilistFixture('media-list-collection-2')
    server = createAniListServer(() => ({ body: chunk }))
    const logs: string[] = []
    const { provider } = await createTestAniList({
      provider: { log: { log: (m: string) => logs.push(m), warn: () => {} } }
    })
    const entries = await provider.listEntries({ token: 't', userId: 5001 })
    expect(entries.filter((e) => e.malId === 6).map((e) => e.native.media.id)).toEqual([206])
    expect(logs).toEqual([
      '[anilist] list refresh: 3 entries; left out 1 with no MAL id and 1 sharing a MAL id'
    ])
  })
})

describe('seeding and adult titles', () => {
  it('list reads seed the map, so a listed title needs no lookup', async () => {
    const chunk = anilistFixture('media-list-collection-2')
    const s = (server = createAniListServer(() => ({ body: chunk })))
    const { provider } = await createTestAniList()
    await provider.listEntries({ token: 't', userId: 5001 })
    expect(provider.idMap.known(4)).toBe(104)
    expect(provider.idMap.known(6)).toBe(206)
    await provider.idMap.resolve([4, 6], { priority: 'interactive' })
    expect(s.calls.map((c) => c.operation)).toEqual(['MediaListCollection'])
  })

  it('an adult title maps, and no request carries an isAdult argument', async () => {
    server = createAniListServer(() => ({ body: anilistFixture('page-media-idmal') }))
    const { idMap } = mapRig()
    expect((await idMap.resolve([8], { priority: 'prefetch' })).get(8)).toBe(901)
    expect(server.calls.some((c) => /isAdult/.test(c.query) || 'isAdult' in c.variables)).toBe(
      false
    )
  })
})
