// The export preflight (#575): what will happen on this target, before a byte
// is copied. It runs when the plan is built and again at start.
//
// - The filesystem type and a write probe, both in the nearest existing
//   ancestor of the library root (a new library's folder doesn't exist yet).
// - FAT32's per-file limit: an item with a file over 4 GiB − 1 bytes is skipped.
// - Names: S5's v1 rule (`nameItems`) on every target; the keys it changed are
//   `renamed`, the ones S5 records in `naming.renamed`.
// - MAX_PATH: S5's `absoluteOverflow`, under the root as Windows would see it.

import { randomBytes } from 'crypto'
import * as path from 'path'
import { preflightItemWarnings } from '@shared/shared-library-export'
import {
  nameItems,
  plainName,
  type NamedItem,
  type NamingInput
} from '../../lib/shared-library/naming'
import { absoluteOverflow } from '../../lib/shared-library/paths'
import { FAT32_MAX_FILE_SIZE, errnoOf, unlinkQuiet, type ExportFs } from './copy'
import type { FsTypeProbe } from './fs-type-probe'

export const PROBE_PREFIX = '.anime-dl-probe-'
/** A leftover probe file older than this is removed; a fresh one may belong to another open dialog. */
export const STALE_PROBE_MS = 60 * 60 * 1000

export interface PreflightItem {
  key: string
  naming: NamingInput
  /** The largest file the item writes, in bytes; for a re-encode, its source's. */
  size: number
  /** An S6c (#576) re-encode: its output size isn't known until it's written. */
  reencode?: boolean
}

export interface PreflightPlan {
  items: readonly PreflightItem[]
  /** The library's existing items, the earlier items for the naming rule's collisions. */
  existing: readonly Pick<SharedLibraryItem, 'path' | 'subtitlePath'>[]
}

/** The type and write probes of one folder. */
export interface FolderProbe {
  fsType: ExportFsType
  mountPoint: string | null
  blockers: string[]
  driveWarnings: string[]
}

export interface PreflightDeps {
  xfs: Pick<ExportFs, 'stat' | 'readdir' | 'unlink'>
  isDirectory: (p: string) => Promise<boolean>
  fsTypeProbe: FsTypeProbe
  /** Creates, writes and removes a probe file in `dir`; throws the write's error. */
  writeProbe: (dir: string) => Promise<void>
  platform: NodeJS.Platform
  now: () => number
  overflow?: typeof absoluteOverflow
  /** The dialog's cache: one probe per folder while it is open. Never passed at start. */
  probeCache?: Map<string, Promise<FolderProbe>>
}

export interface PreflightResult extends ExportPreflight {
  /** The names of the items that aren't skipped, in plan order. */
  named: NamedItem[]
}

/**
 * The deepest existing directory at or above `dest`, found with `stat` only, so
 * preflight never creates a folder. Stops at the filesystem root.
 */
export async function nearestExistingAncestor(
  dest: string,
  isDirectory: (p: string) => Promise<boolean>
): Promise<string> {
  let p = dest
  for (;;) {
    // Not there, not a folder, or not readable: try the parent.
    if (await isDirectory(p).catch(() => false)) return p
    const parent = path.dirname(p)
    if (parent === p) return p
    p = parent
  }
}

/** The default write probe: `wx`-create `.anime-dl-probe-<random>`, write 1 byte, always remove it. */
export function createWriteProbe(
  xfs: Pick<ExportFs, 'open' | 'unlink'>
): (dir: string) => Promise<void> {
  return async (dir) => {
    const file = path.join(dir, `${PROBE_PREFIX}${randomBytes(6).toString('hex')}`)
    const fh = await xfs.open(file, 'wx')
    try {
      await fh.write(Buffer.from([0x2e]))
    } finally {
      await fh.close().catch(() => {})
      await unlinkQuiet(xfs, file).catch(() => {})
    }
  }
}

/** Removes `.anime-dl-probe-*` files in `dir` whose mtime is over an hour old. */
export async function removeStaleProbes(
  dir: string,
  xfs: Pick<ExportFs, 'readdir' | 'stat' | 'unlink'>,
  now: number
): Promise<void> {
  let names: string[]
  try {
    names = await xfs.readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(PROBE_PREFIX)) continue
    const p = path.join(dir, name)
    try {
      if (now - (await xfs.stat(p)).mtimeMs > STALE_PROBE_MS) await xfs.unlink(p)
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

const FS_LABEL: Partial<Record<ExportFsType, string>> = {
  fat32: 'FAT32',
  exfat: 'exFAT',
  ntfs: 'NTFS',
  apfs: 'APFS',
  hfs: 'HFS+',
  ext: 'ext4'
}
const OS_LABEL: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
}

/** The blocker for a write probe that failed with `code`, or null when it isn't a read-only error. */
export function readOnlyBlocker(
  code: string | undefined,
  fsType: ExportFsType,
  platform: NodeJS.Platform
): string | null {
  if (code === 'EROFS') {
    const fs = FS_LABEL[fsType]
    const os = OS_LABEL[platform]
    return fs && os
      ? `This drive is read-only on this computer (${fs} on ${os}).`
      : 'This drive is read-only on this computer.'
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return 'This folder is read-only for you on this computer: you don’t have permission to write to it.'
  }
  return null
}

/** The type and write probes of `dir`, an existing folder. The type alone never blocks. */
export async function probeFolder(dir: string, deps: PreflightDeps): Promise<FolderProbe> {
  await removeStaleProbes(dir, deps.xfs, deps.now())
  const { fsType, mountPoint } = await deps.fsTypeProbe(dir)
  const out: FolderProbe = { fsType, mountPoint, blockers: [], driveWarnings: [] }
  try {
    await deps.writeProbe(dir)
  } catch (err) {
    const code = errnoOf(err)
    const blocker = readOnlyBlocker(code, fsType, deps.platform)
    if (blocker) out.blockers.push(blocker)
    else {
      out.driveWarnings.push(
        `Couldn’t check that this folder can be written (${code ?? (err as Error).message}). Any write error will show during the copy.`
      )
    }
  }
  return out
}

const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/

/**
 * The root as Windows would see it: unchanged when it is already a Windows
 * path, otherwise its path below the mount point under a drive letter. Null
 * when the mount point isn't known.
 */
export function windowsStyleRoot(root: string, mountPoint: string | null): string | null {
  if (WINDOWS_ROOT.test(root)) return root
  if (mountPoint === null) return null
  const rel = path.posix.relative(mountPoint, root)
  if (rel.startsWith('..') || path.posix.isAbsolute(rel)) return null
  return `E:\\${rel.split('/').filter(Boolean).join('\\')}`
}

export async function preflight(
  plan: PreflightPlan,
  target: { root: string },
  deps: PreflightDeps
): Promise<PreflightResult> {
  const ancestor = await nearestExistingAncestor(target.root, deps.isDirectory)
  let probe: Promise<FolderProbe> | undefined = deps.probeCache?.get(ancestor)
  if (!probe) {
    probe = probeFolder(ancestor, deps)
    deps.probeCache?.set(ancestor, probe)
  }
  const { fsType, mountPoint, blockers, driveWarnings } = await probe

  const skipped: string[] = []
  const mayBeSkipped: string[] = []
  const kept: PreflightItem[] = []
  for (const item of plan.items) {
    if (fsType === 'fat32' && item.size > FAT32_MAX_FILE_SIZE) {
      if (item.reencode) mayBeSkipped.push(item.key)
      else {
        skipped.push(item.key)
        continue
      }
    }
    kept.push(item)
  }

  const named = nameItems(
    kept.map((i) => i.naming),
    plan.existing
  )
  const renamed: string[] = []
  const renames: Record<string, { from: string; to: string }> = {}
  named.forEach((n, i) => {
    if (!n.renamed) return
    renamed.push(n.key)
    renames[n.key] = { from: plainName(kept[i].naming).path, to: n.path }
  })

  const winRoot = windowsStyleRoot(target.root, mountPoint)
  const overflow =
    winRoot === null
      ? []
      : (deps.overflow ?? absoluteOverflow)(
          winRoot,
          named.map((n, i) => ({
            animeId: kept[i].naming.animeId,
            episodeInt: kept[i].naming.episodeInt,
            translationId: kept[i].naming.translationId,
            path: n.path,
            ...(n.subtitlePath !== undefined ? { subtitlePath: n.subtitlePath } : {})
          }))
        )

  const lists = { fsType, skipped, mayBeSkipped, renamed, overflow }
  return {
    ok: blockers.length === 0,
    ...lists,
    blockers: [...blockers],
    driveWarnings: [...driveWarnings],
    warnings: [...driveWarnings, ...preflightItemWarnings(lists)],
    renames,
    named
  }
}
