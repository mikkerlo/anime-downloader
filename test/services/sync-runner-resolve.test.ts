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
import {
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

function seedConflicts(pc: Pc, records: SyncConflictRecord[]): void {
  const dir = path.join(pc.userData, 'sync-state')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'conflicts.json'), JSON.stringify({ version: 1, records }))
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

/** S9's Shikimori-side fixture: this PC and the library at 8, shikimori.one at 9, base 7. */
async function shikimoriSideConflict() {
  const s = await ownerSetup({
    base: { score: 7 },
    drive: { score: 8 },
    server: { score: 9, episodes: 3 },
    shikiBase: { score: 7, episodes: 3 },
    cache: { score: 7, episodes: 3 }
  })
  await s.pc.runner.runAll('manual')
  const [rec] = await conflicts(s.pc)
  expect(rec).toMatchObject({ fieldPath: 'rate.score', parties: { local: 8, shikimori: 9 } })
  return { ...s, rec }
}

const keep = (party: string): SyncConflictChoice => ({ kind: 'party', party })

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

  it('independent: A resolves to 8 unplugged (its base stays), B to 9 on the drive; back on A, a new conflict 8 vs 9, nothing applied', async () => {
    const { a, b, ra, rb, root, libraryId } = await twoPcs()
    a.attached.markUnavailable(libraryId, root)
    const res = await a.runner.resolve([ra.id], { [ra.id]: keep('local') })
    expect(res.notes.map((n) => n.text)).toEqual([
      expect.stringContaining("isn't connected. It gets this choice on its next sync.")
    ])
    expect((await baseOf(a, `library-${libraryId}`))!.rate!.score.value).toBe(7)
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

describe('the library is unavailable at resolve time', () => {
  it('the local value changes, the drive is not written and its base not advanced; the next run after the plug writes it', async () => {
    const { pc, root, libraryId, rec } = await shikimoriSideConflict()
    pc.offline.value = true
    pc.attached.markUnavailable(libraryId, root)
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
