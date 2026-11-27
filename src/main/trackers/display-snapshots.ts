// Display snapshots (#568, #570; per provider since #709): what a view last
// showed, kept for the account it was fetched for and persisted to one file
// per provider, `userData/<provider>-snapshots.json`, as
// `{ version: 1, userId, <section>?: { data, fetchedAt } }`. Shikimori's
// calendar and friends activity and AniList's calendar use it.
//
// - A record belongs to the user it was fetched for: a mismatch reads as none,
//   and `put` stores (and persists) only a record for the signed-in user, so a
//   fetch that outlived an account switch never evicts the new user's.
// - The file is written tmp + rename, and only by `put`: a provider that never
//   stored a snapshot never gets one.
// - At creation the file is loaded only when its `userId` is the signed-in
//   user's, and deleted otherwise. `clear` (logout, account switch) drops every
//   section and deletes it.
// - Offline a snapshot is served whatever its age; `serveCalendar` is the
//   calendar's TTL, offline and failed-fetch rules for every provider.

import * as fs from 'fs'
import * as path from 'path'

export interface SnapshotRecord<T> {
  data: T
  fetchedAt: number
  userId: number | null
}

type Records = Record<string, SnapshotRecord<unknown[]>>

export interface DisplaySnapshotsDeps<M extends Records> {
  /** Unset keeps the snapshots in memory. */
  path?: string
  /** The sections in the order the file lists them. */
  sections: readonly (keyof M & string)[]
  /** The signed-in user of this provider, or undefined. */
  currentUserId: () => number | undefined
  /** The log prefix, e.g. `[shikimori]`. */
  label: string
  /** A loaded section's in-memory record, for the signed-in `userId`. */
  revive: {
    [K in keyof M]: (stored: { data: M[K]['data']; fetchedAt: number }, userId: number) => M[K]
  }
}

export interface DisplaySnapshots<M extends Records> {
  /** The section's record when it is the signed-in user's, else null. */
  get<K extends keyof M>(section: K): M[K] | null
  /** Stores and persists `record` when it is the signed-in user's; otherwise a no-op. */
  put<K extends keyof M>(section: K, record: M[K]): void
  /** Rewrites the in-memory record, whoever's it is (the calendar's invalidation). */
  update<K extends keyof M>(section: K, fn: (record: M[K]) => M[K]): void
  /** Drops every section and deletes the file: logout and account switch. */
  clear(): void
}

export function createDisplaySnapshots<M extends Records>(
  deps: DisplaySnapshotsDeps<M>
): DisplaySnapshots<M> {
  const records: { [K in keyof M]?: M[K] | null } = {}

  function isCurrentUser(userId: number | null): boolean {
    return userId === (deps.currentUserId() ?? null)
  }

  function get<K extends keyof M>(section: K): M[K] | null {
    const record = records[section] ?? null
    return record && isCurrentUser(record.userId) ? record : null
  }

  function put<K extends keyof M>(section: K, record: M[K]): void {
    if (!isCurrentUser(record.userId)) return
    records[section] = record
    persist(record.userId)
  }

  function update<K extends keyof M>(section: K, fn: (record: M[K]) => M[K]): void {
    const record = records[section]
    if (record) records[section] = fn(record)
  }

  function clear(): void {
    for (const section of deps.sections) records[section] = null
    deleteFile()
  }

  function deleteFile(): void {
    if (!deps.path) return
    try {
      fs.rmSync(deps.path, { force: true })
    } catch (err) {
      console.warn(`${deps.label} could not delete the offline snapshots:`, err)
    }
  }

  // Tmp + rename, so a crash mid-write leaves the previous file whole.
  function persist(userId: number | null): void {
    const file = deps.path
    if (!file || userId === null) return
    const body: Record<string, unknown> = { version: 1, userId }
    for (const section of deps.sections) {
      const record = records[section]
      if (record?.userId === userId) {
        body[section] = { data: record.data, fetchedAt: record.fetchedAt }
      }
    }
    const tmp = `${file}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(body))
      fs.renameSync(tmp, file)
    } catch (err) {
      console.warn(`${deps.label} could not persist the offline snapshots:`, err)
    }
  }

  function load(): void {
    const file = deps.path
    if (!file) return
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    }
    const userId = deps.currentUserId()
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.userId !== 'number' ||
      parsed.userId !== userId
    ) {
      deleteFile()
      return
    }
    for (const section of deps.sections) {
      const stored = parsed[section] as { data?: unknown; fetchedAt?: unknown } | undefined
      if (stored && Array.isArray(stored.data) && typeof stored.fetchedAt === 'number') {
        records[section] = deps.revive[section](
          { data: stored.data as M[typeof section]['data'], fetchedAt: stored.fetchedAt },
          userId
        )
      }
    }
  }

  load()

  return { get, put, update, clear }
}

/** A calendar snapshot: online an invalidated one is a miss, offline it is still served. */
export interface CalendarSnapshot<E> extends SnapshotRecord<E[]> {
  invalidated: boolean
}

/**
 * A provider's calendar section (#747). Every `invalidate()` bumps a counter,
 * with or without a record; `fetchCalendar` takes `begin()` before it reads the
 * rates and hands it to `put` as `since`, so a fetch an invalidation overlapped
 * stores its result already invalidated, the very first fetch included. A fetch
 * that begins after an invalidation reads the post-edit rates: every
 * invalidation fires after its `store.set` of the rates (the sync instance's
 * `onRateUpdated` and `onRatesRefreshed`, and the Shikimori primary's direct
 * edit paths). The empty-rates self-fill (`fetchAndCacheRates`) fires neither
 * hook, so it bumps nothing.
 */
export interface CalendarCache<E> {
  /** The signed-in user's snapshot, or null. */
  get(): CalendarSnapshot<E> | null
  /** Marks the snapshot invalidated and bumps the counter. */
  invalidate(): void
  /** The counter now: a fetch's `since`. */
  begin(): number
  /**
   * Stores (for the signed-in user only) and returns the snapshot; it is
   * invalidated when `since` is given and an `invalidate()` came after it.
   */
  put(data: E[], userId: number | null, since?: number): CalendarSnapshot<E>
}

export function createCalendarCache<E>(
  snapshots: DisplaySnapshots<{ calendar: CalendarSnapshot<E> }>
): CalendarCache<E> {
  let invalidations = 0
  return {
    get: () => snapshots.get('calendar'),
    invalidate: () => {
      invalidations++
      snapshots.update('calendar', (c) => ({ ...c, invalidated: true }))
    },
    begin: () => invalidations,
    put: (data, userId, since) => {
      const snapshot: CalendarSnapshot<E> = {
        data,
        fetchedAt: Date.now(),
        userId,
        invalidated: since !== undefined && since !== invalidations
      }
      // A fetch that outlived an account switch must not evict the new user's snapshot.
      snapshots.put('calendar', snapshot)
      return snapshot
    }
  }
}

export function freshResult<T>(snapshot: { data: T; fetchedAt: number }): ShikiSnapshotResult<T> {
  return { data: snapshot.data, fetchedAt: snapshot.fetchedAt, stale: false }
}

export function staleResult<E>(
  snapshot: { data: E[]; fetchedAt: number } | null
): ShikiSnapshotResult<E[]> {
  return snapshot
    ? { data: snapshot.data, fetchedAt: snapshot.fetchedAt, stale: true }
    : { data: [], fetchedAt: null, stale: true }
}

/**
 * The calendar's read for any provider (#568, #709): offline the snapshot
 * whatever its age, before anything that could reach the network (with none,
 * an empty stale shape); online a valid snapshot younger than `ttlMs` unless
 * `force`; otherwise `fetch`, and when that fails the snapshot, served stale,
 * if there is one.
 */
export async function serveCalendar<E>(opts: {
  cached: () => CalendarSnapshot<E> | null
  isOffline: () => boolean
  fetch: () => Promise<SnapshotRecord<E[]>>
  force: boolean
  ttlMs: number
  label: string
}): Promise<ShikiSnapshotResult<E[]>> {
  const cachedCalendar = opts.cached()
  if (opts.isOffline()) return staleResult(cachedCalendar)
  if (
    !opts.force &&
    cachedCalendar &&
    !cachedCalendar.invalidated &&
    Date.now() - cachedCalendar.fetchedAt < opts.ttlMs
  ) {
    return freshResult(cachedCalendar)
  }
  try {
    return freshResult(await opts.fetch())
  } catch (err) {
    const snapshot = opts.cached()
    if (!snapshot) throw err
    console.warn(`${opts.label} calendar fetch failed, serving the snapshot:`, err)
    return staleResult(snapshot)
  }
}
