// The MAL → AniList id map (#703 § 4). The MAL id stays the cross-tracker key
// (Shikimori's anime ids are MAL ids), and AniList maps through `Media.idMal`.
//
// - The lookup is `Page.media(idMal_in)`, chunked by 50, matched on `idMal`
//   (results come out of order and unknown ids are omitted), at its caller's
//   priority class. It sends no token and never filters by `isAdult`.
// - Nothing makes `idMal` unique: of two media for one MAL id the map keeps the
//   one on the user's list, otherwise the lowest `id`.
// - `anilistIdMap` caches `{ anilistId, at }` per MAL id. Only a successful
//   lookup that omits an id records a negative entry, and negative entries
//   expire, so a title AniList adds later gets mapped. List reads seed it, and
//   it survives a logout.

import type { StorageService } from '../../store/types'
import type { AniListClient } from './client'
import type { AniListPriority } from './limiter'
import { ID_MAP_LOOKUP, PAGE_SIZE } from './queries'

/** How long a "not on AniList" answer holds before the title is asked again. */
export const NEGATIVE_ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface IdMapEntry {
  /** The AniList media id, or null: a successful lookup omitted the title. */
  anilistId: number | null
  at: number
}

export type IdMapRecord = Record<string, IdMapEntry>

const KEY = 'anilistIdMap'

/** The AniList media id a positive `anilistIdMap` entry holds, else null (no store write). */
export function storedAnilistMediaId(
  store: { get(key: string): unknown },
  malId: number
): number | null {
  const entry = (store.get(KEY) as IdMapRecord | undefined)?.[String(malId)]
  return typeof entry?.anilistId === 'number' ? entry.anilistId : null
}

/** The duplicate-`idMal` rule: the media on the user's list, otherwise the lowest `id`. */
export function pickMedia(ids: readonly number[], onList: ReadonlySet<number>): number {
  const listed = ids.filter((id) => onList.has(id))
  const pool = listed.length > 0 ? listed : ids
  return Math.min(...pool)
}

export interface AniListIdMap {
  /**
   * What the map knows: the AniList id, null for a fresh negative entry, or
   * undefined when it has no answer (never asked, or the negative expired).
   */
  known(malId: number): number | null | undefined
  /**
   * Answers every id, looking the unknown ones up in chunks of 50 at
   * `priority`. Rejects with the lookup's error and records nothing for that
   * chunk: no negative entry comes from a failure.
   */
  resolve(
    malIds: readonly number[],
    opts: { priority: AniListPriority; signal?: AbortSignal }
  ): Promise<Map<number, number | null>>
  /** Seeds the map from a list read (positive entries only). */
  seed(pairs: readonly { malId: number; anilistId: number }[]): void
}

export interface AniListIdMapDeps {
  store: StorageService
  client: AniListClient
  /** The AniList media ids on the user's list, for the duplicate rule. */
  listMediaIds?: () => ReadonlySet<number>
  now?: () => number
  negativeTtlMs?: number
}

export function createAniListIdMap(deps: AniListIdMapDeps): AniListIdMap {
  const { store, client } = deps
  const now = deps.now ?? Date.now
  const ttl = deps.negativeTtlMs ?? NEGATIVE_ENTRY_TTL_MS

  const read = (): IdMapRecord => (store.get(KEY) as IdMapRecord | undefined) ?? {}

  function known(malId: number): number | null | undefined {
    const entry = read()[String(malId)]
    if (!entry) return undefined
    if (entry.anilistId !== null) return entry.anilistId
    return now() - entry.at < ttl ? null : undefined
  }

  function write(updates: Record<string, IdMapEntry>): void {
    if (Object.keys(updates).length === 0) return
    store.set(KEY, { ...read(), ...updates })
  }

  async function resolve(
    malIds: readonly number[],
    opts: { priority: AniListPriority; signal?: AbortSignal }
  ): Promise<Map<number, number | null>> {
    const out = new Map<number, number | null>()
    const unknown: number[] = []
    for (const malId of new Set(malIds)) {
      const k = known(malId)
      if (k === undefined) unknown.push(malId)
      else out.set(malId, k)
    }
    for (let i = 0; i < unknown.length; i += PAGE_SIZE) {
      const chunk = unknown.slice(i, i + PAGE_SIZE)
      const data = await client.request<{
        Page: { media: { id: number; idMal: number | null }[] | null }
      }>(ID_MAP_LOOKUP, { ids: chunk }, { priority: opts.priority, signal: opts.signal })
      const byMal = new Map<number, number[]>()
      for (const m of data?.Page?.media ?? []) {
        if (typeof m?.idMal !== 'number' || typeof m.id !== 'number') continue
        byMal.set(m.idMal, [...(byMal.get(m.idMal) ?? []), m.id])
      }
      const onList = deps.listMediaIds?.() ?? new Set<number>()
      const at = now()
      const updates: Record<string, IdMapEntry> = {}
      for (const malId of chunk) {
        const ids = byMal.get(malId)
        const anilistId = ids ? pickMedia(ids, onList) : null
        updates[String(malId)] = { anilistId, at }
        out.set(malId, anilistId)
      }
      write(updates)
    }
    return out
  }

  function seed(pairs: readonly { malId: number; anilistId: number }[]): void {
    const current = read()
    const at = now()
    const updates: Record<string, IdMapEntry> = {}
    for (const { malId, anilistId } of pairs) {
      if (current[String(malId)]?.anilistId === anilistId) continue
      updates[String(malId)] = { anilistId, at }
    }
    write(updates)
  }

  return { known, resolve, seed }
}
