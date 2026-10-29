// The first merge with no base (#584 §1), and the doc shapes the engine takes.
// The per-field no-base rule itself is S4's field table: every `decide*` with
// `base === undefined` reduces to §1's table (equal values unchanged; a value
// on one side only taken; `position` / membership / order to the later `at`,
// a tie to side A; `watched: true` wins; `episodes` takes the max; differing
// `status` / `score` / `rewatches` conflict; `dismissed` a union). Pure.

import { RATE_FIELDS } from '../sync-state/project'

const NO_ORDER: SyncField<string[]> = { value: [], at: Number.NEGATIVE_INFINITY, origin: '' }

/**
 * A drive's `SharedSyncDoc` (every doc-level field optional), or no state at
 * all (S5's empty state, `stateGeneration: null`), as a full `SyncDoc`. A
 * missing field is absence: with no base it is "never had it", never a
 * deletion. The library's plain unknown keys are kept.
 */
export function normalizeDoc(doc: SharedSyncDoc | SyncDoc | null | undefined): SyncDoc {
  return {
    ...(doc ?? {}),
    stateVersion: 1,
    stateMinor: doc?.stateMinor ?? 0,
    installId: typeof doc?.installId === 'string' ? doc.installId : '',
    titles: { ...(doc?.titles ?? {}) },
    priorityOrder: doc?.priorityOrder ?? NO_ORDER,
    tombstones: { ...(doc?.tombstones ?? {}) }
  }
}

/** Whether a doc has a priority order of its own (a drive doc may have none). */
export function hasOrder(doc: SharedSyncDoc | SyncDoc | null | undefined): boolean {
  return !!doc?.priorityOrder && Number.isFinite(doc.priorityOrder.at)
}

/**
 * The Shikimori leg with no base (§1): the base *is* the Shikimori side. The
 * cache mirrors the server and the drain has run, so the only local
 * differences are this PC's real pending results, and they are pushed.
 */
export function shikimoriNoBase(shikimori: SyncDoc): SyncDoc {
  return structuredClone(shikimori)
}

/** A rates-only doc: the Shikimori leg merges `titles[id].rate` and nothing else. */
export function ratesOnly(doc: SyncDoc, ids: Iterable<string>): SyncDoc {
  const titles: Record<string, SyncTitleState> = {}
  for (const id of ids) {
    const rate = doc.titles[id]?.rate
    if (rate && RATE_FIELDS.every((f) => rate[f] !== undefined)) titles[id] = { rate }
  }
  return {
    stateVersion: 1,
    stateMinor: 0,
    installId: doc.installId,
    titles,
    priorityOrder: NO_ORDER,
    tombstones: {}
  }
}
