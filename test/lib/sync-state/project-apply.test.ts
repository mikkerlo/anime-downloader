// projectSyncDoc / applySyncDoc (#572 §4): scope, paths, the AnimeSearchResult
// source, rate clocks, and the round trip.
import { describe, it, expect, vi } from 'vitest'
import { InMemoryStorage } from '../../helpers/in-memory-storage'
import { projectSyncDoc, type ProjectDeps } from '../../../src/main/lib/sync-state/project'
import {
  applySyncDoc,
  rewritePrioritySlots,
  type ApplyDeps
} from '../../../src/main/lib/sync-state/apply'

const NOW = Date.UTC(2026, 9, 27, 12)
const A = '101'
const B = '303'
const X = '424242'

function anime(id: string): AnimeSearchResult {
  return {
    id: Number(id),
    title: `Title ${id}`,
    titles: {},
    posterUrlSmall: 'p.jpg',
    numberOfEpisodes: 12,
    type: 'tv',
    typeTitle: 'TV',
    year: 2020,
    season: 'spring'
  }
}

const ALGORITHM = {
  source: 'local',
  sampleRate: 11025,
  matchBitThreshold: 10,
  minRunSec: 20,
  windowSec: 360,
  refineBitThreshold: 8,
  refineSustainHashes: 4
} as ShowSkipDetections['algorithm']

const projectDeps: ProjectDeps = { resolveEpisodeFile: () => null }

function applyDeps(over: Partial<ApplyDeps> = {}): ApplyDeps {
  return {
    now: () => NOW,
    localEpisodeFile: () => null,
    skipAlgorithm: ALGORITHM,
    ...over
  }
}

/** A store whose `set` calls are counted. */
function counted(initial: Record<string, unknown>): { store: InMemoryStorage; writes: string[] } {
  const store = new InMemoryStorage(initial)
  const writes: string[] = []
  const set = store.set.bind(store)
  store.set = (key: string, value: unknown) => {
    writes.push(key)
    set(key, value)
  }
  return { store, writes }
}

describe('priorityOrder stays in scope', () => {
  function store(): InMemoryStorage {
    return new InMemoryStorage({
      installId: 'pc-a',
      library: { [A]: anime(A), [X]: anime(X), [B]: anime(B) },
      priorityAnimeIds: [A, X, B],
      watchProgress: { [`${X}:1`]: { position: 1, duration: 2, updatedAt: 3 } },
      dismissedContinueWatching: [`${X}:1`],
      syncMeta: {
        titles: { [X]: { starred: { at: 5, origin: 'pc-a' } } },
        priorityOrder: { at: 10, origin: 'pc-a' },
        rates: {}
      }
    })
  }

  it('the projected bytes never contain an out-of-scope id', () => {
    const doc = projectSyncDoc(store(), [A, B], projectDeps)
    expect(doc.priorityOrder.value).toEqual([A, B])
    expect(JSON.stringify(doc)).not.toContain(X)
  })

  it('applying a newer library order [B, A] gives [B, X, A]: X keeps index 1', () => {
    const s = store()
    const doc = projectSyncDoc(s, [A, B], projectDeps)
    doc.priorityOrder = { value: [B, A], at: 20, origin: 'pc-b' }

    const report = applySyncDoc(s, doc, [A, B], applyDeps())

    expect(s.get('priorityAnimeIds')).toEqual([B, X, A])
    expect(report.applied).toContain('priorityOrder')
    expect((s.get('syncMeta') as SyncMeta).priorityOrder).toEqual({ at: 20, origin: 'pc-b' })
  })

  it('a doc naming an out-of-scope id adds, removes and reorders nothing of it', () => {
    const s = store()
    const doc = projectSyncDoc(s, [A, B], projectDeps)
    doc.titles[X] = { starred: { value: true, at: 99, origin: 'pc-b' } }
    doc.tombstones[X] = { priority: { deleted: true, at: 99, origin: 'pc-b' } }
    doc.priorityOrder = { value: [X, B, A], at: 20, origin: 'pc-b' }

    applySyncDoc(s, doc, [A, B], applyDeps())

    expect(s.get('priorityAnimeIds')).toEqual([B, X, A])
    expect(s.get('library')).toHaveProperty(X)
  })

  it('slot rewrite: new members go at the end, leftover slots are dropped', () => {
    const scope = new Set(['1', '2', '3'])
    expect(rewritePrioritySlots(['1', 'x', '2'], scope, ['2', '1', '3'])).toEqual([
      '2',
      'x',
      '1',
      '3'
    ])
    expect(rewritePrioritySlots(['1', 'x', '2'], scope, ['2'])).toEqual(['2', 'x'])
  })
})

describe('skip: no local path reaches the doc', () => {
  const DIR = '/tmp/anime-dl-download-root-7f3a9'
  const detections = (): ShowSkipDetections => ({
    animeId: Number(A),
    analyzedAt: 1000,
    episodeCount: 12,
    algorithm: ALGORITHM,
    perEpisode: {
      '1': {
        episodeInt: '1',
        episodeLabel: 'Episode 1',
        filePath: `${DIR}/Show/Show - 01.mkv`,
        durationSec: 1420,
        hashesPerSec: 8,
        op: { startSec: 60, endSec: 150, pairCount: 3 },
        ed: null
      },
      '2': {
        episodeInt: '2',
        episodeLabel: 'Episode 2',
        filePath: `${DIR}/Show/Show - 02.mkv`,
        durationSec: 1420,
        hashesPerSec: 8,
        op: { startSec: 61, endSec: 151, pairCount: 3 },
        ed: null
      }
    }
  })
  const identities: Record<string, { translationId: number; fileSize: number }> = {
    [`${DIR}/Show/Show - 01.mkv`]: { translationId: 7, fileSize: 1000 },
    [`${DIR}/Show/Show - 02.mkv`]: { translationId: 7, fileSize: 2000 }
  }

  it('strips filePath and carries the file identity instead', () => {
    const s = new InMemoryStorage({ installId: 'pc-a', skipDetections: { [A]: detections() } })
    const doc = projectSyncDoc(s, [A], {
      resolveEpisodeFile: (_id, _ep, filePath) => identities[filePath] ?? null
    })
    const bytes = JSON.stringify(doc)
    expect(bytes).not.toContain(DIR)
    expect(bytes).not.toContain('filePath')
    expect(doc.titles[A].skip!.perEpisode['1'].file).toEqual({ translationId: 7, fileSize: 1000 })
    expect(doc.titles[A].skip!.perEpisode['2'].file).toEqual({ translationId: 7, fileSize: 2000 })
  })

  it('an unresolvable file leaves its entry out', () => {
    const s = new InMemoryStorage({ installId: 'pc-a', skipDetections: { [A]: detections() } })
    const doc = projectSyncDoc(s, [A], {
      resolveEpisodeFile: (_id, ep) => (ep === '1' ? { translationId: 7, fileSize: 1000 } : null)
    })
    expect(Object.keys(doc.titles[A].skip!.perEpisode)).toEqual(['1'])
  })

  function driveDoc(): SyncDoc {
    const source = new InMemoryStorage({ installId: 'pc-b', skipDetections: { [A]: detections() } })
    return projectSyncDoc(source, [A], {
      resolveEpisodeFile: (_id, _ep, filePath) => identities[filePath] ?? null
    })
  }

  it("a drive entry whose fileSize differs from this PC's file leaves the local detection as it was", () => {
    const local = detections()
    delete local.perEpisode['2']
    const { store, writes } = counted({
      installId: 'pc-a',
      skipDetections: { [A]: structuredClone(local) }
    })

    applySyncDoc(
      store,
      driveDoc(),
      [A],
      applyDeps({
        localEpisodeFile: () => ({
          filePath: '/elsewhere/02.mkv',
          translationId: 7,
          fileSize: 2001
        })
      })
    )

    expect(store.get('skipDetections')).toEqual({ [A]: local })
    expect(writes).not.toContain('skipDetections')
  })

  it('a matching drive entry is taken, with filePath from the local resolver', () => {
    const local = detections()
    delete local.perEpisode['2']
    const s = new InMemoryStorage({ installId: 'pc-a', skipDetections: { [A]: local } })

    const report = applySyncDoc(
      s,
      driveDoc(),
      [A],
      applyDeps({
        localEpisodeFile: (_id, ep) =>
          ep === '2' ? { filePath: '/mnt/here/02.mkv', translationId: 7, fileSize: 2000 } : null
      })
    )

    const ep2 = (s.get('skipDetections') as Record<string, ShowSkipDetections>)[A].perEpisode['2']
    expect(ep2.filePath).toBe('/mnt/here/02.mkv')
    expect(ep2.op).toEqual({ startSec: 61, endSec: 151, pairCount: 3 })
    expect(report.applied).toContain(`titles.${A}.skip.2`)
  })
})

describe('starred = true: the AnimeSearchResult source', () => {
  function starDoc(): SyncDoc {
    return {
      stateVersion: 1,
      stateMinor: 0,
      installId: 'pc-b',
      titles: { [A]: { starred: { value: true, at: 50, origin: 'pc-b' } } },
      priorityOrder: { value: [], at: 0, origin: 'legacy' },
      tombstones: {}
    }
  }

  it('uses local library first', () => {
    const own = { ...anime(A), title: 'Mine' }
    const shared = vi.fn(() => anime(A))
    const s = new InMemoryStorage({
      installId: 'pc-a',
      library: { [A]: own },
      downloadedAnime: { [A]: anime(A) }
    })
    applySyncDoc(s, starDoc(), [A], applyDeps({ sharedSearchResult: shared }))
    expect((s.get('library') as Record<string, AnimeSearchResult>)[A]).toEqual(own)
    expect(shared).not.toHaveBeenCalled()
  })

  it('then downloadedAnime', () => {
    const dl = { ...anime(A), title: 'Downloaded' }
    const shared = vi.fn(() => anime(A))
    const s = new InMemoryStorage({ installId: 'pc-a', downloadedAnime: { [A]: dl } })
    applySyncDoc(s, starDoc(), [A], applyDeps({ sharedSearchResult: shared }))
    expect((s.get('library') as Record<string, AnimeSearchResult>)[A]).toEqual(dl)
    expect(shared).not.toHaveBeenCalled()
  })

  it("then the Shared Library's meta searchResult", () => {
    const fromMeta = { ...anime(A), title: 'From meta' }
    const s = new InMemoryStorage({ installId: 'pc-a' })
    const report = applySyncDoc(
      s,
      starDoc(),
      [A],
      applyDeps({ sharedSearchResult: () => fromMeta })
    )
    expect((s.get('library') as Record<string, AnimeSearchResult>)[A]).toEqual(fromMeta)
    expect((s.get('syncMeta') as SyncMeta).titles[A].starred).toEqual({ at: 50, origin: 'pc-b' })
    expect(report.applied).toContain(`titles.${A}.starred`)
  })

  it('with none of them, it reports unapplied and writes nothing', () => {
    const { store, writes } = counted({ installId: 'pc-a' })
    const doc = starDoc()
    doc.titles[A].priority = { value: true, at: 50, origin: 'pc-b' }
    const report = applySyncDoc(store, doc, [A], applyDeps({ sharedSearchResult: () => null }))
    expect(report.unapplied).toEqual([
      { path: `titles.${A}.starred`, reason: 'no AnimeSearchResult for this title' },
      { path: `titles.${A}.priority`, reason: 'not starred on this PC' }
    ])
    expect(writes).toEqual([])
  })
})

// A queued edit that is discarded (logout Discard, or a parked bucket's) leaves
// its `syncMeta.rates` clock behind, recording a value Shikimori never
// received. The rule: a rate clock counts only while it records the value the
// projection sees (cache ⊕ the owner's queue ⊕ S9's pending overlay). A
// leftover clock is inert, and rules 4–7 never decide on `at` anyway.
describe('rate clocks: only a clock that records the projected value counts', () => {
  const SERVER_AT = '2026-05-01T00:00:00.000Z'
  function rateStore(over: Record<string, unknown> = {}): InMemoryStorage {
    return new InMemoryStorage({
      installId: 'pc-a',
      shikimoriUser: { id: 7, nickname: 'me' },
      shikimoriUserRates: [
        {
          rate: {
            id: 1,
            target_id: 42,
            episodes: 3,
            status: 'watching',
            score: 7,
            rewatches: 0,
            updated_at: SERVER_AT,
            serverUpdatedAt: SERVER_AT
          },
          shikiAnime: { id: 42 },
          smotretAnime: anime(A)
        }
      ],
      shikimoriUpdateQueue: [],
      ...over
    })
  }
  const stamp = (value: number | string, at: number): SyncRateFieldClock => ({
    value,
    at,
    origin: 'pc-a'
  })

  it("a confirmed edit's clock is used: the stamp records the cached value", () => {
    const s = rateStore({
      syncMeta: { titles: {}, rates: { '7:42': { episodes: stamp(3, 900) } } }
    })
    const rate = projectSyncDoc(s, [A], projectDeps).titles[A].rate!
    expect(rate.malId).toBe(42)
    expect(rate.episodes).toEqual({ value: 3, at: 900, origin: 'pc-a' })
    expect(rate.score).toEqual({ value: 7, at: Date.parse(SERVER_AT), origin: 'shikimori' })
  })

  it("a discarded edit's leftover clock is inert: the field keeps the Shikimori clock", () => {
    // Episode 5 was queued, stamped, then discarded; the cache is back at 3.
    const s = rateStore({
      syncMeta: { titles: {}, rates: { '7:42': { episodes: stamp(5, 900) } } }
    })
    const rate = projectSyncDoc(s, [A], projectDeps).titles[A].rate!
    expect(rate.episodes).toEqual({ value: 3, at: Date.parse(SERVER_AT), origin: 'shikimori' })
  })

  it('a still-queued edit projects its queued value with its clock, even with no cache entry', () => {
    const s = rateStore({
      shikimoriUserRates: [],
      malIdMap: { '42': anime(A) },
      shikimoriUpdateQueue: [
        {
          malId: 42,
          rateId: null,
          before: { episodes: 0, status: 'planned', score: 0, rewatches: 0 },
          after: { episodes: 1, status: 'watching', score: 0, rewatches: 0 },
          queuedAt: 1
        }
      ],
      syncMeta: {
        titles: {},
        rates: { '7:42': { episodes: stamp(1, 900), status: stamp('watching', 900) } }
      }
    })
    const rate = projectSyncDoc(s, [A], projectDeps).titles[A].rate!
    expect(rate.episodes).toEqual({ value: 1, at: 900, origin: 'pc-a' })
    expect(rate.status).toEqual({ value: 'watching', at: 900, origin: 'pc-a' })
  })

  it("S9's pending overlay wins over the cache and the queue", () => {
    const s = rateStore()
    const rate = projectSyncDoc(s, [A], {
      ...projectDeps,
      pendingRates: () => ({ episodes: { value: 8, at: 1234, origin: 'pc-b' } })
    }).titles[A].rate!
    expect(rate.episodes).toEqual({ value: 8, at: 1234, origin: 'pc-b' })
  })

  it('with no account there is no local rate', () => {
    expect(
      projectSyncDoc(rateStore({ shikimoriUser: null }), [A], projectDeps).titles[A].rate
    ).toBeUndefined()
  })

  it('apply hands a rate change to the rate writer, and reports it unapplied without one', () => {
    const s = rateStore()
    const doc = projectSyncDoc(s, [A], projectDeps)
    doc.titles[A].rate!.episodes = { value: 6, at: 2000, origin: 'pc-b' }
    const applyRate = vi.fn(() => true as const)

    expect(applySyncDoc(s, doc, [A], applyDeps({ applyRate })).applied).toContain(
      `titles.${A}.rate`
    )
    expect(applyRate).toHaveBeenCalledWith(A, doc.titles[A].rate)
    expect(applySyncDoc(s, doc, [A], applyDeps()).unapplied).toEqual([
      { path: `titles.${A}.rate`, reason: 'no rate writer (S9 #584)' }
    ])
  })
})

describe('apply: clamps and no-ops', () => {
  function baseStore(): InMemoryStorage {
    return new InMemoryStorage({
      installId: 'pc-a',
      library: { [A]: anime(A) },
      watchProgress: {
        [`${A}:1`]: {
          position: 600,
          duration: 1420,
          updatedAt: 5,
          watched: false,
          translationId: 7,
          sync: { position: { at: 5, origin: 'pc-a' }, watched: { at: 5, origin: 'pc-a' } }
        }
      },
      syncMeta: {
        titles: { [A]: { starred: { at: 4, origin: 'pc-a' } } },
        priorityOrder: { at: 1, origin: 'pc-a' },
        rates: {}
      }
    })
  }

  it('applying the projection of the same store writes nothing', () => {
    const s = baseStore()
    const doc = projectSyncDoc(s, [A], projectDeps)
    const { store, writes } = counted(
      structuredClone(
        Object.fromEntries(
          ['installId', 'library', 'watchProgress', 'syncMeta'].map((k) => [k, s.get(k)])
        )
      )
    )
    const report = applySyncDoc(store, doc, [A], applyDeps())
    expect(writes).toEqual([])
    expect(report).toEqual({ applied: [], unapplied: [], clamped: [] })
  })

  it('an `at` more than 120 s in the future is clamped to now, and reported', () => {
    const s = baseStore()
    const doc = projectSyncDoc(s, [A], projectDeps)
    doc.titles[A].watch!['1'].position = {
      value: { position: 900, duration: 1420 },
      at: NOW + 121_000,
      origin: 'pc-b'
    }

    const report = applySyncDoc(s, doc, [A], applyDeps())

    expect(report.clamped).toEqual([
      { path: `titles.${A}.watch.1.position`, at: NOW + 121_000, clampedTo: NOW }
    ])
    const row = (s.get('watchProgress') as Record<string, WatchProgressEntry>)[`${A}:1`]
    expect(row.sync?.position).toEqual({ at: NOW, origin: 'pc-b' })
    expect(row.position).toBe(900)
  })
})

describe('apply: legacy rows and clocks are left alone, changed rows keep their own recency', () => {
  const legacyRow = { position: 600, duration: 1420, updatedAt: 5, watched: true, watchedAt: 6 }

  it('a legacy row applied back unchanged is not rewritten, and keeps updatedAt', () => {
    const { store, writes } = counted({
      installId: 'pc-a',
      watchProgress: { [`${A}:1`]: legacyRow }
    })
    const doc = projectSyncDoc(store, [A], projectDeps)

    const report = applySyncDoc(store, doc, [A], applyDeps({ now: () => 999999 }))

    expect(writes).toEqual([])
    expect(report.applied).toEqual([])
    expect(
      (store.get('watchProgress') as Record<string, WatchProgressEntry>)[`${A}:1`].updatedAt
    ).toBe(5)
  })

  it('a row with no `watched` key, or with a missing clock, is not rewritten either', () => {
    const { store, writes } = counted({
      installId: 'pc-a',
      watchProgress: {
        [`${A}:1`]: { position: 300, duration: 1420, updatedAt: 7 },
        [`${A}:2`]: { position: 0, duration: 1420, updatedAt: 8, watched: false, sync: {} }
      }
    })
    applySyncDoc(
      store,
      projectSyncDoc(store, [A], projectDeps),
      [A],
      applyDeps({ now: () => 999999 })
    )
    expect(writes).toEqual([])
  })

  it('legacy star and priority clocks are not stamped into syncMeta', () => {
    const { store, writes } = counted({
      installId: 'pc-a',
      library: { [A]: anime(A) },
      priorityAnimeIds: [A]
    })
    applySyncDoc(store, projectSyncDoc(store, [A], projectDeps), [A], applyDeps())
    expect(writes).toEqual([])
  })

  it('30 episodes brought in by a sync each take updatedAt from their own clock, not now', () => {
    const rows: Record<string, WatchProgressEntry> = {}
    for (let ep = 1; ep <= 30; ep++) {
      const at = 1_000_000 + ep * 3_600_000
      rows[`${A}:${ep}`] = {
        position: 0,
        duration: 1420,
        updatedAt: at,
        watched: true,
        watchedAt: at,
        sync: { position: { at, origin: 'pc-b' }, watched: { at, origin: 'pc-b' } }
      }
    }
    const doc = projectSyncDoc(
      new InMemoryStorage({ installId: 'pc-b', watchProgress: rows }),
      [A],
      projectDeps
    )
    const target = new InMemoryStorage({ installId: 'pc-a' })

    applySyncDoc(target, doc, [A], applyDeps({ now: () => NOW }))

    const applied = target.get('watchProgress') as Record<string, WatchProgressEntry>
    expect(Object.keys(applied)).toHaveLength(30)
    for (const [key, row] of Object.entries(rows))
      expect(applied[key].updatedAt).toBe(row.updatedAt)
  })

  // `set-watched` advances only `sync.watched`; done locally it moves
  // `updatedAt` to its clock, so the same change arriving by sync does too.
  it('a remote un-watch that keeps its position moves updatedAt to watched.at', () => {
    const s = new InMemoryStorage({
      installId: 'pc-a',
      watchProgress: {
        [`${A}:1`]: {
          position: 600,
          duration: 1420,
          updatedAt: 5000,
          watched: true,
          watchedAt: 4000,
          sync: { position: { at: 3000, origin: 'pc-a' }, watched: { at: 4000, origin: 'pc-a' } }
        }
      }
    })
    const doc = projectSyncDoc(s, [A], projectDeps)
    const entry = doc.titles[A].watch!['1']
    entry.watched = { value: false, at: 9000, origin: 'pc-b' }
    entry.watchedAt = null

    applySyncDoc(s, doc, [A], applyDeps({ now: () => NOW }))

    const row = (s.get('watchProgress') as Record<string, WatchProgressEntry>)[`${A}:1`]
    expect(row).toMatchObject({ position: 600, watched: false, updatedAt: 9000 })
  })

  it('a changed row never moves its updatedAt backwards', () => {
    const s = new InMemoryStorage({
      installId: 'pc-a',
      watchProgress: {
        [`${A}:1`]: { ...legacyRow, watched: false, watchedAt: undefined, updatedAt: 5000 }
      }
    })
    const doc = projectSyncDoc(s, [A], projectDeps)
    doc.titles[A].watch!['1'].position = {
      value: { position: 900, duration: 1420 },
      at: 4000,
      origin: 'pc-b'
    }

    applySyncDoc(s, doc, [A], applyDeps({ now: () => NOW }))

    expect((s.get('watchProgress') as Record<string, WatchProgressEntry>)[`${A}:1`].updatedAt).toBe(
      5000
    )
  })
})

describe('round trip: project → apply on an empty store → project', () => {
  function richStore(): InMemoryStorage {
    return new InMemoryStorage({
      installId: 'pc-a',
      library: { [A]: anime(A), [B]: anime(B) },
      priorityAnimeIds: [B, A],
      watchProgress: {
        [`${A}:1`]: {
          position: 0,
          duration: 1420,
          updatedAt: 100,
          watched: true,
          watchedAt: 90,
          translationId: 7
        },
        [`${A}:2`]: {
          position: 700,
          duration: 1420,
          updatedAt: 200,
          watched: false,
          sync: { position: { at: 200, origin: 'pc-a' } }
        },
        [`${A}:12.5`]: {
          position: 30,
          duration: 300,
          updatedAt: 300,
          watched: false,
          translationId: 8,
          sync: { position: { at: 300, origin: 'pc-c' }, watched: { at: 0, origin: 'pc-c' } }
        }
      },
      dismissedContinueWatching: [`${A}:2`, `${B}:5`],
      syncMeta: {
        titles: {
          [A]: { starred: { at: 10, origin: 'pc-a' }, priority: { at: 11, origin: 'pc-a' } },
          [B]: { starred: { at: 12, origin: 'pc-b' } },
          '505': { starred: { deleted: true, at: NOW - 1000, origin: 'pc-a' } }
        },
        priorityOrder: { at: 13, origin: 'pc-a' },
        rates: {}
      },
      skipDetections: {
        [A]: {
          animeId: Number(A),
          analyzedAt: 77,
          episodeCount: 12,
          algorithm: ALGORITHM,
          perEpisode: {
            '1': {
              episodeInt: '1',
              episodeLabel: 'Episode 1',
              filePath: '/src/01.mkv',
              durationSec: 1420,
              hashesPerSec: 8,
              op: null,
              ed: { startSec: 1300, endSec: 1390, pairCount: 2 }
            }
          }
        }
      }
    })
  }

  it('is deep-equal, including unknown fields and tombstones', () => {
    const scope = [A, B, '505']
    const doc = projectSyncDoc(richStore(), scope, {
      resolveEpisodeFile: () => ({ translationId: 7, fileSize: 1000 })
    })
    // A newer writer's fields, at the doc and the title level.
    doc.futureTop = { kept: true }
    doc.titles[A].futureField = [1, { deep: 'x' }]

    const target = new InMemoryStorage({ installId: 'pc-z' })
    const report = applySyncDoc(
      target,
      doc,
      scope,
      applyDeps({
        sharedSearchResult: (id) => anime(id),
        localEpisodeFile: () => ({ filePath: '/dst/01.mkv', translationId: 7, fileSize: 1000 })
      })
    )
    expect(report.unapplied).toEqual([])
    const again = projectSyncDoc(target, scope, {
      resolveEpisodeFile: () => ({ translationId: 7, fileSize: 1000 })
    })

    expect(doc.tombstones['505'].starred).toEqual({ deleted: true, at: NOW - 1000, origin: 'pc-a' })
    expect({ ...again, installId: 'x' }).toEqual({ ...doc, installId: 'x' })
  })
})
