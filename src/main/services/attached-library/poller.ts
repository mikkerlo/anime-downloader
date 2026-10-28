// The availability poller (#581). Electron has no mount event, and a drive's
// letter or path changes between plugs, so every 10 s and on window focus:
//
// 1. each attached library's last root is checked for its manifest: a `stat`,
//    and a re-read (the service's `reopenAt`) only when it changed or the
//    library was unavailable. Gone means unavailable, with `lastSeenAt` kept.
// 2. the mount candidates (`mount-candidates.ts`, network mounts dropped) are
//    scanned with `discoverLibraries`, at their root and one level below: a
//    newly mounted one once, to offer the unknown libraries on it, and every
//    one while an attached library is unavailable. A known `libraryId` found
//    at a new path moves there and becomes available. Matching is by
//    `libraryId`, never by path.
//
// The cost guard is async. Every filesystem call is `fs.promises`; each check
// races a 1 s budget, so a sleeping disk or a hung mount never blocks the main
// process. A call past its budget still holds one of libuv's four threadpool
// threads, so its path stays in `inFlight` and is skipped until the call
// settles, and no more than `MAX_OUTSTANDING` calls are ever pending. No sync
// fs here: `attached-library-poller.test.ts` reads this file to check.

import { promises as fsp } from 'fs'
import * as path from 'path'
import { discoverLibraries } from '../../lib/shared-library/discover'
import {
  CANDIDATE_BUDGET_MS,
  withBudget,
  type MountCandidates
} from '../../lib/shared-library/mount-candidates'
import { LIBRARY_DIR, MANIFEST } from '../../lib/shared-library/read'

export const POLL_INTERVAL_MS = 10_000
export const MAX_OUTSTANDING = 2

export interface KnownLibrary {
  libraryId: string
  root: string
  available: boolean
}

/** What the poller needs from `AttachedLibraryService`. */
export interface PollerTarget {
  known(): KnownLibrary[]
  /** Re-reads `root` as `libraryId`'s; true when it holds it and is now its root. */
  reopenAt(libraryId: string, root: string): Promise<boolean>
  /** A no-op unless `root` is still the library's root. */
  markUnavailable(libraryId: string, root: string): void
  markSeen(libraryId: string): void
  /** The library at `root`, as the open flow lists it; null when there is none. */
  identify(root: string): Promise<SharedLibraryCandidate | null>
  isDismissed(libraryId: string): boolean
}

export interface AvailabilityPollerDeps {
  target: PollerTarget
  candidates: MountCandidates
  onFound: (found: SharedLibraryFound) => void
  /** A change signature of `<root>/.anime-dl/manifest.json`, or null when it isn't there. */
  statManifest?: (root: string) => Promise<string | null>
  discover?: (dir: string) => Promise<string[]>
  budgetMs?: number
  intervalMs?: number
  log?: Pick<Console, 'warn'>
}

export interface AvailabilityPoller {
  start(): void
  stop(): void
  /** A tick now (window focus); coalesced with one already running. */
  poke(): void
  /** One tick; resolves when it is done. */
  tick(): Promise<void>
}

async function defaultStatManifest(root: string): Promise<string | null> {
  try {
    const st = await fsp.stat(path.join(root, LIBRARY_DIR, MANIFEST))
    return st.isFile() ? `${st.size}:${st.mtimeMs}:${st.ino}` : null
  } catch {
    return null
  }
}

/** `E:` for a drive letter, the folder name otherwise. */
export function volumeLabel(dir: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(dir)) return dir.slice(0, 2).toUpperCase()
  return path.basename(dir) || dir
}

interface Job {
  key: string
  run(late: () => boolean): Promise<void>
}

const TIMED_OUT = Symbol('timed-out')

export function createAvailabilityPoller(deps: AvailabilityPollerDeps): AvailabilityPoller {
  const { target } = deps
  const statManifest = deps.statManifest ?? defaultStatManifest
  const discover = deps.discover ?? discoverLibraries
  const budgetMs = deps.budgetMs ?? CANDIDATE_BUDGET_MS
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS
  const log = deps.log ?? console

  // A call per path that hasn't settled, abandoned or not.
  const inFlight = new Map<string, Promise<void>>()
  // The manifest signature each available library was last seen with.
  const seen = new Map<string, string>()
  // The manifest signature a known root last failed to match its library with.
  const refused = new Map<string, string>()
  // Mounts already offered, until they disappear: one toast per mount.
  const offered = new Set<string>()
  // Each library root found on a mount: its manifest signature and what it held.
  const identified = new Map<string, { sig: string; found: SharedLibraryCandidate | null }>()

  /** Runs `jobs` at most `MAX_OUTSTANDING` calls at a time, each within the budget. */
  function runPool(jobs: Job[]): Promise<void> {
    const queue = jobs.filter((j) => !inFlight.has(j.key))
    return new Promise<void>((resolve) => {
      let waiting = 0
      let done = false
      const pump = (): void => {
        if (done) return
        while (queue.length > 0 && inFlight.size < MAX_OUTSTANDING) {
          const job = queue.shift()!
          if (inFlight.has(job.key)) continue
          let late = false
          const work = job
            .run(() => late)
            .catch((err) => {
              log.warn(`[shared-library] availability check of ${job.key} failed`, err)
            })
          inFlight.set(job.key, work)
          void work.finally(() => {
            inFlight.delete(job.key)
            pump()
          })
          waiting++
          void withBudget<unknown>(() => work, budgetMs, TIMED_OUT).then((r) => {
            if (r === TIMED_OUT) late = true
            waiting--
            pump()
          })
        }
        if (waiting === 0) {
          done = true
          resolve()
        }
      }
      pump()
    })
  }

  function knownJob(k: KnownLibrary): Job {
    return {
      key: k.root,
      run: async (late) => {
        const sig = await statManifest(k.root)
        if (late()) return
        if (sig === null) {
          seen.delete(k.libraryId)
          if (k.available) target.markUnavailable(k.libraryId, k.root)
          return
        }
        if (k.available && (!seen.has(k.libraryId) || seen.get(k.libraryId) === sig)) {
          // Unchanged since the last read (or the startup read this tick follows).
          seen.set(k.libraryId, sig)
          target.markSeen(k.libraryId)
          return
        }
        // A manifest that didn't hold this library is read again only once it changes.
        if (!k.available && refused.get(k.libraryId) === sig) return
        if (await target.reopenAt(k.libraryId, k.root)) {
          seen.set(k.libraryId, sig)
          refused.delete(k.libraryId)
        } else {
          refused.set(k.libraryId, sig)
          if (k.available) target.markUnavailable(k.libraryId, k.root)
        }
      }
    }
  }

  async function identifyAt(root: string): Promise<SharedLibraryCandidate | null> {
    const sig = (await statManifest(root)) ?? ''
    const cached = identified.get(root)
    if (cached && sig !== '' && cached.sig === sig) return cached.found
    const found = await target.identify(root)
    identified.set(root, { sig, found })
    return found
  }

  function candidateJob(dir: string): Job {
    return {
      key: dir,
      run: async (late) => {
        const found: SharedLibraryCandidate[] = []
        for (const root of await discover(dir)) {
          if (late()) return
          const c = await identifyAt(root)
          if (c?.libraryId) found.push(c)
        }
        if (late()) return
        const known = new Map(target.known().map((k) => [k.libraryId, k]))
        const unknown: SharedLibraryCandidate[] = []
        for (const c of found) {
          const k = known.get(c.libraryId!)
          if (!k) {
            if (!target.isDismissed(c.libraryId!)) unknown.push(c)
          } else if (!k.available && k.root !== c.root) {
            await target.reopenAt(c.libraryId!, c.root)
          }
        }
        if (offered.has(dir)) return
        offered.add(dir)
        if (unknown.length > 0) {
          deps.onFound({ volume: volumeLabel(dir), dir, candidates: unknown })
        }
      }
    }
  }

  async function tickOnce(): Promise<void> {
    const known = target.known()
    const ids = new Set(known.map((k) => k.libraryId))
    for (const map of [seen, refused]) for (const id of map.keys()) if (!ids.has(id)) map.delete(id)
    await runPool(known.map(knownJob))

    let mounts: string[] = []
    try {
      mounts = await deps.candidates()
    } catch (err) {
      log.warn('[shared-library] could not list mount candidates', err)
    }
    const present = new Set(mounts)
    for (const dir of offered) if (!present.has(dir)) offered.delete(dir)
    const under = (root: string, dir: string): boolean =>
      root === dir || root.startsWith(/[\\/]$/.test(dir) ? dir : dir + path.sep)
    for (const root of identified.keys()) {
      if (!mounts.some((d) => under(root, d))) identified.delete(root)
    }
    const searching = target.known().some((k) => !k.available)
    await runPool(mounts.filter((d) => searching || !offered.has(d)).map(candidateJob))
  }

  let running: Promise<void> | null = null
  let again = false

  function tick(): Promise<void> {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await tickOnce()
        } while (again)
      } catch (err) {
        log.warn('[shared-library] availability tick failed', err)
      } finally {
        running = null
      }
    })()
    return running
  }

  let timer: ReturnType<typeof setInterval> | null = null

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), intervalMs)
      void tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    poke() {
      if (timer) void tick()
    },
    tick
  }
}
