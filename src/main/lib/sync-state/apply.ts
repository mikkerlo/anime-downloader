// A SyncDoc written back into the local store (#572 §4). Only in-scope titles
// are touched: an out-of-scope id is never added, removed or reordered. No
// `fs`: local files and the Shared Library's metadata come from `deps`.

import type { StorageService } from '../../store/types'
import { updateSyncMeta } from '../../store/sync-meta'
import { LEGACY_ORIGIN, clampSyncDoc, watchSyncOf } from './clock'
import { reconcileOrder, sameValue } from './field-table'
import {
  KNOWN_DOC_FIELDS,
  KNOWN_TITLE_FIELDS,
  RATE_FIELDS,
  projectRate,
  type ProjectDeps
} from './project'
import { restoreSkipEpisode } from './skip'

export interface ApplyDeps extends Pick<ProjectDeps, 'pendingRates'> {
  now(): number
  /**
   * The Shared Library's `meta/<animeId>.json` `searchResult` (S5 #573): the
   * last place `starred = true` looks for the `AnimeSearchResult` a `library`
   * row needs, after local `library` and `downloadedAnime`.
   */
  sharedSearchResult?(animeId: string): AnimeSearchResult | null
  /** This PC's file for an episode, which a drive skip entry must match. */
  localEpisodeFile(
    animeId: string,
    episodeInt: string
  ): { filePath: string; translationId: number; fileSize: number } | null
  /** The skip detector's algorithm on this PC. */
  skipAlgorithm: ShowSkipDetections['algorithm']
  /**
   * S9 (#584)'s writer for rate fields (its pending store, never only the
   * cache). `true` when written, otherwise the reason it wasn't. Without it a
   * rate change is reported unapplied.
   */
  applyRate?(animeId: string, rate: SyncRateState): true | string
}

// The clock a legacy star or priority projects with when `syncMeta` has none.
// Stamping it back would be a write that records nothing.
function isLegacyClock(clock: SyncClock): boolean {
  return clock.at === 0 && clock.origin === LEGACY_ORIGIN
}

function read<T>(store: StorageService, key: string, fallback: T): T {
  return structuredClone(store.get<T | undefined>(key) ?? fallback)
}

/**
 * Rule 10's apply: `priority` with the slots that in-scope ids occupy
 * rewritten in `inScopeOrder`. Out-of-scope ids keep their positions; extra
 * in-scope ids go at the end, and slots left over are dropped.
 */
export function rewritePrioritySlots(
  priority: readonly string[],
  inScope: ReadonlySet<string>,
  inScopeOrder: readonly string[]
): string[] {
  const out: string[] = []
  let next = 0
  for (const id of priority) {
    if (!inScope.has(id)) out.push(id)
    else if (next < inScopeOrder.length) out.push(inScopeOrder[next++])
  }
  while (next < inScopeOrder.length) out.push(inScopeOrder[next++])
  return out
}

export function applySyncDoc(
  store: StorageService,
  input: SyncDoc,
  scope: Iterable<string | number>,
  deps: ApplyDeps
): SyncApplyReport {
  const now = deps.now()
  const { doc, clamped } = clampSyncDoc(input, now)
  const report: SyncApplyReport = { applied: [], unapplied: [], clamped }
  const inScope = new Set([...scope].map(String))

  const watchProgress = read<Record<string, WatchProgressEntry>>(store, 'watchProgress', {})
  const library = read<Record<string, AnimeSearchResult>>(store, 'library', {})
  const downloaded = read<Record<string, AnimeSearchResult>>(store, 'downloadedAnime', {})
  const priorityBefore = read<string[]>(store, 'priorityAnimeIds', [])
  const priority = [...priorityBefore]
  const dismissedBefore = read<string[]>(store, 'dismissedContinueWatching', [])
  let dismissed = [...dismissedBefore]
  const skipDetections = read<Record<string, ShowSkipDetections>>(store, 'skipDetections', {})
  const metaBefore = store.get<SyncMeta | undefined>('syncMeta')
  const missingClock = { at: 0, origin: store.get<string | undefined>('installId') ?? '' }
  const metaEdits: ((meta: SyncMeta) => void)[] = []
  const changed = new Set<string>()

  const titleIds = [...new Set([...Object.keys(doc.titles), ...Object.keys(doc.tombstones)])]
    .filter((id) => inScope.has(id))
    .sort()

  for (const id of titleIds) {
    const title: SyncTitleState = doc.titles[id] ?? {}
    const stones = doc.tombstones[id] ?? {}
    const path = `titles.${id}`

    for (const [episodeInt, entry] of Object.entries(title.watch ?? {})) {
      const key = `${id}:${episodeInt}`
      const prev = watchProgress[key]
      const next: WatchProgressEntry = {
        position: entry.position.value.position,
        duration: entry.position.value.duration,
        updatedAt: prev?.updatedAt ?? entry.position.at,
        watched: entry.watched.value,
        watchedAt: entry.watchedAt ?? undefined,
        translationId: entry.position.value.translationId,
        sync: {
          position: { at: entry.position.at, origin: entry.position.origin },
          watched: { at: entry.watched.at, origin: entry.watched.origin }
        }
      }
      // A row compares by the clocks it projects (a legacy row's, or `at: 0`
      // for a missing one), so applying a store's own projection leaves it as it is.
      const clocks = prev && watchSyncOf(prev)
      const seen = prev && {
        ...prev,
        watched: !!prev.watched,
        sync: {
          position: clocks!.position ?? missingClock,
          watched: clocks!.watched ?? missingClock
        }
      }
      if (seen && sameValue(next, seen)) continue
      // From the doc's clock, as `watch-progress:save` does: rows brought in by
      // a sync keep their own recency instead of all reading "now".
      next.updatedAt = Math.max(prev?.updatedAt ?? 0, entry.position.at)
      watchProgress[key] = next
      changed.add('watchProgress')
      report.applied.push(`${path}.watch.${episodeInt}`)
    }

    if (title.starred) {
      const clock = { at: title.starred.at, origin: title.starred.origin }
      if (!library[id]) {
        const anime = downloaded[id] ?? deps.sharedSearchResult?.(id) ?? null
        if (anime) {
          library[id] = anime
          changed.add('library')
          report.applied.push(`${path}.starred`)
        } else {
          report.unapplied.push({
            path: `${path}.starred`,
            reason: 'no AnimeSearchResult for this title'
          })
        }
      }
      if (library[id] && !(isLegacyClock(clock) && !metaBefore?.titles?.[id]?.starred)) {
        metaEdits.push((m) => ((m.titles[id] ??= {}).starred = clock))
      }
    } else if (stones.starred) {
      const stone = stones.starred
      if (library[id]) {
        delete library[id]
        changed.add('library')
        report.applied.push(`${path}.starred`)
      }
      metaEdits.push((m) => ((m.titles[id] ??= {}).starred = { ...stone }))
    }

    if (title.priority && !stones.starred) {
      const clock = { at: title.priority.at, origin: title.priority.origin }
      if (!library[id]) {
        report.unapplied.push({ path: `${path}.priority`, reason: 'not starred on this PC' })
      } else {
        if (!priority.includes(id)) {
          priority.push(id)
          report.applied.push(`${path}.priority`)
        }
        if (!(isLegacyClock(clock) && !metaBefore?.titles?.[id]?.priority)) {
          metaEdits.push((m) => ((m.titles[id] ??= {}).priority = clock))
        }
      }
    } else if (stones.priority || stones.starred) {
      // Rule 9's invariant: an unstarred title is not prioritised either.
      const stone = stones.priority ?? stones.starred!
      const at = priority.indexOf(id)
      if (at !== -1) {
        priority.splice(at, 1)
        report.applied.push(`${path}.priority`)
      }
      if (stones.priority || at !== -1) {
        metaEdits.push((m) => ((m.titles[id] ??= {}).priority = { ...stone }))
      }
    }

    if (title.rate) {
      const local = projectRate(store, title.rate.malId, deps)
      const same = RATE_FIELDS.every((f) => sameValue(local?.[f].value, title.rate![f].value))
      if (!same) {
        const result = deps.applyRate ? deps.applyRate(id, title.rate) : 'no rate writer (S9 #584)'
        if (result === true) report.applied.push(`${path}.rate`)
        else report.unapplied.push({ path: `${path}.rate`, reason: result })
      }
    }

    if (doc.titles[id]) {
      const prefix = `${id}:`
      const local = dismissed.filter((k) => k.startsWith(prefix))
      const target = (title.dismissed ?? []).map((ep) => `${prefix}${ep}`)
      if (!sameValue([...new Set(local)].sort(), [...new Set(target)].sort())) {
        dismissed = [...dismissed.filter((k) => !k.startsWith(prefix)), ...target]
        changed.add('dismissedContinueWatching')
        report.applied.push(`${path}.dismissed`)
      }
    }

    if (title.skip && sameValue(title.skip.algorithm, deps.skipAlgorithm)) {
      const current = skipDetections[id]
      const fresh = !!current && sameValue(current.algorithm, deps.skipAlgorithm)
      const det: ShowSkipDetections = fresh
        ? current
        : {
            animeId: Number(id),
            perEpisode: {},
            analyzedAt: title.skip.analyzedAt,
            episodeCount: title.skip.episodeCount,
            algorithm: title.skip.algorithm
          }
      let took = false
      for (const [episodeInt, entry] of Object.entries(title.skip.perEpisode)) {
        if (det.perEpisode[episodeInt]) continue
        const file = deps.localEpisodeFile(id, episodeInt)
        if (
          !file ||
          !sameValue({ translationId: file.translationId, fileSize: file.fileSize }, entry.file)
        ) {
          continue
        }
        det.perEpisode[episodeInt] = restoreSkipEpisode(episodeInt, entry, file.filePath)
        report.applied.push(`${path}.skip.${episodeInt}`)
        took = true
      }
      if (took) {
        skipDetections[id] = det
        changed.add('skipDetections')
      }
    }

    if (doc.titles[id]) {
      const carried = Object.fromEntries(
        Object.entries(title).filter(([k]) => !KNOWN_TITLE_FIELDS.has(k))
      )
      metaEdits.push((m) => {
        const titles = (m.unknown ??= {}).titles ?? {}
        if (Object.keys(carried).length > 0) titles[id] = carried
        else delete titles[id]
        m.unknown.titles = titles
      })
    }
  }

  const members = priority.filter((id) => inScope.has(id))
  const order = reconcileOrder(doc.priorityOrder.value, members, members)
  const nextPriority = rewritePrioritySlots(priority, inScope, order)
  if (!sameValue(nextPriority, priorityBefore)) {
    changed.add('priorityAnimeIds')
    if (!sameValue(nextPriority, priority)) report.applied.push('priorityOrder')
    const clock = { at: doc.priorityOrder.at, origin: doc.priorityOrder.origin }
    metaEdits.push((m) => (m.priorityOrder = clock))
  }

  const carriedDoc = Object.fromEntries(
    Object.entries(doc).filter(([k]) => !KNOWN_DOC_FIELDS.has(k))
  )
  metaEdits.push((m) => {
    if (Object.keys(carriedDoc).length > 0) (m.unknown ??= {}).doc = carriedDoc
    else if (m.unknown) delete m.unknown.doc
    if (m.unknown && !m.unknown.doc && Object.keys(m.unknown.titles ?? {}).length === 0) {
      delete m.unknown
    }
  })

  if (changed.has('watchProgress')) store.set('watchProgress', watchProgress)
  if (changed.has('library')) store.set('library', library)
  if (changed.has('priorityAnimeIds')) store.set('priorityAnimeIds', nextPriority)
  if (changed.has('dismissedContinueWatching')) store.set('dismissedContinueWatching', dismissed)
  if (changed.has('skipDetections')) store.set('skipDetections', skipDetections)
  const draft = structuredClone(metaBefore ?? { titles: {}, rates: {} })
  draft.titles ??= {}
  draft.rates ??= {}
  for (const edit of metaEdits) edit(draft)
  if (!sameValue(draft, metaBefore ?? { titles: {}, rates: {} })) {
    updateSyncMeta(store, (m) => metaEdits.forEach((edit) => edit(m)), now)
  }
  return report
}
