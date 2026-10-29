// Shikimori-bound merge results, per owner and per field (#584 §4):
// `userData/sync-pending/<ownerId>.json` = `{ [malId]: { [field]: PendingField } }`.
//
// This is the durable copy. A wholesale rate refresh can overwrite the cache;
// the projection still sees the pending value (`overlay`), so the next library
// leg never writes the server's old value back. Every value is written here
// (tmp + rename) before the cache is patched for display. Only the owner's
// single-flight run and the settle listener (queued behind it) write.

import { promises as fsp } from 'fs'
import * as path from 'path'
import type { StorageService } from '../../store/types'
import type { CachedRateEntry } from '../../lib/shikimori-rate-cache'

export interface PendingField {
  value: number | string
  clock: SyncClock
  provenance: SyncProvenance
  /** The cache's server value before any pending patch of this field. */
  prePatch: { value: number | string | null; serverUpdatedAt: string | null }
  /** A decision-5 rewatch raise Shikimori hasn't accepted yet: kept off the drive. */
  unconfirmedRewatch?: true
  /** Consecutive 4xx drops of this field (3 make a held conflict). */
  drops?: number
}

export type PendingRates = Record<string, Partial<Record<SyncRateField, PendingField>>>

interface PendingFile {
  version: 1
  ownerId: number
  rates: PendingRates
}

const FILE = /^(\d{1,15})\.json$/

export const parseAt = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY
}

export interface PendingStore {
  load(ownerId: number): Promise<PendingRates>
  save(ownerId: number, rates: PendingRates): Promise<void>
  owners(): Promise<number[]>
}

export function createPendingStore(dir: string): PendingStore {
  const fileOf = (ownerId: number): string => path.join(dir, `${ownerId}.json`)
  return {
    async load(ownerId) {
      try {
        const body = JSON.parse(await fsp.readFile(fileOf(ownerId), 'utf8')) as PendingFile
        return body?.version === 1 && body.rates && typeof body.rates === 'object' ? body.rates : {}
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw err
      }
    },
    async save(ownerId, rates) {
      const file = fileOf(ownerId)
      for (const malId of Object.keys(rates)) {
        if (Object.keys(rates[malId] ?? {}).length === 0) delete rates[malId]
      }
      if (Object.keys(rates).length === 0) {
        await fsp.rm(file, { force: true })
        return
      }
      await fsp.mkdir(dir, { recursive: true })
      const body: PendingFile = { version: 1, ownerId, rates }
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(body), 'utf8')
      await fsp.rename(`${file}.tmp`, file)
    },
    async owners() {
      try {
        return (await fsp.readdir(dir))
          .map((n) => FILE.exec(n)?.[1])
          .filter((n): n is string => !!n)
          .map(Number)
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
 * while its clock is at least the field's `syncMeta` stamp. A newer user edit
 * wins at once, and its field is reported in `superseded` (path D). For the
 * library leg (`skipUnconfirmed`), an unconfirmed rewatch raise reads as the
 * server value it patched over, so it never reaches a drive.
 */
export function overlay(
  store: StorageService,
  ownerId: number,
  malId: number,
  rates: PendingRates,
  opts: { skipUnconfirmed: boolean },
  superseded: { malId: number; field: SyncRateField }[]
): Partial<Record<SyncRateField, SyncRateFieldClock>> | undefined {
  const fields = rates[String(malId)]
  if (!fields) return undefined
  const stamps = store.get<SyncMeta | undefined>('syncMeta')?.rates?.[`${ownerId}:${malId}`] ?? {}
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
        origin: 'shikimori'
      }
      continue
    }
    out[f] = { value: p.value, at: p.clock.at, origin: p.clock.origin }
  }
  return out
}
