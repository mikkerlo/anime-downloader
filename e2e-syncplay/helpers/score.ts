// Rows are scored as counts over N timed runs, never on single-run luck.
//
// The ✗ rule (#489 review): the investigation's rates (96% / 6 of 14 / 24%)
// were measured on real streams, and a fixture with a synthetic per-request
// delay will not reproduce them, so a rate band around them would be flaky.
// Tier 1 carries the exact pins. A Tier 2 ✗ row asserts only `bad ≥ 1` at its
// stated N on current main — proof the rig can *see* the bug — and the fix PR
// flips it to `bad == 0`. A non-✗ row asserts `bad == 0` over its scoreable
// runs.
//
// Every run's record goes to `test-results/syncplay-traces/<row>.jsonl`
// whether the row passes or not; the workflow uploads that directory when the
// job fails. Records are per-transition summaries plus a bounded trace slice,
// sized to be aggregated with `jq`, not read raw.

import fs from 'node:fs'
import path from 'node:path'
import { TRACE_DIR } from './paths'

/** What one instance did across an episode change, read off its media events
 *  and 200 ms samples (both relative to the press). The thresholds are #486's:
 *  > 5 s in at `loadedmetadata`, > 7 s two seconds later, or a stale seek past
 *  9 s within 4 s of metadata (the short snap-backs). */
export interface StaleOutcome {
  srcChanged: boolean
  /** The new element's `loadedmetadata`, relative to the press. */
  lmAt?: number
  ctLm?: number
  ct2?: number | null
  ct10?: number | null
  maxCtFirst4s?: number
  stale: boolean
  /** `stale` from `lm.ct > 5` or `ct2 > 7` alone, without the 4 s term. */
  staleEarly?: boolean
  /** Still past 20 s at metadata + 10 s: stuck rather than self-corrected. */
  stuck: boolean
}

type MediaEv = { at: number; t: string; ct: number; src: string }

export function staleOutcome(
  d: {
    ev: MediaEv[]
    smp: { at: number; ct: number; src: string }[]
  },
  oldSrc: string
): StaleOutcome {
  const oldTail = oldSrc.slice(-40)
  const lm = d.ev.find((e) => e.t === 'loadedmetadata' && e.src !== oldTail && e.at >= 0)
  if (!lm) return { srcChanged: false, stale: false, stuck: false }
  const at = (t: number): { ct: number; src: string } | null => {
    let best: { ct: number; src: string } | null = null
    for (const s of d.smp) if (s.at <= t) best = s
    return best
  }
  const s2 = at(lm.at + 2000)
  const s10 = at(lm.at + 10_000)
  const ct2 = s2 && s2.src !== oldTail ? s2.ct : null
  const ct10 = s10 && s10.src !== oldTail ? s10.ct : null
  const maxCtFirst4s = Math.max(
    0,
    ...d.smp
      .filter((s) => s.src !== oldTail && s.at >= lm.at && s.at <= lm.at + 4000)
      .map((s) => s.ct)
  )
  const staleEarly = lm.ct > 5 || (ct2 !== null && ct2 > 7)
  const stale = staleEarly || maxCtFirst4s > 9
  return {
    srcChanged: true,
    lmAt: lm.at,
    ctLm: +lm.ct.toFixed(2),
    ct2,
    ct10,
    maxCtFirst4s,
    stale,
    staleEarly,
    stuck: stale && ct10 !== null && ct10 > 20
  }
}

/** E5's seek set: every `seeking` at or after the press on the new element
 *  whose target is past 5 s. */
export function seeksPast5(ev: MediaEv[], oldSrc: string): MediaEv[] {
  const oldTail = oldSrc.slice(-40)
  return ev.filter((e) => e.t === 'seeking' && e.at >= 0 && e.src !== oldTail && e.ct > 5)
}

/** The position a `Resumed at …` toast names, in whole seconds (`formatTime`
 *  floors), or null for any other text. */
export function resumeToastSeconds(txt: string): number | null {
  const m = /^Resumed at (?:(\d+):)?(\d+):(\d{2})$/.exec(txt.trim())
  if (!m) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** A seek belongs to a `Resumed at …` toast when its target floors to the
 *  toast's seconds and it lands within 50 ms of it, on either side: the toast
 *  is set in the same branch as #497's saved-progress seek, and the probe's
 *  `MutationObserver` fires on Vue's flush, ahead of the queued `seeking`. */
export const RESUME_PAIR_MS = 50

/** E1 / E6's #486 verdict with #497 split out (#514). #497's saved-progress
 *  seek is the one paired with a `Resumed at …` toast (`foreign`); every other
 *  seek in the set within ±15 s of the instance's measured pre-press `ct` is
 *  #486's (`old`, recorded over the whole set as E5 does). A paired seek
 *  excuses only the `maxCtFirst4s > 9` term, and only when it lands in the
 *  window that term reads, `[lmAt, lmAt + 4000]`, with no unpaired seek past
 *  5 s beside it there. `lm.ct > 5` and `ct2 > 7` stay #486: #497 seeks after
 *  metadata and is gone within 300 ms. Unlike `e5Split`, nothing here depends
 *  on where the press was. */
export function resumeSplit(
  d: { ev: MediaEv[]; toasts: { at: number; cls: string; txt: string }[] },
  before: { ct: number; src: string },
  outcome: StaleOutcome
): { stale: boolean; foreignSeek: boolean; old: boolean; excused: boolean } {
  const seeks = seeksPast5(d.ev, before.src)
  const toasts = d.toasts
    .filter((t) => t.cls === 'resume-toast' && t.at >= 0)
    .map((t) => ({ at: t.at, s: resumeToastSeconds(t.txt) }))
    .filter((t): t is { at: number; s: number } => t.s !== null)
  const paired = (e: MediaEv): boolean =>
    toasts.some((t) => Math.floor(e.ct) === t.s && Math.abs(e.at - t.at) <= RESUME_PAIR_MS)
  const foreignSeek = seeks.some(paired)
  const old = seeks.some((e) => !paired(e) && Math.abs(e.ct - before.ct) <= 15)
  const lmAt = outcome.lmAt
  const inWindow = (e: MediaEv): boolean =>
    lmAt !== undefined && e.at >= lmAt && e.at <= lmAt + 4000
  const excused =
    seeks.some((e) => inWindow(e) && paired(e)) && !seeks.some((e) => inWindow(e) && !paired(e))
  const stale = outcome.stale && (!!outcome.staleEarly || !excused)
  return { stale, foreignSeek, old, excused }
}

/** E5's position before run `i`'s pause, from `rand` in [0, 1). Runs alternate
 *  next/prev, so the episode run `i` lands on was last left at run `i - 1`, and
 *  #497's saved-progress seek targets that run's position. Even runs draw from
 *  300–420 s and odd runs from 480–600 s: consecutive positions are always
 *  ≥ 60 s apart, so a #497 seek can never fall inside `e5Split`'s ±15 s window
 *  around the old position and be counted as #486 (#499). */
export function e5Position(i: number, rand: number): number {
  return (i % 2 === 0 ? 300 : 480) + rand * 120
}

/** Splits E5's seeks on the new element past 5 s by target: within ±15 s of
 *  the old position is #486's stale seek (`old`), whether or not it later snaps
 *  back; anything else is #497's saved-progress seek (`foreign`). Sound only
 *  because `e5Position` keeps #497's target out of the window. */
export function e5Split(
  d: { ev: MediaEv[] },
  before: { ct: number; src: string },
  outcome: { stale: boolean }
): { old: boolean; foreign: boolean } {
  const targets = seeksPast5(d.ev, before.src).map((e) => e.ct)
  const foreign = targets.some((ct) => Math.abs(ct - before.ct) > 15)
  const old = targets.some((ct) => Math.abs(ct - before.ct) <= 15)
  // `staleOutcome` also reads positions; a stale reading the foreign seek
  // explains is #497's, not #486's.
  return { old: old || (outcome.stale && !foreign), foreign }
}

export interface RunRecord {
  row: string
  i: number
  /** A setup step (positioning, both-playing) failed: not scoreable. */
  setupOk: boolean
  bad: boolean
  [k: string]: unknown
}

export interface RowScore {
  row: string
  n: number
  scoreable: number
  bad: number
  records: RunRecord[]
}

export class RowScorer {
  private readonly records: RunRecord[] = []
  private readonly file: string

  constructor(readonly row: string) {
    fs.mkdirSync(TRACE_DIR, { recursive: true })
    this.file = path.join(TRACE_DIR, `${row}.jsonl`)
    fs.writeFileSync(this.file, '')
  }

  add(rec: Omit<RunRecord, 'row' | 'i'>, trace?: unknown): RunRecord {
    const full = { row: this.row, i: this.records.length, ...rec } as RunRecord
    this.records.push(full)
    fs.appendFileSync(this.file, JSON.stringify(trace ? { ...full, trace } : full) + '\n')
    return full
  }

  score(): RowScore {
    const scoreable = this.records.filter((r) => r.setupOk)
    const s: RowScore = {
      row: this.row,
      n: this.records.length,
      scoreable: scoreable.length,
      bad: scoreable.filter((r) => r.bad).length,
      records: this.records
    }
    fs.appendFileSync(this.file, JSON.stringify({ summary: { ...s, records: undefined } }) + '\n')
    process.stdout.write(
      `[syncplay-e2e] ${this.row}: n=${s.n} scoreable=${s.scoreable} bad=${s.bad}\n`
    )
    return s
  }
}
