// The chronology's shared step and its two walks (#710): `buildChronology`
// over Shikimori's franchise (characterized against `main`), AniList's
// level-batched walk and MyAnimeList's one-at-a-time walk. The routing by
// source is `test/ipc/tracker-related.ipc.test.ts`'s.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { anilistFixture, createAniListServer, createTestAniList } from '../helpers/anilist-server'
import {
  capturedChronology,
  franchiseFixture,
  PLAIN_SMOTRET,
  RICH_FRANCHISE,
  RICH_SMOTRET,
  RICH_STORE
} from '../helpers/chronology-fixtures'
import {
  adapterKindOf,
  buildChronology,
  CANONICAL_RELATIONS,
  unixSeconds,
  type ChronologyDeps,
  type ChronologyGraph
} from '../../src/main/trackers/chronology'
import {
  franchiseGraph,
  shikimoriKindOf,
  shikimoriStatusByMalId
} from '../../src/main/services/shikimori-sync/chronology'
import {
  ANILIST_RELATION_MAP,
  ANILIST_WALK_CAP,
  anilistKind,
  createAniListRelated
} from '../../src/main/trackers/anilist/related'
import type { AniListRelatedMedia } from '../../src/main/trackers/anilist/provider'
import {
  createMalRelated,
  MAL_RELATED_TTL_MS,
  MAL_WALK_CAP,
  malKind,
  malStartDate
} from '../../src/main/trackers/mal/related'
import type { MalRelatedRead } from '../../src/main/trackers/mal/provider'
import type { ShikiFranchise } from '../../src/main/shikimori'

const utc = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 1000

const smotretOf =
  (table: Record<number, unknown>) =>
  async (ids: number[]): Promise<Record<number, never>> =>
    Object.fromEntries(ids.filter((id) => table[id]).map((id) => [id, table[id]])) as never

const shikimoriDeps = (
  store: InMemoryStorage,
  smotret: Record<number, unknown>
): ChronologyDeps => ({
  lookupByMalIds: smotretOf(smotret),
  kindOf: shikimoriKindOf(store),
  statusByMalId: shikimoriStatusByMalId(store)
})

const adapterDeps = (opts: Partial<ChronologyDeps> = {}): ChronologyDeps => ({
  lookupByMalIds: async () => ({}),
  kindOf: adapterKindOf,
  statusByMalId: new Map(),
  ...opts
})

describe('buildChronology — the Shikimori characterization (captured on main)', () => {
  it('franchise.json: exactly what shikimori:get-related returned on main', async () => {
    const store = new InMemoryStorage({ shikimoriAnimeDetails: {}, shikimoriUserRates: [] })
    const out = await buildChronology(
      franchiseGraph(franchiseFixture() as unknown as ShikiFranchise),
      shikimoriDeps(store, PLAIN_SMOTRET)
    )
    expect(out).toEqual(capturedChronology().plain)
  })

  it('the rich franchise: kinds, caches, exclusions, the unreachable node and the null date', async () => {
    const store = new InMemoryStorage(structuredClone(RICH_STORE))
    const out = await buildChronology(
      franchiseGraph(structuredClone(RICH_FRANCHISE) as unknown as ShikiFranchise),
      shikimoriDeps(store, RICH_SMOTRET)
    )
    expect(out).toEqual(capturedChronology().rich)
    // Shikimori's dates pass through unchanged: unix seconds, null last.
    expect(out.map((e) => e.shikiAnime.date)).toEqual(
      capturedChronology().rich.map((e) => e.shikiAnime.date)
    )
    expect(out.at(-1)!.shikiAnime.date).toBeNull()
  })

  it('the Shikimori branch still prefers its caches over the node’s kind', async () => {
    const store = new InMemoryStorage(structuredClone(RICH_STORE))
    const out = await buildChronology(
      franchiseGraph(structuredClone(RICH_FRANCHISE) as unknown as ShikiFranchise),
      shikimoriDeps(store, RICH_SMOTRET)
    )
    const kind = (id: number) => out.find((e) => e.shikiAnime.id === id)?.shikiAnime.kind
    expect(kind(9999)).toBe('movie') // details cache over the node's 'tv'
    expect(kind(2222)).toBe('special') // rate cache over the node's 'OVA'
  })
})

// ---- AniList ---------------------------------------------------------------

const WALK = (): AniListRelatedMedia[] =>
  anilistFixture<{ data: { Page: { media: AniListRelatedMedia[] } } }>('related-walk').data.Page
    .media

/** The walk's deps over `related-walk.json`, raw (MANGA edges kept), counting requests. */
function walkDeps(
  opts: {
    media?: AniListRelatedMedia[]
    map?: Record<number, number | null>
    list?: number[]
    cap?: number
  } = {}
) {
  const media = new Map((opts.media ?? WALK()).map((m) => [m.id, m]))
  const map = opts.map ?? { 601: 3001, 604: 3004 }
  const batches: number[][] = []
  const store = new InMemoryStorage({
    anilistUserRates: (opts.list ?? []).map((mediaId) => ({
      entry: { id: 1, mediaId, status: 'CURRENT', media: { id: mediaId, idMal: null } },
      smotretAnime: null
    }))
  })
  const resolveRef = vi.fn(async (malId: number) => {
    const id = map[malId]
    return typeof id === 'number' ? { mediaId: id } : null
  })
  const getRelatedBatch = vi.fn(async (ids: readonly number[], _opts?: unknown) => {
    batches.push([...ids])
    const out = new Map<number, AniListRelatedMedia>()
    for (const id of ids) {
      const m = media.get(id)
      if (m) out.set(id, structuredClone(m))
    }
    return out
  })
  const related = createAniListRelated({ store, resolveRef, getRelatedBatch, cap: opts.cap })
  return { related, batches, resolveRef, getRelatedBatch }
}

async function anilistChronology(
  opts: Parameters<typeof walkDeps>[0] & { malId?: number; deps?: Partial<ChronologyDeps> } = {}
) {
  const rig = walkDeps(opts)
  const graph = (await rig.related.walk(opts.malId ?? 601)) as ChronologyGraph
  const out = await buildChronology(
    graph,
    adapterDeps({ isOnList: rig.related.isOnList, ...opts.deps })
  )
  return { ...rig, graph, out, ids: out.map((e) => e.shikiAnime.id) }
}

describe('AniList: the MediaRelation table', () => {
  it('every value in the introspection fixture has a row (exhaustiveness)', () => {
    const values = anilistFixture<{
      data: { __type: { enumValues: { name: string }[] } }
    }>('media-relation-enum').data.__type.enumValues.map((v) => v.name)
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) expect(ANILIST_RELATION_MAP).toHaveProperty(value)
    expect(Object.keys(ANILIST_RELATION_MAP).sort()).toEqual([...values].sort())
  })

  it('maps onto the canonical set, with CHARACTER / OTHER / ADAPTATION / SOURCE not walked', () => {
    const walked = Object.entries(ANILIST_RELATION_MAP)
      .filter(([, c]) => CANONICAL_RELATIONS.has(c))
      .map(([v]) => v)
      .sort()
    expect(walked).toEqual(
      [
        'ALTERNATIVE',
        'COMPILATION',
        'CONTAINS',
        'PARENT',
        'PREQUEL',
        'SEQUEL',
        'SIDE_STORY',
        'SPIN_OFF',
        'SUMMARY'
      ].sort()
    )
  })

  it('COMPILATION → summary and CONTAINS → full_story, read from the fixture’s edge pair', async () => {
    // 3001 → 3004: COMPILATION (3004 is the recap); 3004 → 3001: CONTAINS.
    const fromSeason = await anilistChronology()
    expect(fromSeason.out.find((e) => e.shikiAnime.id === 604)?.relation).toBe('summary')
    const fromRecap = await anilistChronology({ malId: 604 })
    expect(fromRecap.out.find((e) => e.shikiAnime.id === 601)?.relation).toBe('full_story')
  })

  it('format → kind: lowercased, TV_SHORT is tv, none is null', () => {
    expect(anilistKind('TV')).toBe('tv')
    expect(anilistKind('TV_SHORT')).toBe('tv')
    expect(anilistKind('MUSIC')).toBe('music')
    expect(anilistKind('MOVIE')).toBe('movie')
    expect(anilistKind(null)).toBeNull()
  })
})

describe('AniList: the walk', () => {
  it('the whole franchise in date order, with AniList titles, kinds and unix-second dates', async () => {
    const { out } = await anilistChronology()
    expect(
      out.map((e) => [
        e.shikiAnime.id,
        e.shikiAnime.name,
        e.shikiAnime.kind,
        e.shikiAnime.date,
        e.shikiAnime.year
      ])
    ).toEqual([
      [601, 'Season One', 'tv', utc(2015, 4, 5), 2015],
      [604, 'The Recap Movie', 'movie', utc(2016, 1, 9), 2016],
      [603, 'Kisetsu 2', 'tv', utc(2017, 10, 1), 2017],
      [610, 'Spin-off', 'ona', utc(2020, 7, 1), 2020],
      [611, 'Betsu', null, utc(2021, 1, 1), 2021],
      [607, 'Omake A', 'ova', null, null]
    ])
    expect(out[0].shikiAnime.url).toBe('https://anilist.co/anime/3001')
    expect(out[0].shikiAnime.image_url).toBe('https://s4.anilist.co/cover/3001.jpg')
  })

  it('MANGA edges are dropped, even a canonical one (the SPIN_OFF manga)', async () => {
    const { graph, ids } = await anilistChronology()
    expect(graph.nodes.map((n) => n.key)).not.toContain(9002)
    expect(graph.edges.map((e) => e.to)).not.toContain(9002)
    expect(graph.edges.map((e) => e.to)).not.toContain(9001)
    expect(ids).not.toContain(99002)
  })

  it('CHARACTER / OTHER edges are not walked (the Isekai Quartet case)', async () => {
    const { batches, ids } = await anilistChronology()
    expect(batches.flat()).not.toContain(3005)
    expect(batches.flat()).not.toContain(3009)
    expect(ids).not.toContain(605)
    expect(ids).not.toContain(609)
  })

  it('MUSIC is excluded from the output, though walked', async () => {
    const { graph, ids } = await anilistChronology()
    expect(graph.nodes.find((n) => n.key === 3006)?.kind).toBe('music')
    expect(ids).not.toContain(606)
  })

  it('the bridge node: a no-idMal special between two seasons is walked through, not returned', async () => {
    const { graph, ids } = await anilistChronology()
    expect(graph.nodes.find((n) => n.key === 3002)?.malId).toBeNull()
    expect(ids).toContain(601)
    expect(ids).toContain(603)
    expect(ids).toContain(610)
    expect(ids.every((id) => typeof id === 'number')).toBe(true)
    expect(ids).toHaveLength(6)
  })

  it('one getRelatedBatch request per level, at interactive, after resolveRef', async () => {
    const { batches, resolveRef, getRelatedBatch } = await anilistChronology()
    expect(resolveRef).toHaveBeenCalledTimes(1)
    expect(resolveRef).toHaveBeenCalledWith(601, { priority: 'interactive' })
    expect(batches).toEqual([[3001], [3002, 3004, 3006], [3003], [3007, 3008, 3010], [3011]])
    for (const call of getRelatedBatch.mock.calls)
      expect(call[1]).toEqual({ priority: 'interactive' })
  })

  it('stops at the cap: at most 40 nodes, and no request past it', async () => {
    // A chain of 60 sequels.
    const chain: AniListRelatedMedia[] = Array.from({ length: 60 }, (_, i) => ({
      id: 4000 + i,
      idMal: 700 + i,
      format: 'TV',
      startDate: { year: 2000 + i, month: 1, day: 1 },
      title: { romaji: `S${i + 1}`, english: null },
      relations: {
        edges:
          i < 59
            ? [
                {
                  relationType: 'SEQUEL',
                  node: {
                    id: 4001 + i,
                    idMal: 701 + i,
                    type: 'ANIME',
                    format: 'TV',
                    startDate: { year: 2001 + i, month: 1, day: 1 },
                    title: { romaji: `S${i + 2}`, english: null }
                  }
                }
              ]
            : []
      }
    })) as unknown as AniListRelatedMedia[]
    const { graph, batches, out } = await anilistChronology({
      media: chain,
      map: { 700: 4000 },
      malId: 700
    })
    expect(ANILIST_WALK_CAP).toBe(40)
    expect(graph.nodes).toHaveLength(ANILIST_WALK_CAP)
    expect(out).toHaveLength(ANILIST_WALK_CAP)
    expect(batches.flat()).not.toContain(4000 + ANILIST_WALK_CAP)
    expect(batches).toHaveLength(ANILIST_WALK_CAP - 1)
  })

  it('an unmapped title is null, with no relations request', async () => {
    const rig = walkDeps({ map: {} })
    expect(await rig.related.walk(601)).toBeNull()
    expect(rig.getRelatedBatch).not.toHaveBeenCalled()
  })

  it('a failed level throws: no partial graph', async () => {
    const rig = walkDeps()
    rig.getRelatedBatch.mockImplementationOnce(async (ids) => {
      rig.batches.push([...ids])
      return new Map([[3001, structuredClone(WALK()[0])]])
    })
    rig.getRelatedBatch.mockRejectedValueOnce(new Error('network'))
    await expect(rig.related.walk(601)).rejects.toThrow('network')
  })
})

describe('AniList: level 0 through the real id map (#703)', () => {
  let server: ReturnType<typeof createAniListServer> | null = null
  afterEach(() => {
    server?.restore()
    server = null
  })

  it('a duplicate idMal picks the media on the list; the walk sends one request per level', async () => {
    // MAL id 50 is AniList 512 and 501; 512 is on the list.
    const rows = [
      {
        id: 512,
        idMal: 50,
        format: 'TV',
        startDate: { year: 2010, month: 1, day: 1 },
        title: { romaji: 'Listed', english: null },
        relations: {
          edges: [
            {
              relationType: 'SEQUEL',
              node: { id: 513, idMal: 51, type: 'ANIME', format: 'TV', startDate: { year: 2011 } }
            }
          ]
        }
      },
      {
        id: 513,
        idMal: 51,
        format: 'TV',
        startDate: { year: 2011 },
        title: { romaji: 'Next' },
        relations: { edges: [] }
      }
    ]
    server = createAniListServer((call) => {
      if (call.operation === 'IdMap') return { body: anilistFixture('page-media-duplicate-idmal') }
      const ids = call.variables.ids as number[]
      return { body: { data: { Page: { media: rows.filter((r) => ids.includes(r.id)) } } } }
    })
    const { provider, store } = await createTestAniList({
      seed: {
        anilistUserRates: [
          {
            entry: { id: 9, mediaId: 512, status: 'CURRENT', media: { id: 512, idMal: 50 } },
            smotretAnime: null
          }
        ]
      }
    })
    const related = createAniListRelated({
      store: store as never,
      resolveRef: (m, o) => provider.resolveRef(m, o),
      getRelatedBatch: (ids, o) => provider.getRelatedBatch(ids, o)
    })
    const graph = (await related.walk(50))!
    expect(graph.current).toBe(512)
    expect(server.of('IdMap')).toHaveLength(1)
    expect(server.of('RelatedBatch').map((c) => c.variables.ids)).toEqual([[512], [513]])
    expect(server.calls.every((c) => c.token === null)).toBe(true)
  })
})

describe('buildChronology: the generic rules', () => {
  const node = (key: number, malId: number | null, date: number | null = key) => ({
    key,
    malId,
    title: `#${key}`,
    imageUrl: '',
    url: '',
    kind: 'tv',
    date,
    year: null
  })

  it('duplicate idMal inside the walk: one entry, else isOnList, else the lower AniList id', async () => {
    const plain = await anilistChronology()
    expect(plain.ids.filter((id) => id === 607)).toHaveLength(1)
    expect(plain.out.find((e) => e.shikiAnime.id === 607)?.shikiAnime.name).toBe('Omake A') // 3007 < 3008
    const listed = await anilistChronology({ list: [3008] })
    expect(listed.ids.filter((id) => id === 607)).toHaveLength(1)
    expect(listed.out.find((e) => e.shikiAnime.id === 607)?.shikiAnime.name).toBe('Omake B')
  })

  it('duplicate idMal with the current node in the pair keeps the current node', async () => {
    const graph: ChronologyGraph = {
      current: 20,
      nodes: [node(10, 5), node(20, 5), node(30, 6)],
      edges: [
        { from: 20, to: 10, relation: 'alternative_version' },
        { from: 20, to: 30, relation: 'sequel' }
      ]
    }
    const out = await buildChronology(graph, adapterDeps({ isOnList: (k) => k === 10 }))
    expect(out.map((e) => [e.shikiAnime.id, e.shikiAnime.name, e.isCurrent])).toEqual([
      [5, '#20', true],
      [6, '#30', false]
    ])
  })

  it('compares keys, never MAL ids: isCurrent, labels and shikiAnime.id', async () => {
    // Keys collide with other nodes' MAL ids on purpose.
    const graph: ChronologyGraph = {
      current: 1,
      nodes: [node(1, 2), node(2, 3), node(3, 1)],
      edges: [
        { from: 1, to: 2, relation: 'sequel' },
        { from: 1, to: 3, relation: 'prequel' }
      ]
    }
    const out = await buildChronology(graph, adapterDeps())
    expect(out.map((e) => [e.shikiAnime.id, e.isCurrent, e.relation])).toEqual([
      [2, true, null],
      [3, false, 'sequel'],
      [1, false, 'prequel']
    ])
  })

  it('kind precedence for an adapter: its own kind, then smotret’s type, then null', async () => {
    expect(adapterKindOf(node(1, 1), 'Movie')).toBe('tv')
    expect(adapterKindOf({ ...node(1, 1), kind: null }, 'Movie')).toBe('movie')
    expect(adapterKindOf({ ...node(1, 1), kind: null }, undefined)).toBeNull()
  })

  it('watchStatus comes from the injected map', async () => {
    const { out } = await anilistChronology({
      deps: { statusByMalId: new Map([[603, 'rewatching']]) }
    })
    expect(out.find((e) => e.shikiAnime.id === 603)?.watchStatus).toBe('rewatching')
    expect(out.find((e) => e.shikiAnime.id === 601)?.watchStatus).toBeNull()
  })

  it('date: partial dates take the 1st of the period (UTC); no year is null and sorts last', async () => {
    expect(unixSeconds(2017, 10, null)).toBe(utc(2017, 10, 1))
    expect(unixSeconds(2016, null, null)).toBe(utc(2016, 1, 1))
    expect(unixSeconds(null, 5, 5)).toBeNull()
    expect(malStartDate('2009')).toEqual({ date: utc(2009, 1, 1), year: 2009 })
    expect(malStartDate('2003-10')).toEqual({ date: utc(2003, 10, 1), year: 2003 })
    expect(malStartDate('2009-04-05')).toEqual({ date: utc(2009, 4, 5), year: 2009 })
    expect(malStartDate(undefined)).toEqual({ date: null, year: null })
    const out = await buildChronology(
      {
        current: 1,
        nodes: [node(2, 2, null), node(1, 1, 50)],
        edges: [{ from: 1, to: 2, relation: 'sequel' }]
      },
      adapterDeps()
    )
    expect(out.map((e) => e.shikiAnime.id)).toEqual([1, 2])
  })
})

// ---- MyAnimeList -----------------------------------------------------------

const MAL_WALK = (): Record<string, MalRelatedRead> =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'mal', 'related-walk.json'), 'utf8')
  )

function malRig(
  opts: { reads?: Record<string, MalRelatedRead>; cap?: number; fail?: number } = {}
) {
  const reads = opts.reads ?? MAL_WALK()
  let inFlight = 0
  let maxInFlight = 0
  const fetched: number[] = []
  let clock = 1_000_000
  const getRelated = vi.fn(async (ref: { malId: number }) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 0))
    inFlight--
    fetched.push(ref.malId)
    if (opts.fail !== undefined && fetched.length === opts.fail) throw new Error('MAL 503')
    const read = reads[String(ref.malId)]
    if (!read) return { id: ref.malId, title: `#${ref.malId}`, related_anime: [] }
    return structuredClone(read)
  })
  const related = createMalRelated({ getRelated, cap: opts.cap, now: () => clock })
  return {
    related,
    getRelated,
    fetched,
    maxInFlight: () => maxInFlight,
    advance: (ms: number) => (clock += ms)
  }
}

const malDeps = (smotret: Record<number, unknown> = {}): ChronologyDeps =>
  adapterDeps({
    lookupByMalIds: smotretOf(smotret),
    yearOf: (n, s) => n.year ?? s?.year ?? null
  })

describe('MyAnimeList: the walk', () => {
  it('relation_type maps one-to-one; character / other are not walked', async () => {
    const rig = malRig()
    const graph = await rig.related.walk(5114)
    expect(graph.edges.filter((e) => e.from === 5114).map((e) => e.relation)).toEqual([
      'alternative_version',
      'side_story',
      'character',
      'other'
    ])
    expect(rig.fetched).toEqual([5114, 121, 9135, 430])
    const out = await buildChronology(graph, malDeps())
    expect(out.map((e) => [e.shikiAnime.id, e.relation, e.isCurrent])).toEqual([
      [121, 'alternative_version', false],
      [430, null, false],
      [5114, null, true],
      [9135, 'side_story', false]
    ])
    expect(out[2].shikiAnime.url).toBe('https://myanimelist.net/anime/5114')
  })

  it('a missing or unknown media_type falls back to the smotret type', async () => {
    const graph = await malRig().related.walk(5114)
    const out = await buildChronology(
      graph,
      malDeps({ 121: { id: 1, type: 'TV' }, 9135: { id: 2, type: 'Movie' } })
    )
    const kind = (id: number) => out.find((e) => e.shikiAnime.id === id)?.shikiAnime.kind
    expect(kind(121)).toBe('tv') // 'unknown'
    expect(kind(9135)).toBe('movie') // missing
    expect(kind(430)).toBe('movie') // its own
  })

  it('a node only discovered (cap reached) gets smotret’s type and year, and sorts last', async () => {
    const rig = malRig({ cap: 2 })
    const graph = await rig.related.walk(5114)
    expect(rig.fetched).toEqual([5114, 121])
    const out = await buildChronology(
      graph,
      malDeps({ 9135: { id: 2, type: 'Movie', year: 2011 } })
    )
    expect(out.map((e) => e.shikiAnime.id)).toEqual([121, 5114, 9135, 430])
    expect(out.find((e) => e.shikiAnime.id === 9135)!.shikiAnime).toMatchObject({
      kind: 'movie',
      year: 2011,
      date: null
    })
  })

  it('the cap stops the walk: exactly 15 fetches, at most one request in flight', async () => {
    // A chain of 30 sequels, and a title with 30 side stories (a queue 30 deep).
    const chain: Record<string, MalRelatedRead> = {}
    for (let i = 0; i < 30; i++) {
      chain[String(100 + i)] = {
        id: 100 + i,
        title: `S${i + 1}`,
        media_type: 'tv',
        start_date: `${2000 + i}`,
        related_anime: [
          { node: { id: 101 + i, title: `S${i + 2}` } as never, relation_type: 'sequel' }
        ]
      }
    }
    const star: Record<string, MalRelatedRead> = {
      '500': {
        id: 500,
        title: 'Root',
        related_anime: Array.from({ length: 30 }, (_, i) => ({
          node: { id: 501 + i, title: `Side ${i + 1}` } as never,
          relation_type: 'side_story'
        }))
      }
    }
    expect(MAL_WALK_CAP).toBe(15)
    for (const [reads, root, nodes] of [
      [chain, 100, MAL_WALK_CAP + 1],
      [star, 500, 31]
    ] as const) {
      const rig = malRig({ reads })
      const graph = await rig.related.walk(root)
      expect(rig.getRelated).toHaveBeenCalledTimes(MAL_WALK_CAP)
      expect(rig.maxInFlight()).toBe(1)
      expect(graph.nodes).toHaveLength(nodes)
    }
  })

  it('a mid-walk failure throws rather than returning a partial graph, and nothing is cached', async () => {
    const rig = malRig({ fail: 2 })
    await expect(rig.related.walk(5114)).rejects.toThrow('MAL 503')
    await rig.related.walk(5114)
    expect(rig.fetched[2]).toBe(5114)
  })

  it('a second call within the hour makes no request; one after the TTL refetches', async () => {
    const rig = malRig()
    const first = await rig.related.walk(5114)
    const calls = rig.getRelated.mock.calls.length
    rig.advance(MAL_RELATED_TTL_MS - 1)
    expect(await rig.related.walk(5114)).toBe(first)
    expect(rig.getRelated.mock.calls.length).toBe(calls)
    rig.advance(1)
    await rig.related.walk(5114)
    expect(rig.getRelated.mock.calls.length).toBe(calls * 2)
  })

  it('media_type → kind', () => {
    expect(malKind('tv')).toBe('tv')
    expect(malKind('unknown')).toBeNull()
    expect(malKind(undefined)).toBeNull()
  })
})
