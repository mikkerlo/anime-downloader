// One title's 3-way merge (#584): S4 (#572)'s rules 1–9, 11 and 12 applied
// exactly as the frozen field table states them, field by field. Pure.
//
// For every field the decision gives three values: what side A (this PC)
// ends up with, what side B (the library or Shikimori) ends up with, and the
// next base. A conflict leaves both sides as they are and the base where it
// was, so the conflict comes back until it is resolved.

import {
  enforcePriorityInvariant,
  membershipOf,
  sameValue,
  type Decision,
  type FieldRule,
  type Membership,
  type SkipContext
} from '../sync-state/field-table'
import { KNOWN_TITLE_FIELDS, RATE_FIELDS } from '../sync-state/project'

export interface FieldConflict {
  animeId: string
  fieldPath: SyncConflictFieldPath
  reason: string
  base: unknown
  a: unknown
  b: unknown
  atA?: SyncClock
  atB?: SyncClock
  /** Rule 7's "both rose": S10 asks one or two, so there is never a suggestion. */
  noSuggestion?: boolean
}

export interface MergeLogEntry {
  path: string
  kind: 'take-a' | 'take-b' | 'merge' | 'conflict'
  reason?: string
}

export interface MergeAcc {
  changesA: string[]
  changesB: string[]
  conflicts: FieldConflict[]
  log: MergeLogEntry[]
}

export interface TitleSides {
  base: SyncTitleState | undefined
  a: SyncTitleState | undefined
  b: SyncTitleState | undefined
}

export interface TitleOut {
  a: SyncTitleState
  b: SyncTitleState
  base: SyncTitleState
  stones: { a: TombstonesOf; b: TombstonesOf; base: TombstonesOf }
}

type TombstonesOf = { starred?: SyncTombstone; priority?: SyncTombstone }

type Decide<T> = (base: T | undefined, a: T | undefined, b: T | undefined) => Decision<T>

export function ruleFn<F>(table: readonly FieldRule[], rule: number): F {
  const r = table.find((x) => x.rule === rule)
  if (!r) throw new Error(`field table has no rule ${rule}`)
  return r.decide as unknown as F
}

/** Applies one decision: returns A's, B's and the next base's values, and records the change. */
function settle<T>(
  d: Decision<T>,
  sides: { base: T | undefined; a: T | undefined; b: T | undefined },
  path: string,
  acc: MergeAcc
): { a: T | undefined; b: T | undefined; base: T | undefined; conflict: boolean } {
  let out: { a: T | undefined; b: T | undefined; base: T | undefined }
  if (d.kind === 'unchanged') {
    out = { a: sides.a, b: sides.b, base: sides.base ?? sides.a ?? sides.b }
  } else if (d.kind === 'conflict') {
    acc.log.push({ path, kind: 'conflict', reason: d.reason })
    return { a: sides.a, b: sides.b, base: sides.base, conflict: true }
  } else {
    out = { a: d.value, b: d.value, base: d.value }
    acc.log.push({
      path,
      kind: d.kind === 'take' ? (d.from === 'a' ? 'take-a' : 'take-b') : 'merge'
    })
  }
  if (!sameValue(valueOf(out.a), valueOf(sides.a))) acc.changesA.push(path)
  if (!sameValue(valueOf(out.b), valueOf(sides.b))) acc.changesB.push(path)
  return { ...out, conflict: false }
}

// A changed clock alone is not a change; a value is.
function valueOf(v: unknown): unknown {
  if (v && typeof v === 'object' && 'value' in v && 'at' in v)
    return (v as SyncField<unknown>).value
  return v
}

function conflict(
  acc: MergeAcc,
  animeId: string,
  fieldPath: SyncConflictFieldPath,
  d: Extract<Decision<unknown>, { kind: 'conflict' }>,
  base: SyncField<unknown> | undefined,
  a: SyncField<unknown> | undefined,
  b: SyncField<unknown> | undefined,
  noSuggestion = false
): void {
  acc.conflicts.push({
    animeId,
    fieldPath,
    reason: d.reason,
    base: base?.value,
    a: a?.value,
    b: b?.value,
    ...(a ? { atA: { at: a.at, origin: a.origin } } : {}),
    ...(b ? { atB: { at: b.at, origin: b.origin } } : {}),
    ...(noSuggestion ? { noSuggestion: true } : {})
  })
}

function mergeWatch(
  table: readonly FieldRule[],
  id: string,
  s: TitleSides,
  acc: MergeAcc
): {
  a?: Record<string, SyncWatchEntry>
  b?: Record<string, SyncWatchEntry>
  base?: Record<string, SyncWatchEntry>
} {
  const decidePosition = ruleFn<Decide<SyncField<SyncWatchPosition>>>(table, 1)
  const decideWatched = ruleFn<Decide<SyncField<boolean>>>(table, 2)
  const decideWatchedAt = ruleFn<
    (
      base: unknown,
      a: { watched: boolean; watchedAt: number | null } | undefined,
      b: { watched: boolean; watchedAt: number | null } | undefined,
      ctx: { mergedWatched: boolean }
    ) => Decision<number | null>
  >(table, 3)
  const eps = new Set([...Object.keys(s.a?.watch ?? {}), ...Object.keys(s.b?.watch ?? {})])
  if (eps.size === 0) return { a: s.a?.watch, b: s.b?.watch, base: s.base?.watch }
  const out = {
    a: { ...(s.a?.watch ?? {}) },
    b: { ...(s.b?.watch ?? {}) },
    base: { ...(s.base?.watch ?? {}) }
  }
  for (const ep of [...eps].sort()) {
    const base = s.base?.watch?.[ep]
    const a = s.a?.watch?.[ep]
    const b = s.b?.watch?.[ep]
    const path = `titles.${id}.watch.${ep}`
    const pos = settle(
      decidePosition(base?.position, a?.position, b?.position),
      { base: base?.position, a: a?.position, b: b?.position },
      `${path}.position`,
      acc
    )
    const wd = decideWatched(base?.watched, a?.watched, b?.watched)
    if (wd.kind === 'conflict') {
      conflict(acc, id, `watch.${ep}.watched`, wd, base?.watched, a?.watched, b?.watched)
    }
    const w = settle(
      wd,
      { base: base?.watched, a: a?.watched, b: b?.watched },
      `${path}.watched`,
      acc
    )
    const sideOf = (e: SyncWatchEntry | undefined) =>
      e ? { watched: e.watched.value, watchedAt: e.watchedAt } : undefined
    const whenFor = (mergedWatched: boolean, own: SyncWatchEntry | undefined): number | null => {
      const d = decideWatchedAt(sideOf(base), sideOf(a), sideOf(b), { mergedWatched })
      return d.kind === 'merge' ? d.value : (own?.watchedAt ?? null)
    }
    const assemble = (
      position: SyncField<SyncWatchPosition> | undefined,
      watched: SyncField<boolean> | undefined,
      watchedAt: number | null
    ): SyncWatchEntry | undefined =>
      position && watched ? { position, watched, watchedAt } : undefined
    const aWhen = w.conflict ? (a?.watchedAt ?? null) : whenFor(!!w.a?.value, a)
    const bWhen = w.conflict ? (b?.watchedAt ?? null) : whenFor(!!w.b?.value, b)
    const nextA = assemble(pos.a, w.a, aWhen)
    const nextB = assemble(pos.b, w.b, bWhen)
    if (nextA) {
      if (a && a.watchedAt !== nextA.watchedAt && !acc.changesA.includes(`${path}.watched`)) {
        acc.changesA.push(`${path}.watchedAt`)
      }
      out.a[ep] = nextA
    }
    if (nextB) {
      if (b && b.watchedAt !== nextB.watchedAt && !acc.changesB.includes(`${path}.watched`)) {
        acc.changesB.push(`${path}.watchedAt`)
      }
      out.b[ep] = nextB
    }
    const nextBase = assemble(pos.base, w.base, w.conflict ? (base?.watchedAt ?? null) : aWhen)
    if (nextBase) out.base[ep] = nextBase
  }
  return out
}

function mergeRate(
  table: readonly FieldRule[],
  id: string,
  s: TitleSides,
  acc: MergeAcc
): { a?: SyncRateState; b?: SyncRateState; base?: SyncRateState } {
  const ra = s.a?.rate
  const rb = s.b?.rate
  const rbase = s.base?.rate
  if (!ra && !rb) return { base: rbase }
  const malId = ra?.malId ?? rb?.malId ?? rbase?.malId
  const rules: Record<SyncRateField, number> = { episodes: 4, status: 5, score: 6, rewatches: 7 }
  const a: Partial<SyncRateState> = {}
  const b: Partial<SyncRateState> = {}
  const base: Partial<SyncRateState> = {}
  for (const f of RATE_FIELDS) {
    const decide = ruleFn<Decide<SyncField<unknown>>>(table, rules[f])
    const sides = {
      base: rbase?.[f] as SyncField<unknown> | undefined,
      a: ra?.[f] as SyncField<unknown> | undefined,
      b: rb?.[f] as SyncField<unknown> | undefined
    }
    const d = decide(sides.base, sides.a, sides.b)
    if (d.kind === 'conflict') {
      const bothRose =
        f === 'rewatches' &&
        !!sides.base &&
        !!sides.a &&
        !!sides.b &&
        (sides.a.value as number) > (sides.base.value as number) &&
        (sides.b.value as number) > (sides.base.value as number)
      conflict(acc, id, `rate.${f}`, d, sides.base, sides.a, sides.b, bothRose)
    }
    const r = settle(d, sides, `titles.${id}.rate.${f}`, acc)
    if (r.a) (a as Record<string, unknown>)[f] = r.a
    if (r.b) (b as Record<string, unknown>)[f] = r.b
    if (r.base) (base as Record<string, unknown>)[f] = r.base
  }
  // A side with no rate that took only some fields is filled from the other side.
  const complete = (x: Partial<SyncRateState>, ...fill: Partial<SyncRateState>[]) => {
    if (RATE_FIELDS.every((f) => x[f] === undefined)) return undefined
    for (const f of RATE_FIELDS) {
      for (const src of fill)
        if (x[f] === undefined && src[f]) (x as Record<string, unknown>)[f] = src[f]
    }
    return RATE_FIELDS.every((f) => x[f] !== undefined)
      ? ({ ...x, malId } as SyncRateState)
      : undefined
  }
  return {
    a: complete(a, b, base),
    b: complete(b, a, base),
    base: complete(base, a, b)
  }
}

function toStones(m: Membership): SyncTombstone | undefined {
  return !m.present && Number.isFinite(m.at)
    ? { deleted: true, at: m.at, origin: m.origin }
    : undefined
}

function toField(m: Membership): SyncField<true> | undefined {
  return m.present ? { value: true, at: m.at, origin: m.origin } : undefined
}

/** One in-scope title: every rule but 10, which is doc-level. */
export function mergeTitle(
  table: readonly FieldRule[],
  id: string,
  docs: { base: SyncDoc | null; a: SyncDoc; b: SyncDoc },
  skip: SkipContext | undefined,
  acc: MergeAcc
): TitleOut {
  const s: TitleSides = { base: docs.base?.titles[id], a: docs.a.titles[id], b: docs.b.titles[id] }
  const out: TitleOut = {
    a: {},
    b: {},
    base: {},
    stones: { a: {}, b: {}, base: {} }
  }
  // The library's plain unknown keys at the title level (S5's plain-key carry).
  for (const [k, v] of Object.entries(s.b ?? {})) if (!KNOWN_TITLE_FIELDS.has(k)) out.a[k] = v
  for (const [k, v] of Object.entries(s.b ?? {})) if (!KNOWN_TITLE_FIELDS.has(k)) out.b[k] = v

  const watch = mergeWatch(table, id, s, acc)
  if (watch.a && Object.keys(watch.a).length) out.a.watch = watch.a
  if (watch.b && Object.keys(watch.b).length) out.b.watch = watch.b
  if (watch.base && Object.keys(watch.base).length) out.base.watch = watch.base

  // Rules 8 and 9.
  const decideMembership = ruleFn<
    (base: Membership | undefined, a: Membership, b: Membership) => Decision<Membership>
  >(table, 8)
  const decidePriority = ruleFn<
    (base: Membership | undefined, a: Membership, b: Membership) => Decision<Membership>
  >(table, 9)
  const member = (field: 'starred' | 'priority', decide: typeof decideMembership) => {
    const base = docs.base ? membershipOf(docs.base, id, field) : undefined
    const a = membershipOf(docs.a, id, field)
    const b = membershipOf(docs.b, id, field)
    const d = decide(base, a, b)
    const path = `titles.${id}.${field}`
    if (d.kind === 'take' || d.kind === 'merge') {
      acc.log.push({
        path,
        kind: d.kind === 'take' ? (d.from === 'a' ? 'take-a' : 'take-b') : 'merge'
      })
      return { a: d.value, b: d.value, base: d.value }
    }
    return { a, b, base: base ?? a }
  }
  const starred = member('starred', decideMembership)
  const prio = member('priority', decidePriority)
  const sides = ['a', 'b', 'base'] as const
  for (const side of sides) {
    const st = starred[side]
    const pr = enforcePriorityInvariant(st, prio[side])
    if (toField(st)) out[side].starred = toField(st)
    if (toField(pr)) out[side].priority = toField(pr)
    const stoneS = toStones(st)
    const stoneP = toStones(pr)
    if (stoneS) out.stones[side].starred = stoneS
    if (stoneP) out.stones[side].priority = stoneP
  }
  for (const side of ['a', 'b'] as const) {
    for (const f of ['starred', 'priority'] as const) {
      if (membershipOf(docs[side], id, f).present !== !!out[side][f]) {
        ;(side === 'a' ? acc.changesA : acc.changesB).push(`titles.${id}.${f}`)
      }
    }
  }

  const rate = mergeRate(table, id, s, acc)
  if (rate.a) out.a.rate = rate.a
  if (rate.b) out.b.rate = rate.b
  if (rate.base) out.base.rate = rate.base

  // Rule 11.
  const decideDismissed = ruleFn<Decide<string[]>>(table, 11)
  const dis = settle(
    decideDismissed(s.base?.dismissed, s.a?.dismissed, s.b?.dismissed),
    { base: s.base?.dismissed, a: s.a?.dismissed, b: s.b?.dismissed },
    `titles.${id}.dismissed`,
    acc
  )
  if (dis.a?.length) out.a.dismissed = dis.a
  if (dis.b?.length) out.b.dismissed = dis.b
  if (dis.base?.length) out.base.dismissed = dis.base

  // Rule 12: a cache, side A is this PC. The drive gets this PC's entries on top of its own.
  if (skip && (s.a?.skip || s.b?.skip)) {
    const decideSkip = ruleFn<
      (
        base: SyncSkipState | undefined,
        a: SyncSkipState | undefined,
        b: SyncSkipState | undefined,
        ctx: SkipContext
      ) => Decision<SyncSkipState | undefined>
    >(table, 12)
    const d = decideSkip(s.base?.skip, s.a?.skip, s.b?.skip, skip)
    const aSkip = d.kind === 'merge' ? d.value : s.a?.skip
    if (d.kind === 'merge') acc.changesA.push(`titles.${id}.skip`)
    const aOk = !!aSkip && sameValue(aSkip.algorithm, skip.algorithm)
    const bSkip =
      aOk && s.b?.skip && sameValue(s.b.skip.algorithm, aSkip!.algorithm)
        ? { ...aSkip!, perEpisode: { ...s.b.skip.perEpisode, ...aSkip!.perEpisode } }
        : aOk
          ? aSkip
          : s.b?.skip
    if (aSkip) out.a.skip = aSkip
    if (bSkip) {
      out.b.skip = bSkip
      if (!sameValue(bSkip, s.b?.skip)) acc.changesB.push(`titles.${id}.skip`)
    }
    if (bSkip ?? aSkip) out.base.skip = bSkip ?? aSkip
  } else {
    if (s.a?.skip) out.a.skip = s.a.skip
    if (s.b?.skip) out.b.skip = s.b.skip
  }
  return out
}
