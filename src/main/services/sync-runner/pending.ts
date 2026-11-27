// Tracker-bound merge results, per owner and per field (#584 §4, #715):
// `{ [malId]: { [field]: PendingField } }` in `userData/sync-pending/`, one
// file per owner. A Shikimori owner's is `<ownerId>.json` with a numeric
// `ownerId`, exactly as before; another tracker's is `<provider>-<userId>.json`
// with the string `userId`, a name v6's `^(\d{1,15})\.json$` never lists.
//
// This is the durable copy. A wholesale rate refresh can overwrite the cache;
// the projection still sees the pending value (`overlay`), so the next library
// leg never writes the server's old value back. Every value is written here
// (tmp + rename) before the cache is patched for display. Only the owner's
// single-flight run and the settle listener (queued behind it) write.

import { promises as fsp } from 'fs'
import * as path from 'path'
import type { StorageService } from '../../store/types'
import { rateClockKey } from '../../store/sync-meta'
import type { CachedRateEntry } from '../../lib/shikimori-rate-cache'

export interface PendingField {
  value: number | string
  clock: SyncClock
  provenance: SyncProvenance
  /** The cache's server value before any pending patch of this field. */
  prePatch: { value: number | string | null; serverUpdatedAt: string | null }
  /** A decision-5 rewatch raise the tracker hasn't accepted yet: kept off the drive. */
  unconfirmedRewatch?: true
  /** Consecutive 4xx drops of this field (3 make a held conflict). */
  drops?: number
}

export type PendingRates = Record<string, Partial<Record<SyncRateField, PendingField>>>

interface PendingFile {
  version: 1
  /** A Shikimori owner's numeric id; another tracker's string `userId` (#715). */
  ownerId: number | string
  rates: PendingRates
}

/** A pending file's owner (#715): `(provider, userId)`, `userId` the owner key's string. */
export interface PendingOwner {
  provider: TrackerId
  userId: string
}

const SHIKIMORI_FILE = /^(\d{1,15})\.json$/
// The same id charset as a base party (`lib/sync-state/bases.ts`).
const TRACKER_FILE = /^(anilist|mal)-([A-Za-z0-9_-]{1,128})\.json$/
const SHIKIMORI_ID = /^\d{1,15}$/
const TRACKER_ID = /^[A-Za-z0-9_-]{1,128}$/

export const parseAt = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY
}

export interface PendingStore {
  load(owner: PendingOwner): Promise<PendingRates>
  save(owner: PendingOwner, rates: PendingRates): Promise<void>
  /** Every owner with a pending file, in both forms. */
  owners(): Promise<PendingOwner[]>
}

/** The pending file's name for an owner: `<id>.json` for Shikimori, `<provider>-<id>.json` otherwise. */
export function pendingFileOf(owner: PendingOwner): string {
  if (owner.provider === 'shikimori') {
    if (!SHIKIMORI_ID.test(owner.userId)) throw new Error(`invalid pending owner: ${owner.userId}`)
    return `${owner.userId}.json`
  }
  if (!TRACKER_ID.test(owner.userId)) throw new Error(`invalid pending owner: ${owner.userId}`)
  return `${owner.provider}-${owner.userId}.json`
}

export function createPendingStore(dir: string): PendingStore {
  const fileOf = (owner: PendingOwner): string => path.join(dir, pendingFileOf(owner))
  return {
    async load(owner) {
      try {
        const body = JSON.parse(await fsp.readFile(fileOf(owner), 'utf8')) as PendingFile
        return body?.version === 1 && body.rates && typeof body.rates === 'object' ? body.rates : {}
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw err
      }
    },
    async save(owner, rates) {
      const file = fileOf(owner)
      for (const malId of Object.keys(rates)) {
        if (Object.keys(rates[malId] ?? {}).length === 0) delete rates[malId]
      }
      if (Object.keys(rates).length === 0) {
        await fsp.rm(file, { force: true })
        return
      }
      await fsp.mkdir(dir, { recursive: true })
      // Shikimori keeps exactly `{ version, ownerId, rates }` with a numeric id.
      const ownerId = owner.provider === 'shikimori' ? Number(owner.userId) : owner.userId
      const body: PendingFile = { version: 1, ownerId, rates }
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(body), 'utf8')
      await fsp.rename(`${file}.tmp`, file)
    },
    async owners() {
      try {
        const out: PendingOwner[] = []
        for (const n of await fsp.readdir(dir)) {
          const s = SHIKIMORI_FILE.exec(n)
          if (s) {
            out.push({ provider: 'shikimori', userId: String(Number(s[1])) })
            continue
          }
          const t = TRACKER_FILE.exec(n)
          if (t) out.push({ provider: t[1] as TrackerId, userId: t[2] })
        }
        return out
      } catch {
        return []
      }
    }
  }
}

/** The cached rate entry of `malId`, when `ownerId` is the signed-in user (the cache is theirs). */
export function cacheEntry(
  store: StorageService,
  ownerId: number,
  malId: number
): { entries: CachedRateEntry[]; idx: number } | null {
  if (store.get<{ id: number } | null>('shikimoriUser')?.id !== ownerId) return null
  const entries = store.get<CachedRateEntry[] | undefined>('shikimoriUserRates') ?? []
  const idx = entries.findIndex((e) => e.rate.target_id === malId)
  return { entries, idx }
}

/**
 * The per-field rate source the projection uses (§4): a pending value counts
 * while its clock is at least the field's `syncMeta` stamp, read under the
 * owner tracker's clock key (#715: Shikimori's `<userId>:<malId>`, another
 * tracker's `<provider>:<userId>:<malId>`). A newer user edit wins at once,
 * and its field is reported in `superseded` (path D). For the library leg
 * (`skipUnconfirmed`), an unconfirmed rewatch raise reads as the server value
 * it patched over, stamped with the tracker's origin, so it never reaches a
 * drive.
 */
export function overlay(
  store: StorageService,
  ownerId: number,
  malId: number,
  rates: PendingRates,
  opts: { skipUnconfirmed: boolean },
  superseded: { malId: number; field: SyncRateField }[],
  tracker: TrackerId = 'shikimori'
): Partial<Record<SyncRateField, SyncRateFieldClock>> | undefined {
  const fields = rates[String(malId)]
  if (!fields) return undefined
  const stamps =
    store.get<SyncMeta | undefined>('syncMeta')?.rates?.[rateClockKey(tracker, ownerId, malId)] ??
    {}
  const out: Partial<Record<SyncRateField, SyncRateFieldClock>> = {}
  for (const [f, p] of Object.entries(fields) as [SyncRateField, PendingField][]) {
    const stamp = stamps[f]
    if (stamp && stamp.at > p.clock.at) {
      superseded.push({ malId, field: f })
      continue
    }
    if (p.unconfirmedRewatch && opts.skipUnconfirmed) {
      if (p.prePatch.value === null) continue
      const at = parseAt(p.prePatch.serverUpdatedAt)
      out[f] = {
        value: p.prePatch.value,
        at: Number.isFinite(at) ? at : 0,
        origin: tracker
      }
      continue
    }
    out[f] = { value: p.value, at: p.clock.at, origin: p.clock.origin }
  }
  return out
}
