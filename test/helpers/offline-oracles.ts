/**
 * What "correct" means for the offline scenario matrix (#659), as functions
 * over one observed run of a world. Each returns a list of violations, so a
 * failure names the entry and what it got; `[]` means the oracle holds.
 *
 * O1–O3, O7 and O10 are invariants agreed on #655 and #657 (O10 with the scope
 * set on #680); the others are derived, and each one's comment names its
 * source. O5 (the readers of `downloadedEpisodes` agree) joins with the
 * legacy-key rows. O11 (a restart's reconcile keeps every entry whose file is
 * on disk under one of the title's names) is #679's.
 */
import * as fs from 'fs'
import * as path from 'path'
import { isDeepStrictEqual } from 'util'
import { sanitizeFilename } from '../../src/main/download-manager'
import {
  entryKey,
  type ItemOutcome,
  type Outcome,
  type Router,
  type Snapshot,
  type StepRun,
  type World
} from './offline-world'

export type OracleId = 'O1' | 'O2' | 'O3' | 'O4' | 'O6' | 'O7' | 'O8' | 'O9' | 'O10' | 'O11'

export interface Violation {
  scenario: string
  entry: string
  oracle: OracleId
  actual: string
}

/** One world after its actions and one run of step 4 (and of step 5, with a library). */
export interface Run {
  scenario: string
  world: World
  /**
   * Store and files right before step 4, and right after it (and step 5). With
   * `whole`, they also bracket a whole `runPrepare()` before step 4.
   */
  before: Snapshot
  after: Snapshot
  whole: boolean
  out: StepRun
  /** Step 4 over each entry alone (`World.entryOutcomes`), after the run. */
  outcomes: Map<string, Outcome>
  /** Step 5's run; null in a world with no library. */
  attached: StepRun | null
  /** Step 5 over each item alone (`World.itemOutcomes`), after the run. */
  items: ItemOutcome[]
}

type Found = Omit<Violation, 'scenario' | 'oracle'>

const animeIdOf = (key: string): number => Number(key.split(':')[0])
const epOf = (key: string): string => key.split(':')[1]
const trIdOf = (key: string): number => Number(key.split(':')[2])

function episodes(w: World): Record<string, { translationId: number }> {
  return w.store.get('downloadedEpisodes') as Record<string, { translationId: number }>
}

function onDisk(w: World, key: string): boolean {
  const file = w.files.get(key)
  return file !== undefined && fs.existsSync(file)
}

/**
 * The folders the title's names give, from every record the store holds for
 * it, and its auto-download subscription's `animeName` (#676).
 */
function heldFolders(w: World, id: number): Set<string> {
  const of = (key: string): unknown =>
    (w.store.get(key) as Record<string, unknown> | undefined)?.[id]
  const cached = of('animeCache') as { animeDetail?: unknown } | undefined
  const out = new Set<string>()
  for (const r of [
    of('downloadedAnime'),
    of('library'),
    cached?.animeDetail,
    of('recentAnimeMeta')
  ]) {
    const rec = r as AnimeSearchResult | null | undefined
    for (const n of [rec?.titles?.romaji, rec?.titles?.ru, rec?.title]) {
      if (n) out.add(sanitizeFilename(n))
    }
  }
  const sub = of('autoDownloadSubscriptions') as AutoDownloadSubscription | undefined
  if (sub?.animeName) out.add(sanitizeFilename(sub.animeName))
  return out
}

const remoteError = (message: string): string =>
  message.replace(/^Error invoking remote method '[^']+': /, '')

/**
 * O1: "ok" means the player will find the file (mikkerlo, #657: Prepare for
 * offline "is meant to tell me what I can play on the train"). For every entry
 * counted ok whose title has cached details, the offline route (`GET_ANIME`,
 * then `player:find-local-file` under `getAnimeName` of its answer) returns
 * that entry's file. The same for every item of an attached library that
 * step 5 counts ok: the player returns the drive's file, or this PC's copy of
 * it, which the player prefers. No `.mkv` clause (#659's Q1).
 */
async function okMeansPlayable(r: Run): Promise<Found[]> {
  const found: Found[] = []
  const cache = r.world.store.get('animeCache') as Record<
    string,
    { animeDetail?: unknown } | undefined
  >
  const check = async (
    entry: string,
    key: string,
    trId: number,
    accept: (string | undefined)[]
  ): Promise<void> => {
    const play = await r.world.playOffline(animeIdOf(key), epOf(key), trId)
    if (!play.opened) {
      found.push({ entry, actual: `the page doesn't open: ${remoteError(play.why)}` })
    } else if (play.file === null || !accept.includes(play.file)) {
      const got = play.file === null ? 'nothing' : r.world.norm(play.file)
      found.push({ entry, actual: `counted ok, the player gets ${got} under "${play.name}"` })
    }
  }
  for (const [key, o] of r.outcomes) {
    if (o.kind !== 'ok' || !cache[animeIdOf(key)]?.animeDetail) continue
    await check(key, key, episodes(r.world)[key].translationId, [r.world.files.get(key)])
  }
  for (const { key, file, outcome } of r.items) {
    if (outcome.kind !== 'ok' || !cache[animeIdOf(key)]?.animeDetail) continue
    await check(`drive ${key}`, key, trIdOf(key), [file, r.world.files.get(key)])
  }
  return found
}

/**
 * O2: nothing a user can act on is skipped silently (#657). Every recorded
 * entry whose file is on disk, and every record-less one whose file is under
 * one of the title's names (any record the store holds for it, or its
 * auto-download subscription), is counted ok or gets a line. The silent
 * skips allowed are #658's: a title with no record whose file isn't under
 * any of its names, and a title the user deleted. Step 5 the same: every
 * item of an available library whose file is on the drive is counted ok or
 * gets a line.
 */
async function nothingOnDiskSkipped(r: Run): Promise<Found[]> {
  const found: Found[] = []
  for (const [key, o] of r.outcomes) {
    if (o.kind !== 'skipped' || !onDisk(r.world, key)) continue
    const id = animeIdOf(key)
    if (r.world.deleted.has(id)) continue
    // #658's skip is for a title with no record; a recorded one must get a line.
    const recorded = (r.world.store.get('downloadedAnime') as Record<string, unknown>)[id]
    const folder = path.basename(path.dirname(r.world.files.get(key)!))
    if (!recorded && !heldFolders(r.world, id).has(folder)) continue
    found.push({ entry: key, actual: 'not counted and no line, with its file on disk' })
  }
  for (const { key, file, outcome } of r.items) {
    if (outcome.kind !== 'skipped' || !fs.existsSync(file)) continue
    found.push({
      entry: `drive ${key}`,
      actual: 'not counted and no line, with its file on the drive'
    })
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
 * drive gets a line naming that drive (#664). An attached library whose drive
 * is unplugged gets step 5's "not connected" line, and none of its items is
 * reported missing.
 */
async function awayRootNamed(r: Run): Promise<Found[]> {
  const found: Found[] = []
  const recorded = r.world.store.get('downloadedAnime') as Record<string, unknown>
  for (const t of r.world.spec.coldAway ? r.world.spec.titles : []) {
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
  for (const lib of r.world.libraries()) {
    if (lib.available && !r.world.spec.library?.away) continue
    const entry = `library ${lib.name}`
    if (!r.attached || 'failed' in r.attached) {
      found.push({ entry, actual: r.attached ? `failed: ${r.attached.failed}` : 'step 5 not run' })
      continue
    }
    const lines = r.attached.details.map((d) => d.text).filter((t) => t.startsWith(`${lib.name}: `))
    if (
      lines.some((t) => t.includes('not connected')) &&
      !lines.some((t) => t.includes('missing'))
    ) {
      continue
    }
    found.push({ entry, actual: lines.length > 0 ? lines.join(' | ') : 'no line' })
  }
  return found
}

/**
 * O6: report only (`docs/architecture.md`, Prepare for offline: "Reports
 * only"). Steps 4 and 5 leave every store key deep-equal and every file as
 * it was. A whole offline run does too, apart from the runner's own record of
 * it (`prepareOfflineLastRun`): the network steps are skipped, so nothing
 * refreshes the cache or sends the Shikimori queue.
 */
async function reportOnly(r: Run): Promise<Found[]> {
  const found: Found[] = []
  const { before, after } = r
  for (const k of new Set([...Object.keys(before.store), ...Object.keys(after.store)])) {
    if (r.whole && k === 'prepareOfflineLastRun') continue
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
 * remain, and neither does a Library → Delete that leaves some of them on
 * disk (#663).
 */
async function recordKept(r: Run): Promise<Found[]> {
  const found: Found[] = []
  const recorded = r.world.store.get('downloadedAnime') as Record<string, unknown>
  const cache = r.world.store.get('animeCache') as Record<string, unknown>
  for (const t of r.world.spec.titles) {
    if (!t.downloaded) continue
    const keys = [...r.world.files.keys()].filter((k) => animeIdOf(k) === t.id)
    if (!keys.some((k) => onDisk(r.world, k))) continue
    if (!recorded[t.id]) found.push({ entry: `title ${t.id}`, actual: 'its record is gone' })
    if (t.cache !== undefined && !cache[t.id]) {
      found.push({ entry: `title ${t.id}`, actual: 'its cached details are gone' })
    }
  }
  return found
}

/**
 * O10: a "missing" line means the file isn't there (mikkerlo, #657: "a
 * recorded title never gets told a file is missing when it's on disk"). No
 * entry that step 4 reports as "the video file is missing" has its file on
 * disk under one of the title's names (`heldFolders`). The narrowing to those
 * names is mikkerlo's (#680,
 * https://github.com/mikkerlo/anime-downloader/issues/680#issuecomment-6646389720):
 * a folder no record or subscription names is one no reader can find, so
 * "missing" is the true answer there. The away-root lines (#664: "cold
 * storage isn't connected", "the download folder isn't there") say the
 * episode wasn't checked, not that it's missing; O4 checks them.
 */
async function missingMeansGone(r: Run): Promise<Found[]> {
  const found: Found[] = []
  for (const [key, o] of r.outcomes) {
    if (o.kind !== 'line' || !o.text.endsWith(': the video file is missing')) continue
    if (!onDisk(r.world, key)) continue
    const file = r.world.files.get(key)!
    if (!heldFolders(r.world, animeIdOf(key)).has(path.basename(path.dirname(file)))) continue
    found.push({ entry: key, actual: `reported missing, with its file at ${r.world.norm(file)}` })
  }
  return found
}

/**
 * O11: a restart keeps what's on disk. The startup reconcile drops only the
 * entries with no file on disk (#423), and never on an answer it can't trust
 * (#421). So after `World.restart()`, every entry whose file is on disk under
 * one of the title's names (`heldFolders`) is still in `downloadedEpisodes`,
 * apart from a deleted title's (O3).
 */
async function restartKeepsOnDisk(r: Run): Promise<Found[]> {
  const held = Object.keys(episodes(r.world)).filter((key) => {
    if (!onDisk(r.world, key) || r.world.deleted.has(animeIdOf(key))) return false
    const folder = path.basename(path.dirname(r.world.files.get(key)!))
    return heldFolders(r.world, animeIdOf(key)).has(folder)
  })
  r.world.restart()
  const after = episodes(r.world)
  return held
    .filter((key) => !(key in after))
    .map((key) => ({
      entry: key,
      actual: `dropped by a restart's reconcile, with its file at ${r.world.norm(r.world.files.get(key)!)}`
    }))
}

const ORACLES: Record<OracleId, (r: Run) => Promise<Found[]>> = {
  O1: okMeansPlayable,
  O2: nothingOnDiskSkipped,
  O3: deletedStaysGone,
  O4: awayRootNamed,
  O6: reportOnly,
  O7: recordKept,
  O8: perEntryLines,
  O9: linksOpenOffline,
  O10: missingMeansGone,
  O11: restartKeepsOnDisk
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
  O9: ['anime'],
  O10: [],
  O11: []
}

export async function check(oracle: OracleId, r: Run): Promise<Violation[]> {
  return (await ORACLES[oracle](r)).map((v) => ({ scenario: r.scenario, oracle, ...v }))
}
