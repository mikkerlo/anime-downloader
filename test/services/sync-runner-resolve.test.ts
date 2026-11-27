// The review sheet's resolve (#585): choices become forward edits through the
// merge runner's own apply path, over real Shared Library trees with the real
// drain against a fake Shikimori.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/fake-shikimori')).fakeApi
}))

import { cleanup } from '../helpers/shared-library'
import { doc, rate, watch } from '../helpers/sync-merge'
import { ANILIST_MEDIA_IDS } from '../helpers/fake-tracker'
import { ANILIST_KEYS } from '../../src/main/trackers/keys'
import {
  ANILIST_5,
  ANILIST_USER,
  ANIME,
  MAL,
  OWNER,
  T0,
  cacheEntry,
  driveDoc,
  driveGeneration,
  makeLibrary,
  makePc,
  progressRow,
  refreshCache,
  server,
  vals,
  type Pc
} from '../helpers/sync-runner'
import { projectRate } from '../../src/main/lib/sync-state/project'
import { EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { expectQueueTwin, expectRateTwin, onlyTwin } from '../helpers/tracker-events'
import { writeState as realWriteState } from '../../src/main/lib/shared-library/write'
import {
  createLibrarySyncStep,
  needReviewFrom
} from '../../src/main/services/prepare-offline/steps/library-sync'

const ID = String(ANIME)
const titleDoc = (title: SyncTitleState) => doc({ [ID]: title })
type RateV = NonNullable<Parameters<typeof rate>[0]>
const r = (v: RateV, at = T0, origin = 'pc-other') => rate(v, at, origin, MAL)
const OTHER_LIB = '22222222-2222-4222-8222-222222222222'

async function seedBase(pc: Pc, libraryId: string, root: string, base: SyncDoc): Promise<void> {
  await pc.bases.write(`library-${libraryId}`, {
    stateGeneration: await driveGeneration(root),
    doc: base
  })
}

async function seedShikiBase(pc: Pc, v: RateV, at = T0): Promise<void> {
  await pc.bases.write(`shikimori-${OWNER.id}`, {
    stateGeneration: null,
    doc: titleDoc({ rate: rate(v, at, 'shikimori', MAL) })
  })
}

async function pending(pc: Pc): Promise<Record<string, Record<string, any>>> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(pc.userData, 'sync-pending', `${OWNER.id}.json`), 'utf8')
    ).rates
  } catch {
    return {}
  }
}

async function conflicts(pc: Pc): Promise<SyncConflictRecord[]> {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(pc.userData, 'sync-state', 'conflicts.json'), 'utf8')
    ).records
  } catch {
    return []
  }
}

function seedConflicts(pc: Pc, records: SyncConflictRecord[], provider = 'shikimori'): void {
  const dir = path.join(pc.userData, 'sync-state')
  fs.mkdirSync(dir, { recursive: true })
  const file = provider === 'shikimori' ? 'conflicts.json' : `conflicts-${provider}.json`
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ version: 1, records }))
}

const queue = (pc: Pc) => pc.store.get('shikimoriUpdateQueue') as any[]
const cached = (pc: Pc) =>
  (pc.store.get('shikimoriUserRates') as { rate: Record<string, any> }[]).find(
    (e) => e.rate.target_id === MAL
  )?.rate
const driveScore = async (root: string) => (await driveDoc(root))!.titles![ID].rate!.score.value
const baseOf = async (pc: Pc, party: string) => (await pc.bases.read(party))?.doc.titles[ID]
const shikiBaseScore = async (pc: Pc) =>
  (await baseOf(pc, `shikimori-${OWNER.id}`))?.rate?.score.value

async function settleDrain(pc: Pc): Promise<void> {
  await pc.sync.drainNow()
  await pc.runner.quiesce()
}

/** A library at base `b`, drive `d`, attached to an owner PC whose cache holds `cache`. */
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

/** S9's Shikimori-side fixture: this PC and the library at 8, shikimori.one at 9, base 7. */
async function shikimoriSideConflict(bridge = false) {
  const s = await ownerSetup({
    base: { score: 7 },
    drive: { score: 8 },
    server: { score: 9, episodes: 3 },
    shikiBase: { score: 7, episodes: 3 },
    cache: { score: 7, episodes: 3 },
    bridge
  })
  await s.pc.runner.runAll('manual')
  const [rec] = await conflicts(s.pc)
  expect(rec).toMatchObject({ fieldPath: 'rate.score', parties: { local: 8, shikimori: 9 } })
  return { ...s, rec }
}

const keep = (party: string): SyncConflictChoice => ({ kind: 'party', party })

/**
 * Unplugs a library. A run that wrote the drive leaves a background
 * `attached.refresh` behind, which would mark it available again if it lands
 * after this; `refresh` joins the one in flight, so awaiting it first settles it.
 */
async function unplug(pc: Pc, libraryId: string, root: string): Promise<void> {
  await pc.attached.refresh(libraryId, root)
  pc.attached.markUnavailable(libraryId, root)
  expect(pc.attached.get(libraryId)!.available).toBe(false)
}

beforeEach(() => server.reset())
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('resolve: Keep mine on a held three-party score conflict, the server moved on since', () => {
  it('queues resolvedFields: [score]; the drain writes 6 over the server 10 and keeps its episodes 5; bases advance per party; the record goes and the log has it', async () => {
    // This PC 6 (cached), the library 8, Shikimori 9, all from base 7.
    const { pc, root, libraryId } = await ownerSetup({
      base: { score: 7, episodes: 2 },
      drive: { score: 8, episodes: 2 },
      server: { score: 9, episodes: 2 },
      shikiBase: { score: 7, episodes: 2 },
      cache: { score: 6, episodes: 2 }
    })
    await pc.runner.runAll('manual')
    const [rec] = await conflicts(pc)
    expect(rec.parties).toEqual({ local: 6, [`library:${libraryId}`]: 8, shikimori: 9 })
    // shikimori.one moved on after the conflict was held: episodes and the score.
    server.set(MAL, { episodes: 5, score: 10 })
    pc.offline.value = true

    const res = await pc.runner.resolve([rec.id], { [rec.id]: keep('local') })
    expect(res).toEqual({ resolved: [rec.id], failed: [], notes: [] })

    expect(queue(pc)).toHaveLength(1)
    expect(queue(pc)[0]).toMatchObject({
      malId: MAL,
      fields: ['score'],
      resolvedFields: ['score'],
      before: { score: 9, episodes: 2 },
      after: { score: 6, episodes: 2 },
      origin: {
        kind: 'sync-merge',
        provenance: { score: { resolution: rec.id, libraryIds: [libraryId] } }
      }
    })
    expect((await pending(pc))[MAL].score).toMatchObject({
      value: 6,
      provenance: { resolution: rec.id, libraryIds: [libraryId] }
    })
    // The drive has this PC's value; the library base advanced for the score only.
    expect(await driveScore(root)).toBe(6)
    const libBase = await baseOf(pc, `library-${libraryId}`)
    expect(libBase!.rate!.score.value).toBe(6)
    expect(libBase!.rate!.episodes).toEqual(r({ score: 7, episodes: 2 }).episodes)
    // The Shikimori base waits for the drain's settle.
    expect(await shikiBaseScore(pc)).toBe(7)
    expect(await conflicts(pc)).toEqual([])
    const log = await pc.runner.syncLog.read(new Date(pc.clock.t).toISOString().slice(0, 7))
    expect(log.find((e) => e.kind === 'resolution')).toMatchObject({
      conflictId: rec.id,
      fieldPath: 'rate.score',
      choice: 'local',
      value: 6,
      wrote: { local: true, libraries: [libraryId], shikimori: 'queued' }
    })

    pc.offline.value = false
    await settleDrain(pc)
    // current.score (10) ≠ before.score (9): written anyway, and the server's episodes 5 kept.
    expect(server.get(MAL)).toMatchObject({ score: 6, episodes: 5 })
    expect(await shikiBaseScore(pc)).toBe(6)
    expect(await pending(pc)).toEqual({})
    expect(queue(pc)).toEqual([])
  })
})

describe('two PCs resolving the same conflict differently is a conflict', () => {
  async function twoPcs() {
    // The drive at 6 from base 7; PC A has 8 and PC B has 9. Offline: library legs only.
    const { root, libraryId } = await makeLibrary({
      doc: titleDoc({ rate: r({ score: 6 }, T0 + 500) })
    })
    const mk = (installId: string, score: number) => {
      const pc = makePc({
        installId,
        store: { shikimoriUserRates: [cacheEntry(MAL, ANIME, { score }, T0)] }
      })
      pc.offline.value = true
      return pc
    }
    const a = mk('pc-a', 8)
    const b = mk('pc-b', 9)
    for (const pc of [a, b]) {
      await pc.attach(root)
      await seedBase(pc, libraryId, root, titleDoc({ rate: r({ score: 7 }) }))
      await pc.runner.runAll('manual')
    }
    const [ra] = await conflicts(a)
    const [rb] = await conflicts(b)
    expect(ra.parties).toEqual({ local: 8, [`library:${libraryId}`]: 6 })
    expect(rb.parties).toEqual({ local: 9, [`library:${libraryId}`]: 6 })
    return { a, b, ra, rb, root, libraryId }
  }

  it('independent: A resolves to 8 unplugged (its base moves to the 6 it saw, not to 8), B to 9 on the drive; back on A, a new conflict 8 vs 9, nothing applied', async () => {
    const { a, b, ra, rb, root, libraryId } = await twoPcs()
    await unplug(a, libraryId, root)
    const res = await a.runner.resolve([ra.id], { [ra.id]: keep('local') })
    expect(res.notes.map((n) => n.text)).toEqual([
      expect.stringContaining("isn't connected. It gets this choice on its next sync.")
    ])
    expect((await baseOf(a, `library-${libraryId}`))!.rate!.score.value).toBe(6)
    expect(await driveScore(root)).toBe(6)

    await b.runner.resolve([rb.id], { [rb.id]: keep('local') })
    expect(await driveScore(root)).toBe(9)

    await a.attached.reopenAt(libraryId, root)
    await a.runner.runLibrary(libraryId, 'plug')
    const held = await conflicts(a)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({
      fieldPath: 'rate.score',
      parties: { local: 8, [`library:${libraryId}`]: 9 }
    })
    expect(held[0].id).not.toBe(ra.id)
    expect(await driveScore(root)).toBe(9)
    expect(projectRate(a.store as never, MAL)!.score.value).toBe(8)
  })

  it("informed control: B resolves after A's 8 reached the drive, so A's next run takes B's 9 silently", async () => {
    const { a, b, ra, root, libraryId } = await twoPcs()
    await a.runner.resolve([ra.id], { [ra.id]: keep('local') })
    expect(await driveScore(root)).toBe(8)
    expect((await baseOf(a, `library-${libraryId}`))!.rate!.score.value).toBe(8)

    await b.runner.runAll('manual')
    const [rb] = await conflicts(b)
    expect(rb.parties).toEqual({ local: 9, [`library:${libraryId}`]: 8 })
    await b.runner.resolve([rb.id], { [rb.id]: keep('local') })
    expect(await driveScore(root)).toBe(9)

    await a.runner.runAll('manual')
    expect(await conflicts(a)).toEqual([])
    expect((await pending(a))[MAL].score).toMatchObject({ value: 9, provenance: { libraryId } })
  })
})

describe('a Shikimori-side score conflict through the review sheet', () => {
  it('lists one row: the Shikimori column active, no library party (it agrees with this PC), Keep mine / Keep theirs and no Combine', async () => {
    const { pc, libraryId } = await shikimoriSideConflict()
    const [item] = await pc.runner.listConflicts()
    expect(item.parties).toEqual({ local: 8, shikimori: 9 })
    expect(item.libraries).toEqual([
      { libraryId, name: expect.any(String), involved: false, available: true }
    ])
    expect(item.options).toEqual([
      { choice: keep('local'), value: 8 },
      { choice: keep('shikimori'), value: 9 }
    ])
    expect(item.rewatchQuestion).toBe(false)
  })

  it('Keep theirs (Shikimori): 9 here and on the drive, nothing queued, the Shikimori base at once, and the pending 8 cleared and stripped from a queued merge entry', async () => {
    const { pc, root, libraryId, rec } = await shikimoriSideConflict()
    const p = (await pending(pc))[MAL].score
    expect(p).toMatchObject({ value: 8, provenance: { libraryId } })
    // A merge entry still carrying the library's 8 (a leg queued it, the drain hasn't sent it).
    pc.store.set('shikimoriUpdateQueue', [
      {
        malId: MAL,
        rateId: MAL * 10,
        before: vals({ score: 7, episodes: 3 }),
        after: vals({ score: 8, episodes: 4 }),
        queuedAt: 5,
        fields: ['score', 'episodes'],
        origin: {
          kind: 'sync-merge',
          provenance: { score: { libraryId }, episodes: { libraryId } }
        }
      }
    ])
    pc.offline.value = true
    await pc.runner.resolve([rec.id], { [rec.id]: keep('shikimori') })

    expect(await pending(pc)).toEqual({})
    expect(cached(pc)!.score).toBe(9)
    expect(queue(pc)).toEqual([
      expect.objectContaining({
        fields: ['episodes'],
        after: vals({ score: 7, episodes: 4 }),
        origin: { kind: 'sync-merge', provenance: { episodes: { libraryId } } }
      })
    ])
    expect(await driveScore(root)).toBe(9)
    expect((await baseOf(pc, `library-${libraryId}`))!.rate!.score.value).toBe(9)
    expect(await shikiBaseScore(pc)).toBe(9)
    expect(await pc.runner.listConflicts()).toEqual([])

    // The next Shikimori leg pushes no score, and a wholesale refresh still reads 9.
    pc.store.set('shikimoriUpdateQueue', [])
    pc.offline.value = false
    await pc.runner.runAll('manual')
    await settleDrain(pc)
    expect(server.get(MAL)!.score).toBe(9)
    refreshCache(pc.store)
    expect(projectRate(pc.store as never, MAL)!.score.value).toBe(9)
    await pc.runner.runAll('manual')
    expect(await driveScore(root)).toBe(9)
    expect(server.get(MAL)!.score).toBe(9)
  })

  it('Keep mine: resolvedFields [score], the pending 8 with resolution provenance until the settle lists score, and the drain writes 8 over 9', async () => {
    const { pc, libraryId, rec } = await shikimoriSideConflict()
    const settled: unknown[] = []
    pc.sync.onItemSettled((e) => settled.push(e))
    pc.offline.value = true
    await pc.runner.resolve([rec.id], { [rec.id]: keep('local') })
    expect(queue(pc)).toEqual([
      expect.objectContaining({ fields: ['score'], resolvedFields: ['score'] })
    ])
    expect((await pending(pc))[MAL].score).toMatchObject({
      value: 8,
      provenance: { resolution: rec.id, libraryIds: [libraryId] }
    })
    expect(await shikiBaseScore(pc)).toBe(7)
    pc.offline.value = false
    await settleDrain(pc)
    expect(settled[0]).toMatchObject({ fieldsApplied: ['score'] })
    expect(server.get(MAL)!.score).toBe(8)
    expect(await pending(pc)).toEqual({})
    expect(await shikiBaseScore(pc)).toBe(8)
    expect(await pc.runner.listConflicts()).toEqual([])
  })

  it('Keep theirs (Shikimori) rebases a later via survivor: a copy queued over the library 8 still lands its 10 (#692 review)', async () => {
    const { pc, libraryId, rec } = await shikimoriSideConflict()
    // The leg's entry (its `before` is the server's 9 / 3 at the leg), then a
    // "Copy from primary" built on its projection: score 8 is the library's.
    const merge = {
      malId: MAL,
      rateId: MAL * 10,
      before: vals({ score: 9, episodes: 3 }),
      after: vals({ score: 8, episodes: 4 }),
      queuedAt: 5,
      fields: ['score', 'episodes'],
      origin: { kind: 'sync-merge', provenance: { score: { libraryId }, episodes: { libraryId } } }
    }
    const copy = {
      malId: MAL,
      rateId: MAL * 10,
      before: vals({ score: 8, episodes: 4 }),
      after: vals({ score: 10, episodes: 4 }),
      queuedAt: 6,
      fields: ['score'],
      via: 'copy'
    }
    pc.store.set('shikimoriUpdateQueue', [merge, copy])
    pc.offline.value = true

    await pc.runner.resolve([rec.id], { [rec.id]: keep('shikimori') })

    expect(queue(pc)).toHaveLength(2)
    expect(queue(pc)[1]).toMatchObject({
      via: 'copy',
      before: vals({ score: 9, episodes: 4 }),
      after: vals({ score: 10, episodes: 4 })
    })
    pc.offline.value = false
    await settleDrain(pc)
    expect(server.get(MAL)).toMatchObject({ score: 10, episodes: 4 })
    expect(queue(pc)).toEqual([])
  })

  it('the merge pin (#692 § 5): the resolution entry is exactly its eight keys, with no clock, no prompt and no enqueue patch', async () => {
    const { pc, libraryId, rec } = await shikimoriSideConflict()
    pc.offline.value = true
    const meta = structuredClone(pc.store.get('syncMeta'))
    const row = structuredClone(cached(pc))
    pc.broadcast.mockClear()

    await pc.runner.resolve([rec.id], { [rec.id]: keep('local') })

    expect(queue(pc)).toHaveLength(1)
    const entry = queue(pc)[0]
    expect(Object.keys(entry)).toEqual([
      'malId',
      'rateId',
      'before',
      'after',
      'queuedAt',
      'fields',
      'resolvedFields',
      'origin'
    ])
    expect(entry).toEqual({
      malId: MAL,
      rateId: MAL * 10,
      before: vals({ score: 9, episodes: 3 }),
      after: vals({ score: 8, episodes: 3 }),
      queuedAt: pc.clock.t,
      fields: ['score'],
      resolvedFields: ['score'],
      origin: {
        kind: 'sync-merge',
        provenance: { score: { resolution: rec.id, libraryIds: [libraryId] } }
      }
    })
    expect(pc.store.get('syncMeta')).toEqual(meta)
    expect(pc.broadcast.mock.calls.map(([c]) => c)).not.toContain('cleanup:prompt')
    // Only the resolution's own display patch (`patchCache`, the runner clock);
    // a fan-out enqueue patch would move `updated_at` to the wall clock.
    expect(cached(pc)).toEqual({
      ...row,
      score: 8,
      updated_at: new Date(pc.clock.t).toISOString()
    })
  })

  it('Forget in between drops the unpushed choice for a party library, counted under resolutions; a non-party library leaves it', async () => {
    const { pc, libraryId, rec } = await shikimoriSideConflict()
    const other = await makeLibrary({ libraryId: OTHER_LIB, titles: [102], doc: doc({}) })
    await pc.attach(other.root)
    pc.offline.value = true
    await pc.runner.resolve([rec.id], { [rec.id]: keep('local') })
    expect(cached(pc)!.score).toBe(8)

    expect(await pc.attached.forget(OTHER_LIB)).toEqual({ needsConfirm: false })
    expect((await pending(pc))[MAL].score.value).toBe(8)
    expect(queue(pc)).toHaveLength(1)

    const asked = await pc.attached.forget(libraryId)
    expect(asked).toMatchObject({ needsConfirm: true, pendingCount: { resolutions: 1 } })
    await pc.attached.forget(libraryId, { confirmDropPending: true })
    expect(await pending(pc)).toEqual({})
    expect(queue(pc)).toEqual([])
    // The cache goes back to the newer server value the conflict showed.
    expect(cached(pc)!.score).toBe(9)
  })
})

describe('Combine, and the rewatch question (owner decision 6)', () => {
  it('Combine on episodes takes the max; no Combine for score', async () => {
    const { pc, root } = await ownerSetup({
      base: { episodes: 4 },
      drive: { episodes: 3 },
      server: { episodes: 6 },
      cache: { episodes: 6 }
    })
    pc.offline.value = true
    await pc.runner.runAll('manual')
    const [item] = await pc.runner.listConflicts()
    expect(item.fieldPath).toBe('rate.episodes')
    expect(item.options.map((o) => o.choice)).toContainEqual({ kind: 'combine' })
    expect(item.options.find((o) => o.choice.kind === 'combine')!.value).toBe(6)
    await pc.runner.resolve([item.id], { [item.id]: { kind: 'combine' } })
    expect((await driveDoc(root))!.titles![ID].rate!.episodes.value).toBe(6)

    const score = await shikimoriSideConflict()
    const [s] = await score.pc.runner.listConflicts()
    expect(s.options.some((o) => o.choice.kind === 'combine')).toBe(false)
    const refused = await score.pc.runner.resolve([s.id], { [s.id]: { kind: 'combine' } })
    expect(refused.resolved).toEqual([])
    expect(await conflicts(score.pc)).toHaveLength(1)
  })

  for (const [count, value] of [
    [1, 3],
    [2, 4]
  ] as const) {
    it(`2 → 3 on both sides asks one rewatch or two, with no suggestion; ${count === 1 ? 'One' : 'Two'} applies ${value}`, async () => {
      const { pc, root } = await ownerSetup({
        base: { status: 'completed', rewatches: 2 },
        drive: { status: 'completed', rewatches: 3 },
        server: { status: 'completed', rewatches: 3 },
        cache: { status: 'completed', rewatches: 3 }
      })
      pc.offline.value = true
      await pc.runner.runAll('manual')
      const [item] = await pc.runner.listConflicts()
      expect(item).toMatchObject({ fieldPath: 'rate.rewatches', rewatchQuestion: true })
      expect(item.suggestion).toBeNull()
      expect(item.options).toEqual([
        { choice: { kind: 'rewatches', count: 1 }, value: 3 },
        { choice: { kind: 'rewatches', count: 2 }, value: 4 }
      ])
      await pc.runner.resolve([item.id], { [item.id]: { kind: 'rewatches', count } })
      expect((await driveDoc(root))!.titles![ID].rate!.rewatches.value).toBe(value)
      expect((await pending(pc))[MAL]?.rewatches?.value ?? cached(pc)!.rewatches).toBe(value)
    })
  }
})

describe('a claim unlocks a rate conflict only for its owner (#714, #715)', () => {
  // The claim library holds the title but isn't a party: only `conflictLibraries`'
  // owner clause brings it in.
  const scoped = (ownerScope: number | string): SyncConflictRecord => ({
    id: 'c-scope',
    ownerScope,
    animeId: ID,
    fieldPath: 'rate.score',
    parties: { local: 7, [`library:${OTHER_LIB}`]: 8 },
    bases: { [`library:${OTHER_LIB}`]: 6 },
    at: {},
    suggestion: null,
    reason: 'changed on both sides, to different values',
    firstSeenRunId: 'r1',
    lastSeenRunId: 'r1'
  })
  const SIGN_IN = { id: 'c-scope', reason: "Sign in as the library's owner to resolve this." }

  /** A no-account PC claiming a library owned by AniList user `OWNER.id`. */
  async function anilistClaim() {
    const tracker = { provider: 'anilist', userId: String(OWNER.id) }
    const lib = await makeLibrary({ tracker, doc: titleDoc({ rate: r({ score: 8 }, T0 + 77) }) })
    const pc = makePc({ user: null, installId: 'pc-claim' })
    await pc.attach(lib.root, { claim: true })
    expect(pc.attached.get(lib.libraryId)).toMatchObject({ role: 'claim', layoutVersion: 2 })
    return { pc, ...lib }
  }

  it('a v2 claim of AniList user N unlocks a conflicts-anilist.json record with ownerScope "N": the drive gets the choice', async () => {
    const { pc, root } = await anilistClaim()
    seedConflicts(pc, [scoped(String(OWNER.id))], 'anilist')
    const res = await pc.runner.resolve(['c-scope'], { 'c-scope': keep('local') })
    expect(res.failed).toEqual([])
    expect(res.resolved).toEqual(['c-scope'])
    expect(await driveScore(root)).toBe(7)
    expect(pc.store.get('shikimoriUpdateQueue')).toEqual([])
  })

  it('the same claim does not unlock a conflicts.json record with ownerScope N: another provider is another owner', async () => {
    const { pc, root } = await anilistClaim()
    seedConflicts(pc, [scoped(OWNER.id)])
    const res = await pc.runner.resolve(['c-scope'], { 'c-scope': keep('local') })
    expect(res.failed).toEqual([SIGN_IN])
    expect(await driveScore(root)).toBe(8)
  })

  it('a v1 claim library of another owner holding the title does not unlock it either', async () => {
    const { root, libraryId } = await makeLibrary({
      ownerId: 777,
      doc: titleDoc({ rate: r({ score: 8 }, T0 + 77) })
    })
    const pc = makePc({ user: null, installId: 'pc-claim' })
    await pc.attach(root, { claim: true })
    expect(pc.attached.get(libraryId)?.role).toBe('claim')
    seedConflicts(pc, [scoped(OWNER.id)])
    const res = await pc.runner.resolve(['c-scope'], { 'c-scope': keep('local') })
    expect(res.failed).toEqual([SIGN_IN])
    expect(await driveScore(root)).toBe(8)
  })
})

describe('a claim PC', () => {
  it('resolving writes the drive and its base and queues nothing for Shikimori', async () => {
    const libRate = r({ score: 8 }, T0 + 77)
    const { root, libraryId } = await makeLibrary({ doc: titleDoc({ rate: libRate }) })
    const pc = makePc({ user: null, installId: 'pc-claim' })
    await pc.attach(root, { claim: true })
    await seedBase(pc, libraryId, root, titleDoc({ rate: r({ score: 6 }) }))
    // A rate conflict a claim PC holds (as a rejected owner edit or an older replica would leave).
    seedConflicts(pc, [
      {
        id: 'c-claim',
        ownerScope: OWNER.id,
        animeId: ID,
        fieldPath: 'rate.score',
        parties: { local: 7, [`library:${libraryId}`]: 8 },
        bases: { [`library:${libraryId}`]: 6 },
        at: {},
        suggestion: null,
        reason: 'changed on both sides, to different values',
        firstSeenRunId: 'r1',
        lastSeenRunId: 'r1'
      }
    ])
    const res = await pc.runner.resolve(['c-claim'], { 'c-claim': keep('local') })
    expect(res.resolved).toEqual(['c-claim'])
    expect(await driveScore(root)).toBe(7)
    expect((await baseOf(pc, `library-${libraryId}`))!.rate!.score.value).toBe(7)
    expect(queue(pc)).toEqual([])
    expect(fs.existsSync(path.join(pc.userData, 'sync-pending'))).toBe(false)
  })

  it('a library with nothing to put the choice on (no rate on the drive, here or in its base) is left as it is, and the note says so', async () => {
    const { root, libraryId } = await makeLibrary({
      doc: titleDoc({ watch: { '1': watch(true, T0, 0, 'pc-other') } })
    })
    const pc = makePc({ user: null, installId: 'pc-claim' })
    await pc.attach(root, { claim: true })
    await seedBase(
      pc,
      libraryId,
      root,
      titleDoc({ watch: { '1': watch(true, T0, 0, 'pc-other') } })
    )
    seedConflicts(pc, [
      {
        id: 'c-bare',
        ownerScope: OWNER.id,
        animeId: ID,
        fieldPath: 'rate.score',
        parties: { local: 7, [`library:${libraryId}`]: 8 },
        bases: { [`library:${libraryId}`]: 6 },
        at: {},
        suggestion: null,
        reason: 'changed on both sides, to different values',
        firstSeenRunId: 'r1',
        lastSeenRunId: 'r1'
      }
    ])
    const gen = await driveGeneration(root)
    const res = await pc.runner.resolve(['c-bare'], { 'c-bare': keep('local') })
    expect(res.resolved).toEqual(['c-bare'])
    expect(res.notes).toEqual([
      {
        id: 'c-bare',
        text: `${pc.attached.get(libraryId)!.name} has no entry for this field yet, so the choice wasn't written there.`
      }
    ])
    expect(await driveGeneration(root)).toBe(gen)
    expect((await driveDoc(root))!.titles![ID].rate).toBeUndefined()
    expect(queue(pc)).toEqual([])
  })

  it('a watched conflict (unwatched here, re-watched on the drive): Combine keeps the re-watch here and on the drive', async () => {
    const { root, libraryId } = await makeLibrary({
      doc: titleDoc({ watch: { '1': watch(true, T0 + 200, 0, 'pc-other') } })
    })
    const pc = makePc({
      user: null,
      installId: 'pc-claim',
      store: { watchProgress: { [`${ID}:1`]: progressRow(false, T0 + 100) } }
    })
    await pc.attach(root, { claim: true })
    await seedBase(pc, libraryId, root, titleDoc({ watch: { '1': watch(true, T0, 0, 'pc-x') } }))
    await pc.runner.runAll('manual')
    const [item] = await pc.runner.listConflicts()
    expect(item.fieldPath).toBe('watch.1.watched')
    await pc.runner.resolve([item.id], { [item.id]: { kind: 'combine' } })
    expect((pc.store.get('watchProgress') as any)[`${ID}:1`].watched).toBe(true)
    expect((await driveDoc(root))!.titles![ID].watch!['1'].watched.value).toBe(true)
    expect(queue(pc)).toEqual([])
    await pc.runner.runAll('manual')
    expect(await conflicts(pc)).toEqual([])
  })
})

describe('a party library that cannot be written at resolve time (review of #637)', () => {
  // The drive at 6 from base 7, this PC at 8: a library-party conflict. Keep mine.
  async function partySetup(opts: { failWrites?: { left: number } } = {}) {
    const { root, libraryId } = await makeLibrary({
      doc: titleDoc({ rate: r({ score: 6 }, T0 + 500) })
    })
    const writeState: typeof realWriteState = async (...args) => {
      if (opts.failWrites && opts.failWrites.left-- > 0) {
        throw Object.assign(new Error('I/O error'), { code: 'EIO' })
      }
      return realWriteState(...args)
    }
    const pc = makePc({
      store: { shikimoriUserRates: [cacheEntry(MAL, ANIME, { score: 8 }, T0)] },
      runner: { writeState }
    })
    pc.offline.value = true
    await pc.attach(root)
    await seedBase(pc, libraryId, root, titleDoc({ rate: r({ score: 7 }) }))
    await pc.runner.runAll('manual')
    const [rec] = await conflicts(pc)
    expect(rec.parties).toEqual({ local: 8, [`library:${libraryId}`]: 6 })
    return { pc, root, libraryId, rec }
  }

  async function expectWrittenSilentlyNextRun(pc: Pc, root: string, libraryId: string) {
    // Its base moved to the 6 the conflict showed, not to the choice.
    expect((await baseOf(pc, `library-${libraryId}`))!.rate!.score.value).toBe(6)
    expect(await driveScore(root)).toBe(6)
    const run = await pc.runner.runLibrary(libraryId, 'plug')
    expect(run.libraries[0]).toMatchObject({ drive: 'ok', counts: { conflicts: 0 } })
    expect(await conflicts(pc)).toEqual([])
    expect(await driveScore(root)).toBe(8)
    expect((await baseOf(pc, `library-${libraryId}`))!.rate!.score.value).toBe(8)
  }

  it('unplugged: the note holds, and after the plug the drive gets the choice with no second conflict', async () => {
    const { pc, root, libraryId, rec } = await partySetup()
    await unplug(pc, libraryId, root)
    const res = await pc.runner.resolve([rec.id], { [rec.id]: keep('local') })
    expect(res.notes.map((n) => n.text)).toEqual([
      expect.stringContaining("isn't connected. It gets this choice on its next sync.")
    ])
    await pc.attached.reopenAt(libraryId, root)
    await expectWrittenSilentlyNextRun(pc, root, libraryId)
  })

  it('unreadable at resolve time (the folder is gone while it still shows connected): the same', async () => {
    const { pc, root, libraryId, rec } = await partySetup()
    const away = `${root}-away`
    fs.renameSync(root, away)
    const res = await pc.runner.resolve([rec.id], { [rec.id]: keep('local') })
    expect(res.notes.map((n) => n.text)).toEqual([expect.stringContaining("couldn't be read")])
    fs.renameSync(away, root)
    await expectWrittenSilentlyNextRun(pc, root, libraryId)
  })

  it('the write fails at resolve time: the same', async () => {
    const failWrites = { left: 0 }
    const { pc, root, libraryId, rec } = await partySetup({ failWrites })
    failWrites.left = 1
    const res = await pc.runner.resolve([rec.id], { [rec.id]: keep('local') })
    expect(res.notes.map((n) => n.text)).toEqual([expect.stringContaining("couldn't be written")])
    await expectWrittenSilentlyNextRun(pc, root, libraryId)
  })
})

describe("Prepare for offline's sync line when conflicts.json can't be read (review of #637)", () => {
  it("keeps the run's own count: never 'Drive synced' / ok for a run that held a conflict", async () => {
    const { root, libraryId } = await makeLibrary({
      doc: titleDoc({ rate: r({ score: 6 }, T0 + 500) })
    })
    const pc = makePc({ store: { shikimoriUserRates: [cacheEntry(MAL, ANIME, { score: 8 }, T0)] } })
    pc.offline.value = true
    await pc.attach(root)
    await seedBase(pc, libraryId, root, titleDoc({ rate: r({ score: 7 }) }))
    const file = path.join(pc.userData, 'sync-state', 'conflicts.json')
    const step = createLibrarySyncStep({
      list: () => pc.attached.list(),
      runAll: async (trigger) => {
        const result = await pc.runner.runAll(trigger)
        // Unreadable after the run held its conflict.
        fs.writeFileSync(file, '{ not json')
        return result
      },
      needReview: needReviewFrom(pc.runner)
    })
    const out = await step.run({
      signal: new AbortController().signal,
      progress: () => {},
      isOffline: () => true
    })
    const name = pc.attached.get(libraryId)!.name
    expect(out.status).toBe('warning')
    expect(out.details[0]).toEqual({
      text: `${name}: Drive synced, 1 need review; Shikimori push waits until online`,
      status: 'warning'
    })
    // The review sheet's list itself still reads as empty, as before.
    expect(await pc.runner.listConflicts()).toEqual([])
    await expect(pc.runner.listConflicts({ strict: true })).rejects.toThrow()
  })
})

describe('the library is unavailable at resolve time', () => {
  it('the local value changes, the drive is not written and its base not advanced; the next run after the plug writes it', async () => {
    const { pc, root, libraryId, rec } = await shikimoriSideConflict()
    pc.offline.value = true
    await unplug(pc, libraryId, root)
    const gen = await driveGeneration(root)
    const res = await pc.runner.resolve([rec.id], { [rec.id]: keep('shikimori') })
    expect(res.notes).toHaveLength(1)
    expect(cached(pc)!.score).toBe(9)
    expect(await driveGeneration(root)).toBe(gen)
    expect(await driveScore(root)).toBe(8)
    expect((await baseOf(pc, `library-${libraryId}`))!.rate!.score.value).toBe(8)

    await pc.attached.reopenAt(libraryId, root)
    await pc.runner.runLibrary(libraryId, 'plug')
    expect(await driveScore(root)).toBe(9)
    expect(await conflicts(pc)).toEqual([])
  })
})

describe('a title out of the library scope since the conflict was held', () => {
  it('is resolved here and for Shikimori only, says so, and keeps the library base entry', async () => {
    const { root, libraryId } = await makeLibrary({ titles: [102], doc: doc({}) })
    server.set(MAL, { score: 9 }, T0)
    const pc = makePc({ store: { shikimoriUserRates: [cacheEntry(MAL, ANIME, { score: 7 }, T0)] } })
    pc.offline.value = true
    await pc.attach(root)
    const kept = titleDoc({ rate: r({ score: 6 }) })
    await seedBase(pc, libraryId, root, kept)
    seedConflicts(pc, [
      {
        id: 'c-scope',
        ownerScope: OWNER.id,
        animeId: ID,
        fieldPath: 'rate.score',
        parties: { local: 7, [`library:${libraryId}`]: 8 },
        bases: { [`library:${libraryId}`]: 6 },
        at: {},
        suggestion: null,
        reason: 'changed on both sides, to different values',
        firstSeenRunId: 'r1',
        lastSeenRunId: 'r1'
      }
    ])
    const gen = await driveGeneration(root)
    const res = await pc.runner.resolve(['c-scope'], { 'c-scope': keep(`library:${libraryId}`) })
    expect(res.notes.map((n) => n.text)).toEqual([
      expect.stringContaining('no longer has this title')
    ])
    expect(cached(pc)!.score).toBe(8)
    expect(queue(pc)[0]).toMatchObject({ resolvedFields: ['score'], after: { score: 8 } })
    expect(await driveGeneration(root)).toBe(gen)
    expect((await pc.bases.read(`library-${libraryId}`))!.doc).toEqual(kept)
  })
})

describe('the history records the values', () => {
  it('a run logs each silent change with its values, and a history page shows them', async () => {
    const { pc, libraryId } = await ownerSetup({
      base: { score: 6 },
      drive: { score: 8 },
      server: { score: 6 },
      shikiBase: { score: 6 }
    })
    pc.store.set('library', {
      [ID]: { id: ANIME, title: 'Frieren', titles: {}, posterUrlSmall: '', numberOfEpisodes: 28 }
    })
    pc.offline.value = true
    await pc.runner.runAll('manual')
    const page = await pc.runner.listHistory({})
    expect(page.entries[0]).toMatchObject({
      kind: 'run',
      trigger: 'manual',
      libraries: [{ libraryId, name: expect.any(String) }]
    })
    const name = pc.attached.get(libraryId)!.name
    expect(page.entries[0].details).toContain(`Frieren: score ★ 6 → ★ 8 from ${name}`)
  })
})

// The double-emit table (#694), the runner's resolution rows. With `index.ts`'s
// wiring (`makePc({ bridge })`) each emit goes through the Shikimori bridge.
describe('the resolution double-emits through the Shikimori bridge (#694)', () => {
  it('Keep mine: the display patch and the queued resolution, each followed by its twin', async () => {
    const { pc, rec } = await shikimoriSideConflict(true)
    pc.offline.value = true
    pc.broadcast.mockClear()

    await pc.runner.resolve([rec.id], { [rec.id]: keep('local') })

    const calls = pc.broadcast.mock.calls
    const patch = onlyTwin(calls, EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED)
    expect((patch.legacy as any).rate).toMatchObject({ target_id: MAL, score: 8 })
    expectRateTwin(patch)
    const changed = onlyTwin(calls, EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED)
    expect(changed.legacy).toEqual({ length: 1 })
    expectQueueTwin(changed, { [MAL]: vals({ score: 8, episodes: 3 }) })
  })

  it("stripQueued (Keep theirs over a queued merge entry): the sync instance's queue change and its twin", async () => {
    const { pc, rec, libraryId } = await shikimoriSideConflict(true)
    pc.store.set('shikimoriUpdateQueue', [
      {
        malId: MAL,
        rateId: MAL * 10,
        before: vals({ score: 7, episodes: 3 }),
        after: vals({ score: 8, episodes: 4 }),
        queuedAt: 5,
        fields: ['score', 'episodes'],
        origin: {
          kind: 'sync-merge',
          provenance: { score: { libraryId }, episodes: { libraryId } }
        }
      }
    ])
    pc.offline.value = true
    pc.broadcast.mockClear()

    await pc.runner.resolve([rec.id], { [rec.id]: keep('shikimori') })

    const calls = pc.broadcast.mock.calls
    expectRateTwin(onlyTwin(calls, EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED))
    const changed = onlyTwin(calls, EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED)
    expect(changed.legacy).toEqual({ length: 1 })
    expectQueueTwin(changed, { [MAL]: vals({ score: 7, episodes: 4 }) })
  })
})

// --- resolve per owner tracker (#715) ----------------------------------------------------------

/** One non-Shikimori owner tracker: AniList here; #717 (T14) adds MyAnimeList's row. */
const RESOLVE_CASES = [
  {
    id: 'anilist' as const,
    label: 'AniList',
    user: ANILIST_USER,
    owner: ANILIST_5,
    keys: ANILIST_KEYS,
    pc: (opts: Parameters<typeof makePc>[0] = {}) =>
      makePc({ ...opts, anilist: { user: ANILIST_USER } })
  }
]

describe.each(RESOLVE_CASES)('resolve on an $label-owned library (#715)', (tc) => {
  const party = `${tc.id}-${tc.user.id}`
  const trackerQueue = (pc: Pc) => (pc.store.get(tc.keys.updateQueue) ?? []) as any[]
  const pendingPath = (pc: Pc) =>
    path.join(pc.userData, 'sync-pending', `${tc.id}-${tc.user.id}.json`)
  const trackerRecords = (pc: Pc): SyncConflictRecord[] => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(pc.userData, 'sync-state', `conflicts-${tc.id}.json`), 'utf8')
      ).records
    } catch {
      return []
    }
  }

  /** This PC and the library at 8, the tracker at 9, base 7: one held tracker-side conflict. */
  async function trackerSideConflict(opts: { user?: typeof OWNER } = {}) {
    const lib = await makeLibrary({
      tracker: tc.owner,
      doc: titleDoc({ rate: r({ score: 8 }, T0 + 500) })
    })
    const pc = tc.pc({
      ...(opts.user ? { user: opts.user } : {}),
      store: {
        [tc.keys.userRates]: [
          {
            malId: MAL,
            remoteId: ANILIST_MEDIA_IDS[MAL] * 10,
            values: vals({ score: 7, episodes: 3 }),
            updatedAt: T0,
            smotretAnime: { id: ANIME }
          }
        ]
      }
    })
    pc.anilist!.fake.set(MAL, { score: 9, episodes: 3 }, { at: T0 })
    await pc.attach(lib.root)
    await seedBase(pc, lib.libraryId, lib.root, titleDoc({ rate: r({ score: 7 }) }))
    await pc.bases.write(party, {
      stateGeneration: null,
      doc: titleDoc({ rate: rate({ score: 7, episodes: 3 }, T0, tc.id, MAL) })
    })
    await pc.runner.runAll('manual')
    const [rec] = trackerRecords(pc)
    expect(rec).toMatchObject({
      ownerScope: String(tc.user.id),
      fieldPath: 'rate.score',
      parties: { local: 8, [tc.id]: 9 }
    })
    return { pc, rec, ...lib }
  }

  it('lists the row with the tracker as its fourth party', async () => {
    const { pc, libraryId } = await trackerSideConflict()
    const [item] = await pc.runner.listConflicts()
    expect(item).toMatchObject({ tracker: tc.id, parties: { local: 8, [tc.id]: 9 } })
    expect(item.libraries.map((l) => l.libraryId)).toEqual([libraryId])
    expect(item.options).toEqual([
      { choice: keep('local'), value: 8 },
      { choice: keep(tc.id), value: 9 }
    ])
  })

  it('Keep mine queues exactly one resolvedFields entry to its queue, and kicks its drain, not Shikimori’s', async () => {
    const { pc, rec } = await trackerSideConflict()
    const sync = pc.anilist!.sync
    const kicked = vi.spyOn(sync, 'syncQueue').mockResolvedValue(undefined)
    const shiki = vi.spyOn(pc.sync, 'syncShikimoriQueue').mockResolvedValue(undefined)
    const shikiTimer = vi.spyOn(pc.sync, 'startSyncTimer')
    const res = await pc.runner.resolve([rec.id], { [rec.id]: keep('local') })
    expect(res.resolved).toEqual([rec.id])
    const q = trackerQueue(pc)
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({
      malId: MAL,
      fields: ['score'],
      resolvedFields: ['score'],
      after: expect.objectContaining({ score: 8 }),
      origin: { kind: 'sync-merge', provenance: { score: { resolution: rec.id } } }
    })
    expect(queue(pc)).toEqual([])
    expect(kicked).toHaveBeenCalledTimes(1)
    expect(shiki).not.toHaveBeenCalled()
    expect(shikiTimer).not.toHaveBeenCalled()
    const log = await pc.runner.syncLog.read(new Date(pc.clock.t).toISOString().slice(0, 7))
    expect(log.find((e) => e.kind === 'resolution')).toMatchObject({
      wrote: { shikimori: 'none', tracker: { id: tc.id, status: 'queued' } }
    })
    expect(trackerRecords(pc)).toEqual([])
  })

  it(`Keep theirs (the tracker), which already has it: nothing queued, its queue stripped and base advanced with its origin; Shikimori's untouched`, async () => {
    const { pc, rec, libraryId, root } = await trackerSideConflict()
    const merge = (queuedAt: number) => ({
      malId: MAL,
      rateId: 1,
      before: vals({ score: 7, episodes: 3 }),
      after: vals({ score: 8, episodes: 4 }),
      queuedAt,
      fields: ['score', 'episodes'],
      origin: {
        kind: 'sync-merge',
        provenance: { score: { libraryId }, episodes: { libraryId } }
      }
    })
    pc.store.set(tc.keys.updateQueue, [merge(5)])
    // A colliding Shikimori owner's base and queue entry for the same field.
    pc.store.set('shikimoriUpdateQueue', [merge(6)])
    await pc.bases.write(`shikimori-${tc.user.id}`, {
      stateGeneration: null,
      doc: titleDoc({ rate: rate({ score: 3 }, T0, 'shikimori', MAL) })
    })
    const shikiFile = path.join(pc.userData, 'sync-bases', `shikimori-${tc.user.id}.json`)
    const shikiBytes = fs.readFileSync(shikiFile, 'utf8')
    const shikiQueue = JSON.stringify(pc.store.get('shikimoriUpdateQueue'))
    pc.offline.value = true
    const res = await pc.runner.resolve([rec.id], { [rec.id]: keep(tc.id) })
    expect(res.resolved).toEqual([rec.id])
    expect(fs.existsSync(pendingPath(pc))).toBe(false)
    expect(trackerQueue(pc)).toEqual([
      expect.objectContaining({
        queuedAt: 5,
        fields: ['episodes'],
        origin: { kind: 'sync-merge', provenance: { episodes: { libraryId } } }
      })
    ])
    expect((await pc.bases.read(party))!.doc.titles[ID].rate!.score).toMatchObject({
      value: 9,
      origin: tc.id
    })
    expect(await driveScore(root)).toBe(9)
    expect(fs.readFileSync(shikiFile, 'utf8')).toBe(shikiBytes)
    expect(JSON.stringify(pc.store.get('shikimoriUpdateQueue'))).toBe(shikiQueue)
    const log = await pc.runner.syncLog.read(new Date(pc.clock.t).toISOString().slice(0, 7))
    expect(log.find((e) => e.kind === 'resolution')).toMatchObject({
      choice: tc.id,
      wrote: { shikimori: 'none', tracker: { id: tc.id, status: 'already' } }
    })
  })

  it('colliding ids: a Shikimori 5 record next to it stays, and resolving the tracker’s leaves the Shikimori base alone', async () => {
    const SHIKI_5 = { ...OWNER, id: tc.user.id }
    const { pc, rec } = await trackerSideConflict({ user: SHIKI_5 })
    const shikiRecord: SyncConflictRecord = { ...rec, id: 'c-shiki', ownerScope: tc.user.id }
    shikiRecord.parties = { local: 8, shikimori: 4 }
    seedConflicts(pc, [shikiRecord])
    await pc.bases.write(`shikimori-${tc.user.id}`, {
      stateGeneration: null,
      doc: titleDoc({ rate: rate({ score: 4 }, T0, 'shikimori', MAL) })
    })
    const shikiFile = path.join(pc.userData, 'sync-bases', `shikimori-${tc.user.id}.json`)
    const before = fs.readFileSync(shikiFile, 'utf8')
    pc.offline.value = true
    expect((await pc.runner.listConflicts()).map((i) => i.id).sort()).toEqual(
      ['c-shiki', rec.id].sort()
    )
    await pc.runner.resolve([rec.id], { [rec.id]: keep(tc.id) })
    expect(trackerRecords(pc)).toEqual([])
    expect(await conflicts(pc)).toEqual([shikiRecord])
    expect(fs.readFileSync(shikiFile, 'utf8')).toBe(before)
    expect((await pc.bases.read(party))!.doc.titles[ID].rate!.score.value).toBe(9)
  })
})

describe('conflictLibraries filters to the record’s owner (#715)', () => {
  const watchRecord = (id: string, ownerScope: number | string, partyLib: string) =>
    ({
      id,
      ownerScope,
      animeId: ID,
      fieldPath: 'watch.1.watched',
      parties: { local: false, [`library:${partyLib}`]: true },
      bases: { [`library:${partyLib}`]: false },
      at: {},
      suggestion: null,
      reason: 'changed on both sides, to different values',
      firstSeenRunId: 'r1',
      lastSeenRunId: 'r1'
    }) as SyncConflictRecord
  const unwatched = () => titleDoc({ watch: { '1': watch(false, T0, 0, 'pc-x') } })
  const filesOf = (pc: Pc, root: string, libraryId: string) => [
    fs.readFileSync(path.join(root, '.anime-dl', 'state.json'), 'utf8'),
    fs.readFileSync(path.join(pc.userData, 'sync-bases', `library-${libraryId}.json`), 'utf8')
  ]

  it.each([
    ['Shikimori 5 and Shikimori 7', { ownerId: 7 }],
    ['Shikimori 5 and AniList 5', { tracker: ANILIST_5 }]
  ] as const)(
    '%s: the sheet lists only the record owner’s libraries, and resolve leaves the other’s alone',
    async (_l, other) => {
      const OTHER_LIB_ID = '44444444-4444-4444-8444-444444444444'
      const mine = await makeLibrary({ ownerId: 5, doc: unwatched() })
      const theirs = await makeLibrary({ libraryId: OTHER_LIB_ID, ...other, doc: unwatched() })
      const pc = makePc({ user: null, installId: 'pc-claim' })
      await pc.attach(mine.root, { claim: true })
      await pc.attach(theirs.root, { claim: true })
      expect(pc.attached.get(theirs.libraryId)?.role).toBe('claim')
      for (const lib of [mine, theirs]) await seedBase(pc, lib.libraryId, lib.root, unwatched())
      seedConflicts(pc, [watchRecord('c-w', 5, OTHER_LIB)])
      const [item] = await pc.runner.listConflicts()
      expect(item.libraries.map((l) => l.libraryId)).toEqual([mine.libraryId])
      const before = filesOf(pc, theirs.root, theirs.libraryId)
      const res = await pc.runner.resolve(['c-w'], { 'c-w': keep('local') })
      expect(res.resolved).toEqual(['c-w'])
      expect(res.notes.map((n) => n.text).join(' ')).not.toContain(
        pc.attached.get(theirs.libraryId)!.name
      )
      expect(filesOf(pc, theirs.root, theirs.libraryId)).toEqual(before)
    }
  )

  it('a party library whose manifest owner changed is still listed and still held for its next run', async () => {
    const lib = await makeLibrary({ ownerId: 7, doc: unwatched() })
    const pc = makePc({ user: null, installId: 'pc-claim' })
    await pc.attach(lib.root, { claim: true })
    await seedBase(pc, lib.libraryId, lib.root, unwatched())
    // Held for owner 5, from before the library changed hands.
    seedConflicts(pc, [watchRecord('c-p', 5, lib.libraryId)])
    const [item] = await pc.runner.listConflicts()
    expect(item.libraries).toEqual([
      expect.objectContaining({ libraryId: lib.libraryId, involved: true })
    ])
    const res = await pc.runner.resolve(['c-p'], { 'c-p': keep('local') })
    expect(res.notes).toEqual([
      {
        id: 'c-p',
        text: `${pc.attached.get(lib.libraryId)!.name} couldn't be read. It gets this choice on its next sync.`
      }
    ])
    // holdForNextRun: the base moves to the value the conflict showed for the library.
    const base = await pc.bases.read(`library-${lib.libraryId}`)
    expect(base!.doc.titles[ID].watch!['1'].watched.value).toBe(true)
  })
})
