// The Shared Library merge runner (#584, epic #563): local ↔ library first,
// then the result ↔ Shikimori. The only writer of state to a drive.
//
// - The library leg runs per available owned or claimed library: read the pair
//   (S5), load the base, the rollback check, `merge3`, the owner-decision-5
//   raise, apply locally (S4's `applySyncDoc`, rates into the pending store),
//   write the drive (S5's `writeState`), and only then store the new base.
// - The Shikimori leg runs per owner, logged in as that owner and online,
//   after the drain: one `getUserAnimeRates`, path F, `merge3` against the
//   Shikimori base, and field-scoped queue entries for what Shikimori lacks.
// - Libraries that are foreign, videos only or read-only are never written.
// - Runs are single-flight per library (a second caller joins); every leg,
//   the settle listener and Forget's own steps run one at a time.

import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { EVENT_CHANNELS } from '@shared/ipc/channels'
import * as shikimoriApi from '../../shikimori'
import { isNetworkError } from '../../lib/errors'
import { createMutex } from '../../lib/async-mutex'
import { inspectLibrary, readMeta } from '../../lib/shared-library/read'
import { writeState as defaultWriteState } from '../../lib/shared-library/write'
import { toAnimeSearchResult } from '../../lib/shared-library/format'
import { createSyncBaseStore, type SyncBase } from '../../lib/sync-state/bases'
import { applySyncDoc } from '../../lib/sync-state/apply'
import { FIELD_TABLE, sameValue, type SkipContext } from '../../lib/sync-state/field-table'
import { pruneDocTombstones } from '../../lib/sync-state/gc'
import {
  RATE_FIELDS,
  SHIKIMORI_ORIGIN,
  defaultMalIdOf,
  projectRate,
  projectSyncDoc
} from '../../lib/sync-state/project'
import type { EpisodeFileIdentity } from '../../lib/sync-state/skip'
import { merge3 } from '../../lib/sync-merge/merge3'
import { normalizeDoc, ratesOnly, shikimoriNoBase } from '../../lib/sync-merge/no-base'
import { isRollback, rollbackAdjust } from '../../lib/sync-merge/rollback'
import { computeRaise, type WatchFlip } from '../../lib/sync-merge/raise'
import { reconcileLeg, type LegConflict } from '../../lib/sync-merge/conflicts'
import { NO_RATE_BEFORE, rateValues, type RateValues } from '../../lib/shikimori-rate'
import { mergeQueues, type QueuedShikimoriUpdate } from '../../lib/shikimori-queue'
import type { CachedRateEntry } from '../../lib/shikimori-rate-cache'
import type { StorageService } from '../../store/types'
import type { AttachedLibraryService } from '../attached-library'
import type { ShikimoriSyncService, ShikiItemSettled } from '../shikimori-sync'
import { buildActor } from './actor'
import { createConflictStore } from './conflicts'
import { createSyncLog, REWATCH_SUPERSEDED_REASON, type SyncLog } from './log'
import {
  cacheEntry,
  createPendingStore,
  overlay,
  parseAt,
  type PendingField,
  type PendingRates
} from './pending'
import { createForgetHook } from './forget'

const READ_ONLY_CODES = new Set(['EROFS', 'EACCES', 'EPERM'])
export const DROPS_TO_CONFLICT = 3

export interface SyncRunnerDeps {
  store: StorageService
  userDataDir: string
  attached: Pick<
    AttachedLibraryService,
    | 'list'
    | 'get'
    | 'refresh'
    | 'reportWriteFailure'
    | 'markSynced'
    | 'registerForgetHook'
    | 'onAvailabilityChanged'
  >
  sync: Pick<
    ShikimoriSyncService,
    'drainNow' | 'withQueueLock' | 'onItemSettled' | 'syncShikimoriQueue' | 'startSyncTimer'
  >
  isOffline(): boolean
  /** The online edge (S1a's `OFFLINE_STATE_CHANGED → online`). Returns an unsubscribe. */
  onOnline?(listener: () => void): () => void
  broadcast(channel: string, ...args: unknown[]): void
  /** `EVENT_CHANNELS.SYNC_RUN_FINISHED`, passed in by `index.ts` like the other services' channels. */
  runFinishedChannel?: string
  appVersion: string
  now?: () => number
  api?: Pick<typeof shikimoriApi, 'ensureFreshToken' | 'getUserAnimeRates'>
  /** This PC's file for an episode, which a drive skip entry must match (rule 12). */
  localEpisodeFile?(
    animeId: string,
    episodeInt: string
  ): { filePath: string; translationId: number; fileSize: number } | null
  resolveEpisodeFile?(
    animeId: string,
    episodeInt: string,
    filePath: string
  ): EpisodeFileIdentity | null
  skipAlgorithm?: ShowSkipDetections['algorithm']
  writeState?: typeof defaultWriteState
  /** A background rate refresh, when a reverted field has nothing to revert to. */
  refreshRates?(): void
  makeId?: () => string
  log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface SyncRunner {
  runAll(trigger: SyncTrigger): Promise<SyncRunResult>
  runLibrary(libraryId: string, trigger: SyncTrigger): Promise<SyncRunResult>
  runTitle(animeId: number, trigger: SyncTrigger): Promise<SyncRunResult>
  /** Resolves once no run of `libraryId` is in flight (S7c's `syncIdle`). */
  idle(libraryId: string): Promise<void>
  status(): Promise<SyncStatus>
  /** Resolves once every leg, settle and Forget step queued so far has run. */
  quiesce(): Promise<void>
  /**
   * Subscribes to the drain's settles and Forget, and with `triggers` (the
   * default) to availability and the online edge.
   */
  start(opts?: { triggers?: boolean }): void
  stop(): void
  readonly syncLog: SyncLog
}

export const DEFAULT_SKIP_ALGORITHM: ShowSkipDetections['algorithm'] = {
  source: 'local',
  sampleRate: 11025,
  matchBitThreshold: 6,
  minRunSec: 18,
  windowSec: 6,
  refineBitThreshold: 4,
  refineSustainHashes: 5
}

type Outcome = Pick<SyncLibraryResult, 'drive' | 'driveReason' | 'counts'> & {
  changes: string[]
  conflicts: { animeId: string; fieldPath: string; reason: string }[]
  clamps: { path: string; at: number; clampedTo: number }[]
  raises: { libraryId: string; animeId: string; malId: number; kind: string; episodes: number }[]
  resolvedElsewhere: { animeId: string; fieldPath: string }[]
}

interface ShikiOutcome {
  shikimori: SyncLibraryResult['shikimori']
  shikimoriReason?: SyncLibraryResult['shikimoriReason']
  waitingMalIds: number[]
  rewatchesSuperseded: number
  counts: { applied: number; conflicts: number }
  conflicts: { animeId: string; fieldPath: string; reason: string }[]
  resolvedElsewhere: { animeId: string; fieldPath: string }[]
}

const emptyCounts = (): SyncLibraryResult['counts'] => ({ applied: 0, conflicts: 0, clamped: 0 })

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

const WATCHED_PATH = /^titles\.([^.]+)\.watch\.(.+)\.watched$/

export function createSyncRunner(deps: SyncRunnerDeps): SyncRunner {
  const { store, attached } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? console
  const api = deps.api ?? shikimoriApi
  const writeState = deps.writeState ?? defaultWriteState
  const makeId = deps.makeId ?? randomUUID
  const bases = createSyncBaseStore(path.join(deps.userDataDir, 'sync-bases'), fs.promises)
  const pending = createPendingStore(path.join(deps.userDataDir, 'sync-pending'))
  const conflictStore = createConflictStore(path.join(deps.userDataDir, 'sync-state'))
  const syncLog = createSyncLog(path.join(deps.userDataDir, 'sync-log'))
  const work = createMutex()
  const inflight = new Map<string, Promise<SyncLibraryResult>>()
  const lastResults = new Map<string, SyncLibraryResult>()
  const unsubscribe: (() => void)[] = []

  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    const release = await work.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  const userId = (): number | null => store.get<{ id?: number } | null>('shikimoriUser')?.id ?? null

  // --- the rate cache, the pending store's display side --------------------------------

  function patchCache(
    ownerId: number,
    malId: number,
    values: Partial<Record<SyncRateField, number | string>>,
    serverUpdatedAt?: string
  ): void {
    const c = cacheEntry(store, ownerId, malId)
    if (!c || c.idx === -1 || Object.keys(values).length === 0) return
    const e = c.entries[c.idx]
    const rate = {
      ...e.rate,
      ...values,
      updated_at: new Date(now()).toISOString(),
      ...(serverUpdatedAt ? { serverUpdatedAt } : {})
    } as CachedRateEntry['rate']
    c.entries[c.idx] = { ...e, rate }
    store.set('shikimoriUserRates', c.entries)
    deps.broadcast(EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED, c.entries[c.idx])
  }

  /**
   * One rule for dropping a pending field (Forget, and every other drop but
   * path F): a wholesale refresh newer than the patch is kept; otherwise the
   * newer of `prePatch` and the Shikimori base; with neither, a refresh.
   */
  function revertTarget(
    ownerId: number,
    malId: number,
    field: SyncRateField,
    p: PendingField,
    shikiBase: SyncBase | null
  ): { value: number | string } | 'keep' | 'refresh' {
    const c = cacheEntry(store, ownerId, malId)
    const cached = c && c.idx !== -1 ? c.entries[c.idx].rate : null
    if (cached && parseAt(cached.serverUpdatedAt) > parseAt(p.prePatch.serverUpdatedAt))
      return 'keep'
    const baseField = Object.values(shikiBase?.doc.titles ?? {}).find(
      (t) => t.rate?.malId === malId
    )?.rate?.[field] as SyncField<number | string> | undefined
    const pre =
      p.prePatch.value !== null
        ? { value: p.prePatch.value, at: parseAt(p.prePatch.serverUpdatedAt) }
        : null
    if (pre && baseField)
      return baseField.at > pre.at ? { value: baseField.value } : { value: pre.value }
    if (pre) return { value: pre.value }
    if (baseField) return { value: baseField.value }
    return 'refresh'
  }

  async function revertFields(
    ownerId: number,
    dropped: { malId: number; field: SyncRateField; p: PendingField }[]
  ): Promise<void> {
    if (dropped.length === 0) return
    const shikiBase = await bases.read(`shikimori-${ownerId}`).catch(() => null)
    const byMal = new Map<number, Partial<Record<SyncRateField, number | string>>>()
    let refresh = false
    for (const d of dropped) {
      const t = revertTarget(ownerId, d.malId, d.field, d.p, shikiBase)
      if (t === 'keep') continue
      if (t === 'refresh') {
        refresh = true
        continue
      }
      byMal.set(d.malId, { ...byMal.get(d.malId), [d.field]: t.value })
    }
    for (const [malId, values] of byMal) patchCache(ownerId, malId, values)
    if (refresh && !deps.isOffline()) deps.refreshRates?.()
  }

  /**
   * A merge value into the pending store, with the first `prePatch` carried
   * forward when the field is already pending (refreshed only when a wholesale
   * refresh replaced the cache since). In memory; the caller saves, then patches.
   */
  function putPending(
    rates: PendingRates,
    ownerId: number,
    malId: number,
    field: SyncRateField,
    f: SyncField<number | string>,
    provenance: SyncProvenance,
    unconfirmedRewatch: boolean
  ): void {
    const fields = (rates[String(malId)] ??= {})
    const existing = fields[field]
    const c = cacheEntry(store, ownerId, malId)
    const cached = c && c.idx !== -1 ? c.entries[c.idx].rate : null
    const fresh = {
      value: (cached?.[field] as number | string | undefined) ?? null,
      serverUpdatedAt: cached?.serverUpdatedAt ?? null
    }
    const prePatch =
      existing &&
      !(cached && parseAt(cached.serverUpdatedAt) > parseAt(existing.prePatch.serverUpdatedAt))
        ? existing.prePatch
        : fresh
    fields[field] = {
      value: f.value,
      clock: { at: f.at, origin: f.origin },
      provenance,
      prePatch,
      ...(unconfirmedRewatch ? { unconfirmedRewatch: true as const } : {})
    }
  }

  function deletePending(
    rates: PendingRates,
    malId: number,
    field: SyncRateField
  ): PendingField | null {
    const fields = rates[String(malId)]
    const p = fields?.[field]
    if (!p) return null
    delete fields![field]
    if (Object.keys(fields!).length === 0) delete rates[String(malId)]
    return p
  }

  // --- conflicts -----------------------------------------------------------------------------

  async function reconcileConflicts(
    ownerScope: number,
    party: string,
    scope: Set<string>,
    list: LegConflict[],
    runId: string
  ): Promise<{ resolvedElsewhere: { animeId: string; fieldPath: string }[] }> {
    const records = await conflictStore.read()
    const r = reconcileLeg(
      records,
      { ownerScope, party, inScope: (id) => scope.has(id), conflicts: list, runId },
      makeId
    )
    if (!sameValue(r.records, records)) await conflictStore.write(r.records)
    return {
      resolvedElsewhere: r.removed.map((x) => ({ animeId: x.animeId, fieldPath: x.fieldPath }))
    }
  }

  // --- the library leg ------------------------------------------------------------------------

  function librarySkip(lib: AttachedLibraryInfo): Outcome | null {
    const skipped = (driveReason: SyncLibraryResult['driveReason']): Outcome => ({
      drive: 'skipped',
      driveReason,
      counts: emptyCounts(),
      changes: [],
      conflicts: [],
      clamps: [],
      raises: [],
      resolvedElsewhere: []
    })
    if (lib.mode === 'videos') return skipped('videos-only')
    if (lib.role !== 'owner' && lib.role !== 'claim') return skipped('foreign')
    if (!lib.available) return skipped('unavailable')
    if (lib.access === 'read-only') return skipped('read-only')
    return null
  }

  async function libraryLeg(
    lib: AttachedLibraryInfo,
    runId: string,
    animeId: string | null
  ): Promise<Outcome> {
    const skip = librarySkip(lib)
    if (skip) return skip
    const out: Outcome = {
      drive: 'ok',
      counts: emptyCounts(),
      changes: [],
      conflicts: [],
      clamps: [],
      raises: [],
      resolvedElsewhere: []
    }
    const fail = (driveReason: SyncLibraryResult['driveReason']): Outcome => ({
      ...out,
      drive: 'error',
      driveReason
    })
    const libraryId = lib.libraryId
    const insp = await inspectLibrary(lib.root)
    const read = insp.result
    if (read.status === 'none') return fail('unreadable')
    if (read.status === 'read-only') {
      return read.reason === 'interrupted'
        ? fail('unreadable')
        : { ...out, drive: 'skipped', driveReason: 'read-only' }
    }
    const manifest = read.manifest
    if (manifest.libraryId !== libraryId || manifest.mode !== 'metadata' || !manifest.owner) {
      return fail('unreadable')
    }
    const ownerId = manifest.owner.shikimoriId
    const role = lib.role
    const scopeAll = manifest.titles.map((t) => String(t.animeId))
    const scope = animeId === null ? scopeAll : scopeAll.filter((id) => id === animeId)
    const inScope = new Set(scope)
    const base = await bases.read(`library-${libraryId}`)
    const t = now()

    const isOwner = role === 'owner' && userId() === ownerId
    const rates: PendingRates = role === 'owner' ? await pending.load(ownerId) : {}
    const superseded: { malId: number; field: SyncRateField }[] = []
    const pendingRates = (owner: number, malId: number) =>
      owner === ownerId
        ? overlay(store, owner, malId, rates, { skipUnconfirmed: true }, superseded)
        : undefined
    const local = projectSyncDoc(store, scope, {
      resolveEpisodeFile: (id, ep, fp) => deps.resolveEpisodeFile?.(id, ep, fp) ?? null,
      pendingRates
    })
    // A claim PC has no session, so its projection has no rate: an absent side
    // never changed, and the library's rates pass through to the base (§4).

    let libDoc = normalizeDoc(read.state?.doc)
    if (base && isRollback(read.state?.generation ?? null, base.stateGeneration)) {
      const r = rollbackAdjust(libDoc, normalizeDoc(base.doc))
      libDoc = r.doc
      log.log(
        `[sync] ${lib.name}: the drive's state generation ${read.state?.generation} is below the base's ${base.stateGeneration}: an older replica (${r.replaced.length} fields predate the base)`
      )
    }

    const skipContext = (id: string): SkipContext => ({
      algorithm: deps.skipAlgorithm ?? DEFAULT_SKIP_ALGORITHM,
      localFile: (ep) => {
        const f = deps.localEpisodeFile?.(id, ep)
        return f ? { translationId: f.translationId, fileSize: f.fileSize } : null
      }
    })
    const m = merge3(base?.doc ?? null, local, libDoc, FIELD_TABLE, {
      now: t,
      scope,
      skip: skipContext,
      order: animeId === null
    })

    // The owner-decision-5 raise, on the owner's logged-in PC only.
    const unconfirmed = new Map<string, Set<SyncRateField>>()
    if (isOwner) {
      const malIdOf = defaultMalIdOf(store)
      for (const id of scope) {
        const flips: WatchFlip[] = []
        for (const p of m.changesA) {
          const w = WATCHED_PATH.exec(p)
          if (!w || w[1] !== id) continue
          const after = m.result.titles[id]?.watch?.[w[2]]?.watched
          const before = local.titles[id]?.watch?.[w[2]]?.watched
          if (after?.value === true && before?.value !== true) {
            flips.push({ episodeInt: w[2], at: after.at, origin: after.origin })
          }
        }
        if (flips.length === 0) continue
        const merged = m.result.titles[id]?.rate
        const malId = merged?.malId ?? malIdOf(id)
        if (malId === null || malId === undefined) continue
        const cached = cacheEntry(store, ownerId, malId)
        const cachedAt =
          cached && cached.idx !== -1
            ? parseAt(cached.entries[cached.idx].rate.serverUpdatedAt)
            : -Infinity
        const shikiClocks = merged
          ? RATE_FIELDS.map((f) => merged[f])
              .filter((f) => f.origin === SHIKIMORI_ORIGIN)
              .map((f) => f.at)
          : []
        const shikimoriAt = Math.max(cachedAt, ...shikiClocks)
        const raise = computeRaise({
          noBase: !base,
          flips,
          mergedRate: merged ? (rateValuesOf(merged) as RateValues) : null,
          shikimoriAt: Number.isFinite(shikimoriAt) ? shikimoriAt : null
        })
        if (!raise) continue
        const prev = merged ? rateValuesOf(merged) : NO_RATE_BEFORE
        const changed = RATE_FIELDS.filter((f) => !merged || prev[f] !== raise.rate[f])
        // Only the raised fields move: a conflicted field stays as each side has it.
        const raiseOnto = (rate: SyncRateState | undefined): SyncRateState => {
          const out = { ...(rate ?? merged ?? { malId }) } as SyncRateState
          out.malId = malId
          for (const f of RATE_FIELDS) {
            if (changed.includes(f) || !out[f]) {
              ;(out as unknown as Record<string, unknown>)[f] = {
                value: raise.rate[f],
                ...raise.clock
              }
            }
          }
          return out
        }
        ;(m.result.titles[id] ??= {}).rate = raiseOnto(merged)
        if (raise.kind === 'forward') {
          const t = (m.remote.titles[id] ??= {})
          t.rate = raiseOnto(t.rate)
          const nb = (m.nextBase.titles[id] ??= {})
          nb.rate = raiseOnto(nb.rate)
          for (const f of changed) m.changesB.push(`titles.${id}.rate.${f}`)
        } else {
          unconfirmed.set(id, new Set(changed))
        }
        out.raises.push({
          libraryId,
          animeId: id,
          malId,
          kind: raise.kind,
          episodes: raise.rate.episodes
        })
      }
    }

    // Apply locally. `starred` needs the drive's metadata snapshot when this PC has no row.
    const library = store.get<Record<string, unknown> | undefined>('library') ?? {}
    const downloaded = store.get<Record<string, unknown> | undefined>('downloadedAnime') ?? {}
    const searchResults = new Map<string, AnimeSearchResult>()
    for (const id of scope) {
      if (!m.result.titles[id]?.starred || library[id] || downloaded[id]) continue
      const meta = await readMeta(lib.root, Number(id)).catch(() => null)
      if (meta?.status === 'ok' && meta.meta.searchResult) {
        searchResults.set(id, toAnimeSearchResult(meta.meta.searchResult))
      }
    }
    const patches: { malId: number; values: Partial<Record<SyncRateField, number | string>> }[] = []
    const report = applySyncDoc(store, m.result, scope, {
      now,
      sharedSearchResult: (id) => searchResults.get(id) ?? null,
      localEpisodeFile: (id, ep) => deps.localEpisodeFile?.(id, ep) ?? null,
      skipAlgorithm: deps.skipAlgorithm ?? DEFAULT_SKIP_ALGORITHM,
      pendingRates,
      applyRate: (id, rate) => {
        if (role !== 'owner') return true
        const current = projectRate(store, rate.malId, { pendingRates })
        const values: Partial<Record<SyncRateField, number | string>> = {}
        for (const f of RATE_FIELDS) {
          if (current && sameValue(current[f].value, rate[f].value)) continue
          putPending(
            rates,
            ownerId,
            rate.malId,
            f,
            rate[f],
            { libraryId },
            !!unconfirmed.get(id)?.has(f)
          )
          values[f] = rate[f].value
        }
        patches.push({ malId: rate.malId, values })
        return true
      }
    })
    for (const s of superseded) deletePending(rates, s.malId, s.field)
    if (role === 'owner') {
      await pending.save(ownerId, rates)
      for (const p of patches) patchCache(ownerId, p.malId, p.values)
    }
    // A field left unapplied (no metadata to star it with) keeps its base, so it is retried.
    for (const u of report.unapplied) {
      const mm = /^titles\.([^.]+)\.(starred|priority|rate)$/.exec(u.path)
      if (!mm) continue
      const [, id, field] = mm
      const title = (m.nextBase.titles[id] ??= {})
      const old = base?.doc.titles[id]?.[field as 'starred']
      if (old !== undefined) (title as Record<string, unknown>)[field] = old
      else delete (title as Record<string, unknown>)[field]
      if (field !== 'rate') {
        const stone = base?.doc.tombstones[id]?.[field as 'starred']
        const stones = (m.nextBase.tombstones[id] ??= {})
        if (stone) stones[field as 'starred'] = stone
        else delete stones[field as 'starred']
      }
    }

    // The drive: the merged in-scope titles, every other title as the drive has it.
    const driveTitles = read.state?.doc.titles ?? {}
    const driveStones = read.state?.doc.tombstones ?? {}
    const doc: SyncDoc = {
      ...m.remote,
      titles: { ...m.remote.titles },
      tombstones: { ...m.remote.tombstones }
    }
    for (const [id, title] of Object.entries(driveTitles))
      if (!inScope.has(id)) doc.titles[id] = title
    for (const [id, s] of Object.entries(driveStones)) if (!inScope.has(id)) doc.tombstones[id] = s
    doc.tombstones = pruneDocTombstones(doc.tombstones, t, scopeAll)
    if (animeId !== null && read.state?.doc.priorityOrder)
      doc.priorityOrder = read.state.doc.priorityOrder
    const prunedStones = !sameValue(doc.tombstones, { ...driveStones })
    let stateGeneration = manifest.stateGeneration
    if (m.changesB.length > 0 || prunedStones) {
      try {
        const actor = buildActor(store, libraryId, deps.appVersion)
        const w = await writeState(lib.root, doc as SharedSyncDoc, actor, manifest.stateGeneration)
        stateGeneration = w.stateGeneration
        void attached.refresh(libraryId, lib.root).catch(() => {})
      } catch (err) {
        if (READ_ONLY_CODES.has(errCode(err) ?? '')) {
          attached.reportWriteFailure(libraryId, err)
          log.warn(`[sync] ${lib.name}: the drive write failed (${errCode(err)}); read-only now`)
          return {
            ...fail('write-failed-read-only'),
            counts: { ...out.counts, applied: m.changesA.length }
          }
        }
        log.warn(`[sync] ${lib.name}: the drive write failed; retried on the next trigger`, err)
        return { ...fail('io'), counts: { ...out.counts, applied: m.changesA.length } }
      }
    }

    // The base, only after the write succeeded.
    const nextBase = normalizeDoc(base?.doc ?? m.nextBase)
    for (const id of scope) {
      if (m.nextBase.titles[id] && Object.keys(m.nextBase.titles[id]).length > 0) {
        nextBase.titles[id] = m.nextBase.titles[id]
      } else delete nextBase.titles[id]
      const s = m.nextBase.tombstones[id]
      if (s && (s.starred || s.priority)) nextBase.tombstones[id] = s
      else delete nextBase.tombstones[id]
    }
    if (animeId === null || !base) nextBase.priorityOrder = m.nextBase.priorityOrder
    await bases.write(`library-${libraryId}`, { stateGeneration, doc: nextBase })

    const legConflicts: LegConflict[] = m.conflicts.map((c) => ({
      animeId: c.animeId,
      fieldPath: c.fieldPath,
      reason: c.reason,
      local: c.a,
      party: c.b,
      base: c.base,
      ...(c.atA ? { atLocal: c.atA } : {}),
      ...(c.atB ? { atParty: c.atB } : {}),
      ...(c.noSuggestion ? { noSuggestion: true } : {})
    }))
    const conv = await reconcileConflicts(
      ownerId,
      `library:${libraryId}`,
      inScope,
      legConflicts,
      runId
    )
    attached.markSynced(libraryId, now())
    return {
      ...out,
      counts: {
        applied: m.changesA.length + m.changesB.length,
        conflicts: m.conflicts.length,
        clamped: m.clamped.length
      },
      changes: [...m.changesA.map((p) => `local:${p}`), ...m.changesB.map((p) => `library:${p}`)],
      conflicts: m.conflicts.map((c) => ({
        animeId: c.animeId,
        fieldPath: c.fieldPath,
        reason: c.reason
      })),
      clamps: m.clamped.map((c) => ({ path: c.path, at: c.at, clampedTo: c.clampedTo })),
      resolvedElsewhere: conv.resolvedElsewhere
    }
  }

  // --- the Shikimori leg ---------------------------------------------------------------------

  async function shikimoriLeg(
    ownerId: number,
    ids: string[],
    runId: string
  ): Promise<ShikiOutcome> {
    const out: ShikiOutcome = {
      shikimori: 'ok',
      waitingMalIds: [],
      rewatchesSuperseded: 0,
      counts: { applied: 0, conflicts: 0 },
      conflicts: [],
      resolvedElsewhere: []
    }
    const fail = (
      shikimori: SyncLibraryResult['shikimori'],
      shikimoriReason: SyncLibraryResult['shikimoriReason']
    ): ShikiOutcome => ({ ...out, shikimori, shikimoriReason })
    if (userId() !== ownerId) return fail('skipped', userId() === null ? 'logged-out' : 'foreign')
    if (deps.isOffline()) return fail('skipped', 'offline')
    if (!store.get('shikimoriCredentials')) return fail('error', 'auth')

    const malIdOf = defaultMalIdOf(store)
    const live = new Set(
      (store.get<QueuedShikimoriUpdate[] | undefined>('shikimoriUpdateQueue') ?? []).map(
        (q) => q.malId
      )
    )
    let rows: shikimoriApi.ShikiAnimeRateEntry[]
    try {
      const token = await api.ensureFreshToken(store)
      rows = await api.getUserAnimeRates(token, ownerId)
    } catch (err) {
      if (err instanceof shikimoriApi.ShikiAuthError) return fail('error', 'auth')
      if (isNetworkError(err)) return fail('error', 'network')
      log.warn('[sync] the Shikimori read failed:', err)
      return fail('error', 'api')
    }
    if (userId() !== ownerId) return fail('skipped', userId() === null ? 'logged-out' : 'foreign')
    const rowOf = new Map(rows.map((r) => [r.target_id ?? r.anime.id, r]))

    const t = now()
    const rates = await pending.load(ownerId)
    const shikiBase = await bases.read(`shikimori-${ownerId}`)

    const titleIds: string[] = []
    const malOf = new Map<string, number>()
    for (const id of ids) {
      const malId = malIdOf(id)
      if (malId === null) continue
      if (live.has(malId)) {
        if (!out.waitingMalIds.includes(malId)) out.waitingMalIds.push(malId)
        continue
      }
      titleIds.push(id)
      malOf.set(id, malId)
    }
    if (out.waitingMalIds.length > 0) {
      log.log(`[sync] waiting for queued edits: MAL ${out.waitingMalIds.join(', ')}`)
    }

    // Path F: an unconfirmed rewatch raise older than the fresh row is cancelled.
    for (const [id, malId] of malOf) {
      const fields = rates[String(malId)]
      const raised = (Object.entries(fields ?? {}) as [SyncRateField, PendingField][]).filter(
        ([, p]) => p.unconfirmedRewatch
      )
      if (raised.length === 0) continue
      const row = rowOf.get(malId)
      const flipAt = Math.max(...raised.map(([, p]) => p.clock.at))
      if (!row || parseAt(row.updated_at) <= flipAt) continue
      for (const [f] of raised) deletePending(rates, malId, f)
      const episodes = raised.find(([f]) => f === 'episodes')?.[1].value
      const provenance = raised[0][1].provenance
      patchCache(ownerId, malId, rateValues(row), row.updated_at)
      await syncLog.append({
        kind: 'rewatch-superseded',
        runId,
        at: t,
        animeId: id,
        malId,
        episodes: typeof episodes === 'number' ? episodes : row.episodes,
        flipAt,
        shikimoriUpdatedAt: row.updated_at,
        libraryId: 'libraryId' in provenance ? provenance.libraryId : null,
        reason: REWATCH_SUPERSEDED_REASON
      })
      out.rewatchesSuperseded++
    }

    const superseded: { malId: number; field: SyncRateField }[] = []
    const local: SyncDoc = normalizeDoc(null)
    const shiki: SyncDoc = normalizeDoc(null)
    for (const [id, malId] of malOf) {
      const rate = projectRate(store, malId, {
        pendingRates: (o, mal) =>
          overlay(store, o, mal, rates, { skipUnconfirmed: false }, superseded)
      })
      if (rate) local.titles[id] = { rate }
      const row = rowOf.get(malId)
      if (row) {
        const clock = { at: parseAt(row.updated_at), origin: SHIKIMORI_ORIGIN }
        const at = Number.isFinite(clock.at) ? clock.at : 0
        const v = rateValues(row)
        shiki.titles[id] = {
          rate: {
            malId,
            episodes: { value: v.episodes, at, origin: SHIKIMORI_ORIGIN },
            status: { value: v.status, at, origin: SHIKIMORI_ORIGIN },
            score: { value: v.score, at, origin: SHIKIMORI_ORIGIN },
            rewatches: { value: v.rewatches, at, origin: SHIKIMORI_ORIGIN }
          }
        }
      }
    }
    for (const s of superseded) deletePending(rates, s.malId, s.field)
    const baseDoc = shikiBase
      ? ratesOnly(normalizeDoc(shikiBase.doc), titleIds)
      : shikimoriNoBase(shiki)
    const m = merge3(baseDoc, local, shiki, FIELD_TABLE, { now: t, scope: titleIds, order: false })

    const conflicted = new Set(m.conflicts.map((c) => `${c.animeId}:${c.fieldPath}`))
    // A field Shikimori rejected 3 times is a held conflict until it converges.
    const records = await conflictStore.read()
    const rejected = new Set(
      records
        .filter(
          (r) =>
            r.ownerScope === ownerId && r.reason === REJECTED_REASON && 'shikimori' in r.parties
        )
        .map((r) => `${r.animeId}:${r.fieldPath}`)
    )
    const nextBase = normalizeDoc(shikiBase?.doc ?? shiki)
    // Only this leg's own entries; the queue is re-read right before the write.
    const additions: QueuedShikimoriUpdate[] = []
    let queuedAt = t
    const legConflicts: LegConflict[] = m.conflicts.map((c) => ({
      animeId: c.animeId,
      fieldPath: c.fieldPath,
      reason: c.reason,
      local: c.a,
      party: c.b,
      base: c.base,
      ...(c.atA ? { atLocal: c.atA } : {}),
      ...(c.atB ? { atParty: c.atB } : {}),
      ...(c.noSuggestion ? { noSuggestion: true } : {})
    }))
    for (const id of titleIds) {
      const malId = malOf.get(id)!
      const row = rowOf.get(malId)
      const merged = m.remote.titles[id]?.rate
      const fromShiki: Partial<Record<SyncRateField, number | string>> = {}
      const push: SyncRateField[] = []
      for (const f of RATE_FIELDS) {
        const key = `${id}:rate.${f}`
        const path = `titles.${id}.rate.${f}`
        if (conflicted.has(key)) continue
        if (rejected.has(key)) {
          legConflicts.push({
            animeId: id,
            fieldPath: `rate.${f}`,
            reason: REJECTED_REASON,
            local: local.titles[id]?.rate?.[f].value,
            party: row ? rateValues(row)[f] : undefined,
            base: baseDoc.titles[id]?.rate?.[f].value
          })
          continue
        }
        const tookShikimori = m.changesA.includes(path) && !!row
        if (tookShikimori) {
          // Path B: Shikimori's value applied here; a pending value would hide it.
          fromShiki[f] = rateValues(row!)[f]
          deletePending(rates, malId, f)
        }
        if (m.changesB.includes(path)) push.push(f)
        else if (
          !tookShikimori &&
          row &&
          merged &&
          sameValue(merged[f].value, rateValues(row)[f])
        ) {
          // Path A: this PC's value, which the server already has.
          deletePending(rates, malId, f)
        }
        // The base: now for every field that needs no push; a pushed one waits for its settle.
        if (!m.changesB.includes(path)) {
          const nb = m.nextBase.titles[id]?.rate
          if (nb) {
            const title = (nextBase.titles[id] ??= {})
            title.rate = { ...(title.rate ?? nb), malId, [f]: nb[f] } as SyncRateState
          }
        }
      }
      if (Object.keys(fromShiki).length > 0 && row) {
        patchCache(ownerId, malId, fromShiki, row.updated_at)
        out.counts.applied += Object.keys(fromShiki).length
      }
      if (push.length > 0 && merged) {
        const after = rateValuesOf(merged) as RateValues
        const provenance: Partial<Record<SyncRateField, SyncProvenance>> = {}
        for (const f of push) {
          const p = rates[String(malId)]?.[f]
          if (p) provenance[f] = p.provenance
        }
        additions.push({
          malId,
          rateId: row?.id ?? null,
          before: row ? rateValues(row) : NO_RATE_BEFORE,
          after,
          queuedAt: queuedAt++,
          fields: push,
          ...(Object.keys(provenance).length > 0
            ? { origin: { kind: 'sync-merge' as const, provenance } }
            : {})
        })
        out.counts.applied += push.length
      }
    }
    out.counts.conflicts = legConflicts.length
    out.conflicts = legConflicts.map((c) => ({
      animeId: c.animeId,
      fieldPath: c.fieldPath,
      reason: c.reason
    }))
    await pending.save(ownerId, rates)
    await bases.write(`shikimori-${ownerId}`, { stateGeneration: null, doc: nextBase })
    const conv = await reconcileConflicts(
      ownerId,
      'shikimori',
      new Set(titleIds),
      legConflicts,
      runId
    )
    out.resolvedElsewhere = conv.resolvedElsewhere
    if (additions.length > 0) {
      // Re-read: a user edit or a drain may have written the queue during the awaits above.
      // In `queuedAt` order: a user edit made during the leg is newer than the
      // leg's entries, and `consolidateQueue` takes the last entry's `after`.
      const queue = mergeQueues(
        store.get<QueuedShikimoriUpdate[] | undefined>('shikimoriUpdateQueue') ?? [],
        additions
      )
      store.set('shikimoriUpdateQueue', queue)
      deps.broadcast(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, { length: queue.length })
      deps.sync.startSyncTimer()
      void deps.sync.syncShikimoriQueue()
    }
    return out
  }

  // --- the settle listener (path C, drops) ---------------------------------------------------

  /**
   * What Shikimori has for a pending field, as this PC last saw it: the cache,
   * when a refresh replaced the patch since; otherwise the value the patch
   * covered (`prePatch`). The cache itself shows the pending value.
   */
  function serverValueOf(
    ownerId: number,
    malId: number,
    field: SyncRateField,
    p: PendingField
  ): number | string | null {
    const c = cacheEntry(store, ownerId, malId)
    const cached = c && c.idx !== -1 ? c.entries[c.idx].rate : null
    if (cached && parseAt(cached.serverUpdatedAt) > parseAt(p.prePatch.serverUpdatedAt)) {
      return cached[field] as number | string
    }
    return p.prePatch.value ?? (cached?.[field] as number | string | undefined) ?? null
  }

  function animeIdOfMal(ownerId: number, malId: number): string | null {
    const c = cacheEntry(store, ownerId, malId)
    const fromCache =
      c && c.idx !== -1 ? (c.entries[c.idx].smotretAnime as { id?: number } | null)?.id : undefined
    if (fromCache !== undefined) return String(fromCache)
    const mapped = store.get<Record<string, { id?: number }> | undefined>('malIdMap')?.[
      String(malId)
    ]?.id
    return mapped !== undefined ? String(mapped) : null
  }

  async function onSettled(e: ShikiItemSettled): Promise<void> {
    const rates = await pending.load(e.ownerId)
    const fields = rates[String(e.malId)]
    let changed = false
    if (e.outcome === 'dropped') {
      const scope = (Object.keys(e.provenance ?? {}) as SyncRateField[]).filter((f) => fields?.[f])
      const held: SyncRateField[] = []
      for (const f of scope) {
        const p = fields![f]!
        p.drops = (p.drops ?? 0) + 1
        changed = true
        if (p.drops >= DROPS_TO_CONFLICT) held.push(f)
      }
      if (held.length > 0) {
        const id = animeIdOfMal(e.ownerId, e.malId)
        const records = await conflictStore.read()
        const r = reconcileLeg(
          records,
          {
            ownerScope: e.ownerId,
            party: 'shikimori',
            inScope: () => false,
            conflicts: held.map((f) => ({
              animeId: id ?? `mal:${e.malId}`,
              fieldPath: `rate.${f}` as SyncConflictFieldPath,
              reason: REJECTED_REASON,
              local: fields![f]!.value,
              party: serverValueOf(e.ownerId, e.malId, f, fields![f]!),
              base: null
            })),
            runId: `settle-${e.malId}`
          },
          makeId
        )
        await conflictStore.write(r.records)
        await syncLog.append({
          kind: 'shikimori-rejected',
          at: now(),
          malId: e.malId,
          fields: held,
          error: e.error ?? ''
        })
      }
    } else if (e.rate) {
      const values = rateValues(e.rate)
      for (const f of e.fieldsApplied) {
        const p = fields?.[f]
        if (p && sameValue(p.value, values[f])) {
          deletePending(rates, e.malId, f)
          changed = true
        }
      }
      const base = await bases.read(`shikimori-${e.ownerId}`)
      if (base && e.fieldsApplied.length > 0) {
        const doc = normalizeDoc(base.doc)
        const entry = Object.entries(doc.titles).find(([, ti]) => ti.rate?.malId === e.malId)
        if (entry?.[1].rate) {
          const rate = { ...entry[1].rate }
          for (const f of e.fieldsApplied) {
            ;(rate as unknown as Record<string, unknown>)[f] = {
              value: values[f],
              at: now(),
              origin: SHIKIMORI_ORIGIN
            }
          }
          doc.titles[entry[0]] = { ...entry[1], rate }
          await bases.write(`shikimori-${e.ownerId}`, { stateGeneration: null, doc })
        }
      }
    }
    if (changed) await pending.save(e.ownerId, rates)
  }

  // --- runs ------------------------------------------------------------------------------------

  async function run(
    trigger: SyncTrigger,
    pick: (lib: AttachedLibraryInfo) => boolean,
    animeId: string | null
  ): Promise<SyncRunResult> {
    const runId = makeId()
    const libs = attached.list().filter(pick)
    const joined = new Map<string, Promise<SyncLibraryResult>>()
    const fresh: AttachedLibraryInfo[] = []
    const settle = new Map<string, (r: SyncLibraryResult) => void>()
    for (const lib of libs) {
      const running = inflight.get(lib.libraryId)
      if (running) {
        joined.set(lib.libraryId, running)
        continue
      }
      fresh.push(lib)
      const p = new Promise<SyncLibraryResult>((resolve) => settle.set(lib.libraryId, resolve))
      inflight.set(lib.libraryId, p)
      joined.set(lib.libraryId, p)
    }
    const record: Extract<import('./log').SyncLogRecord, { kind: 'run' }> = {
      kind: 'run',
      runId,
      trigger,
      at: now(),
      libraries: fresh.map((l) => l.libraryId),
      counts: emptyCounts(),
      changes: [],
      conflicts: [],
      clamps: [],
      skippedMalIds: [],
      raises: [],
      resolvedElsewhere: [],
      result: { runId, trigger, libraries: [] }
    }
    const results = new Map<string, SyncLibraryResult>()
    try {
      const outcomes = await locked(async () => {
        const o = new Map<string, Outcome>()
        for (const lib of fresh) {
          try {
            o.set(lib.libraryId, await libraryLeg(lib, runId, animeId))
          } catch (err) {
            log.error(`[sync] the library leg failed for ${lib.name}:`, err)
            o.set(lib.libraryId, {
              drive: 'error',
              driveReason: 'io',
              counts: emptyCounts(),
              changes: [],
              conflicts: [],
              clamps: [],
              raises: [],
              resolvedElsewhere: []
            })
          }
        }
        return o
      })
      // One Shikimori leg per owner, over the union of that owner's in-scope titles.
      const owners = new Map<number, string[]>()
      for (const lib of fresh) {
        if (lib.mode !== 'metadata' || lib.role !== 'owner') continue
        const id = lib.libraryId
        const ownerId = userId()
        if (ownerId === null) continue
        const titles = (attached.get(id)?.titles ?? lib.titles).map((ti) => String(ti.animeId))
        const scoped = animeId === null ? titles : titles.filter((x) => x === animeId)
        owners.set(ownerId, [...new Set([...(owners.get(ownerId) ?? []), ...scoped])])
      }
      const shiki = new Map<number, ShikiOutcome>()
      for (const [ownerId, ids] of owners) {
        if (userId() === ownerId && !deps.isOffline()) await deps.sync.drainNow()
        try {
          shiki.set(ownerId, await locked(() => shikimoriLeg(ownerId, ids, runId)))
        } catch (err) {
          log.error('[sync] the Shikimori leg failed:', err)
          shiki.set(ownerId, {
            shikimori: 'error',
            shikimoriReason: isNetworkError(err) ? 'network' : 'api',
            waitingMalIds: [],
            rewatchesSuperseded: 0,
            counts: { applied: 0, conflicts: 0 },
            conflicts: [],
            resolvedElsewhere: []
          })
        }
      }
      for (const lib of fresh) {
        const o = outcomes.get(lib.libraryId)!
        const s = lib.role === 'owner' && userId() !== null ? shiki.get(userId()!) : undefined
        const shikiPart: Pick<SyncLibraryResult, 'shikimori' | 'shikimoriReason'> = s
          ? {
              shikimori: s.shikimori,
              ...(s.shikimoriReason ? { shikimoriReason: s.shikimoriReason } : {})
            }
          : { shikimori: 'skipped', shikimoriReason: shikiSkipReason(lib) }
        const r: SyncLibraryResult = {
          libraryId: lib.libraryId,
          drive: o.drive,
          ...(o.driveReason ? { driveReason: o.driveReason } : {}),
          ...shikiPart,
          counts: {
            applied: o.counts.applied + (s?.counts.applied ?? 0),
            conflicts: o.counts.conflicts + (s?.counts.conflicts ?? 0),
            clamped: o.counts.clamped
          },
          waitingMalIds: s ? [...s.waitingMalIds] : [],
          rewatchesSuperseded: s?.rewatchesSuperseded ?? 0
        }
        results.set(lib.libraryId, r)
        record.counts.applied += r.counts.applied
        record.counts.conflicts += r.counts.conflicts
        record.counts.clamped += r.counts.clamped
        record.changes.push(...o.changes)
        record.conflicts.push(...o.conflicts)
        record.clamps.push(...o.clamps)
        record.raises.push(...o.raises)
        record.resolvedElsewhere.push(...o.resolvedElsewhere)
      }
      for (const s of shiki.values()) {
        record.skippedMalIds.push(...s.waitingMalIds)
        record.conflicts.push(...s.conflicts)
        record.resolvedElsewhere.push(...s.resolvedElsewhere)
      }
    } finally {
      for (const lib of fresh) {
        const r =
          results.get(lib.libraryId) ??
          ({
            libraryId: lib.libraryId,
            drive: 'error',
            driveReason: 'io',
            shikimori: 'skipped',
            shikimoriReason: shikiSkipReason(lib),
            counts: emptyCounts(),
            waitingMalIds: [],
            rewatchesSuperseded: 0
          } satisfies SyncLibraryResult)
        lastResults.set(lib.libraryId, r)
        settle.get(lib.libraryId)!(r)
        inflight.delete(lib.libraryId)
      }
    }
    const libraries: SyncLibraryResult[] = []
    for (const lib of libs) libraries.push(await joined.get(lib.libraryId)!)
    const result: SyncRunResult = { runId, trigger, libraries }
    record.result = result
    if (fresh.length > 0) {
      // Under the mutex, as every other append: the size bound rewrites the file.
      await locked(() => syncLog.append(record)).catch((err) =>
        log.warn('[sync] could not write the sync log', err)
      )
    }
    deps.broadcast(deps.runFinishedChannel ?? EVENT_CHANNELS.SYNC_RUN_FINISHED, result)
    return result
  }

  function shikiSkipReason(lib: AttachedLibraryInfo): SyncLibraryResult['shikimoriReason'] {
    if (lib.role === 'claim') return 'claim'
    if (userId() === null) return 'logged-out'
    if (deps.isOffline()) return 'offline'
    return 'foreign'
  }

  const safe = (fn: () => Promise<unknown>) => (): void => {
    void fn().catch((err) => log.error('[sync] a triggered run failed:', err))
  }

  const runner: SyncRunner = {
    runAll: (trigger) => run(trigger, () => true, null),
    runLibrary: (libraryId, trigger) => run(trigger, (l) => l.libraryId === libraryId, null),
    runTitle: (animeId, trigger) =>
      run(
        trigger,
        (l) =>
          l.mode === 'metadata' &&
          (l.role === 'owner' || l.role === 'claim') &&
          l.titles.some((t) => t.animeId === animeId),
        String(animeId)
      ),
    async idle(libraryId) {
      await inflight.get(libraryId)?.catch(() => {})
    },
    async status() {
      const records = await conflictStore.read().catch(() => [])
      const libraries: SyncStatus['libraries'] = {}
      for (const lib of attached.list()) {
        const party = `library:${lib.libraryId}`
        libraries[lib.libraryId] = {
          last: lastResults.get(lib.libraryId) ?? null,
          needReview: records.filter((r) => party in r.parties).length
        }
      }
      return { running: [...inflight.keys()], libraries }
    },
    quiesce: () => locked(async () => {}),
    start(opts = {}) {
      if (opts.triggers !== false) {
        unsubscribe.push(
          attached.onAvailabilityChanged((t) => {
            if (t.available && t.access === 'read-write') {
              safe(() => runner.runLibrary(t.libraryId, 'plug'))()
            }
          })
        )
        if (deps.onOnline) unsubscribe.push(deps.onOnline(safe(() => runner.runAll('online'))))
      }
      unsubscribe.push(
        deps.sync.onItemSettled((e) => {
          void locked(() => onSettled(e)).catch((err) => log.error('[sync] settle failed:', err))
        })
      )
      unsubscribe.push(
        attached.registerForgetHook(
          createForgetHook({
            store,
            locked,
            sync: deps.sync,
            bases,
            pending,
            conflicts: conflictStore,
            attached,
            revertFields,
            pendingRatesFor: (ownerId, rates) => (o, malId) =>
              o === ownerId
                ? overlay(store, o, malId, rates, { skipUnconfirmed: true }, [])
                : undefined,
            resolveEpisodeFile: (id, ep, fp) => deps.resolveEpisodeFile?.(id, ep, fp) ?? null
          })
        )
      )
    },
    stop() {
      for (const u of unsubscribe.splice(0)) u()
    },
    syncLog
  }
  return runner
}

export const REJECTED_REASON = 'Shikimori rejected this change'

function rateValuesOf(rate: SyncRateState): RateValues {
  return rateValues({
    episodes: rate.episodes.value,
    status: rate.status.value as RateValues['status'],
    score: rate.score.value,
    rewatches: rate.rewatches.value
  })
}
