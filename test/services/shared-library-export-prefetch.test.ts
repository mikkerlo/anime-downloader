// Pre-fetch during export (#577): the plan side and the main-side enqueue.
// Missing episodes become selectable online with an API token; each offers the
// cached translations, the title's own first; its size is estimated from
// downloaded siblings (never from `qualityProbes`, which are heights); and the
// start registers the title in `downloadedAnime` before it enqueues the same
// `DownloadRequest` the detail page would build.

import { afterEach, describe, expect, it } from 'vitest'
import { addDownloadedAnime } from '../../src/main/lib/downloaded-anime'
import { STALE_EPISODE_LIST } from '../../src/main/services/shared-library-export/plan'
import {
  TOKEN_REQUIRED,
  downloadName,
  prefetchGate
} from '../../src/main/services/shared-library-export/prefetch-request'
import { getAnimeName } from '../../src/renderer/src/utils'
import { makePrefetchRig, type CachedEpisode, type PrefetchRig } from '../helpers/prefetch-rig'

let rig: PrefetchRig
afterEach(() => rig?.cleanup())

const ALPHA = 101

async function planOf(r: PrefetchRig, animeId = ALPHA): Promise<ExportPlan> {
  return r.svc.plan({ animeIds: [animeId], target: null, name: '' })
}

function missing(plan: ExportPlan, episodeInt: string): ExportNotDownloaded {
  const e = plan.titles[0].notDownloaded.find((x) => x.episodeInt === episodeInt)
  if (!e) throw new Error(`episode ${episodeInt} isn't in notDownloaded`)
  return e
}

/** Alpha Show with two downloaded Studio episodes of `bytes` each. */
function seedSiblings(
  r: PrefetchRig,
  bytes: [number, number],
  durations: [string, string] | null,
  more: CachedEpisode[]
): void {
  r.env.addEpisode({
    animeId: ALPHA,
    title: 'Alpha Show',
    episodeInt: '1',
    translationId: 11,
    bytes: bytes[0]
  })
  r.env.addEpisode({
    animeId: ALPHA,
    title: 'Alpha Show',
    episodeInt: '2',
    translationId: 12,
    bytes: bytes[1]
  })
  r.seedTitle({
    animeId: ALPHA,
    title: 'Alpha Show',
    episodes: [
      {
        episodeInt: '1',
        translations: [{ id: 11, author: 'Studio', duration: durations?.[0] ?? '0' }]
      },
      {
        episodeInt: '2',
        translations: [{ id: 12, author: 'Studio', duration: durations?.[1] ?? '0' }]
      },
      ...more
    ]
  })
}

describe('the plan: missing episodes (#577)', () => {
  it('offers the cached translations, the title’s downloaded one first, with the probed height', async () => {
    rig = makePrefetchRig()
    seedSiblings(
      rig,
      [1000, 1000],
      ['100', '100'],
      [
        {
          episodeInt: '3',
          translations: [
            { id: 93, author: 'Other', type: 'voiceRu', height: 1080 },
            { id: 13, author: 'Studio', height: 720 },
            { id: 83, author: 'Studio', height: 480 },
            { id: 73, author: 'Gone', isActive: 0 }
          ]
        }
      ]
    )
    const cache = rig.env.store.get('animeCache') as Record<
      number,
      { qualityProbes: Record<number, number> }
    >
    cache[ALPHA].qualityProbes = { 13: 1080 }
    const plan = await planOf(rig)
    expect(plan.prefetch).toBe('ok')
    const e = missing(plan, '3')
    expect(e.unavailable).toBeNull()
    expect(e.options.map((o) => [o.translationId, o.author, o.translationType, o.height])).toEqual([
      [13, 'Studio', 'subRu', 1080],
      [93, 'Other', 'voiceRu', 1080]
    ])
  })

  it('a missing episode with no cached translations stays disabled: open the title online', async () => {
    rig = makePrefetchRig()
    seedSiblings(rig, [1000, 1000], null, [])
    const cache = rig.env.store.get('animeCache') as Record<number, { animeDetail: AnimeDetail }>
    cache[ALPHA].animeDetail.episodes.push({
      id: 999,
      episodeFull: '9 серия',
      episodeInt: '9',
      episodeType: 'tv',
      isActive: 1
    })
    const e = missing(await planOf(rig), '9')
    expect(e).toEqual({
      episodeInt: '9',
      label: '9 серия',
      options: [],
      unavailable: STALE_EPISODE_LIST
    })
  })

  it('the gate: no token, offline, or no download queue', async () => {
    expect(prefetchGate({ canEnqueue: true, offline: false, token: 't' })).toBe('ok')
    expect(prefetchGate({ canEnqueue: true, offline: false, token: '' })).toBe('no-token')
    expect(prefetchGate({ canEnqueue: true, offline: false, token: undefined })).toBe('no-token')
    expect(prefetchGate({ canEnqueue: true, offline: true, token: 't' })).toBe('offline')
    expect(prefetchGate({ canEnqueue: false, offline: false, token: 't' })).toBe('unavailable')
  })
})

describe('size estimates (#577)', () => {
  const ep3 = (duration: string): CachedEpisode => ({
    episodeInt: '3',
    translations: [{ id: 13, author: 'Studio', duration }]
  })

  it('two downloaded siblings with durations: their bytes per second × this one’s duration', async () => {
    rig = makePrefetchRig()
    seedSiblings(rig, [1000, 3000], ['100', '300'], [ep3('250')])
    // (1000 + 3000 bytes + their .ass-less 0) / (100 + 300 s) × 250 s
    expect(missing(await planOf(rig), '3').options[0].sizeBytes).toBe(2500)
  })

  it('siblings with no durations: their median size', async () => {
    rig = makePrefetchRig()
    seedSiblings(rig, [1000, 3000], null, [ep3('250')])
    expect(missing(await planOf(rig), '3').options[0].sizeBytes).toBe(2000)
  })

  it('no sibling by the same author: unknown, and a probed height is never used as a size', async () => {
    rig = makePrefetchRig()
    seedSiblings(
      rig,
      [1000, 3000],
      ['100', '300'],
      [
        {
          episodeInt: '3',
          translations: [{ id: 93, author: 'Other', duration: '250', height: 480 }]
        }
      ]
    )
    const cache = rig.env.store.get('animeCache') as Record<
      number,
      { qualityProbes: Record<number, number> }
    >
    cache[ALPHA].qualityProbes = { 93: 1080 }
    const o = missing(await planOf(rig), '3').options[0]
    expect(o.height).toBe(1080)
    expect(o.sizeBytes).toBeNull()
  })

  it('the start counts the estimate against the drive and against this PC', async () => {
    rig = makePrefetchRig()
    seedSiblings(rig, [1000, 3000], ['100', '300'], [ep3('250')])
    const req = {
      selection: [],
      prefetch: [{ animeId: ALPHA, episodeInt: '3', translationId: 13 }],
      target: rig.env.drive,
      name: 'Trip'
    }
    // The estimate is 2500 bytes (+1%): it doesn't fit on a drive with 2000 free.
    rig.driveFree.bytes = 2000
    expect(await rig.svc.start(req)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^Not enough free space: the export needs 2525 bytes/)
    })
    // Nor where it downloads.
    rig.driveFree.bytes = null
    rig.localFree.bytes = 2000
    expect(await rig.svc.start(req)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /^Not enough free space on this PC: the downloads need 2525 bytes/
      )
    })
    expect((await planOf(rig)).localFree).toBe(2000)
    expect(rig.enqueued).toEqual([])
    rig.localFree.bytes = 2525
    expect((await rig.svc.start(req)).ok).toBe(true)
  })
})

describe('the start: main-side enqueue copies the detail page (#577)', () => {
  /** Beta Show: only in the cache, never downloaded. */
  function seedBeta(
    r: PrefetchRig,
    titles: AnimeSearchResult['titles'],
    title = 'Beta Title'
  ): void {
    r.seedTitle({
      animeId: 202,
      title,
      episodes: [{ episodeInt: '1', translations: [{ id: 21, author: 'Studio' }] }]
    })
    const cache = r.env.store.get('animeCache') as Record<number, { animeDetail: AnimeDetail }>
    cache[202].animeDetail.titles = titles
  }
  const req = (r: PrefetchRig): ExportStartRequest => ({
    selection: [],
    prefetch: [{ animeId: 202, episodeInt: '1', translationId: 21 }],
    target: r.env.drive,
    name: 'Trip'
  })

  it('writes downloadedAnime[animeId] before the first enqueue', async () => {
    rig = makePrefetchRig()
    seedBeta(rig, { romaji: 'Beta Romaji' })
    rig.order.length = 0
    const r = await rig.svc.start(req(rig))
    expect(r.ok).toBe(true)
    expect(rig.order.slice(0, 2)).toEqual(['downloadedAnime', 'enqueue'])
    const anime = (rig.env.store.get('downloadedAnime') as Record<string, AnimeSearchResult>)[202]
    expect(anime).toMatchObject({ id: 202, title: 'Beta Title', titles: { romaji: 'Beta Romaji' } })
    expect(Object.keys(anime).sort()).toEqual(
      [
        'id',
        'numberOfEpisodes',
        'posterUrlSmall',
        'season',
        'title',
        'titles',
        'type',
        'typeTitle',
        'year'
      ].sort()
    )
  })

  it.each([
    ['romaji', { romaji: 'Beta Romaji', ru: 'Бета' }],
    ['only ru', { ru: 'Бета' }],
    ['neither', {}]
  ] as const)('the folder name is getAnimeName’s, for a title with %s', async (_what, titles) => {
    rig = makePrefetchRig()
    seedBeta(rig, { ...titles })
    const r = await rig.svc.start(req(rig))
    expect(r.ok).toBe(true)
    const expected = getAnimeName({ title: 'Beta Title', titles })
    expect(rig.enqueued[0][0].animeName).toBe(expected)
    expect(downloadName({ title: 'Beta Title', titles })).toBe(expected)
  })

  it('with an empty token: the plan says no-token, and the start refuses and enqueues nothing', async () => {
    rig = makePrefetchRig()
    seedBeta(rig, { romaji: 'Beta Romaji' })
    rig.env.store.set('token', '')
    expect((await planOf(rig, 202)).prefetch).toBe('no-token')
    expect(await rig.svc.start(req(rig))).toEqual({ ok: false, reason: TOKEN_REQUIRED })
    expect(rig.enqueued).toEqual([])
    expect(rig.env.store.get('downloadedAnime')).toEqual({})
  })

  it('offline: the plan says offline, and the start refuses and enqueues nothing', async () => {
    rig = makePrefetchRig()
    seedBeta(rig, { romaji: 'Beta Romaji' })
    rig.offline.on = true
    expect((await planOf(rig, 202)).prefetch).toBe('offline')
    const r = await rig.svc.start(req(rig))
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^Needs internet to download/)
    })
    expect(rig.enqueued).toEqual([])
  })

  it('a translation no longer in the cached list is refused', async () => {
    rig = makePrefetchRig()
    seedBeta(rig, { romaji: 'Beta Romaji' })
    const r = await rig.svc.start({
      ...req(rig),
      prefetch: [{ animeId: 202, episodeInt: '1', translationId: 99 }]
    })
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(STALE_EPISODE_LIST) })
    expect(rig.enqueued).toEqual([])
  })
})

describe('addDownloadedAnime (#577)', () => {
  it('adds the record under its id, keeping the others', () => {
    const held: Record<string, unknown> = { downloadedAnime: { 1: { id: 1 } } }
    const store = {
      get: (k: 'downloadedAnime') => held[k],
      set: (k: 'downloadedAnime', v: unknown) => {
        held[k] = v
      }
    }
    addDownloadedAnime(store, { id: 2, title: 'B' } as AnimeSearchResult)
    expect(held.downloadedAnime).toEqual({ 1: { id: 1 }, 2: { id: 2, title: 'B' } })
  })
})
