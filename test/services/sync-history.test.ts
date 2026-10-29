// The read-only sync history (#585): paging over the month files, the library
// filter, and the lines each log record becomes.
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createSyncLog, type SyncLogRecord } from '../../src/main/services/sync-runner/log'
import {
  listHistory,
  toEntry,
  type HistoryNames
} from '../../src/main/services/sync-runner/history'

const LIB = 'lib-a'
const OTHER = 'lib-b'
const names: HistoryNames = {
  title: (id) => (id === '101' ? 'Frieren' : `#${id}`),
  titleOfMal: (m) => (m === 9001 ? 'Frieren' : `MAL ${m}`),
  library: (id) => (id === LIB ? 'Drive' : 'Stick')
}

const dirs: string[] = []
function tmpLog(maxBytes?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-history-'))
  dirs.push(dir)
  return { dir, log: createSyncLog(dir, maxBytes) }
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function run(at: number, libraries = [LIB], extra: Partial<SyncLogRecord> = {}): SyncLogRecord {
  return {
    kind: 'run',
    runId: `r${at}`,
    trigger: 'plug',
    at,
    libraries,
    counts: { applied: 1, conflicts: 0, clamped: 0 },
    changes: [],
    conflicts: [],
    clamps: [],
    skippedMalIds: [],
    raises: [],
    resolvedElsewhere: [],
    result: { runId: `r${at}`, trigger: 'plug', libraries: [] },
    ...extra
  } as SyncLogRecord
}

const JAN = Date.UTC(2026, 0, 10)
const FEB = Date.UTC(2026, 1, 10)

describe('listHistory', () => {
  it('pages newest first across month files, never splitting records that share an at', async () => {
    const { log } = tmpLog()
    for (const at of [JAN, JAN + 1, JAN + 2, FEB, FEB, FEB + 1]) await log.append(run(at))
    const p1 = await listHistory(log, { limit: 2 }, names)
    // The second FEB shares the boundary `at`, so it rides on this page.
    expect(p1.entries.map((e) => e.at)).toEqual([FEB + 1, FEB, FEB])
    expect(p1.nextBefore).toBe(FEB)
    const p2 = await listHistory(log, { limit: 2, before: p1.nextBefore! }, names)
    expect(p2.entries.map((e) => e.at)).toEqual([JAN + 2, JAN + 1])
    const p3 = await listHistory(log, { limit: 2, before: p2.nextBefore! }, names)
    expect(p3.entries.map((e) => e.at)).toEqual([JAN])
    expect(p3.nextBefore).toBeNull()
    const keys = [...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.key)
    expect(new Set(keys).size).toBe(6)
  })

  it('filters by library', async () => {
    const { log } = tmpLog()
    await log.append(run(JAN, [LIB]))
    await log.append(run(JAN + 1, [OTHER]))
    await log.append({
      kind: 'resolution',
      at: JAN + 2,
      conflictId: 'c1',
      animeId: '101',
      fieldPath: 'rate.score',
      choice: 'local',
      value: 8,
      libraryIds: [OTHER],
      wrote: { local: true, libraries: [OTHER], shikimori: 'queued' },
      notes: []
    })
    const page = await listHistory(log, { libraryId: OTHER }, names)
    expect(page.entries.map((e) => [e.kind, e.at])).toEqual([
      ['resolution', JAN + 2],
      ['run', JAN + 1]
    ])
  })

  it('reads a month file from its newest bytes when it is past the bound, skipping a torn line', async () => {
    const { dir, log } = tmpLog(600)
    const lines = [JAN, JAN + 1, JAN + 2, JAN + 3].map((at) => JSON.stringify(run(at)))
    fs.writeFileSync(path.join(dir, '2026-01.jsonl'), `${lines.join('\n')}\n{"kind":"ru`)
    const records = await log.read('2026-01')
    expect(fs.statSync(path.join(dir, '2026-01.jsonl')).size).toBeGreaterThan(1200)
    expect(records.length).toBeGreaterThan(0)
    expect(records.length).toBeLessThan(4)
    expect(records.at(-1)!.at).toBe(JAN + 3)
    expect(records.every((r) => r.kind === 'run')).toBe(true)
  })
})

describe('the lines a record becomes', () => {
  it('a run: silent changes with values, the raise, waiting MAL ids, clamps, conflicts and resolved elsewhere', () => {
    const e = toEntry(
      run(JAN, [LIB], {
        trigger: 'manual',
        counts: { applied: 3, conflicts: 1, clamped: 1 },
        details: [
          {
            path: 'titles.101.watch.5.position',
            to: 'local',
            from: 'library',
            libraryId: LIB,
            before: { position: 750, duration: 1440 },
            after: { position: 1082, duration: 1440 }
          },
          {
            path: 'titles.101.rate.status',
            to: 'shikimori',
            from: 'local',
            before: 'watching',
            after: 'completed'
          }
        ],
        raises: [
          { libraryId: LIB, animeId: '101', malId: 9001, kind: 'forward', episodes: 6, from: 3 }
        ],
        skippedMalIds: [9001],
        clamps: [{ path: 'titles.101.watch.2.watched', at: JAN + 9e9, clampedTo: JAN }],
        conflicts: [{ animeId: '101', fieldPath: 'rate.score', reason: 'x' }],
        resolvedElsewhere: [{ animeId: '101', fieldPath: 'rate.episodes' }]
      } as Partial<SyncLogRecord>),
      'k',
      names
    )!
    expect(e.summary).toBe('Sync now: 3 updates, 1 need your input')
    expect(e.details).toEqual([
      'Frieren: Ep 5 position 12:30 → 18:02 from Drive',
      'Frieren: status Watching → Completed sent to Shikimori',
      'Frieren: Shikimori episodes 3 → 6 from episodes watched on Drive',
      'Waiting for your queued Shikimori edits: Frieren',
      expect.stringMatching(
        /^Frieren: Ep 2 was dated .* in the future; it counts as the sync time$/
      ),
      'Needs your input: Frieren: score',
      'Frieren: episodes watched resolved elsewhere'
    ])
  })

  it('an older run record without values falls back to its paths', () => {
    const e = toEntry(run(JAN, [LIB], { changes: ['local:titles.101.rate.score'] }), 'k', names)!
    expect(e.details).toEqual(['Frieren: score changed from Drive'])
  })

  it('a superseded rewatch, a rejection and a resolution', () => {
    const sup = toEntry(
      {
        kind: 'rewatch-superseded',
        runId: 'r',
        at: JAN,
        animeId: '101',
        malId: 9001,
        episodes: 4,
        flipAt: JAN - 1,
        shikimoriUpdatedAt: '',
        libraryId: LIB,
        reason: ''
      },
      'k',
      names
    )!
    expect(sup.summary).toBe(
      "Your rewatch of Frieren (episode 4) didn't count because Shikimori changed after it."
    )
    const res = toEntry(
      {
        kind: 'resolution',
        at: JAN,
        conflictId: 'c',
        animeId: '101',
        fieldPath: 'rate.score',
        choice: 'shikimori',
        value: 9,
        libraryIds: [],
        wrote: { local: true, libraries: [LIB], shikimori: 'already' },
        notes: ["Stick isn't connected. It gets this choice on its next sync."]
      },
      'k',
      names
    )!
    expect(res.summary).toBe('Frieren: score: you kept Shikimori’s value (★ 9)')
    expect(res.details).toEqual([
      'Written to this PC, Drive, Shikimori (already had it)',
      "Stick isn't connected. It gets this choice on its next sync."
    ])
  })
})
