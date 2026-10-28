// Where a removable drive can be mounted (#574), for finding a Shared Library
// by its `libraryId` after a re-plug changed its letter or path. S6a's export
// resume uses it, and S7c (#581)'s availability poller reuses it.
//
// - Windows: the drive letters `D:`–`Z:` that exist.
// - macOS: every folder under `/Volumes`.
// - Linux: every folder under `/media/$USER`, `/run/media/$USER` and `/mnt`.
//
// Every filesystem check here gets its own async budget (1 s by default): a
// sleeping USB disk or a dead network mount must not stall the scan. A check
// that runs out of time counts as "not there".

import { promises as fsp } from 'fs'
import * as os from 'os'
import * as path from 'path'

export const CANDIDATE_BUDGET_MS = 1000

/** `work`'s result, or `fallback` once `ms` have passed. Never rejects. */
export function withBudget<T>(work: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

export interface MountCandidateDeps {
  platform: NodeJS.Platform
  user: string
  /** The folder names directly under `dir`. */
  listDirs: (dir: string) => Promise<string[]>
  /** Whether `p` is an existing directory. */
  isDir: (p: string) => Promise<boolean>
  budgetMs: number
}

export type MountCandidates = () => Promise<string[]>

const defaultDeps = (): MountCandidateDeps => ({
  platform: process.platform,
  user: (() => {
    try {
      return os.userInfo().username
    } catch {
      return process.env.USER ?? ''
    }
  })(),
  listDirs: async (dir) =>
    (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(),
  isDir: async (p) => (await fsp.stat(p)).isDirectory(),
  budgetMs: CANDIDATE_BUDGET_MS
})

/** The candidate mount roots for this OS; every part injectable for tests. */
export function createMountCandidates(
  overrides: Partial<MountCandidateDeps> = {}
): MountCandidates {
  const deps = { ...defaultDeps(), ...overrides }
  const isDir = (p: string): Promise<boolean> =>
    withBudget(() => deps.isDir(p), deps.budgetMs, false)
  const children = async (dir: string): Promise<string[]> => {
    const names = await withBudget(() => deps.listDirs(dir), deps.budgetMs, [] as string[])
    return names.map((n) => path.join(dir, n))
  }

  return async () => {
    if (deps.platform === 'win32') {
      const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`)
      const present = await Promise.all(letters.map((root) => isDir(root)))
      return letters.filter((_, i) => present[i])
    }
    const parents =
      deps.platform === 'darwin'
        ? ['/Volumes']
        : [...(deps.user ? [`/media/${deps.user}`, `/run/media/${deps.user}`] : []), '/mnt']
    const lists = await Promise.all(parents.map((p) => children(p)))
    return lists.flat()
  }
}
