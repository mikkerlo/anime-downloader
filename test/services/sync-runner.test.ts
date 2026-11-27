// The merge runner (#584): both legs over real Shared Library trees, the real
// drain against a fake Shikimori, the pending lifecycle, the raise, conflicts,
// Forget, write failures and the `runAll` result.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi
}))

import { cleanup } from '../helpers/shared-library'
import { F, doc, rate, watch } from '../helpers/sync-merge'
import {
  ANILIST_5,
  ANILIST_USER,
  MAL_5,
  MAL_USER,
  ANIME,
  MAL,
  OWNER,
  T0,
  cacheEntry,
  driveDoc,
  driveGeneration,
  makeLibrary,
  writeDrive,
  makePc,
  progressRow,
  refreshCache,
  server,
  trackerActor,
  vals,
  type Pc
} from '../helpers/sync-runner'
import { ANILIST_MEDIA_IDS, UNMAPPED_MAL_ID } from '../helpers/fake-tracker'
import { ANILIST_KEYS } from '../../src/main/trackers/keys'
import { conflictsFileOf } from '../../src/main/services/sync-runner/conflicts'
import { overlay, pendingFileOf } from '../../src/main/services/sync-runner/pending'
import type { SyncLogRecord } from '../../src/main/services/sync-runner/log'
import { EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { expectQueueTwin, expectRateTwin, onlyTwin } from '../helpers/tracker-events'

const ID = String(ANIME)
const titleDoc = (title: SyncTitleState, extra: Partial<SyncDoc> = {}) =>
  doc({ [ID]: title }, extra)
type RateV = NonNullable<Parameters<typeof rate>[0]>
const r = (v: RateV, at = T0, origin = 'pc-other') => rate(v, at, origin, MAL)

async function seedBase(pc: Pc, libraryId: string, root: string, base: SyncDoc): Promise<void> {
  await pc.bases.write(`library-${libraryId}`, {
    stateGeneration: await driveGeneration(root),
    doc: base
  })
}

async function pending(pc: Pc, ownerId = OWNER.id): Promise<Record<string, Record<string, any>>> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(pc.userData, 'sync-pending', `${ownerId}.json`), 'utf8')
    ).rates
  } catch {
    return {}
  }
}

const cachedScore = (pc: Pc): number | undefined =>
  (pc.store.get('shikimoriUserRates') as { rate: { target_id: number; score: number } }[]).find(
    (e) => e.rate.target_id === MAL
  )?.rate.score

const queue = (pc: Pc) => pc.store.get('shikimoriUpdateQueue') as any[]

async function conflicts(pc: Pc): Promise<SyncConflictRecord[]> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(pc.userData, 'sync-state', 'conflicts.json'), 'utf8')
    ).records
  } catch {
    return []
  }
}

/** Lets the background drain the Shikimori leg kicks finish. */
async function settleDrain(pc: Pc): Promise<void> {
  await pc.sync.drainNow()
  await pc.runner.quiesce()
}

beforeEach(() => server.reset())
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('(must 1) a pending result survives a wholesale refresh', () => {
  it('the drive keeps 8, sync-pending keeps 8, and the next Shikimori leg pushes 8', async () => {
    server.set(MAL, { score: 6 }, T0)
    const { root, libraryId } = await makeLibrary({
      doc: titleDoc({ rate: r({ score: 8 }, T0 + 500) })
    })
    const pc = makePc({ store: { shikimoriUserRates: [cacheEntry(MAL, ANIME, { score: 6 }, T0)] } })
    pc.offline.value = true
    await pc.attach(root)
    await seedBase(pc, libraryId, root, titleDoc({ rate: r({ score: 6 }) }))

    const first = await pc.runner.runLibrary(libraryId, 'plug')
    expect(first.libraries[0]).toMatchObject({
      drive: 'ok',
      shikimori: 'skipped',
      shikimoriReason: 'offline'
    })
    expect((await pending(pc))[MAL].score.value).toBe(8)
    expect(cachedScore(pc)).toBe(8)

    // Back online, a wholesale refresh sets the cache back to the server's 6.
    refreshCache(pc.store)
    expect(cachedScore(pc)).toBe(6)
    const gen = await driveGeneration(root)
    await pc.runner.runLibrary(libraryId, 'plug')
    expect((await driveDoc(root))!.titles![ID].rate!.score.value).toBe(8)
    expect(await driveGeneration(root)).toBe(gen)
    expect((await pending(pc))[MAL].score.value).toBe(8)

    pc.offline.value = false
    await pc.runner.runAll('online')
    await settleDrain(pc)
    expect(server.get(MAL)!.score).toBe(8)
    expect(await pending(pc)).toEqual({})
  })
})

// --- shared setup ------------------------------------------------------------------------------

const ownerKey = `${OWNER.id}:${MAL}`
const shikiDoc = (v: RateV, at = T0) => titleDoc({ rate: rate(v, at, 'shikimori', MAL) })

async function seedShikiBase(pc: Pc, v: RateV, at = T0): Promise<void> {
  await pc.bases.write(`shikimori-${OWNER.id}`, { stateGeneration: null, doc: shikiDoc(v, at) })
}

function seedPending(
  pc: Pc,
  rates: Record<string, Record<string, unknown>>,
  ownerId = OWNER.id
): void {
  const dir = path.join(pc.userData, 'sync-pending')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${ownerId}.json`),
    JSON.stringify({ version: 1, ownerId, rates })
  )
}

const pend = (
  value: number | string,
  at: number,
  libraryId: string,
  pre: [number | string | null, number | null]
) => ({
  value,
  clock: { at, origin: 'pc-other' },
  provenance: { libraryId },
  prePatch: {
    value: pre[0],
    serverUpdatedAt: pre[1] === null ? null : new Date(pre[1]).toISOString()
  }
})

async function shikiBaseScore(pc: Pc): Promise<unknown> {
  return (await pc.bases.read(`shikimori-${OWNER.id}`))?.doc.titles[ID]?.rate?.score.value
}

/** §4's invariant: a pending field has a queued push whose `after` differs from the server, or a held conflict. */
async function expectInvariant(pc: Pc): Promise<void> {
  const held = await conflicts(pc)
  for (const [malId, fields] of Object.entries(await pending(pc))) {
    for (const [f, p] of Object.entries(fields)) {
      const pushed = queue(pc).some(
        (q) =>
          q.malId === Number(malId) &&
          q.fields?.includes(f) &&
          q.after[f] !== (server.get(Number(malId)) as any)?.[f]
      )
      const conflicted = held.some((c) => c.fieldPath === `rate.${f}`)
      expect(pushed || conflicted, `pending ${malId}.${f} = ${p.value}`).toBe(true)
    }
  }
}

/** A library at base `b`, drive `d`, attached to an owner PC whose cache holds the server's row. */
async function ownerSetup(o: {
  base: RateV
  drive: RateV
  server: RateV
  shikiBase?: RateV
  cache?: RateV
  /** `makePc`'s `index.ts` wiring through the Shikimori bridge (#694). */
  bridge?: boolean
}) {
  server.set(MAL, o.server, T0)
  const { root, libraryId } = await makeLibrary({ doc: titleDoc({ rate: r(o.drive, T0 + 500) }) })
  const pc = makePc({
    bridge: o.bridge,
    store: { shikimoriUserRates: [cacheEntry(MAL, ANIME, o.cache ?? o.server, T0)] }
  })
  await pc.attach(root)
  await seedBase(pc, libraryId, root, titleDoc({ rate: r(o.base) }))
  if (o.shikiBase) await seedShikiBase(pc, o.shikiBase)
  return { pc, root, libraryId }
}

describe('(must 2) a fresh before is never consolidated behind a stale one', () => {
  it('the user entry drains first (server wins), then the leg reads 7 and holds a conflict with the library 8', async () => {
    const { pc } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 7 },
      shikiBase: { score: 6 },
      cache: { score: 6 }
    })
    pc.store.set('shikimoriUpdateQueue', [
      {
        malId: MAL,
        rateId: MAL * 10,
        before: vals({ score: 5 }),
        after: vals({ score: 6 }),
        queuedAt: 1
      }
    ])
    await pc.runner.runAll('manual')
    await settleDrain(pc)
    expect(server.get(MAL)!.score).toBe(7)
    expect(queue(pc)).toEqual([])
    const held = await conflicts(pc)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ fieldPath: 'rate.score', parties: { local: 8, shikimori: 7 } })
    expect(await shikiBaseScore(pc)).toBe(6)
    expect((await pending(pc))[MAL].score.value).toBe(8)
    await expectInvariant(pc)
  })

  it('with no user entry, the scoped entry with its fresh before is applied, with the library provenance', async () => {
    const { pc, libraryId } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 6 },
      shikiBase: { score: 6 }
    })
    pc.offline.value = false
    const kicked = vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    await pc.runner.runAll('manual')
    expect(queue(pc)).toHaveLength(1)
    expect(queue(pc)[0]).toMatchObject({
      before: { score: 6 },
      after: { score: 8 },
      fields: ['score'],
      origin: { kind: 'sync-merge', provenance: { score: { libraryId } } }
    })
    await expectInvariant(pc)
    kicked.mockRestore()
    await settleDrain(pc)
    expect(server.get(MAL)!.score).toBe(8)
    expect(await shikiBaseScore(pc)).toBe(8)
    expect(await pending(pc)).toEqual({})
  })
})

describe('the Shikimori merge pin (#692 § 5)', () => {
  it('a leg entry is exactly its seven keys: no clock, no prompt, and the cache untouched by the queue write', async () => {
    const { pc, libraryId } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 6 },
      shikiBase: { score: 6 }
    })
    // The library leg first, offline: the pending 8 and its display patch.
    pc.offline.value = true
    await pc.runner.runAll('manual')
    const row = structuredClone(
      (pc.store.get('shikimoriUserRates') as any[]).find((e) => e.rate.target_id === MAL)
    )
    expect(row.rate.score).toBe(8)
    const meta = structuredClone(pc.store.get('syncMeta'))
    pc.broadcast.mockClear()
    pc.offline.value = false
    const kicked = vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)

    await pc.runner.runAll('manual')

    expect(queue(pc)).toHaveLength(1)
    const entry = queue(pc)[0]
    expect(Object.keys(entry)).toEqual([
      'malId',
      'rateId',
      'before',
      'after',
      'queuedAt',
      'fields',
      'origin'
    ])
    expect(entry).toEqual({
      malId: MAL,
      rateId: MAL * 10,
      before: vals({ score: 6 }),
      after: vals({ score: 8 }),
      queuedAt: pc.clock.t,
      fields: ['score'],
      origin: { kind: 'sync-merge', provenance: { score: { libraryId } } }
    })
    expect(pc.store.get('syncMeta')).toEqual(meta)
    expect(pc.broadcast.mock.calls.map(([c]) => c)).not.toContain('cleanup:prompt')
    expect(
      (pc.store.get('shikimoriUserRates') as any[]).find((e) => e.rate.target_id === MAL)
    ).toEqual(row)
    kicked.mockRestore()
  })
})

describe('a user edit over a merge field clears its provenance (#692 § 4)', () => {
  it("the dropped pair doesn't count toward L's episodes drops", async () => {
    const { ShikiApiError } = await import('../../src/main/shikimori')
    const { pc, libraryId } = await ownerSetup({
      base: { episodes: 3 },
      drive: { episodes: 3 },
      server: { episodes: 3 },
      shikiBase: { episodes: 3 }
    })
    seedPending(pc, { [MAL]: { episodes: pend(6, T0 + 10, libraryId, [3, T0]) } })
    pc.store.set('shikimoriUpdateQueue', [
      {
        malId: MAL,
        rateId: MAL * 10,
        before: vals({ episodes: 3 }),
        after: vals({ episodes: 6 }),
        queuedAt: 10,
        fields: ['episodes'],
        origin: { kind: 'sync-merge', provenance: { episodes: { libraryId } } }
      },
      {
        malId: MAL,
        rateId: MAL * 10,
        before: vals({ episodes: 6 }),
        after: vals({ episodes: 8 }),
        queuedAt: 11
      }
    ])
    server.writeError = new ShikiApiError('rejected', 422)
    const settled: any[] = []
    pc.sync.onItemSettled((e) => settled.push(e))

    await pc.sync.syncShikimoriQueue()
    await pc.runner.quiesce()

    expect((await pending(pc))[MAL].episodes.drops).toBeUndefined()
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ outcome: 'dropped', consumedQueuedAts: [10, 11] })
    expect(settled[0].provenance).toBeUndefined()
    expect(queue(pc)).toEqual([])
  })
})

describe('a Shikimori-side score conflict', () => {
  it('library 8 (pending) against shikimori.one 9 over base 7: one held conflict, nothing pushed, base and pending kept; the next run updates the same record', async () => {
    const { pc } = await ownerSetup({
      base: { score: 7 },
      drive: { score: 8 },
      server: { score: 9 },
      shikiBase: { score: 7 },
      cache: { score: 7 }
    })
    const first = await pc.runner.runAll('manual')
    expect(queue(pc)).toEqual([])
    const [rec] = await conflicts(pc)
    expect(rec).toMatchObject({ fieldPath: 'rate.score', parties: { local: 8, shikimori: 9 } })
    expect(rec.firstSeenRunId).toBe(first.runId)
    expect(await shikiBaseScore(pc)).toBe(7)
    expect((await pending(pc))[MAL].score.value).toBe(8)
    const second = await pc.runner.runAll('manual')
    const after = await conflicts(pc)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      id: rec.id,
      firstSeenRunId: first.runId,
      lastSeenRunId: second.runId
    })
  })
})

describe('the Shikimori base waits for the drain', () => {
  it('a server change between the read and the drain is kept, and the next run holds a conflict', async () => {
    const { pc } = await ownerSetup({
      base: { score: 7 },
      drive: { score: 8 },
      server: { score: 7 },
      shikiBase: { score: 7 },
      cache: { score: 7 }
    })
    const settled: unknown[] = []
    pc.sync.onItemSettled((e) => settled.push(e))
    let moved = false
    server.beforeDrainRead = () => {
      if (!moved) server.set(MAL, { score: 9 })
      moved = true
    }
    await pc.runner.runAll('manual')
    await settleDrain(pc)
    expect(server.get(MAL)!.score).toBe(9)
    expect(settled[0]).toMatchObject({ outcome: 'server-won', fieldsKeptByServer: ['score'] })
    expect(await shikiBaseScore(pc)).toBe(7)
    await pc.runner.runAll('manual')
    expect((await conflicts(pc)).map((c) => c.fieldPath)).toEqual(['rate.score'])
    expect((await pending(pc))[MAL].score.value).toBe(8)
  })
})

describe('the pending lifecycle', () => {
  it('path A: Shikimori already has it, so nothing is pushed, the field is cleared and the base advances; a later shikimori.one edit applies locally', async () => {
    const { pc, root } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 8 },
      shikiBase: { score: 6 },
      cache: { score: 6 }
    })
    await pc.runner.runAll('manual')
    expect(queue(pc)).toEqual([])
    expect(await pending(pc)).toEqual({})
    expect(await shikiBaseScore(pc)).toBe(8)
    server.set(MAL, { score: 9 })
    await pc.runner.runAll('manual')
    expect(cachedScore(pc)).toBe(9)
    expect(queue(pc)).toEqual([])
    await pc.runner.runAll('manual')
    expect((await driveDoc(root))!.titles![ID].rate!.score.value).toBe(9)
    await expectInvariant(pc)
  })

  for (const provenance of ['library', 'resolution'] as const) {
    it(`path B (${provenance}): the server's newer value is applied here and the pending field cleared`, async () => {
      const { pc, root, libraryId } = await ownerSetup({
        base: { score: 8 },
        drive: { score: 8 },
        server: { score: 9 },
        shikiBase: { score: 8 },
        cache: { score: 8 }
      })
      const p = pend(8, T0 + 100, libraryId, [8, T0])
      if (provenance === 'resolution')
        (p as any).provenance = { resolution: 'c1', libraryIds: [libraryId] }
      seedPending(pc, { [MAL]: { score: p } })
      await pc.runner.runAll('manual')
      expect(cachedScore(pc)).toBe(9)
      expect(await pending(pc)).toEqual({})
      expect(queue(pc)).toEqual([])
      await pc.runner.runAll('manual')
      expect((await driveDoc(root))!.titles![ID].rate!.score.value).toBe(9)
      expect(queue(pc)).toEqual([])
    })
  }

  it('path D: a user edit after a pending value wins at once, and the field is gone once the runner loads the file', async () => {
    const { pc, libraryId } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 6 },
      server: { score: 5 },
      cache: { score: 5 }
    })
    seedPending(pc, { [MAL]: { score: pend(8, T0 + 100, libraryId, [6, T0]) } })
    pc.store.set('syncMeta', {
      titles: {},
      rates: { [ownerKey]: { score: { value: 5, at: T0 + 9000, origin: 'pc-owner' } } }
    })
    pc.offline.value = true
    await pc.runner.runLibrary(libraryId, 'manual')
    expect(await pending(pc)).toEqual({})
  })
})

describe('rollback: a drive older than the base', () => {
  it("a replica field that predates the base's clock is unchanged; one edited after the copy applies", async () => {
    const pos = (p: number, at: number) => watch(false, at, p, 'pc-x')
    const { root, libraryId } = await makeLibrary({
      doc: titleDoc({ watch: { '1': pos(100, T0 + 100), '2': pos(50, T0 + 500) } })
    })
    const pc = makePc()
    await pc.attach(root)
    const base = titleDoc({ watch: { '1': pos(600, T0 + 200), '2': pos(600, T0 + 200) } })
    await pc.bases.write(`library-${libraryId}`, { stateGeneration: 10, doc: base })
    pc.store.set('watchProgress', {
      [`${ID}:1`]: {
        position: 600,
        duration: 1440,
        updatedAt: T0 + 200,
        watched: false,
        sync: {
          position: { at: T0 + 200, origin: 'pc-x' },
          watched: { at: T0 + 200, origin: 'pc-x' }
        }
      },
      [`${ID}:2`]: {
        position: 600,
        duration: 1440,
        updatedAt: T0 + 200,
        watched: false,
        sync: {
          position: { at: T0 + 200, origin: 'pc-x' },
          watched: { at: T0 + 200, origin: 'pc-x' }
        }
      }
    })
    pc.offline.value = true
    await pc.runner.runLibrary(libraryId, 'manual')
    const wp = pc.store.get('watchProgress') as Record<string, { position: number }>
    expect(wp[`${ID}:1`].position).toBe(600)
    expect(wp[`${ID}:2`].position).toBe(50)
  })
})

// --- the raise (owner decision 5) --------------------------------------------------------------

const W = (eps: number[], at: number, origin = 'pc-claim'): Record<string, SyncWatchEntry> =>
  Object.fromEntries(eps.map((e) => [String(e), watch(true, at + e, 0, origin)]))
const localRows = (eps: number[], at: number) =>
  Object.fromEntries(eps.map((e) => [`${ID}:${e}`, progressRow(true, at + e)]))

async function raiseSetup(o: {
  rate: RateV
  rateAt?: number
  rateOrigin?: string
  baseEps: number[]
  driveEps: number[]
  flipAt: number
  serverAt: number
  cacheAt?: number
  driveRate?: RateV
  noBase?: boolean
}) {
  server.set(MAL, o.rate, o.serverAt)
  const driveRate = rate(o.driveRate ?? o.rate, o.rateAt ?? T0, o.rateOrigin ?? 'pc-owner', MAL)
  const drive = titleDoc({
    watch: {
      ...W(o.baseEps, T0, 'pc-owner'),
      ...W(
        o.driveEps.filter((e) => !o.baseEps.includes(e)),
        o.flipAt
      )
    },
    rate: driveRate
  })
  const { root, libraryId } = await makeLibrary({ doc: drive })
  const pc = makePc({
    store: {
      shikimoriUserRates: [cacheEntry(MAL, ANIME, o.rate, o.cacheAt ?? o.serverAt)],
      watchProgress: localRows(o.baseEps, T0)
    }
  })
  await pc.attach(root)
  if (!o.noBase) {
    await seedBase(
      pc,
      libraryId,
      root,
      titleDoc({ watch: W(o.baseEps, T0, 'pc-owner'), rate: rate(o.rate, T0, 'pc-owner', MAL) })
    )
    await seedShikiBase(pc, o.rate, o.serverAt)
  }
  return { pc, root, libraryId }
}

describe('the raise (owner decision 5)', () => {
  it('a claim PC watched 4–6 on a title at watching, 3: the owner pushes episodes 6 and writes it to the drive in the same run', async () => {
    const { pc, root } = await raiseSetup({
      rate: { episodes: 3 },
      baseEps: [1, 2, 3],
      driveEps: [1, 2, 3, 4, 5, 6],
      flipAt: T0 + 1000,
      serverAt: T0
    })
    const vs = vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    await pc.runner.runAll('manual')
    expect(queue(pc)).toHaveLength(1)
    expect(queue(pc)[0]).toMatchObject({
      after: { episodes: 6, status: 'watching' },
      fields: ['episodes']
    })
    expect((await driveDoc(root))!.titles![ID].rate!.episodes.value).toBe(6)
    vs.mockRestore()
  })

  it('forward raise, owner answer: a lagging claim clock (T5 < the server T9) still raises, reaches the drive, and path F never cancels it', async () => {
    const { pc, root } = await raiseSetup({
      rate: { episodes: 3, score: 7 },
      baseEps: [1, 2, 3],
      driveEps: [1, 2, 3, 4, 5, 6],
      flipAt: T0 + 5000,
      serverAt: T0 + 9000
    })
    await pc.runner.runAll('manual')
    await settleDrain(pc)
    expect(server.get(MAL)!.episodes).toBe(6)
    expect((await driveDoc(root))!.titles![ID].rate!.episodes.value).toBe(6)
    expect(pc.runner.syncLog).toBeDefined()
    const log = await pc.runner.syncLog.read(new Date(pc.clock.t).toISOString().slice(0, 7))
    expect(log.filter((e) => e.kind === 'rewatch-superseded')).toEqual([])
  })

  it('positive control (rewatch): a completed title with 1–3 newly watched after the Shikimori clock becomes rewatching, 3, rewatches + 1', async () => {
    const { pc, root } = await raiseSetup({
      rate: { episodes: 12, status: 'completed', rewatches: 1 },
      baseEps: [],
      driveEps: [1, 2, 3],
      flipAt: T0 + 5000,
      serverAt: T0
    })
    const vs = vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    await pc.runner.runAll('manual')
    expect(queue(pc)[0]).toMatchObject({
      after: { episodes: 3, status: 'rewatching', rewatches: 2 }
    })
    // Unconfirmed: kept off the drive.
    expect((await driveDoc(root))!.titles![ID].rate!.status.value).toBe('completed')
    expect((await pending(pc))[MAL].status).toMatchObject({
      value: 'rewatching',
      unconfirmedRewatch: true
    })
    // Invisible to the next library leg until Shikimori confirms it.
    pc.offline.value = true
    await pc.runner.runAll('manual')
    expect((await driveDoc(root))!.titles![ID].rate!.status.value).toBe('completed')
    pc.offline.value = false
    vs.mockRestore()
    await settleDrain(pc)
    expect(server.get(MAL)).toMatchObject({ status: 'rewatching', episodes: 3, rewatches: 2 })
    expect(await pending(pc)).toEqual({})
    await pc.runner.runAll('manual')
    expect((await driveDoc(root))!.titles![ID].rate).toMatchObject({
      status: { value: 'rewatching' },
      rewatches: { value: 2 }
    })
  })

  it('a raise already carried in the library rate is not repeated', async () => {
    const { pc } = await raiseSetup({
      rate: { episodes: 3 },
      driveRate: { episodes: 6 },
      rateAt: T0 + 2000,
      baseEps: [1, 2, 3],
      driveEps: [1, 2, 3, 4, 5, 6],
      flipAt: T0 + 1000,
      serverAt: T0
    })
    server.set(MAL, { episodes: 6 })
    await pc.runner.runAll('manual')
    expect(queue(pc)).toEqual([])
    expect(server.get(MAL)!.episodes).toBe(6)
  })

  it('a claim PC never raises', async () => {
    const drive = titleDoc({
      watch: { ...W([1, 2, 3], T0, 'pc-owner'), ...W([4, 5, 6], T0 + 1000) },
      rate: r({ episodes: 3 })
    })
    const { root, libraryId } = await makeLibrary({ doc: drive })
    const pc = makePc({ user: null, installId: 'pc-claim' })
    await pc.attach(root, { claim: true })
    await seedBase(
      pc,
      libraryId,
      root,
      titleDoc({ watch: W([1, 2, 3], T0, 'pc-owner'), rate: r({ episodes: 3 }) })
    )
    const res = await pc.runner.runAll('manual')
    expect(res.libraries[0]).toMatchObject({
      drive: 'ok',
      shikimori: 'skipped',
      shikimoriReason: 'claim'
    })
    expect(queue(pc)).toEqual([])
    expect(fs.existsSync(path.join(pc.userData, 'sync-pending'))).toBe(false)
    expect((await driveDoc(root))!.titles![ID].rate!.episodes.value).toBe(3)
  })

  for (const cache of ['fresh', 'stale'] as const) {
    it(`(must, false rewatch 1) a second owner PC finished the title; ${cache} cached serverUpdatedAt: nothing pushed`, async () => {
      const T1 = T0 + 100_000
      server.set(MAL, { episodes: 12, status: 'completed', rewatches: 0 }, T1 + 5000)
      const drive = titleDoc({
        watch: { ...W([11], T0, 'pc-owner'), ...W([12], T1 - 12, 'pc2') },
        rate: {
          malId: MAL,
          episodes: F(12, T1, 'pc2'),
          status: F('completed', T1 + 5000, 'shikimori'),
          score: F(0, T0, 'pc2'),
          rewatches: F(0, T0, 'pc2')
        }
      })
      const { root, libraryId } = await makeLibrary({ doc: drive })
      const cached =
        cache === 'fresh'
          ? cacheEntry(MAL, ANIME, { episodes: 12, status: 'completed' }, T1 + 5000)
          : cacheEntry(MAL, ANIME, { episodes: 11 }, T0)
      const pc = makePc({
        store: { shikimoriUserRates: [cached], watchProgress: localRows([11], T0) }
      })
      await pc.attach(root)
      await seedBase(
        pc,
        libraryId,
        root,
        titleDoc({
          watch: W([11], T0, 'pc-owner'),
          rate: rate({ episodes: 11 }, T0, 'pc-owner', MAL)
        })
      )
      await seedShikiBase(pc, { episodes: 11 })
      await pc.runner.runAll('manual')
      await settleDrain(pc)
      expect(queue(pc)).toEqual([])
      expect(server.get(MAL)).toMatchObject({ status: 'completed', rewatches: 0 })
      expect(await pending(pc)).toEqual({})
    })
  }

  it('(must, false rewatch 1, variant 3) neither clock is newer: the unconfirmed raise is kept off the drive, cancelled by path F, logged, and the cache reverted', async () => {
    const T1 = T0 + 100_000
    // The drive's rate carries pc2's own clocks, older than its flip; this PC's cache is stale.
    server.set(MAL, { episodes: 12, status: 'completed' }, T1 + 5000)
    const drive = titleDoc({
      watch: { ...W([11], T0, 'pc-owner'), ...W([12], T1 - 12, 'pc2') },
      rate: {
        malId: MAL,
        episodes: F(12, T1 - 50, 'pc2'),
        status: F('completed', T1 - 50, 'pc2'),
        score: F(0, T0, 'pc2'),
        rewatches: F(0, T0, 'pc2')
      }
    })
    const { root, libraryId } = await makeLibrary({ doc: drive })
    const pc = makePc({
      store: {
        shikimoriUserRates: [cacheEntry(MAL, ANIME, { episodes: 11 }, T0)],
        watchProgress: localRows([11], T0)
      }
    })
    await pc.attach(root)
    await seedBase(
      pc,
      libraryId,
      root,
      titleDoc({
        watch: W([11], T0, 'pc-owner'),
        rate: rate({ episodes: 11 }, T0, 'pc-owner', MAL)
      })
    )
    await seedShikiBase(pc, { episodes: 11 })
    pc.broadcast.mockClear()
    await pc.runner.runAll('manual')
    // The drive written this run has no rewatch.
    expect((await driveDoc(root))!.titles![ID].rate).toMatchObject({
      status: { value: 'completed' },
      rewatches: { value: 0 }
    })
    const log = await pc.runner.syncLog.read(new Date(pc.clock.t).toISOString().slice(0, 7))
    const superseded = log.filter((e) => e.kind === 'rewatch-superseded')
    expect(superseded).toHaveLength(1)
    expect(superseded[0]).toMatchObject({
      malId: MAL,
      libraryId,
      reason: "your rewatch didn't count because Shikimori changed after it"
    })
    expect(await pending(pc)).toEqual({})
    const cached = (pc.store.get('shikimoriUserRates') as any[])[0].rate
    expect(cached).toMatchObject({ status: 'completed', episodes: 12, rewatches: 0 })
    expect(pc.broadcast.mock.calls.some(([ch]) => ch === 'shikimori:rate-updated')).toBe(true)
    expect(queue(pc)).toEqual([])
    await pc.runner.runAll('manual')
    expect(queue(pc)).toEqual([])
    expect((await driveDoc(root))!.titles![ID].rate!.rewatches.value).toBe(0)
  })

  it('(must, false rewatch 2) a first merge on a new owner PC with 30 completed, fully watched titles raises nothing; again after Forget and re-attach', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => 200 + i)
    const titles: Record<string, SyncTitleState> = {}
    const malIdMap: Record<string, { id: number }> = {}
    const cache: unknown[] = []
    for (const id of ids) {
      const mal = id * 10
      malIdMap[mal] = { id }
      titles[String(id)] = {
        watch: Object.fromEntries([1, 2, 3].map((e) => [String(e), watch(true, T0 + e, 0, 'pc2')])),
        rate: rate({ episodes: 3, status: 'completed' }, T0, 'pc2', mal)
      }
      server.set(mal, { episodes: 3, status: 'completed' }, T0)
      cache.push(cacheEntry(mal, id, { episodes: 3, status: 'completed' }, T0))
    }
    const { root, libraryId } = await makeLibrary({ titles: ids, doc: doc(titles) })
    const pc = makePc({ store: { malIdMap, shikimoriUserRates: cache } })
    await pc.attach(root)
    const res = await pc.runner.runAll('manual')
    expect(res.libraries[0].drive).toBe('ok')
    expect(queue(pc)).toEqual([])
    expect(await pending(pc)).toEqual({})
    await pc.attached.forget(libraryId, { confirmDropPending: true })
    await pc.attach(root)
    await pc.runner.runAll('manual')
    expect(queue(pc)).toEqual([])
    expect(await pending(pc)).toEqual({})
  })
})

// --- conflict identity, claim PCs, accounts ----------------------------------------------------

describe('conflict identity and convergence', () => {
  it('the library and Shikimori legs on one field give one record with three parties; converged parties remove it, logged "resolved elsewhere"', async () => {
    // Local 7 (stamped), the library 8, Shikimori 9, all from base 6.
    const { pc, root, libraryId } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 9 },
      shikiBase: { score: 6 },
      cache: { score: 7 }
    })
    const first = await pc.runner.runAll('manual')
    const held = await conflicts(pc)
    expect(held).toHaveLength(1)
    expect(held[0].parties).toEqual({ local: 7, [`library:${libraryId}`]: 8, shikimori: 9 })
    expect(held[0].firstSeenRunId).toBe(first.runId)
    expect(queue(pc)).toEqual([])
    // Everyone settles on 7 elsewhere.
    await writeDrive(root, titleDoc({ rate: r({ score: 7 }, T0 + 900) }))
    server.set(MAL, { score: 7 })
    const second = await pc.runner.runAll('manual')
    expect(await conflicts(pc)).toEqual([])
    const log = await pc.runner.syncLog.read(new Date(pc.clock.t).toISOString().slice(0, 7))
    const run = log.find((e) => e.kind === 'run' && e.runId === second.runId) as any
    expect(run.resolvedElsewhere).toEqual(
      expect.arrayContaining([{ animeId: ID, fieldPath: 'rate.score' }])
    )
  })
})

describe('a claim PC', () => {
  it("the library's rate values pass through byte-identical, whatever its empty cache says, and nothing is queued", async () => {
    const libRate = r({ episodes: 5, score: 8, status: 'watching' }, T0 + 77)
    const { root, libraryId } = await makeLibrary({
      doc: titleDoc({ rate: libRate, watch: W([1], T0) })
    })
    const pc = makePc({
      user: null,
      installId: 'pc-claim',
      store: { watchProgress: localRows([1, 2], T0) }
    })
    await pc.attach(root, { claim: true })
    await seedBase(pc, libraryId, root, titleDoc({ rate: libRate, watch: W([1], T0) }))
    await pc.runner.runAll('manual')
    const after = await driveDoc(root)
    expect(JSON.stringify(after!.titles![ID].rate)).toBe(JSON.stringify(libRate))
    expect(after!.titles![ID].watch!['2']).toBeDefined()
    expect(queue(pc)).toEqual([])
    expect((await pc.bases.read(`library-${libraryId}`))!.doc.titles[ID].rate).toEqual(libRate)
  })
})

describe('pending per owner, on top of S0b', () => {
  it("another account's PC treats the library as foreign: nothing written, A's base and pending unchanged; A logs back in and the drive gets A's watch changes", async () => {
    const { pc, root, libraryId } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 6 },
      server: { score: 6 }
    })
    seedPending(pc, { [MAL]: { score: pend(8, T0 + 100, libraryId, [6, T0]) } })
    pc.store.set('watchProgress', localRows([1, 2], T0 + 50))
    const files = () => [
      fs.readFileSync(path.join(pc.userData, 'sync-bases', `library-${libraryId}.json`), 'utf8'),
      fs.readFileSync(path.join(pc.userData, 'sync-pending', `${OWNER.id}.json`), 'utf8')
    ]
    const before = files()
    const gen = await driveGeneration(root)
    pc.store.set('shikimoriUser', { id: 777, nickname: 'b', avatar: '' })
    const res = await pc.runner.runAll('plug')
    expect(res.libraries[0]).toMatchObject({
      drive: 'skipped',
      driveReason: 'foreign',
      shikimori: 'skipped',
      shikimoriReason: 'foreign'
    })
    expect(files()).toEqual(before)
    expect(await driveGeneration(root)).toBe(gen)
    pc.store.set('shikimoriUser', OWNER)
    pc.offline.value = true
    await pc.runner.runAll('login')
    expect(Object.keys((await driveDoc(root))!.titles![ID].watch!).sort()).toEqual(['1', '2'])
  })

  // The login and logout moved into the tracker lifecycle (#695). The runner
  // call is Shikimori's `afterLogin` step, which the lifecycle runs after the
  // restore and never from the logout.
  it('the logout has no runner call, and the login runs it after the restore (source scan)', () => {
    const read = (p: string): string => fs.readFileSync(path.resolve(__dirname, p), 'utf8')
    const router = read('../../src/main/ipc/shikimori.ipc.ts')
    const lifecycle = read('../../src/main/trackers/lifecycle.ts')

    const alias = router.indexOf('CHANNELS.SHIKIMORI_LOGOUT')
    const aliasBody = router.slice(alias, router.indexOf('ipcMain.handle', alias + 1))
    expect(aliasBody).toMatch(/trackerLifecycle\.logout\('shikimori'/)
    expect(aliasBody).not.toMatch(/syncRunner|runAll|runLibrary/)
    const logout = lifecycle.slice(
      lifecycle.indexOf('function logout('),
      lifecycle.indexOf('function account(')
    )
    expect(logout.length).toBeGreaterThan(100)
    expect(logout).not.toMatch(/syncRunner|runAll|runLibrary|afterLogin/)

    // `runAll('login')` lives only in Shikimori's `afterLogin` step.
    expect(router.split("runAll('login')")).toHaveLength(2)
    const step = router.slice(router.indexOf('afterLogin()'), router.indexOf("runAll('login')"))
    expect(step.length).toBeGreaterThan(0)
    expect(step.length).toBeLessThan(200)
    const login = lifecycle.slice(
      lifecycle.indexOf('async function completeLogin('),
      lifecycle.indexOf('function logout(')
    )
    expect(login.indexOf('afterLogin?.()')).toBeGreaterThan(login.indexOf('takeParked'))
  })
})

// --- write failures, the runAll result, Sync now, never written --------------------------------

const errno = (code: string) => Object.assign(new Error(code), { code })
const LIBS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555'
]

describe('write failures (S8 demotion contract)', () => {
  for (const code of ['EROFS', 'EACCES', 'EPERM']) {
    it(`${code}: reportWriteFailure once, no base, no further write, the same pendingCount next run`, async () => {
      const { root, libraryId } = await makeLibrary({ doc: titleDoc({ watch: W([1], T0) }) })
      const writeState = vi.fn(async () => {
        throw errno(code)
      })
      const pc = makePc({ store: { watchProgress: localRows([1, 2], T0) }, runner: { writeState } })
      await pc.attach(root)
      await seedBase(pc, libraryId, root, titleDoc({ watch: W([1], T0) }))
      const baseBefore = fs.readFileSync(
        path.join(pc.userData, 'sync-bases', `library-${libraryId}.json`),
        'utf8'
      )
      const report = vi.spyOn(pc.attached, 'reportWriteFailure')
      const before = await pc.attached.forget(libraryId)
      const res = await pc.runner.runAll('manual')
      expect(res.libraries[0]).toMatchObject({
        drive: 'error',
        driveReason: 'write-failed-read-only'
      })
      expect(report).toHaveBeenCalledTimes(1)
      expect(writeState).toHaveBeenCalledTimes(1)
      expect(
        fs.readFileSync(path.join(pc.userData, 'sync-bases', `library-${libraryId}.json`), 'utf8')
      ).toBe(baseBefore)
      expect(pc.attached.get(libraryId)).toMatchObject({
        access: 'read-only',
        accessReason: 'write-failed'
      })
      const next = await pc.runner.runAll('manual')
      expect(next.libraries[0]).toMatchObject({ drive: 'skipped', driveReason: 'read-only' })
      expect(writeState).toHaveBeenCalledTimes(1)
      expect(await pc.attached.forget(libraryId)).toEqual(before)
      expect(before).toMatchObject({ needsConfirm: true })
    })
  }
  for (const code of ['ENOSPC', 'EIO']) {
    it(`${code}: no demotion, logged, the base not advanced`, async () => {
      const { root, libraryId } = await makeLibrary({ doc: titleDoc({ watch: W([1], T0) }) })
      const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
      const pc = makePc({
        store: { watchProgress: localRows([1, 2], T0) },
        runner: {
          writeState: async () => {
            throw errno(code)
          },
          log
        }
      })
      await pc.attach(root)
      const res = await pc.runner.runAll('manual')
      expect(res.libraries[0]).toMatchObject({ drive: 'error', driveReason: 'io' })
      expect(pc.attached.get(libraryId)!.access).toBe('read-write')
      expect(await pc.bases.read(`library-${libraryId}`)).toBeNull()
      expect(log.warn).toHaveBeenCalled()
    })
  }
})

describe('the runAll result', () => {
  async function fixture() {
    server.set(MAL, { episodes: 1 }, T0)
    const libs = []
    for (const [i, id] of LIBS.entries()) {
      libs.push(
        await makeLibrary({
          libraryId: id,
          ownerId: i === 3 ? 777 : OWNER.id,
          doc: titleDoc({ watch: W([1], T0) })
        })
      )
    }
    const readOnly = libs[2].root
    const failing = libs[4].root
    const pc = makePc({
      store: {
        watchProgress: localRows([1, 2], T0),
        shikimoriUserRates: [cacheEntry(MAL, ANIME, { episodes: 1 }, T0)]
      },
      writable: async (root) =>
        root === readOnly ? { kind: 'read-only', code: 'EROFS' } : { kind: 'writable' },
      runner: {
        writeState: async (root, ...rest) => {
          if (root === failing) throw errno('EROFS')
          const { writeState } = await import('../../src/main/lib/shared-library/write')
          return writeState(root, ...rest)
        }
      }
    })
    for (const l of libs) await pc.attach(l.root)
    pc.attached.markUnavailable(libs[1].libraryId, libs[1].root)
    return { pc, libs }
  }

  it("runAll('prepare') reports every library's drive and Shikimori outcome, and the log record's result is the same object", async () => {
    const { pc } = await fixture()
    const res = await pc.runner.runAll('prepare')
    expect(res.trigger).toBe('prepare')
    expect(
      res.libraries.map((l) => [
        l.libraryId,
        l.drive,
        l.driveReason,
        l.shikimori,
        l.shikimoriReason
      ])
    ).toEqual([
      [LIBS[0], 'ok', undefined, 'ok', undefined],
      [LIBS[1], 'skipped', 'unavailable', 'ok', undefined],
      [LIBS[2], 'skipped', 'read-only', 'ok', undefined],
      [LIBS[3], 'skipped', 'foreign', 'skipped', 'foreign'],
      [LIBS[4], 'error', 'write-failed-read-only', 'ok', undefined]
    ])
    const log = await pc.runner.syncLog.read(new Date(pc.clock.t).toISOString().slice(0, 7))
    const rec = log.find((e) => e.kind === 'run' && e.trigger === 'prepare') as any
    // The log record's result is the run's, without the derived leg the
    // runner adds to what it hands out (#715): never logged.
    const unlegged = { ...res, libraries: res.libraries.map(({ leg: _leg, ...l }) => l) }
    expect(rec.result).toEqual(JSON.parse(JSON.stringify(unlegged)))
    expect(JSON.stringify(rec)).not.toContain('"leg"')
    expect(res.libraries.map((l) => l.leg)).toEqual(
      res.libraries.map((l) => ({
        tracker: 'shikimori',
        status: l.shikimori,
        ...(l.shikimoriReason ? { reason: l.shikimoriReason } : {})
      }))
    )
  })

  it("offline gives shikimoriReason 'offline'; a claimed library on a logged-out PC 'claim'; logged out with no claim 'logged-out'", async () => {
    const { pc } = await fixture()
    pc.offline.value = true
    const res = await pc.runner.runAll('prepare')
    expect(res.libraries[0]).toMatchObject({ shikimori: 'skipped', shikimoriReason: 'offline' })
    const { root } = await makeLibrary({ libraryId: LIBS[0], doc: titleDoc({ watch: W([1], T0) }) })
    const claim = makePc({ user: null, installId: 'pc-claim' })
    await claim.attach(root, { claim: true })
    expect((await claim.runner.runAll('prepare')).libraries[0]).toMatchObject({
      drive: 'ok',
      shikimori: 'skipped',
      shikimoriReason: 'claim'
    })
    const anon = makePc({ user: null, installId: 'pc-anon' })
    await anon.attach(root)
    expect((await anon.runner.runAll('prepare')).libraries[0]).toMatchObject({
      drive: 'skipped',
      driveReason: 'foreign',
      shikimori: 'skipped',
      shikimoriReason: 'logged-out'
    })
  })

  it('a runAll started while a library is in flight joins it: one run, the same result for both callers', async () => {
    const { root } = await makeLibrary({ doc: titleDoc({ watch: W([1], T0) }) })
    const { writeState: real } = await import('../../src/main/lib/shared-library/write')
    const writeState = vi.fn(real)
    const pc = makePc({ store: { watchProgress: localRows([1, 2], T0) }, runner: { writeState } })
    await pc.attach(root)
    pc.offline.value = true
    const [a, b] = await Promise.all([pc.runner.runAll('manual'), pc.runner.runAll('prepare')])
    expect(writeState).toHaveBeenCalledTimes(1)
    expect(b.libraries).toEqual(a.libraries)
  })
})

describe('Sync now', () => {
  it('the all-libraries run writes every available owned or claimed library and nothing foreign', async () => {
    const own = await makeLibrary({ libraryId: LIBS[0], doc: titleDoc({ watch: W([1], T0) }) })
    const foreign = await makeLibrary({
      libraryId: LIBS[1],
      ownerId: 777,
      doc: titleDoc({ watch: W([1], T0) })
    })
    const pc = makePc({ store: { watchProgress: localRows([1, 2], T0) } })
    pc.offline.value = true
    await pc.attach(own.root)
    await pc.attach(foreign.root)
    const g = await driveGeneration(foreign.root)
    await pc.runner.runAll('manual')
    expect(Object.keys((await driveDoc(own.root))!.titles![ID].watch!)).toEqual(['1', '2'])
    expect(await driveGeneration(foreign.root)).toBe(g)
  })

  it("the detail page's run merges only that title; other titles' bases are byte-identical", async () => {
    const { root, libraryId } = await makeLibrary({
      titles: [ANIME, 102],
      doc: doc({ [ID]: { watch: W([1], T0) }, '102': { watch: W([1], T0) } })
    })
    const pc = makePc({
      store: {
        watchProgress: {
          ...localRows([1, 2], T0),
          '102:1': progressRow(true, T0 + 1),
          '102:2': progressRow(true, T0 + 9)
        }
      }
    })
    pc.offline.value = true
    await pc.attach(root)
    await seedBase(
      pc,
      libraryId,
      root,
      doc({ [ID]: { watch: W([1], T0) }, '102': { watch: W([1], T0) } })
    )
    const before = (await pc.bases.read(`library-${libraryId}`))!.doc.titles['102']
    await pc.runner.runTitle(ANIME, 'manual')
    const after = await pc.bases.read(`library-${libraryId}`)
    expect(JSON.stringify(after!.doc.titles['102'])).toBe(JSON.stringify(before))
    expect(Object.keys(after!.doc.titles[ID].watch!)).toEqual(['1', '2'])
    expect(Object.keys((await driveDoc(root))!.titles!['102'].watch!)).toEqual(['1'])
  })

  it('a second click while a run is in flight starts no second run', async () => {
    const { root, libraryId } = await makeLibrary({ doc: titleDoc({ watch: W([1], T0) }) })
    const { writeState: real } = await import('../../src/main/lib/shared-library/write')
    const writeState = vi.fn(real)
    const pc = makePc({ store: { watchProgress: localRows([1, 2], T0) }, runner: { writeState } })
    pc.offline.value = true
    await pc.attach(root)
    const first = pc.runner.runLibrary(libraryId, 'manual')
    expect((await pc.runner.status()).running).toEqual([libraryId])
    const [a, b] = await Promise.all([first, pc.runner.runTitle(ANIME, 'manual')])
    // The second click joined the first run: the same library result, counts included.
    expect(b.libraries).toEqual(a.libraries)
    expect(a.libraries[0].counts.applied).toBeGreaterThan(0)
    expect(writeState).toHaveBeenCalledTimes(1)
  })
})

describe('never written', () => {
  it('foreign, videos-only and read-only libraries see no write at all, in any trigger path', async () => {
    const { fsWritesUnder } = await import('../helpers/attached-library')
    const foreign = await makeLibrary({
      libraryId: LIBS[0],
      ownerId: 777,
      doc: titleDoc({ watch: W([1], T0) })
    })
    const videos = await makeLibrary({ libraryId: LIBS[1], mode: 'videos' })
    const ro = await makeLibrary({ libraryId: LIBS[2], doc: titleDoc({ watch: W([1], T0) }) })
    const pc = makePc({
      store: { watchProgress: localRows([1, 2], T0) },
      writable: async (root) =>
        root === ro.root ? { kind: 'read-only', code: 'EROFS' } : { kind: 'writable' }
    })
    for (const l of [foreign, videos, ro]) await pc.attach(l.root)
    const seen = [foreign, videos, ro].map((l) => fsWritesUnder(l.root))
    for (const trigger of ['attach', 'plug', 'online', 'login', 'manual', 'prepare'] as const) {
      await pc.runner.runAll(trigger)
      for (const l of [foreign, videos, ro]) await pc.runner.runLibrary(l.libraryId, trigger)
    }
    await pc.runner.runTitle(ANIME, 'manual')
    pc.runner.start()
    pc.attached.markUnavailable(ro.libraryId, ro.root)
    await pc.attached.reopenAt(ro.libraryId, ro.root)
    await pc.runner.quiesce()
    expect(seen.flatMap((s) => s())).toEqual([])
  })
})

describe('a layout v2 library (#713): foreign, never written', () => {
  // The v2 `userId` equals OWNER's Shikimori id numerically: still foreign.
  const ANILIST = { provider: 'anilist', userId: String(OWNER.id) }

  // With no account and no claim it is `videos`, as a v1 library is (#714).
  it.each([
    ['logged in as the numerically equal Shikimori user', OWNER, 'foreign'],
    ['with no account', null, 'videos']
  ] as const)('%s: runAll skips it as foreign', async (_l, user, role) => {
    const { fsWritesUnder } = await import('../helpers/attached-library')
    const v2 = await makeLibrary({ libraryId: LIBS[0], tracker: ANILIST })
    const pc = makePc({ user, store: { watchProgress: localRows([1, 2], T0) } })
    pc.offline.value = true
    await pc.attach(v2.root)
    expect(pc.attached.get(v2.libraryId)?.role).toBe(role)
    const seen = fsWritesUnder(v2.root)
    const r = await pc.runner.runAll('manual')
    expect(r.libraries.find((l) => l.libraryId === v2.libraryId)).toMatchObject({
      drive: 'skipped',
      driveReason: 'foreign'
    })
    expect(seen()).toEqual([])
  })

  it.each([
    ['logged in as the numerically equal Shikimori user', OWNER],
    ['with no account', null]
  ] as const)('%s: runExport on a v2 root is skipped as foreign', async (_l, user) => {
    const { fsWritesUnder } = await import('../helpers/attached-library')
    const v2 = await makeLibrary({ libraryId: LIBS[0], tracker: ANILIST })
    const pc = makePc({ user, store: { watchProgress: localRows([1, 2], T0) } })
    pc.offline.value = true
    const seen = fsWritesUnder(v2.root)
    const r = await pc.runner.runExport({ libraryId: v2.libraryId, root: v2.root, name: 'Drive' })
    expect(r).toMatchObject({ drive: 'skipped', driveReason: 'foreign' })
    expect(seen()).toEqual([])
  })
})

// --- "mine" for any connected account (#714) ---------------------------------------------------

describe('"mine" for any connected account (#714): the leg stays the owner’s tracker', () => {
  const AL = { id: 9, nickname: 'al', avatar: null }
  const ALIST_9 = { provider: 'anilist', userId: '9' }

  /** A v1 library rewritten by hand as v2 with a `provider: 'shikimori'` owner (the writer never makes one). */
  async function handV2Shikimori(
    libraryId: string,
    opts: { doc?: SyncDoc; userId?: string } = {}
  ): Promise<{ root: string; libraryId: string }> {
    const lib = await makeLibrary({ libraryId, doc: opts.doc })
    const file = path.join(lib.root, '.anime-dl', 'manifest.json')
    const m = JSON.parse(fs.readFileSync(file, 'utf8'))
    const owner = { provider: 'shikimori', userId: opts.userId ?? String(OWNER.id), nickname: 'o' }
    fs.writeFileSync(file, JSON.stringify({ ...m, layoutVersion: 2, layoutMinor: 0, owner }))
    return lib
  }

  it('a Shikimori-owned library on a Shikimori + AniList PC (AniList primary): owner, one Shikimori leg, nothing queued to AniList', async () => {
    const { fakeApi } = await import('../helpers/fake-shikimori')
    server.set(MAL, { score: 6 }, T0)
    const lib = await makeLibrary({ libraryId: LIBS[0] })
    const pc = makePc({ store: { anilistUser: AL, trackerPrimary: 'anilist' } })
    await pc.attach(lib.root)
    expect(pc.attached.get(lib.libraryId)).toMatchObject({
      role: 'owner',
      ownerProvider: 'shikimori'
    })
    const r = await pc.runner.runAll('manual')
    await settleDrain(pc)
    expect(r.libraries).toEqual([
      expect.objectContaining({ libraryId: lib.libraryId, drive: 'ok', shikimori: 'ok' })
    ])
    expect(fakeApi.getUserAnimeRates).toHaveBeenCalledTimes(1)
    expect(pc.store.get('anilistUpdateQueue') ?? []).toEqual([])
  })

  it('the owner’s tracker absent (only AniList connected): foreign, and its bases and pending raises stay byte-identical', async () => {
    const lib = await makeLibrary({ libraryId: LIBS[0], doc: titleDoc({ rate: r({ score: 8 }) }) })
    // AniList user OWNER.id: numerically the library's Shikimori owner, still not it.
    const pc = makePc({ user: null, store: { anilistUser: { ...AL, id: OWNER.id } } })
    await pc.attach(lib.root)
    await seedBase(pc, lib.libraryId, lib.root, titleDoc({ rate: r({ score: 6 }) }))
    await seedShikiBase(pc, { score: 6 })
    seedPending(pc, { [MAL]: { score: pend(8, T0, lib.libraryId, [6, T0]) } })
    const files = [
      path.join(pc.userData, 'sync-bases', `library-${lib.libraryId}.json`),
      path.join(pc.userData, 'sync-bases', `shikimori-${OWNER.id}.json`),
      path.join(pc.userData, 'sync-pending', `${OWNER.id}.json`)
    ]
    const before = files.map((f) => fs.readFileSync(f))
    expect(pc.attached.get(lib.libraryId)?.role).toBe('foreign')
    const res = await pc.runner.runAll('manual')
    expect(res.libraries[0]).toMatchObject({ drive: 'skipped', driveReason: 'foreign' })
    expect(files.map((f) => fs.readFileSync(f))).toEqual(before)
  })

  it('an AniList-owned v2 owner library adds nothing to the Shikimori leg: its leg is AniList’s (#715)', async () => {
    const { fakeApi } = await import('../helpers/fake-shikimori')
    const v2 = await makeLibrary({ libraryId: LIBS[0], tracker: ALIST_9 })
    const pc = makePc({ anilist: { user: AL } })
    await pc.attach(v2.root)
    expect(pc.attached.get(v2.libraryId)).toMatchObject({
      role: 'owner',
      ownerProvider: 'anilist',
      layoutVersion: 2
    })
    const res = await pc.runner.runAll('manual')
    expect(res.libraries).toEqual([
      expect.objectContaining({
        libraryId: v2.libraryId,
        drive: 'ok',
        shikimori: 'skipped',
        tracker: { id: 'anilist', status: 'ok' }
      })
    ])
    expect(res.libraries[0]).not.toHaveProperty('shikimoriReason')
    // No Shikimori leg ran: nothing was in its scope.
    expect(fakeApi.getUserAnimeRates).not.toHaveBeenCalled()
  })

  it('a hand-written v2 provider: shikimori library joins the Shikimori leg: the numeric files and mergeQueues, ok, and the manifest stays v2 (#715)', async () => {
    const { fakeApi } = await import('../helpers/fake-shikimori')
    server.set(MAL, { score: 6 }, T0)
    const v2 = await handV2Shikimori(LIBS[0], {
      doc: titleDoc({ rate: r({ score: 8 }, T0 + 500) })
    })
    const pc = makePc({ store: { shikimoriUserRates: [cacheEntry(MAL, ANIME, { score: 6 }, T0)] } })
    await pc.attach(v2.root)
    await seedBase(pc, v2.libraryId, v2.root, titleDoc({ rate: r({ score: 6 }) }))
    expect(pc.attached.get(v2.libraryId)).toMatchObject({ role: 'owner', layoutVersion: 2 })
    const manifest = path.join(v2.root, '.anime-dl', 'manifest.json')
    const ownerBytes = JSON.stringify(JSON.parse(fs.readFileSync(manifest, 'utf8')).owner)
    pc.sync.stopSyncTimer()
    const res = await pc.runner.runAll('manual')
    expect(res.libraries[0]).toMatchObject({ drive: 'ok', shikimori: 'ok' })
    expect(res.libraries[0]).not.toHaveProperty('tracker')
    expect(fakeApi.getUserAnimeRates).toHaveBeenCalledTimes(1)
    // The raise is in the Shikimori owner's files, exactly their shape.
    const file = JSON.parse(
      fs.readFileSync(path.join(pc.userData, 'sync-pending', `${OWNER.id}.json`), 'utf8')
    )
    expect(Object.keys(file)).toEqual(['version', 'ownerId', 'rates'])
    expect(file.ownerId).toBe(OWNER.id)
    expect(file.rates[MAL].score.value).toBe(8)
    // `mergeQueues` into Shikimori's queue (the kicked drain may already have taken it).
    expect(pc.broadcast).toHaveBeenCalledWith(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, {
      length: 1
    })
    expect(await pc.bases.read(`shikimori-${OWNER.id}`)).not.toBeNull()
    for (const dir of ['sync-pending', 'sync-bases']) {
      for (const f of fs.readdirSync(path.join(pc.userData, dir))) {
        expect(fs.readFileSync(path.join(pc.userData, dir, f), 'utf8'), f).not.toContain(
          '"provider"'
        )
      }
    }
    const after = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    expect(after.layoutVersion).toBe(2)
    expect(JSON.stringify(after.owner)).toBe(ownerBytes)
    await settleDrain(pc)
    expect(server.get(MAL)!.score).toBe(8)
  })

  it.each(['05', 'abc'])(
    'a hand-written v2 provider: shikimori library with userId %s is foreign: no Shikimori group, no sync-pending/5.json (#715)',
    async (userId) => {
      const { fakeApi } = await import('../helpers/fake-shikimori')
      const v2 = await handV2Shikimori(LIBS[0], {
        userId,
        doc: titleDoc({ rate: r({ score: 8 }, T0 + 500) })
      })
      const user = { ...OWNER, id: 5 }
      const pc = makePc({ user })
      await pc.attach(v2.root)
      expect(pc.attached.get(v2.libraryId)?.role).toBe('foreign')
      const res = await pc.runner.runAll('manual')
      expect(res.libraries[0]).toMatchObject({ drive: 'skipped', driveReason: 'foreign' })
      expect(fakeApi.getUserAnimeRates).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(pc.userData, 'sync-pending', '5.json'))).toBe(false)
      // A no-account PC can't claim it either: the claim names no owner key.
      const claimPc = makePc({ user: null, installId: 'pc-claim' })
      await claimPc.attach(v2.root, { claim: true })
      expect(claimPc.attached.get(v2.libraryId)?.role).not.toBe('claim')
    }
  )

  it('next to a v1 library whose Shikimori leg runs, the v2 library’s result carries no Shikimori leg', async () => {
    server.set(MAL, { score: 6 }, T0)
    const v1 = await makeLibrary({ libraryId: LIBS[0] })
    const v2 = await makeLibrary({ libraryId: LIBS[1], tracker: ALIST_9 })
    const pc = makePc({ store: { anilistUser: AL } })
    await pc.attach(v1.root)
    await pc.attach(v2.root)
    const res = await pc.runner.runAll('manual')
    await settleDrain(pc)
    const of = (id: string) => res.libraries.find((l) => l.libraryId === id)
    expect(of(v1.libraryId)).toMatchObject({ shikimori: 'ok' })
    expect(of(v2.libraryId)).toMatchObject({ drive: 'skipped', shikimori: 'skipped' })
  })

  it('a v2 owner library holding the title is picked by runTitle and, for a record of its owner, by the conflicts list (#715)', async () => {
    const v2 = await makeLibrary({ libraryId: LIBS[0], tracker: ALIST_9 })
    const pc = makePc({ anilist: { user: AL } })
    pc.offline.value = true
    await pc.attach(v2.root)
    expect(pc.attached.get(v2.libraryId)?.role).toBe('owner')
    const run = await pc.runner.runTitle(ANIME, 'manual')
    expect(run.libraries).toEqual([
      expect.objectContaining({ libraryId: v2.libraryId, drive: 'ok' })
    ])
    const dir = path.join(pc.userData, 'sync-state')
    fs.mkdirSync(dir, { recursive: true })
    const record = (id: string, ownerScope: number | string) => ({
      id,
      ownerScope,
      animeId: ID,
      fieldPath: 'rate.score',
      parties: { local: 7, anilist: 8 },
      bases: {},
      at: {},
      suggestion: null,
      reason: 'changed on both sides, to different values',
      firstSeenRunId: 'r1',
      lastSeenRunId: 'r1'
    })
    // Its owner's record (AniList 9) and a Shikimori 9's, which isn't its owner.
    fs.writeFileSync(
      path.join(dir, 'conflicts-anilist.json'),
      JSON.stringify({ version: 1, records: [record('c-al', ALIST_9.userId)] })
    )
    fs.writeFileSync(
      path.join(dir, 'conflicts.json'),
      JSON.stringify({ version: 1, records: [record('c-sh', Number(ALIST_9.userId))] })
    )
    const items = await pc.runner.listConflicts()
    const of = (id: string) => items.find((i) => i.id === id)!
    expect(of('c-al')).toMatchObject({ tracker: 'anilist' })
    expect(of('c-al').libraries.map((l) => l.libraryId)).toEqual([v2.libraryId])
    expect(of('c-sh')).not.toHaveProperty('tracker')
    expect(of('c-sh').libraries).toEqual([])
  })

  it.each([
    ['anilistUser', AL],
    ['myanimelistUser', { ...AL, nickname: 'mal' }]
  ])(
    'a claim is dropped on a %s login: the next run sees foreign, and the library base is untouched',
    async (key, user) => {
      const lib = await makeLibrary({
        libraryId: LIBS[0],
        doc: titleDoc({ rate: r({ score: 8 }) })
      })
      const pc = makePc({ user: null, installId: 'pc-claim' })
      await pc.attach(lib.root, { claim: true })
      await seedBase(pc, lib.libraryId, lib.root, titleDoc({ rate: r({ score: 6 }) }))
      const base = path.join(pc.userData, 'sync-bases', `library-${lib.libraryId}.json`)
      const before = fs.readFileSync(base)
      pc.store.set(key, user)
      const res = await pc.runner.runAll('login')
      expect(res.libraries[0]).toMatchObject({ drive: 'skipped', driveReason: 'foreign' })
      expect(pc.attached.get(lib.libraryId)?.role).toBe('foreign')
      expect(
        (pc.store.get('attachedLibraries') as Record<string, AttachedLibraryRecord>)[lib.libraryId]
      ).not.toHaveProperty('claim')
      expect(fs.readFileSync(base)).toEqual(before)
    }
  )
})

// --- Forget (owner decision 8) -----------------------------------------------------------------

describe('Forget, through the S7c hook', () => {
  const L = LIBS[0]
  const M = LIBS[1]
  const N = LIBS[2]
  const iso = (t: number) => new Date(t).toISOString()

  async function forgetFixture() {
    const baseL = titleDoc({
      watch: { '1': watch(false, T0, 100, 'pc-owner'), '2': watch(false, T0, 0, 'pc-owner') },
      rate: rate({ episodes: 5, status: 'on_hold', score: 8 }, T0, 'pc-owner', MAL)
    })
    const lib = await makeLibrary({ libraryId: L, doc: baseL })
    const libM = await makeLibrary({ libraryId: M, titles: [103], doc: doc({}) })
    const libN = await makeLibrary({ libraryId: N, titles: [104] })
    server.set(MAL, { episodes: 3, status: 'completed', score: 5 }, T0)
    const pc = makePc({
      store: {
        malIdMap: { [MAL]: { id: ANIME }, 9002: { id: 102 }, 9003: { id: 103 } },
        // A wholesale refresh at T0 brought `completed`; score and episodes still show L's patch.
        shikimoriUserRates: [
          cacheEntry(MAL, ANIME, { episodes: 5, status: 'completed', score: 8 }, T0)
        ],
        // Two local fields L hasn't got: ep 1's position and ep 2's watched.
        watchProgress: {
          [`${ID}:1`]: {
            position: 600,
            duration: 1440,
            updatedAt: T0 + 50,
            watched: false,
            sync: {
              position: { at: T0 + 50, origin: 'pc-owner' },
              watched: { at: T0, origin: 'pc-owner' }
            }
          },
          [`${ID}:2`]: progressRow(true, T0 + 60)
        },
        shikimoriUpdateQueue: [
          { malId: 9002, rateId: 1, before: vals(), after: vals({ score: 3 }), queuedAt: 1 },
          {
            malId: MAL,
            rateId: 2,
            before: vals({ score: 5 }),
            after: vals({ score: 8 }),
            queuedAt: 2,
            fields: ['score'],
            origin: { kind: 'sync-merge', provenance: { score: { libraryId: L } } }
          },
          {
            malId: 9002,
            rateId: 3,
            before: vals(),
            after: vals({ rewatches: 4 }),
            queuedAt: 3,
            fields: [],
            resolvedFields: ['rewatches'],
            origin: {
              kind: 'sync-merge',
              provenance: { rewatches: { resolution: 'c1', libraryIds: [L] } }
            }
          }
        ],
        shikimoriParkedQueues: {
          '777': {
            nickname: 'b',
            parkedAt: 1,
            entries: [
              {
                malId: MAL,
                rateId: 2,
                before: vals(),
                after: vals({ episodes: 5 }),
                queuedAt: 4,
                fields: ['episodes'],
                origin: { kind: 'sync-merge', provenance: { episodes: { libraryId: L } } }
              }
            ]
          }
        }
      }
    })
    for (const l of [lib, libM, libN]) await pc.attach(l.root)
    await seedBase(pc, L, lib.root, baseL)
    await pc.bases.write(`shikimori-${OWNER.id}`, {
      stateGeneration: null,
      doc: titleDoc({
        rate: {
          malId: MAL,
          episodes: F(2, T0 + 50, 'shikimori'),
          status: F('watching', T0 + 50, 'shikimori'),
          score: F(5, T0 + 50, 'shikimori'),
          rewatches: F(0, T0, 'shikimori')
        }
      })
    })
    const pre = (v: number | string, at: number) => ({ value: v, serverUpdatedAt: iso(at) })
    seedPending(pc, {
      [MAL]: {
        // Revert-to-newer: the base (T0+50) is newer than prePatch (T0) → 5.
        score: { ...pend(8, T0 + 10, L, [null, null]), prePatch: pre(6, T0) },
        // prePatch (T0+100) is newer than the base (T0+50) → 3.
        episodes: { ...pend(5, T0 + 10, L, [null, null]), prePatch: pre(3, T0 + 100) },
        // A refresh (cache T0) newer than prePatch (T0-100): kept as it is.
        status: {
          ...pend('on_hold', T0 + 10, L, [null, null]),
          prePatch: pre('watching', T0 - 100)
        }
      },
      9002: {
        rewatches: {
          ...pend(4, T0, L, [0, T0]),
          provenance: { resolution: 'c1', libraryIds: [L] }
        },
        score: { ...pend(3, T0, L, [0, T0]), provenance: { resolution: 'c2', libraryIds: [L, M] } }
      },
      9003: {
        score: pend(9, T0, M, [0, T0]),
        episodes: { ...pend(2, T0, M, [0, T0]), provenance: { resolution: 'c3', libraryIds: [M] } }
      }
    })
    fs.mkdirSync(path.join(pc.userData, 'sync-state'), { recursive: true })
    fs.writeFileSync(
      path.join(pc.userData, 'sync-state', 'conflicts.json'),
      JSON.stringify({
        version: 1,
        records: [
          {
            id: 'k1',
            ownerScope: OWNER.id,
            animeId: ID,
            fieldPath: 'watch.3.watched',
            parties: { local: true, [`library:${L}`]: false },
            bases: {},
            at: {},
            suggestion: null,
            reason: 'x',
            firstSeenRunId: 'r',
            lastSeenRunId: 'r'
          }
        ]
      })
    )
    return { pc, lib, libM, libN }
  }

  it('pendingCount(L) is { libraryChanges: 6, resolutions: 2 }, so the first Forget asks; a library with nothing pending is { 0, 0 }', async () => {
    const { pc } = await forgetFixture()
    expect(await pc.attached.forget(L)).toEqual({
      needsConfirm: true,
      pendingCount: { libraryChanges: 6, resolutions: 2 }
    })
    expect(await pc.attached.forget(N)).toEqual({ needsConfirm: false })
  })

  it("onForgotten(L) strips L from the queues and the pending store, reverts the cache to the newer value, and keeps M's, the Shikimori base and the drive", async () => {
    const { pc, lib } = await forgetFixture()
    const { mtimeSnapshot } = await import('../helpers/attached-library')
    const drive = mtimeSnapshot(lib.root)
    const shikiBase = fs.readFileSync(
      path.join(pc.userData, 'sync-bases', `shikimori-${OWNER.id}.json`),
      'utf8'
    )
    pc.broadcast.mockClear()
    await pc.attached.forget(L, { confirmDropPending: true })
    expect(queue(pc).map((q) => q.queuedAt)).toEqual([1])
    expect(pc.store.get('shikimoriParkedQueues')).toEqual({})
    expect(await pending(pc)).toEqual({
      9003: expect.objectContaining({ score: expect.anything(), episodes: expect.anything() })
    })
    const cached = (pc.store.get('shikimoriUserRates') as any[])[0].rate
    expect(cached).toMatchObject({ score: 5, episodes: 3, status: 'completed' })
    expect(pc.broadcast.mock.calls.some(([ch]) => ch === 'shikimori:rate-updated')).toBe(true)
    expect(fs.existsSync(path.join(pc.userData, 'sync-bases', `library-${L}.json`))).toBe(false)
    expect(await conflicts(pc)).toEqual([])
    expect(
      fs.readFileSync(path.join(pc.userData, 'sync-bases', `shikimori-${OWNER.id}.json`), 'utf8')
    ).toBe(shikiBase)
    expect(mtimeSnapshot(lib.root)).toEqual(drive)
    // The next Shikimori leg pushes nothing of L's.
    pc.store.set('attachedLibraries', {})
    server.set(MAL, { episodes: 3, status: 'completed', score: 5 })
    const { root: again } = await makeLibrary({ libraryId: M, titles: [ANIME] })
    await pc.attach(again)
    const vs = vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    await pc.runner.runAll('manual')
    expect(queue(pc).filter((q) => q.malId === MAL)).toEqual([])
    vs.mockRestore()
  })

  it('running it again is a no-op, and the unsubscribe handle removes the hook', async () => {
    const { pc } = await forgetFixture()
    await pc.attached.forget(L, { confirmDropPending: true })
    const snap = () => [
      JSON.stringify(queue(pc)),
      fs.readFileSync(path.join(pc.userData, 'sync-pending', `${OWNER.id}.json`), 'utf8')
    ]
    const before = snap()
    await pc.attached.forget(L, { confirmDropPending: true })
    expect(snap()).toEqual(before)
    pc.runner.stop()
    expect(await pc.attached.forget(M)).toEqual({ needsConfirm: false })
    expect((await pending(pc))[9003]).toBeDefined()
  })

  async function overwriteSetup(refreshBetween: boolean) {
    server.set(MAL, { score: 6 }, T0)
    const m = await makeLibrary({
      libraryId: M,
      doc: titleDoc({ rate: r({ score: 7 }, T0 + 500) })
    })
    const l = await makeLibrary({
      libraryId: L,
      doc: titleDoc({ rate: r({ score: 8 }, T0 + 600) })
    })
    const pc = makePc({ store: { shikimoriUserRates: [cacheEntry(MAL, ANIME, { score: 6 }, T0)] } })
    pc.offline.value = true
    await pc.attach(m.root)
    await pc.attach(l.root)
    await seedBase(pc, M, m.root, titleDoc({ rate: r({ score: 6 }) }))
    await pc.runner.runLibrary(M, 'plug')
    expect(cachedScore(pc)).toBe(7)
    if (refreshBetween) {
      server.set(MAL, { score: 9 }, T0 + 2000)
      refreshCache(pc.store)
    }
    // L's base is where this PC is now, so L's 8 overwrites the pending 7.
    await seedBase(pc, L, l.root, titleDoc({ rate: r({ score: 7 }) }))
    await pc.runner.runLibrary(L, 'plug')
    return { pc, m, l }
  }

  it('M→L→Forget(L): the first prePatch is carried forward, so Forget reverts to the server 6 and nothing is pushed', async () => {
    const { pc } = await overwriteSetup(false)
    const p = (await pending(pc))[MAL].score
    expect(p).toMatchObject({
      value: 8,
      provenance: { libraryId: L },
      prePatch: { value: 6, serverUpdatedAt: new Date(T0).toISOString() }
    })
    await pc.attached.forget(L, { confirmDropPending: true })
    expect(cachedScore(pc)).toBe(6)
    expect(await pending(pc)).toEqual({})
    pc.offline.value = false
    await pc.runner.runLibrary(M, 'manual')
    expect(queue(pc)).toEqual([])
  })

  it("M→L→Forget(M): L's pending 8 and the cache are untouched, and pendingCount(M) does not count it", async () => {
    const { pc } = await overwriteSetup(false)
    // M hasn't got 8 yet (one projection-vs-base field); L's pending field isn't M's.
    expect(await pc.attached.forget(M)).toEqual({
      needsConfirm: true,
      pendingCount: { libraryChanges: 1, resolutions: 0 }
    })
    await pc.attached.forget(M, { confirmDropPending: true })
    expect((await pending(pc))[MAL].score).toMatchObject({ value: 8, provenance: { libraryId: L } })
    expect(cachedScore(pc)).toBe(8)
  })

  it('a refresh between the patches: prePatch becomes { 9, T2 } and Forget(L) reverts to 9', async () => {
    const { pc } = await overwriteSetup(true)
    expect((await pending(pc))[MAL].score.prePatch).toEqual({
      value: 9,
      serverUpdatedAt: new Date(T0 + 2000).toISOString()
    })
    await pc.attached.forget(L, { confirmDropPending: true })
    expect(cachedScore(pc)).toBe(9)
  })

  it('the drain lock: a drain mid-item when Forget starts finishes first, and no drain sends a field Forget stripped', async () => {
    const { pc } = await forgetFixture()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let first = true
    const { fakeApi } = await import('../helpers/fake-shikimori')
    fakeApi.getUserRate.mockImplementation(async (_t: string, _u: number, malId: number) => {
      if (first) {
        first = false
        await gate
      }
      const row = server.get(malId)
      return row ? { ...row, target_id: malId, target_type: 'Anime' } : null
    })
    fakeApi.updateUserRate.mockImplementation(
      async (
        _t: string,
        id: number,
        episodes: number,
        status: string,
        score: number,
        rewatches: number
      ) => {
        order.push(`send ${id}`)
        return { id, target_id: 0, target_type: 'Anime', episodes, status, score, rewatches }
      }
    )
    server.set(9002, {}, T0)
    const drain = pc.sync.syncShikimoriQueue()
    await new Promise((res) => setTimeout(res, 0))
    const forgot = pc.attached
      .forget(L, { confirmDropPending: true })
      .then(() => order.push('forgotten'))
    await new Promise((res) => setTimeout(res, 10))
    release()
    await drain
    await forgot
    expect(order[order.length - 1]).toBe('forgotten')
    expect(order).toContain(`send ${MAL * 10}`)
    fakeApi.getUserRate.mockReset()
    fakeApi.updateUserRate.mockReset()
  })
})

describe('settles and triggers', () => {
  it('three drops of a field become a held conflict ("Shikimori rejected this change"), and the next leg pushes nothing for it', async () => {
    const { ShikiApiError } = await import('../../src/main/shikimori')
    const { pc, libraryId } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 6 },
      server: { score: 6 },
      shikiBase: { score: 6 }
    })
    seedPending(pc, { [MAL]: { score: pend(11, T0 + 10, libraryId, [6, T0]) } })
    server.writeError = new ShikiApiError('score must be 0..10', 422)
    for (let i = 0; i < 3; i++) {
      pc.store.set('shikimoriUpdateQueue', [
        {
          malId: MAL,
          rateId: MAL * 10,
          before: vals({ score: 6 }),
          after: vals({ score: 11 }),
          queuedAt: 10 + i,
          fields: ['score'],
          origin: { kind: 'sync-merge', provenance: { score: { libraryId } } }
        }
      ])
      await pc.sync.syncShikimoriQueue()
      await pc.runner.quiesce()
    }
    const held = await conflicts(pc)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({
      fieldPath: 'rate.score',
      reason: 'Shikimori rejected this change',
      // Shikimori's side is the server value the patch covered, not the rejected 11.
      parties: { local: 11, shikimori: 6 }
    })
    expect((await pending(pc))[MAL].score).toMatchObject({ value: 11, drops: 3 })
    server.writeError = null
    const vs = vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    await pc.runner.runAll('manual')
    expect(queue(pc)).toEqual([])
    vs.mockRestore()
  })

  it('an availability transition runs that library (plug); the online edge runs every library', async () => {
    const { root, libraryId } = await makeLibrary({ doc: titleDoc({ watch: W([1], T0) }) })
    let online: (() => void) | null = null
    const pc = makePc({
      store: { watchProgress: localRows([1, 2], T0) },
      runner: { onOnline: (l) => ((online = l), () => {}) }
    })
    await pc.attach(root)
    pc.offline.value = true
    pc.runner.start()
    const runs: SyncRunResult[] = []
    pc.broadcast.mockImplementation(
      (ch: string, r: SyncRunResult) => ch === 'sync:run-finished' && runs.push(r)
    )
    pc.attached.markUnavailable(libraryId, root)
    await pc.attached.reopenAt(libraryId, root)
    await vi.waitFor(() => expect(runs.map((r) => r.trigger)).toEqual(['plug']))
    online!()
    await vi.waitFor(() => expect(runs.map((r) => r.trigger)).toEqual(['plug', 'online']))
    expect(pc.attached.get(libraryId)!.lastSyncAt).toBe(pc.clock.t)
  })
})

describe('the Shikimori leg never writes back a stale queue (#628 review)', () => {
  /** Runs `fn` once, at the leg's `shikimori-` base rename: after the queue read, before the queue write. */
  function duringShikiBaseWrite(fn: () => void) {
    const real = fs.promises.rename.bind(fs.promises)
    let done = false
    return vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (!done && String(to).includes('shikimori-')) {
        done = true
        fn()
      }
      return real(from, to)
    })
  }

  it("a user edit queued during the leg's awaits survives it", async () => {
    const { pc } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 6 },
      shikiBase: { score: 6 }
    })
    const kicked = vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    const userEntry = {
      malId: 7777,
      rateId: 1,
      before: vals(),
      after: vals({ score: 3 }),
      queuedAt: 42
    }
    const spy = duringShikiBaseWrite(() => {
      const cur = pc.store.get('shikimoriUpdateQueue') as unknown[]
      pc.store.set('shikimoriUpdateQueue', [...cur, userEntry])
    })
    await pc.runner.runAll('manual')
    spy.mockRestore()
    kicked.mockRestore()
    expect(queue(pc).map((q) => q.queuedAt)).toContain(42)
    expect(queue(pc).filter((q) => q.malId === MAL)).toHaveLength(1)
  })

  it('an entry a drain consumed during the leg does not come back', async () => {
    const { pc } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 6 },
      shikiBase: { score: 6 }
    })
    const kicked = vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    const drained = vi.spyOn(pc.sync, 'drainNow').mockResolvedValue(undefined)
    // Another title's user edit, still queued when the leg reads the queue.
    pc.store.set('shikimoriUpdateQueue', [
      { malId: 7777, rateId: 1, before: vals(), after: vals({ score: 3 }), queuedAt: 42 }
    ])
    const spy = duringShikiBaseWrite(() => {
      // A timer drain sends it and drops it (`dropConsumedEntries` writes a fresh array).
      const cur = pc.store.get('shikimoriUpdateQueue') as { queuedAt: number }[]
      pc.store.set(
        'shikimoriUpdateQueue',
        cur.filter((q) => q.queuedAt !== 42)
      )
    })
    await pc.runner.runAll('manual')
    spy.mockRestore()
    kicked.mockRestore()
    drained.mockRestore()
    expect(queue(pc).map((q) => q.queuedAt)).not.toContain(42)
    expect(queue(pc).filter((q) => q.malId === MAL)).toHaveLength(1)
  })
})

describe('a user edit of the same title during the leg (#628 manual run)', () => {
  it("is queued after the leg's entry, so the drain sends the user's edit", async () => {
    const { pc } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 6, episodes: 3 },
      shikiBase: { score: 6 }
    })
    const kicked = vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    const real = fs.promises.rename.bind(fs.promises)
    let done = false
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (!done && String(to).includes('shikimori-')) {
        done = true
        // The detail page's edit falls back to the queue mid-leg: newer than the leg's entry.
        const cur = pc.store.get('shikimoriUpdateQueue') as unknown[]
        pc.store.set('shikimoriUpdateQueue', [
          ...cur,
          {
            malId: MAL,
            rateId: MAL * 10,
            before: vals({ episodes: 3, score: 6 }),
            after: vals({ episodes: 5, score: 6 }),
            queuedAt: pc.clock.t + 1000
          }
        ])
      }
      return real(from, to)
    })
    await pc.runner.runAll('manual')
    spy.mockRestore()
    kicked.mockRestore()
    expect(queue(pc).map((q) => q.queuedAt)).toEqual([pc.clock.t, pc.clock.t + 1000])
    await settleDrain(pc)
    // The user's edit reached Shikimori; the library's 8 stays pending for the next leg.
    expect(server.get(MAL)).toMatchObject({ episodes: 5 })
    expect((await pending(pc))[MAL].score.value).toBe(8)
    await pc.runner.runAll('manual')
    await settleDrain(pc)
    expect(server.get(MAL)).toMatchObject({ episodes: 5, score: 8 })
  })
})

describe('a re-watch on a claim PC reaches the drive (#645)', () => {
  const KEY = `${ID}:1`
  const REWATCH = { at: T0 + 5000, origin: 'pc-b' }
  type Row = ReturnType<typeof progressRow> & { watchedAt?: number }

  const rows = (pc: Pc) => pc.store.get('watchProgress') as Record<string, Row>
  const setRow = (pc: Pc, row: Row) => pc.store.set('watchProgress', { ...rows(pc), [KEY]: row })

  /** S11's steps 1–2: A (owner, offline) syncs episode 1 watched at T0; B claims and re-watches it. */
  async function rewatchOnB(moved: boolean) {
    server.set(MAL, { episodes: 1, score: 6 }, T0)
    const { root } = await makeLibrary()
    const a = makePc({
      installId: 'pc-a',
      store: {
        watchProgress: { [KEY]: progressRow(true, T0) },
        shikimoriUserRates: [cacheEntry(MAL, ANIME, vals({ episodes: 1, score: 6 }), T0)]
      }
    })
    a.offline.value = true
    await a.attach(root)
    await a.runner.runAll('attach')
    a.store.set('attachedLibraries', {})

    const b = makePc({ user: null, installId: 'pc-b' })
    await b.attach(root, { claim: true })
    await b.runner.runAll('attach')
    // What a completing 'playback' save leaves (watch-progress.ipc.ts): still
    // watched, `watchedAt` kept, the watched clock (and the position's, if it moved) stamped.
    const row = rows(b)[KEY]
    setRow(b, {
      ...row,
      ...(moved ? { position: 1430 } : {}),
      updatedAt: REWATCH.at,
      sync: { position: moved ? REWATCH : row.sync.position, watched: REWATCH }
    })
    const generation = await driveGeneration(root)
    const rb = await b.runner.runAll('manual')
    return { root, a, b, rb, generation: generation! }
  }

  it.each([
    ['the clock only', false],
    ['with the position moved too', true]
  ])(
    '%s: B writes the re-watch, and A’s later unwatch is a rule 2 conflict on A',
    async (_n, moved) => {
      const { root, a, generation } = await rewatchOnB(moved)
      expect(await driveGeneration(root)).toBe(generation + 1)
      expect((await driveDoc(root))!.titles![ID].watch!['1'].watched).toEqual({
        value: true,
        ...REWATCH
      })

      // A unwatches after its base (the SET_WATCHED row shape), then plugs the drive back in.
      const row = rows(a)[KEY]
      setRow(a, {
        ...row,
        watched: false,
        watchedAt: undefined,
        updatedAt: T0 + 6000,
        sync: { ...row.sync, watched: { at: T0 + 6000, origin: 'pc-a' } }
      })
      await a.attach(root)
      await a.runner.runAll('plug')
      expect((await conflicts(a)).map((c) => c.fieldPath)).toEqual(['watch.1.watched'])
      expect(rows(a)[KEY].watched).toBe(false)
      expect((await driveDoc(root))!.titles![ID].watch!['1'].watched).toEqual({
        value: true,
        ...REWATCH
      })
    }
  )

  it('side effects: one update on each PC, A takes the clock and its updatedAt moves, no raise', async () => {
    const { root, a, rb } = await rewatchOnB(false)
    expect(rb.libraries[0].counts.applied).toBe(1)
    await a.attach(root)
    const ra = await a.runner.runAll('plug')
    expect(ra.libraries[0].counts.applied).toBe(1)
    const row = rows(a)[KEY]
    expect(row.watched).toBe(true)
    expect(row.sync.watched).toEqual(REWATCH)
    expect(row.updatedAt).toBe(T0 + 5000)
    expect(await conflicts(a)).toEqual([])
    const log = await a.runner.syncLog.read(new Date(a.clock.t).toISOString().slice(0, 7))
    const run = log.find((e) => e.kind === 'run' && e.runId === ra.runId)
    expect(run).toMatchObject({ kind: 'run', raises: [] })
    expect(queue(a)).toEqual([])
    expect(await pending(a)).toEqual({})
  })
})

// The double-emit table (#694), two of the runner's rows. With `index.ts`'s
// wiring (`makePc({ bridge })`) each emit goes through the Shikimori bridge, so
// its `tracker:*` twin follows it, exactly once.
describe('the runner double-emits through the Shikimori bridge (#694)', () => {
  it("patchCache: the library leg's display patch, then its tracker:rate-updated twin", async () => {
    const { pc } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 6 },
      shikiBase: { score: 6 },
      bridge: true
    })
    pc.offline.value = true
    pc.broadcast.mockClear()

    await pc.runner.runAll('manual')

    const patch = onlyTwin(pc.broadcast.mock.calls, EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED)
    expect(patch.legacy).toEqual(
      (pc.store.get('shikimoriUserRates') as any[]).find((e) => e.rate.target_id === MAL)
    )
    expect((patch.legacy as any).rate.score).toBe(8)
    expectRateTwin(patch)
  })

  it("the merge leg: its queue write's offline-queue-changed, then the twin with the overlay", async () => {
    const { pc } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 6 },
      shikiBase: { score: 6 },
      bridge: true
    })
    pc.offline.value = true
    await pc.runner.runAll('manual')
    pc.offline.value = false
    vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    pc.broadcast.mockClear()

    await pc.runner.runAll('manual')

    expect(queue(pc)).toHaveLength(1)
    const changed = onlyTwin(
      pc.broadcast.mock.calls,
      EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED
    )
    expect(changed.legacy).toEqual({ length: 1 })
    expectQueueTwin(changed, { [MAL]: vals({ score: 8 }) })
  })
})

// --- the owner tracker's leg (#715) ------------------------------------------------------------

/**
 * One non-Shikimori owner tracker, as the suites below take it: AniList here.
 * #717 (T14) adds MyAnimeList's row once #702 (T6) has landed.
 */
interface TrackerCase {
  id: 'anilist'
  label: string
  user: typeof ANILIST_USER
  owner: { provider: string; userId: string }
  keys: typeof ANILIST_KEYS
  pc(opts?: Parameters<typeof makePc>[0]): Pc
}

const TRACKER_CASES: TrackerCase[] = [
  {
    id: 'anilist',
    label: 'AniList',
    user: ANILIST_USER,
    owner: ANILIST_5,
    keys: ANILIST_KEYS,
    pc: (opts = {}) => makePc({ ...opts, anilist: { user: ANILIST_USER } })
  }
]

describe.each(TRACKER_CASES)('an $label-owned library: the owner tracker’s leg (#715)', (tc) => {
  const REMOTE = ANILIST_MEDIA_IDS[MAL] * 10
  const party = `${tc.id}-${tc.user.id}`
  const fakeOf = (pc: Pc) => pc.anilist!.fake
  const syncOf = (pc: Pc) => pc.anilist!.sync
  const trackerQueue = (pc: Pc) => (pc.store.get(tc.keys.updateQueue) ?? []) as any[]
  const pendingPath = (pc: Pc) =>
    path.join(pc.userData, 'sync-pending', `${tc.id}-${tc.user.id}.json`)
  const conflictsPath = (pc: Pc) => path.join(pc.userData, 'sync-state', `conflicts-${tc.id}.json`)
  async function trackerPending(pc: Pc): Promise<Record<string, Record<string, any>>> {
    try {
      return JSON.parse(fs.readFileSync(pendingPath(pc), 'utf8')).rates
    } catch {
      return {}
    }
  }
  function seedTrackerPending(pc: Pc, rates: Record<string, Record<string, unknown>>): void {
    fs.mkdirSync(path.dirname(pendingPath(pc)), { recursive: true })
    fs.writeFileSync(
      pendingPath(pc),
      JSON.stringify({ version: 1, ownerId: String(tc.user.id), rates })
    )
  }
  async function trackerConflicts(pc: Pc): Promise<SyncConflictRecord[]> {
    try {
      return JSON.parse(fs.readFileSync(conflictsPath(pc), 'utf8')).records
    } catch {
      return []
    }
  }
  const cacheRow = (malId: number, animeId: number, v: RateV, at: number) => ({
    malId,
    remoteId: ANILIST_MEDIA_IDS[malId] * 10,
    values: vals(v),
    updatedAt: at,
    smotretAnime: { id: animeId, title: `Title ${animeId}`, posterUrlSmall: 'p.jpg' }
  })
  const cachedValues = (pc: Pc) =>
    (pc.store.get(tc.keys.userRates) as any[]).find((row) => row.malId === MAL)?.values
  const trackerBase = async (pc: Pc) => (await pc.bases.read(party))?.doc.titles[ID]?.rate
  const writeAsOwner = (root: string, d: SyncDoc) => writeDrive(root, d, trackerActor(tc.owner))

  /** A library of the tracker's owner at base `base`, drive `drive`, the server at `server`. */
  async function setup(o: {
    base: RateV
    drive: RateV
    server: RateV
    trackerBase?: RateV | null
    cache?: RateV
    serverAt?: number
    store?: Record<string, unknown>
  }) {
    const serverAt = o.serverAt ?? T0
    const lib = await makeLibrary({
      tracker: tc.owner,
      doc: titleDoc({ rate: r(o.drive, T0 + 500) })
    })
    const pc = tc.pc({
      store: { [tc.keys.userRates]: [cacheRow(MAL, ANIME, o.cache ?? o.server, T0)], ...o.store }
    })
    fakeOf(pc).set(MAL, vals(o.server) as never, { at: serverAt })
    await pc.attach(lib.root)
    await seedBase(pc, lib.libraryId, lib.root, titleDoc({ rate: r(o.base) }))
    if (o.trackerBase !== null) {
      await pc.bases.write(party, {
        stateGeneration: null,
        doc: titleDoc({ rate: rate(o.trackerBase ?? o.base, T0, tc.id, MAL) })
      })
    }
    return { pc, ...lib }
  }

  async function settleTracker(pc: Pc): Promise<void> {
    await syncOf(pc).drainNow()
    await pc.runner.quiesce()
  }

  it('red on main: the drive flips episode 6; the leg queues one field-scoped entry, and the pending file holds it until the drain settles', async () => {
    const lib = await makeLibrary({
      tracker: tc.owner,
      doc: titleDoc({
        watch: { ...W([1, 2, 3, 4, 5], T0, 'pc-owner'), ...W([6], T0 + 1000) },
        rate: rate({ episodes: 5 }, T0, 'pc-owner', MAL)
      })
    })
    const pc = tc.pc({
      store: {
        [tc.keys.userRates]: [cacheRow(MAL, ANIME, { episodes: 5 }, T0)],
        watchProgress: localRows([1, 2, 3, 4, 5], T0)
      }
    })
    fakeOf(pc).set(MAL, { episodes: 5 }, { at: T0 })
    await pc.attach(lib.root)
    await seedBase(
      pc,
      lib.libraryId,
      lib.root,
      titleDoc({
        watch: W([1, 2, 3, 4, 5], T0, 'pc-owner'),
        rate: rate({ episodes: 5 }, T0, 'pc-owner', MAL)
      })
    )
    await pc.bases.write(party, {
      stateGeneration: null,
      doc: titleDoc({ rate: rate({ episodes: 5 }, T0, tc.id, MAL) })
    })
    const drain = vi.spyOn(syncOf(pc), 'syncQueue').mockResolvedValue(undefined)
    const res = await pc.runner.runAll('manual')
    expect(res.libraries[0]).toMatchObject({
      drive: 'ok',
      shikimori: 'skipped',
      tracker: { id: tc.id, status: 'ok' },
      leg: { tracker: tc.id, status: 'ok' }
    })
    const q = trackerQueue(pc)
    expect(q).toHaveLength(1)
    expect(Object.keys(q[0]).sort()).toEqual([
      'after',
      'before',
      'fields',
      'malId',
      'origin',
      'queuedAt',
      'rateId'
    ])
    expect(q[0]).toMatchObject({
      malId: MAL,
      rateId: REMOTE,
      before: vals({ episodes: 5 }),
      after: vals({ episodes: 6 }),
      fields: ['episodes'],
      origin: { kind: 'sync-merge', provenance: { episodes: { libraryId: lib.libraryId } } }
    })
    expect(queue(pc)).toEqual([])
    expect((await trackerPending(pc))[MAL].episodes.value).toBe(6)
    expect((await driveDoc(lib.root))!.titles![ID].rate!.episodes.value).toBe(6)
    drain.mockRestore()
    await settleTracker(pc)
    expect(fakeOf(pc).rows.get(MAL)!.values.episodes).toBe(6)
    expect(fs.existsSync(pendingPath(pc))).toBe(false)
    // Path C: the base advances with the tracker's origin.
    expect((await trackerBase(pc))!.episodes).toMatchObject({ value: 6, origin: tc.id })
  })

  it('path A: the tracker already has it, so nothing is pushed, the field is cleared and its base advances', async () => {
    const { pc } = await setup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 8 },
      trackerBase: { score: 6 },
      cache: { score: 6 }
    })
    await pc.runner.runAll('manual')
    expect(trackerQueue(pc)).toEqual([])
    expect(await trackerPending(pc)).toEqual({})
    expect((await trackerBase(pc))!.score.value).toBe(8)
  })

  it('with no base, the leg’s first base is the tracker’s side: every field clock it wrote has the tracker’s origin', async () => {
    const { pc } = await setup({
      base: { score: 6 },
      drive: { score: 6 },
      server: { score: 6 },
      trackerBase: null
    })
    await pc.runner.runAll('manual')
    const base = (await trackerBase(pc))!
    for (const f of ['episodes', 'status', 'score', 'rewatches'] as const) {
      expect(base[f].origin, f).toBe(tc.id)
    }
  })

  it('path B: the tracker’s newer value is applied here and the pending field cleared', async () => {
    const { pc, root, libraryId } = await setup({
      base: { score: 8 },
      drive: { score: 8 },
      server: { score: 9 },
      cache: { score: 8 }
    })
    seedTrackerPending(pc, { [MAL]: { score: pend(8, T0 + 100, libraryId, [8, T0]) } })
    await pc.runner.runAll('manual')
    expect(cachedValues(pc).score).toBe(9)
    expect(await trackerPending(pc)).toEqual({})
    expect(trackerQueue(pc)).toEqual([])
    await pc.runner.runAll('manual')
    expect((await driveDoc(root))!.titles![ID].rate!.score.value).toBe(9)
  })

  it('path D: a newer user edit stamped under the tracker’s clock key beats a pending value', async () => {
    const { pc, libraryId } = await setup({
      base: { score: 6 },
      drive: { score: 6 },
      server: { score: 5 },
      cache: { score: 5 }
    })
    seedTrackerPending(pc, { [MAL]: { score: pend(8, T0 + 100, libraryId, [6, T0]) } })
    pc.store.set('syncMeta', {
      titles: {},
      rates: {
        [`${tc.id}:${tc.user.id}:${MAL}`]: {
          score: { value: 5, at: T0 + 9000, origin: 'pc-owner' }
        }
      }
    })
    pc.offline.value = true
    await pc.runner.runLibrary(libraryId, 'manual')
    expect(await trackerPending(pc)).toEqual({})
  })

  it('path F: an unconfirmed rewatch raise older than the fresh row is cancelled and logged with the tracker', async () => {
    const { pc, libraryId } = await setup({
      base: { episodes: 12, status: 'completed' },
      drive: { episodes: 12, status: 'completed' },
      server: { episodes: 12, status: 'completed' },
      serverAt: T0 + 5000
    })
    seedTrackerPending(pc, {
      [MAL]: {
        episodes: { ...pend(1, T0 + 100, libraryId, [12, T0]), unconfirmedRewatch: true },
        status: {
          ...pend('rewatching', T0 + 100, libraryId, ['completed', T0]),
          unconfirmedRewatch: true
        }
      }
    })
    const res = await pc.runner.runAll('manual')
    expect(res.libraries[0]).toMatchObject({ rewatchesSuperseded: 1 })
    expect(await trackerPending(pc)).toEqual({})
    const log = await pc.runner.syncLog.read(new Date(pc.clock.t).toISOString().slice(0, 7))
    expect(log.filter((e) => e.kind === 'rewatch-superseded')).toEqual([
      expect.objectContaining({
        malId: MAL,
        tracker: tc.id,
        reason: `your rewatch didn't count because ${tc.label} changed after it`
      })
    ])
  })

  it('the rewatch guard reads the tracker’s clocks: a merged clock of its origin newer than the cache wins, so no raise', async () => {
    const T1 = T0 + 100_000
    const lib = await makeLibrary({
      tracker: tc.owner,
      doc: titleDoc({
        watch: { ...W([11], T0, 'pc-owner'), ...W([12], T1 - 12, 'pc2') },
        rate: {
          malId: MAL,
          episodes: F(12, T1, 'pc2'),
          status: F('completed', T1 + 5000, tc.id),
          score: F(0, T0, 'pc2'),
          rewatches: F(0, T0, 'pc2')
        }
      })
    })
    const pc = tc.pc({
      store: {
        [tc.keys.userRates]: [cacheRow(MAL, ANIME, { episodes: 11 }, T0)],
        watchProgress: localRows([11], T0)
      }
    })
    fakeOf(pc).set(MAL, { episodes: 12, status: 'completed' }, { at: T1 + 5000 })
    await pc.attach(lib.root)
    await seedBase(
      pc,
      lib.libraryId,
      lib.root,
      titleDoc({
        watch: W([11], T0, 'pc-owner'),
        rate: rate({ episodes: 11 }, T0, 'pc-owner', MAL)
      })
    )
    await pc.bases.write(party, {
      stateGeneration: null,
      doc: titleDoc({ rate: rate({ episodes: 11 }, T0, tc.id, MAL) })
    })
    await pc.runner.runAll('manual')
    await settleTracker(pc)
    const log = await pc.runner.syncLog.read(new Date(pc.clock.t).toISOString().slice(0, 7))
    const run = log.find((e) => e.kind === 'run') as Extract<SyncLogRecord, { kind: 'run' }>
    expect(run.raises).toEqual([])
    expect(trackerQueue(pc)).toEqual([])
    expect(fakeOf(pc).rows.get(MAL)!.values).toMatchObject({ status: 'completed', rewatches: 0 })
    expect(await trackerPending(pc)).toEqual({})
  })

  it('three drops become a held conflict in its own file, with its reason and a tracker-rejected log; nothing pushed after', async () => {
    const { pc, libraryId } = await setup({
      base: { score: 6 },
      drive: { score: 6 },
      server: { score: 6 },
      trackerBase: { score: 6 }
    })
    seedTrackerPending(pc, { [MAL]: { score: pend(9, T0 + 10, libraryId, [6, T0]) } })
    fakeOf(pc).fail('item', { member: 'upsertEntry', times: 3 })
    for (let i = 0; i < 3; i++) {
      pc.store.set(tc.keys.updateQueue, [
        {
          malId: MAL,
          rateId: REMOTE,
          before: vals({ score: 6 }),
          after: vals({ score: 9 }),
          queuedAt: 10 + i,
          fields: ['score'],
          origin: { kind: 'sync-merge', provenance: { score: { libraryId } } }
        }
      ])
      await syncOf(pc).syncQueue()
      await pc.runner.quiesce()
    }
    const held = await trackerConflicts(pc)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({
      ownerScope: String(tc.user.id),
      fieldPath: 'rate.score',
      reason: `${tc.label} rejected this change`,
      parties: { local: 9, [tc.id]: 6 }
    })
    expect(await conflicts(pc)).toEqual([])
    expect((await trackerPending(pc))[MAL].score).toMatchObject({ value: 9, drops: 3 })
    const log = await pc.runner.syncLog.read(new Date(pc.clock.t).toISOString().slice(0, 7))
    expect(log.filter((e) => e.kind === 'shikimori-rejected')).toEqual([])
    expect(log.filter((e) => e.kind === 'tracker-rejected')).toEqual([
      expect.objectContaining({ tracker: tc.id, malId: MAL, fields: ['score'] })
    ])
    const vs = vi.spyOn(syncOf(pc), 'syncQueue').mockResolvedValue(undefined)
    pc.store.set(tc.keys.updateQueue, [])
    await pc.runner.runAll('manual')
    expect(trackerQueue(pc)).toEqual([])
    vs.mockRestore()
  })

  it('Forget reverts a dropped field from the tracker’s base and cache, and leaves a colliding shikimori-<id> alone', async () => {
    const { pc, libraryId } = await setup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 6 },
      cache: { score: 8 },
      trackerBase: null
    })
    await pc.bases.write(party, {
      stateGeneration: null,
      doc: titleDoc({ rate: rate({ score: 7 }, T0 + 50, tc.id, MAL) })
    })
    const shikiBase = path.join(pc.userData, 'sync-bases', `shikimori-${tc.user.id}.json`)
    await pc.bases.write(`shikimori-${tc.user.id}`, {
      stateGeneration: null,
      doc: titleDoc({ rate: rate({ score: 3 }, T0 + 60, 'shikimori', MAL) })
    })
    const shikiBytes = fs.readFileSync(shikiBase, 'utf8')
    seedTrackerPending(pc, { [MAL]: { score: pend(8, T0 + 100, libraryId, [6, T0]) } })
    await pc.attached.forget(libraryId, { confirmDropPending: true })
    expect(fs.existsSync(pendingPath(pc))).toBe(false)
    // The newer of the prePatch (6 at T0) and the tracker's base (7 at T0 + 50).
    expect(cachedValues(pc).score).toBe(7)
    expect(fs.readFileSync(shikiBase, 'utf8')).toBe(shikiBytes)
  })

  it('a title with no AniList id mapping is skipped there: nothing queued, nothing waiting', async () => {
    const UNMAPPED_ANIME = 199
    const lib = await makeLibrary({
      tracker: tc.owner,
      titles: [UNMAPPED_ANIME],
      doc: doc({
        [String(UNMAPPED_ANIME)]: {
          rate: rate({ score: 8 }, T0 + 500, 'pc-other', UNMAPPED_MAL_ID)
        }
      })
    })
    const pc = tc.pc({ store: { malIdMap: { [UNMAPPED_MAL_ID]: { id: UNMAPPED_ANIME } } } })
    await pc.attach(lib.root)
    const res = await pc.runner.runAll('manual')
    expect(res.libraries[0]).toMatchObject({
      tracker: { id: tc.id, status: 'ok' },
      waitingMalIds: []
    })
    expect(trackerQueue(pc)).toEqual([])
  })

  it('the owner’s tracker disconnected: the pending file stays and nothing is queued anywhere; a reconnect as the same user pushes it', async () => {
    const { pc, libraryId } = await setup({
      base: { score: 6 },
      drive: { score: 6 },
      server: { score: 6 },
      trackerBase: { score: 6 }
    })
    seedTrackerPending(pc, { [MAL]: { score: pend(8, T0 + 100, libraryId, [6, T0]) } })
    const bytes = fs.readFileSync(pendingPath(pc), 'utf8')
    pc.store.set(tc.keys.user, null)
    pc.store.set(tc.keys.credentials, null)
    await pc.attached.init()
    const res = await pc.runner.runAll('manual')
    expect(res.libraries[0]).toMatchObject({ drive: 'skipped', driveReason: 'foreign' })
    expect(fs.readFileSync(pendingPath(pc), 'utf8')).toBe(bytes)
    expect(trackerQueue(pc)).toEqual([])
    expect(queue(pc)).toEqual([])
    pc.store.set(tc.keys.user, tc.user)
    pc.store.set(tc.keys.credentials, { v: 1, enc: 'plain', data: 'token' })
    await pc.attached.init()
    const vs = vi.spyOn(syncOf(pc), 'syncQueue').mockResolvedValue(undefined)
    await pc.runner.runAll('manual')
    expect(trackerQueue(pc)).toEqual([
      expect.objectContaining({ malId: MAL, fields: ['score'], after: vals({ score: 8 }) })
    ])
    expect(queue(pc)).toEqual([])
    vs.mockRestore()
  })

  it('the results: skipped reasons, a thrown leg classified through the provider, and a run’s fallback all carry the tracker', async () => {
    const { pc, libraryId } = await setup({
      base: { score: 6 },
      drive: { score: 6 },
      server: { score: 6 }
    })
    pc.offline.value = true
    expect((await pc.runner.runAll('manual')).libraries[0]).toMatchObject({
      shikimori: 'skipped',
      tracker: { id: tc.id, status: 'skipped', reason: 'offline' },
      leg: { tracker: tc.id, status: 'skipped', reason: 'offline' }
    })
    pc.offline.value = false
    // A network error out of the leg itself, past its read: the owner-grouping catch.
    const has = vi.spyOn(syncOf(pc), 'hasTitle').mockImplementation(() => {
      throw new TypeError('fetch failed')
    })
    const thrown = (await pc.runner.runAll('manual')).libraries[0]
    expect(thrown).toMatchObject({
      shikimori: 'skipped',
      tracker: { id: tc.id, status: 'error', reason: 'network' }
    })
    expect(thrown).not.toHaveProperty('shikimoriReason')
    has.mockRestore()
    // The read's own failure, through the provider's classifier.
    fakeOf(pc).fail('auth', { member: 'listEntries' })
    expect((await pc.runner.runAll('manual')).libraries[0]).toMatchObject({
      tracker: { id: tc.id, status: 'error', reason: 'auth' }
    })
    // A run that dies past the legs: the fallback result still names the tracker.
    const get = vi.spyOn(pc.attached, 'get').mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(pc.runner.runAll('manual')).rejects.toThrow('boom')
    get.mockRestore()
    expect((await pc.runner.status()).libraries[libraryId].last).toMatchObject({
      drive: 'error',
      shikimori: 'skipped',
      tracker: { id: tc.id, status: 'skipped' },
      leg: { tracker: tc.id, status: 'skipped' }
    })
  })

  it('a review item of a mal:<id> record shows its title and poster from the tracker cache alone', async () => {
    const pc = tc.pc({
      store: {
        malIdMap: {},
        [tc.keys.userRates]: [cacheRow(MAL, ANIME, { score: 6 }, T0)]
      }
    })
    fs.mkdirSync(path.dirname(conflictsPath(pc)), { recursive: true })
    fs.writeFileSync(
      conflictsPath(pc),
      JSON.stringify({
        version: 1,
        records: [
          {
            id: 'c-mal',
            ownerScope: String(tc.user.id),
            animeId: `mal:${MAL}`,
            fieldPath: 'rate.score',
            parties: { local: 9, [tc.id]: 6 },
            bases: {},
            at: {},
            suggestion: null,
            reason: `${tc.label} rejected this change`,
            firstSeenRunId: 'r1',
            lastSeenRunId: 'r1'
          }
        ]
      })
    )
    const [item] = await pc.runner.listConflicts()
    expect(item).toMatchObject({
      tracker: tc.id,
      title: { name: `Title ${ANIME}`, poster: 'p.jpg' }
    })
  })

  it('a Shikimori-owned library on a PC whose only cache mapping is Shikimori’s keeps its title (the union)', async () => {
    server.set(MAL, { score: 6 }, T0)
    const lib = await makeLibrary({ doc: titleDoc({ rate: r({ score: 8 }, T0 + 500) }) })
    const pc = tc.pc({
      store: {
        malIdMap: {},
        trackerPrimary: tc.id,
        shikimoriUserRates: [cacheEntry(MAL, ANIME, { score: 6 }, T0)]
      }
    })
    await pc.attach(lib.root)
    await seedBase(pc, lib.libraryId, lib.root, titleDoc({ rate: r({ score: 6 }) }))
    const vs = vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    await pc.runner.runAll('manual')
    expect(queue(pc)).toEqual([expect.objectContaining({ malId: MAL, fields: ['score'] })])
    expect(trackerQueue(pc)).toEqual([])
    vs.mockRestore()
  })

  it('runExport on its owner’s PC: the library leg as that owner, and the result names the tracker', async () => {
    const lib = await makeLibrary({ tracker: tc.owner })
    const pc = tc.pc({ store: { watchProgress: localRows([1, 2], T0) } })
    pc.offline.value = true
    const r = await pc.runner.runExport({ libraryId: lib.libraryId, root: lib.root, name: 'Drive' })
    expect(r).toMatchObject({
      drive: 'ok',
      shikimori: 'skipped',
      tracker: { id: tc.id, status: 'skipped' },
      leg: { tracker: tc.id, status: 'skipped' }
    })
    expect((await driveDoc(lib.root))!.titles![ID].watch!['1'].watched.value).toBe(true)
    expect(await pc.bases.read(`library-${lib.libraryId}`)).not.toBeNull()
    // The owner's other PC keeps its owner; the export leg is foreign after a switch.
    await writeAsOwner(lib.root, (await driveDoc(lib.root)) as SyncDoc)
    pc.store.set(tc.keys.user, { ...tc.user, id: tc.user.id + 1 })
    const switched = await pc.runner.runExport({
      libraryId: lib.libraryId,
      root: lib.root,
      name: 'Drive'
    })
    expect(switched).toMatchObject({ drive: 'skipped', driveReason: 'foreign' })
  })
})

describe('a MyAnimeList-owned library: the MAL leg (#715, after #702)', () => {
  it('the drive flips episode 6; the MAL leg queues one field-scoped entry, mal-5.json holds it, and the drain settles it into mal-5', async () => {
    const pendingFile = (pc: Pc) =>
      path.join(pc.userData, 'sync-pending', `mal-${MAL_USER.id}.json`)
    const lib = await makeLibrary({
      tracker: MAL_5,
      doc: titleDoc({
        watch: { ...W([1, 2, 3, 4, 5], T0, 'pc-owner'), ...W([6], T0 + 1000) },
        rate: rate({ episodes: 5 }, T0, 'pc-owner', MAL)
      })
    })
    const pc = makePc({
      user: null,
      mal: {},
      store: {
        myanimelistUserRates: [
          {
            malId: MAL,
            remoteId: MAL,
            values: vals({ episodes: 5 }),
            updatedAt: T0,
            smotretAnime: { id: ANIME }
          }
        ],
        watchProgress: localRows([1, 2, 3, 4, 5], T0)
      }
    })
    pc.mal!.fake.set(MAL, { episodes: 5 }, { at: T0 })
    await pc.attach(lib.root)
    expect(pc.attached.get(lib.libraryId)).toMatchObject({ role: 'owner', ownerProvider: 'mal' })
    await seedBase(
      pc,
      lib.libraryId,
      lib.root,
      titleDoc({
        watch: W([1, 2, 3, 4, 5], T0, 'pc-owner'),
        rate: rate({ episodes: 5 }, T0, 'pc-owner', MAL)
      })
    )
    await pc.bases.write(`mal-${MAL_USER.id}`, {
      stateGeneration: null,
      doc: titleDoc({ rate: rate({ episodes: 5 }, T0, 'mal', MAL) })
    })
    const drain = vi.spyOn(pc.mal!.sync, 'syncQueue').mockResolvedValue(undefined)
    const res = await pc.runner.runAll('manual')
    expect(res.libraries[0]).toMatchObject({
      drive: 'ok',
      shikimori: 'skipped',
      tracker: { id: 'mal', status: 'ok' }
    })
    expect(pc.store.get('myanimelistUpdateQueue')).toEqual([
      expect.objectContaining({
        malId: MAL,
        rateId: MAL,
        before: vals({ episodes: 5 }),
        after: vals({ episodes: 6 }),
        fields: ['episodes']
      })
    ])
    expect(pc.store.get('anilistUpdateQueue') ?? []).toEqual([])
    expect(queue(pc)).toEqual([])
    expect(JSON.parse(fs.readFileSync(pendingFile(pc), 'utf8'))).toMatchObject({
      ownerId: String(MAL_USER.id),
      rates: { [MAL]: { episodes: { value: 6 } } }
    })
    drain.mockRestore()
    await pc.mal!.sync.drainNow()
    await pc.runner.quiesce()
    expect(pc.mal!.fake.rows.get(MAL)!.values.episodes).toBe(6)
    expect(fs.existsSync(pendingFile(pc))).toBe(false)
    expect(
      (await pc.bases.read(`mal-${MAL_USER.id}`))!.doc.titles[ID].rate!.episodes
    ).toMatchObject({ value: 6, origin: 'mal' })
  })
})

describe('two owners with colliding numeric ids on one PC: Shikimori 5 and AniList 5 (#715)', () => {
  it('each conflict stays in its own file, and each base advances only in its own party', async () => {
    const SHIKI_5 = { ...OWNER, id: ANILIST_USER.id }
    server.set(MAL, { score: 9 }, T0)
    const shikiLib = await makeLibrary({
      libraryId: LIBS[0],
      ownerId: SHIKI_5.id,
      doc: titleDoc({ rate: r({ score: 8 }, T0 + 500) })
    })
    const alLib = await makeLibrary({
      libraryId: LIBS[1],
      tracker: ANILIST_5,
      doc: titleDoc({ rate: r({ score: 8 }, T0 + 500) })
    })
    const pc = makePc({
      user: SHIKI_5,
      anilist: { user: ANILIST_USER },
      store: {
        shikimoriUserRates: [cacheEntry(MAL, ANIME, { score: 7 }, T0)],
        anilistUserRates: [
          {
            malId: MAL,
            remoteId: ANILIST_MEDIA_IDS[MAL] * 10,
            values: vals({ score: 7 }),
            updatedAt: T0,
            smotretAnime: { id: ANIME }
          }
        ]
      }
    })
    pc.anilist!.fake.set(MAL, { score: 9 }, { at: T0 })
    for (const lib of [shikiLib, alLib]) {
      await pc.attach(lib.root)
      await seedBase(pc, lib.libraryId, lib.root, titleDoc({ rate: r({ score: 7 }) }))
    }
    for (const p of ['shikimori', 'anilist']) {
      await pc.bases.write(`${p}-5`, {
        stateGeneration: null,
        doc: titleDoc({ rate: rate({ score: 7 }, T0, p, MAL) })
      })
    }
    await pc.runner.runAll('manual')
    const shiki = await conflicts(pc)
    const al = JSON.parse(
      fs.readFileSync(path.join(pc.userData, 'sync-state', 'conflicts-anilist.json'), 'utf8')
    ).records as SyncConflictRecord[]
    // Two records, not one: the same `5|animeId|fieldPath` in two files.
    expect(shiki).toEqual([
      expect.objectContaining({
        ownerScope: 5,
        animeId: ID,
        fieldPath: 'rate.score',
        parties: { local: 8, shikimori: 9 }
      })
    ])
    expect(al).toEqual([
      expect.objectContaining({
        ownerScope: '5',
        animeId: ID,
        fieldPath: 'rate.score',
        parties: { local: 8, anilist: 9 }
      })
    ])
    // Each base keeps its own party's held value.
    expect((await pc.bases.read('shikimori-5'))!.doc.titles[ID].rate!.score).toMatchObject({
      value: 7,
      origin: 'shikimori'
    })
    expect((await pc.bases.read('anilist-5'))!.doc.titles[ID].rate!.score).toMatchObject({
      value: 7,
      origin: 'anilist'
    })
    // The Shikimori pending file is numeric and has no AniList value, and vice versa.
    const shikiPending = JSON.parse(
      fs.readFileSync(path.join(pc.userData, 'sync-pending', '5.json'), 'utf8')
    )
    expect(shikiPending.ownerId).toBe(5)
    const alPending = JSON.parse(
      fs.readFileSync(path.join(pc.userData, 'sync-pending', 'anilist-5.json'), 'utf8')
    )
    expect(alPending.ownerId).toBe('5')
  })
})

describe('overlay reads per owner tracker (#715)', () => {
  const raise = {
    value: 1,
    clock: { at: T0 + 100, origin: 'pc-claim' },
    provenance: { libraryId: LIBS[0] },
    prePatch: { value: 12, serverUpdatedAt: new Date(T0).toISOString() },
    unconfirmedRewatch: true as const
  }
  const rates = { [MAL]: { episodes: raise } }

  it('an unconfirmed raise reads back with its tracker’s origin: AniList’s, Shikimori’s', () => {
    const store = new (class {
      get = () => undefined
    })() as never
    expect(overlay(store, 5, MAL, rates, { skipUnconfirmed: true }, [], 'anilist')).toEqual({
      episodes: { value: 12, at: T0, origin: 'anilist' }
    })
    expect(overlay(store, 5, MAL, rates, { skipUnconfirmed: true }, [])).toEqual({
      episodes: { value: 12, at: T0, origin: 'shikimori' }
    })
  })

  it('path D’s stamp is read under the tracker’s own clock key', () => {
    const stamp = { value: 3, at: T0 + 9000, origin: 'pc-owner' }
    const plain = { ...raise, unconfirmedRewatch: undefined }
    const keyed = (key: string) =>
      ({
        get: (k: string) =>
          k === 'syncMeta' ? { titles: {}, rates: { [key]: { episodes: stamp } } } : undefined
      }) as never
    const run = (store: never, tracker?: TrackerId) => {
      const superseded: { malId: number; field: SyncRateField }[] = []
      overlay(
        store,
        5,
        MAL,
        { [MAL]: { episodes: plain } },
        { skipUnconfirmed: false },
        superseded,
        tracker
      )
      return superseded
    }
    expect(run(keyed(`anilist:5:${MAL}`), 'anilist')).toEqual([{ malId: MAL, field: 'episodes' }])
    expect(run(keyed(`5:${MAL}`), 'anilist')).toEqual([])
    expect(run(keyed(`5:${MAL}`))).toEqual([{ malId: MAL, field: 'episodes' }])
  })
})

describe('v6 never lists the new files (#715)', () => {
  // The v6 literals, copied from 6.0.21: the pending store's file regex, the
  // base store's party regex, and the one conflicts file it reads.
  const V6_PENDING = /^(\d{1,15})\.json$/
  const V6_PARTY = /^(library|shikimori)-[A-Za-z0-9_-]{1,128}$/
  const V6_CONFLICTS = 'conflicts.json'

  it('rejects anilist-5.json / mal-5.json, the anilist-5 / mal-5 bases, and reads no AniList record', () => {
    for (const f of ['anilist-5.json', 'mal-5.json']) expect(V6_PENDING.test(f)).toBe(false)
    expect(V6_PENDING.test('5.json')).toBe(true)
    for (const p of ['anilist-5', 'mal-5']) expect(V6_PARTY.test(p)).toBe(false)
    expect(V6_PARTY.test('shikimori-5')).toBe(true)
    expect(conflictsFileOf('anilist')).not.toBe(V6_CONFLICTS)
    expect(conflictsFileOf('mal')).not.toBe(V6_CONFLICTS)
    expect(conflictsFileOf('shikimori')).toBe(V6_CONFLICTS)
    expect(pendingFileOf({ provider: 'anilist', userId: '5' })).toBe('anilist-5.json')
    expect(pendingFileOf({ provider: 'shikimori', userId: '5' })).toBe('5.json')
  })
})
