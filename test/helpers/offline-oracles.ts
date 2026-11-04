/**
 * What "correct" means for the offline scenario matrix (#659), as functions
 * over one observed run of a world. Each returns a list of violations, so a
 * failure names the entry and what it got; `[]` means the oracle holds.
 *
 * O1–O3 and O7 are invariants agreed on #655 and #657; the others are derived,
 * and each one's comment names its source. O5 (the readers of
 * `downloadedEpisodes` agree) joins with the legacy-key rows.
 */
import * as fs from 'fs'
import { isDeepStrictEqual } from 'util'
import {
  entryKey,
  type Outcome,
  type Router,
  type Snapshot,
  type StepRun,
  type World
} from './offline-world'

export type OracleId = 'O1' | 'O2' | 'O3' | 'O4' | 'O6' | 'O7' | 'O8' | 'O9'

export interface Violation {
  scenario: string
  entry: string
  oracle: OracleId
  actual: string
}

/** One world after its actions and one run of step 4. */
export interface Run {
  scenario: string
  world: World
  /** Store and files right before step 4, and right after it. */
  before: Snapshot
  after: Snapshot
  out: StepRun
  /** Step 4 over each entry alone (`World.entryOutcomes`), after the run. */
  outcomes: Map<string, Outcome>
}

type Found = Omit<Violation, 'scenario' | 'oracle'>

const animeIdOf = (key: string): number => Number(key.split(':')[0])
const epOf = (key: string): string => key.split(':')[1]

function episodes(w: World): Record<string, { translationId: number }> {
  return w.store.get('downloadedEpisodes') as Record<string, { translationId: number }>
}

function onDisk(w: World, key: string): boolean {
  const file = w.files.get(key)
  return file !== undefined && fs.existsSync(file)
}

const remoteError = (message: string): string =>
  message.replace(/^Error invoking remote method '[^']+': /, '')

/**
 * O1: "ok" means the player will find the file (mikkerlo, #657: Prepare for
 * offline "is meant to tell me what I can play on the train"). For every entry
 * counted ok whose title has cached details, the offline route (`GET_ANIME`,
 * then `player:find-local-file` under `getAnimeName` of its answer) returns
 * that entry's file. No `.mkv` clause (#659's Q1).
 */
async function okMeansPlayable(r: Run): Promise<Found[]> {
  const found: Found[] = []
  const cache = r.world.store.get('animeCache') as Record<
    string,
    { animeDetail?: unknown } | undefined
  >
  for (const [key, o] of r.outcomes) {
    if (o.kind !== 'ok' || !cache[animeIdOf(key)]?.animeDetail) continue
    const play = await r.world.playOffline(
      animeIdOf(key),
      epOf(key),
      episodes(r.world)[key].translationId
    )
    if (!play.opened) {
      found.push({ entry: key, actual: `the page doesn't open: ${remoteError(play.why)}` })
    } else if (play.file === null || play.file !== r.world.files.get(key)) {
      const got = play.file === null ? 'nothing' : r.world.norm(play.file)
      found.push({ entry: key, actual: `counted ok, the player gets ${got} under "${play.name}"` })
    }
  }
  return found
}

/**
 * O2: nothing a user can act on is skipped silently (#657). Every entry whose
 * file is on disk is counted ok or gets a line. The one silent skip allowed is
 * #658's: a title the user deleted, whose leftovers have no record.
 */
async function nothingOnDiskSkipped(r: Run): Promise<Found[]> {
  const found: Found[] = []
  for (const [key, o] of r.outcomes) {
    if (o.kind !== 'skipped' || !onDisk(r.world, key)) continue
    if (r.world.deleted.has(animeIdOf(key))) continue
    found.push({ entry: key, actual: 'not counted and no line, with its file on disk' })
  }
  return found
}

function stillThere(outcomes: Map<string, Outcome>, ids: Set<number>, when: string): Found[] {
  const found: Found[] = []
  for (const [key, o] of outcomes) {
    if (!ids.has(animeIdOf(key)) || o.kind === 'skipped') continue
    found.push({ entry: key, actual: `${when}${o.kind === 'ok' ? 'counted ok' : o.text}` })
  }
  return found
}

/**
 * O3: a deleted title's bookkeeping never resurfaces (#655, #657). After
 * Library → Delete there is no line, nothing in the total, no export row, and
 * none of it comes back after a restart's reconcile.
 */
async function deletedStaysGone(r: Run): Promise<Found[]> {
  const ids = r.world.deleted
  const found = stillThere(r.outcomes, ids, '')
  for (const id of await r.world.exportPlan()) {
    if (ids.has(id)) found.push({ entry: `title ${id}`, actual: 'an export row' })
  }
  r.world.restart()
  found.push(...stillThere(await r.world.entryOutcomes(), ids, 'after a restart: '))
  return found
}

/**
 * O4: a problem is reported with its real cause. An away root is "unknown",
 * never "missing" (the #421 guard), so a recorded entry on an unplugged cold
 * drive gets a line naming that drive (#664).
 */
async function awayRootNamed(r: Run): Promise<Found[]> {
  const found: Found[] = []
  if (!r.world.spec.coldAway) return found
  const recorded = r.world.store.get('downloadedAnime') as Record<string, unknown>
  for (const t of r.world.spec.titles) {
    if (!recorded[t.id]) continue
    for (const e of t.entries) {
      if (e.where !== 'cold') continue
      const key = entryKey(t.id, e)
      const o = r.outcomes.get(key)
      if (o?.kind === 'line' && o.text.includes(r.world.cold) && !o.text.includes('missing')) {
        continue
      }
      const actual = !o ? 'no entry' : o.kind === 'line' ? r.world.norm(o.text) : o.kind
      found.push({ entry: key, actual })
    }
  }
  return found
}

/**
 * O6: report only (`docs/architecture.md`, Prepare for offline: "Reports
 * only"). Step 4 leaves every store key deep-equal and every file as it was.
 */
async function reportOnly(r: Run): Promise<Found[]> {
  const found: Found[] = []
  const { before, after } = r
  for (const k of new Set([...Object.keys(before.store), ...Object.keys(after.store)])) {
    if (!isDeepStrictEqual(before.store[k], after.store[k])) {
      found.push({ entry: `store ${k}`, actual: 'changed' })
    }
  }
  for (const f of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    const a = before.files[f]
    const b = after.files[f]
    if (a && b && a.mtimeMs === b.mtimeMs && a.size === b.size) continue
    found.push({ entry: f, actual: !b ? 'deleted' : !a ? 'created' : 'modified' })
  }
  return found
}

/**
 * O8: a per-entry problem is a per-entry line. One step throwing is `failed`
 * (the runner's contract), so an entry's I/O error must never fail the step.
 * The summary's `ok of checked` is `ok` + the entry lines, `0 of 0` reads
 * `ok` (#657), and the counts agree with the entries checked one by one.
 */
async function perEntryLines(r: Run): Promise<Found[]> {
  if ('failed' in r.out) return [{ entry: 'step', actual: r.world.norm(`failed: ${r.out.failed}`) }]
  const found: Found[] = []
  const [summary] = r.out.details
  const m = /^(\d+) of (\d+) episodes? ok$/.exec(summary?.text ?? '')
  if (!m) return [{ entry: 'summary', actual: summary ? summary.text : 'no summary line' }]
  const ok = Number(m[1])
  const checked = Number(m[2])
  const lines = r.out.details.filter((d) => d.animeId !== undefined).length
  if (checked !== ok + lines) {
    found.push({ entry: 'summary', actual: `${summary.text} with ${lines} entry lines` })
  }
  if (checked === 0 && summary.status !== 'ok') {
    found.push({ entry: 'summary', actual: `${summary.text} reads ${summary.status}` })
  }
  const one = [...r.outcomes.values()]
  const okOne = one.filter((o) => o.kind === 'ok').length
  const checkedOne = one.filter((o) => o.kind !== 'skipped').length
  if (okOne !== ok || checkedOne !== checked) {
    found.push({ entry: 'entries', actual: `one by one: ${okOne} of ${checkedOne} ok` })
  }
  return found
}

/**
 * O9: a detail link opens a page offline. The panel's links go to
 * `libraryStore.openAnime` (#657), so every title on a line or counted ok
 * must be answered by offline `GET_ANIME`.
 */
async function linksOpenOffline(r: Run): Promise<Found[]> {
  const ids = new Set<number>()
  if (!('failed' in r.out)) {
    for (const d of r.out.details) if (d.animeId !== undefined) ids.add(d.animeId)
  }
  for (const [key, o] of r.outcomes) if (o.kind === 'ok') ids.add(animeIdOf(key))
  const found: Found[] = []
  for (const id of [...ids].sort((a, b) => a - b)) {
    const opened = await r.world.opensOffline(id)
    if (opened !== true) {
      found.push({ entry: `title ${id}`, actual: `GET_ANIME offline: ${remoteError(opened)}` })
    }
  }
  return found
}

/**
 * O7: a title whose files are on disk keeps its record (mikkerlo, #655: "A
 * title whose files are on disk belongs in the Library"). A user action on one
 * episode never drops the title's record or cached details while its files
 * remain.
 */
async function recordKept(r: Run): Promise<Found[]> {
  const found: Found[] = []
  const recorded = r.world.store.get('downloadedAnime') as Record<string, unknown>
  const cache = r.world.store.get('animeCache') as Record<string, unknown>
  for (const t of r.world.spec.titles) {
    if (!t.downloaded || r.world.deleted.has(t.id)) continue
    const keys = [...r.world.files.keys()].filter((k) => animeIdOf(k) === t.id)
    if (!keys.some((k) => onDisk(r.world, k))) continue
    if (!recorded[t.id]) found.push({ entry: `title ${t.id}`, actual: 'its record is gone' })
    if (t.cache !== undefined && !cache[t.id]) {
      found.push({ entry: `title ${t.id}`, actual: 'its cached details are gone' })
    }
  }
  return found
}

const ORACLES: Record<OracleId, (r: Run) => Promise<Found[]>> = {
  O1: okMeansPlayable,
  O2: nothingOnDiskSkipped,
  O3: deletedStaysGone,
  O4: awayRootNamed,
  O6: reportOnly,
  O7: recordKept,
  O8: perEntryLines,
  O9: linksOpenOffline
}

/** The routers each oracle calls, so a world registers only those. */
export const ORACLE_ROUTERS: Record<OracleId, Router[]> = {
  O1: ['anime', 'player'],
  O2: [],
  O3: ['export'],
  O4: [],
  O6: [],
  O7: [],
  O8: [],
  O9: ['anime']
}

export async function check(oracle: OracleId, r: Run): Promise<Violation[]> {
  return (await ORACLES[oracle](r)).map((v) => ({ scenario: r.scenario, oracle, ...v }))
}
