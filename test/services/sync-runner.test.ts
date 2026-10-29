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
  vals,
  type Pc
} from '../helpers/sync-runner'

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
}) {
  server.set(MAL, o.server, T0)
  const { root, libraryId } = await makeLibrary({ doc: titleDoc({ rate: r(o.drive, T0 + 500) }) })
  const pc = makePc({
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

  it('the logout handler has no runner call (source scan)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/main/ipc/shikimori.ipc.ts'),
      'utf8'
    )
    const start = src.indexOf('CHANNELS.SHIKIMORI_LOGOUT')
    const body = src.slice(start, src.indexOf('ipcMain.handle', start + 1))
    expect(body.length).toBeGreaterThan(100)
    expect(body).not.toMatch(/syncRunner|runAll|runLibrary/)
    const login = src.slice(src.indexOf('CHANNELS.SHIKIMORI_EXCHANGE_CODE'), start)
    expect(login.indexOf("runAll('login')")).toBeGreaterThan(login.indexOf('takeParked'))
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
    expect(rec.result).toEqual(JSON.parse(JSON.stringify(res)))
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
