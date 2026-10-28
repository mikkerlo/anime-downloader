// Finding an export job's library after a re-plug (#574). A job is keyed by
// its `libraryId`, never by its path: a different drive mounted at the old
// letter or path, with another library or none, is never written.

import { discoverLibraries } from '../../lib/shared-library/discover'
import {
  CANDIDATE_BUDGET_MS,
  withBudget,
  type MountCandidates
} from '../../lib/shared-library/mount-candidates'
import { readLibrary } from '../../lib/shared-library/read'

const LAST_ROOT_BUDGET_MS = 10_000

/** The `libraryId` of the library at `root`, or null (none, unreadable, or out of time). */
export async function libraryIdAt(
  root: string,
  budgetMs = CANDIDATE_BUDGET_MS
): Promise<string | null> {
  return withBudget(
    async () => {
      const r = await readLibrary(root)
      if (r.status === 'none') return null
      return r.manifest?.libraryId ?? null
    },
    budgetMs,
    null
  )
}

/** The library roots at `dir` (itself, then one level below) holding `libraryId`. */
export async function rootsWithId(
  dir: string,
  libraryId: string,
  budgetMs = CANDIDATE_BUDGET_MS
): Promise<string[]> {
  const roots = await withBudget(() => discoverLibraries(dir), budgetMs, [] as string[])
  const out: string[] = []
  for (const root of roots) {
    if ((await libraryIdAt(root, budgetMs)) === libraryId) out.push(root)
  }
  return out
}

export interface Located {
  root: string
  /** Set when the library was found somewhere other than the last known root. */
  moved: boolean
  /** Other roots holding the same `libraryId` (a cloned stick); the first match wins. */
  duplicates: string[]
}

/**
 * The last known root when it still holds `libraryId`; otherwise the first
 * candidate mount (or one level below it) that does. Null when none does.
 */
export async function locateLibrary(
  libraryId: string,
  lastRoot: string,
  candidates: MountCandidates,
  budgetMs = CANDIDATE_BUDGET_MS
): Promise<Located | null> {
  // The last root gets longer: it is one read, of a manifest that can be 32 MB.
  if ((await libraryIdAt(lastRoot, Math.max(budgetMs, LAST_ROOT_BUDGET_MS))) === libraryId) {
    return { root: lastRoot, moved: false, duplicates: [] }
  }
  const found: string[] = []
  for (const mount of await candidates()) {
    for (const root of await rootsWithId(mount, libraryId, budgetMs)) {
      if (!found.includes(root)) found.push(root)
    }
  }
  if (found.length === 0) return null
  return { root: found[0], moved: true, duplicates: found.slice(1) }
}
