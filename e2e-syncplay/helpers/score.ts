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
  ctLm?: number
  ct2?: number | null
  ct10?: number | null
  maxCtFirst4s?: number
  stale: boolean
  /** Still past 20 s at metadata + 10 s: stuck rather than self-corrected. */
  stuck: boolean
}

export function staleOutcome(
  d: {
    ev: { at: number; t: string; ct: number; src: string }[]
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
  const stale = lm.ct > 5 || (ct2 !== null && ct2 > 7) || maxCtFirst4s > 9
  return {
    srcChanged: true,
    ctLm: +lm.ct.toFixed(2),
    ct2,
    ct10,
    maxCtFirst4s,
    stale,
    stuck: stale && ct10 !== null && ct10 > 20
  }
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
