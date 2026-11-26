// Forget a library with pending changes (owner decision 8, #584 §4), through
// S7c (#581)'s forget-hook contract. Forget forgets everything that makes
// sense after the warning: the library's unwritten changes, its Shikimori
// pushes, and the unpushed review-screen choices for conflicts it was part of.
// It never touches the drive, and running it again is a no-op.

import { FIELD_TABLE } from '../../lib/sync-state/field-table'
import { projectSyncDoc } from '../../lib/sync-state/project'
import type { EpisodeFileIdentity } from '../../lib/sync-state/skip'
import type { SyncBaseStore } from '../../lib/sync-state/bases'
import { merge3 } from '../../lib/sync-merge/merge3'
import { dropLibraryParty } from '../../lib/sync-merge/conflicts'
import {
  keptByLaterVia,
  provenanceNames,
  revertAndRebase,
  stripProvenanceSlots,
  type ParkedQueues,
  type QueuedShikimoriUpdate
} from '../../lib/shikimori-queue'
import type { StorageService } from '../../store/types'
import type { AttachedLibraryService, ForgetHook } from '../attached-library'
import type { TrackerSyncService } from '../trackers/sync'
import type { ConflictStore } from './conflicts'
import type { PendingField, PendingRates, PendingStore } from './pending'

export interface ForgetHookDeps {
  store: StorageService
  locked<T>(fn: () => Promise<T>): Promise<T>
  /** Every tracker's queues are stripped, each under its own lock (#692 § 6). */
  trackers: Pick<TrackerSyncService<unknown, unknown>, 'trackerId' | 'keys' | 'withQueueLock'>[]
  bases: SyncBaseStore
  pending: PendingStore
  conflicts: ConflictStore
  attached: Pick<AttachedLibraryService, 'get'>
  revertFields(
    ownerId: number,
    dropped: { malId: number; field: SyncRateField; p: PendingField }[],
    opts?: { keep?: ReadonlySet<string> }
  ): Promise<void>
  pendingRatesFor(
    ownerId: number,
    rates: PendingRates
  ): (
    owner: number,
    malId: number
  ) => Partial<Record<SyncRateField, SyncRateFieldClock>> | undefined
  resolveEpisodeFile(
    animeId: string,
    episodeInt: string,
    filePath: string
  ): EpisodeFileIdentity | null
  now?: () => number
}

const isResolution = (p: SyncProvenance): boolean => 'resolution' in p

export function createForgetHook(deps: ForgetHookDeps): ForgetHook {
  const { store } = deps
  const now = deps.now ?? Date.now

  async function pendingCount(libraryId: string): Promise<SharedLibraryPendingCount> {
    let libraryChanges = 0
    let resolutions = 0
    const resolutionMalFields = new Set<string>()
    for (const ownerId of await deps.pending.owners()) {
      const rates = await deps.pending.load(ownerId)
      for (const [malId, fields] of Object.entries(rates)) {
        for (const [f, p] of Object.entries(fields ?? {})) {
          if (!p || !provenanceNames(p.provenance, libraryId)) continue
          if (isResolution(p.provenance)) {
            resolutions++
            resolutionMalFields.add(`${malId}:${f}`)
          } else libraryChanges++
        }
      }
    }
    // The in-scope fields where this PC differs from the library base.
    const base = await deps.bases.read(`library-${libraryId}`)
    const lib = deps.attached.get(libraryId)
    if (base && lib) {
      const scope = lib.titles.map((t) => String(t.animeId))
      const userId = store.get<{ id?: number } | null>('shikimoriUser')?.id ?? null
      const ownerRates = userId !== null ? await deps.pending.load(userId) : {}
      const local = projectSyncDoc(store, scope, {
        resolveEpisodeFile: deps.resolveEpisodeFile,
        pendingRates: userId !== null ? deps.pendingRatesFor(userId, ownerRates) : undefined
      })
      const diff = merge3(base.doc, local, base.doc, FIELD_TABLE, { now: now(), scope }).changesB
      for (const p of diff) {
        const m = /^titles\.([^.]+)\.rate\.(\w+)$/.exec(p)
        const malId = m ? base.doc.titles[m[1]]?.rate?.malId : undefined
        if (m && malId !== undefined && resolutionMalFields.has(`${malId}:${m[2]}`)) continue
        libraryChanges++
      }
    }
    const party = `library:${libraryId}`
    libraryChanges += (await deps.conflicts.read()).filter((r) => party in r.parties).length
    return { libraryChanges, resolutions }
  }

  // One tracker's live queue and parked buckets: stripped of the library's
  // fields, and every later `via` survivor rebased past what was stripped
  // (#692 § 6-7: owner-leg strips are passed for the rebase only). Returns
  // the live fields a later `via` survivor carries, for the owner revert.
  function stripTracker(
    keys: Pick<TrackerSyncService<unknown, unknown>['keys'], 'updateQueue' | 'parkedQueues'>,
    libraryId: string
  ): Set<string> {
    const live = store.get<QueuedShikimoriUpdate[] | undefined>(keys.updateQueue) ?? []
    const slots = stripProvenanceSlots(live, libraryId)
    const nextLive = revertAndRebase(slots).queue
    if (JSON.stringify(nextLive) !== JSON.stringify(live)) store.set(keys.updateQueue, nextLive)
    const parked = store.get<ParkedQueues | undefined>(keys.parkedQueues) ?? {}
    const nextParked: ParkedQueues = {}
    for (const [owner, bucket] of Object.entries(parked)) {
      const entries = revertAndRebase(stripProvenanceSlots(bucket.entries, libraryId)).queue
      if (entries.length > 0) nextParked[owner] = { ...bucket, entries }
    }
    if (JSON.stringify(nextParked) !== JSON.stringify(parked)) {
      store.set(keys.parkedQueues, nextParked)
    }
    return keptByLaterVia(slots)
  }

  async function onForgotten(libraryId: string): Promise<void> {
    await deps.locked(async () => {
      for (const t of deps.trackers) {
        await t.withQueueLock(async () => {
          const keep = stripTracker(t.keys, libraryId)
          // The pending store and its owner revert are Shikimori's.
          if (t.trackerId === 'shikimori') await revertOwner(libraryId, keep)
        })
      }
      await deps.bases.remove(`library-${libraryId}`)
      const records = await deps.conflicts.read()
      const next = dropLibraryParty(records, libraryId)
      if (next.length !== records.length || JSON.stringify(next) !== JSON.stringify(records)) {
        await deps.conflicts.write(next)
      }
    })
  }

  async function revertOwner(libraryId: string, keep: ReadonlySet<string>): Promise<void> {
    for (const ownerId of await deps.pending.owners()) {
      const rates = await deps.pending.load(ownerId)
      const dropped: { malId: number; field: SyncRateField; p: PendingField }[] = []
      for (const [malId, fields] of Object.entries(rates)) {
        for (const [f, p] of Object.entries(fields ?? {}) as [SyncRateField, PendingField][]) {
          if (!provenanceNames(p.provenance, libraryId)) continue
          dropped.push({ malId: Number(malId), field: f, p })
          delete fields![f]
        }
      }
      if (dropped.length === 0) continue
      await deps.pending.save(ownerId, rates)
      await deps.revertFields(ownerId, dropped, { keep })
    }
  }

  return { pendingCount, onForgotten }
}
