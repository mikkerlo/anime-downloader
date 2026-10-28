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
// that runs out of time counts as "not there", and a path whose check is still
// pending isn't checked again until it settles.
//
// Network mounts are dropped (#581): NAS and network shares are out of scope.
// `classifyMounts` marks them, and runs only when the set of candidates gains
// a path it hasn't classified; each verdict is kept until its path disappears.
// A path it can't classify is still a candidate. A failed run is retried after
// `CLASSIFY_RETRY_MS`, not on every scan.

import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import * as os from 'os'
import * as path from 'path'

export const CANDIDATE_BUDGET_MS = 1000
export const CLASSIFY_TIMEOUT_MS = 5000
/** How long a failed classification waits before it is tried again. */
export const CLASSIFY_RETRY_MS = 60_000

export type MountKind = 'local' | 'network'

/** A verdict per candidate path; a path left out couldn't be classified. */
export type ClassifyMounts = (paths: string[]) => Promise<Map<string, MountKind>>

/** Linux fs types (`/proc/self/mountinfo`) that are a network share. */
export const LINUX_NETWORK_FS = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smb3',
  'smbfs',
  '9p',
  'davfs',
  'afs',
  'ceph',
  'glusterfs',
  'fuse.sshfs',
  'fuse.rclone',
  'fuse.davfs2'
])

/** macOS fs types (`/sbin/mount`) that are a network share. */
export const DARWIN_NETWORK_FS = new Set(['smbfs', 'nfs', 'afpfs', 'webdav', 'ftp'])

/** `Win32_LogicalDisk.DriveType` of a network drive. */
export const WIN32_NETWORK_DRIVE_TYPE = 4

interface MountEntry {
  mountPoint: string
  fsType: string
}

const unescapeMountinfo = (s: string): string =>
  s.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))

/** `/proc/self/mountinfo`: the mount point is field 5, the fs type follows the ` - ` separator. */
export function parseMountinfo(text: string): MountEntry[] {
  const out: MountEntry[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ')
    const sep = fields.indexOf('-')
    if (fields.length < 5 || sep < 0 || sep + 1 >= fields.length) continue
    out.push({ mountPoint: unescapeMountinfo(fields[4]), fsType: fields[sep + 1] })
  }
  return out
}

/** `/sbin/mount` on macOS: `<device> on <mount point> (<type>, <options>…)`. */
export function parseDarwinMount(text: string): MountEntry[] {
  const out: MountEntry[] = []
  for (const line of text.split('\n')) {
    const m = /^.*? on (.+) \(([^,()]+)[,)]/.exec(line.trim())
    if (m) out.push({ mountPoint: m[1], fsType: m[2].trim() })
  }
  return out
}

/** `Get-CimInstance Win32_LogicalDisk | ConvertTo-Json`: `D:` → its `DriveType`. */
export function parseWin32DriveTypes(json: string): Map<string, number> {
  const out = new Map<string, number>()
  const parsed: unknown = JSON.parse(json)
  for (const d of Array.isArray(parsed) ? parsed : [parsed]) {
    const { DeviceID, DriveType } = (d ?? {}) as { DeviceID?: unknown; DriveType?: unknown }
    if (typeof DeviceID === 'string' && typeof DriveType === 'number') {
      out.set(DeviceID.toUpperCase(), DriveType)
    }
  }
  return out
}

/** Each path's kind from the deepest mount holding it. */
function classifyByTable(
  paths: string[],
  table: MountEntry[],
  network: Set<string>
): Map<string, MountKind> {
  const out = new Map<string, MountKind>()
  for (const p of paths) {
    let best: MountEntry | null = null
    for (const e of table) {
      const m = e.mountPoint
      const holds = p === m || p.startsWith(m.endsWith('/') ? m : `${m}/`)
      if (holds && (!best || m.length > best.mountPoint.length)) best = e
    }
    if (best) out.set(p, network.has(best.fsType) ? 'network' : 'local')
  }
  return out
}

export interface ClassifyMountsDeps {
  platform: NodeJS.Platform
  readMountinfo: () => Promise<string>
  runMount: () => Promise<string>
  /** `Win32_LogicalDisk`'s `DeviceID` and `DriveType` as JSON. */
  queryDriveTypes: () => Promise<string>
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: CLASSIFY_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })

/** The per-OS `classifyMounts`; every source is injectable. Rejects when its source fails. */
export function createClassifyMounts(overrides: Partial<ClassifyMountsDeps> = {}): ClassifyMounts {
  const deps: ClassifyMountsDeps = {
    platform: process.platform,
    readMountinfo: () => fsp.readFile('/proc/self/mountinfo', 'utf8'),
    runMount: () => run('/sbin/mount', []),
    queryDriveTypes: () =>
      run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance -ClassName Win32_LogicalDisk | Select-Object DeviceID,DriveType | ConvertTo-Json -Compress'
      ]),
    ...overrides
  }
  return async (paths) => {
    if (deps.platform === 'win32') {
      const types = parseWin32DriveTypes(await deps.queryDriveTypes())
      const out = new Map<string, MountKind>()
      for (const p of paths) {
        const type = types.get(p.slice(0, 2).toUpperCase())
        if (type !== undefined) {
          out.set(p, type === WIN32_NETWORK_DRIVE_TYPE ? 'network' : 'local')
        }
      }
      return out
    }
    if (deps.platform === 'darwin') {
      return classifyByTable(paths, parseDarwinMount(await deps.runMount()), DARWIN_NETWORK_FS)
    }
    return classifyByTable(paths, parseMountinfo(await deps.readMountinfo()), LINUX_NETWORK_FS)
  }
}

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
  classifyMounts: ClassifyMounts
  /** Folders whose children replace the per-OS list (a test or an unpackaged run). */
  parents?: string[]
  log: Pick<Console, 'warn'>
  now: () => number
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
  budgetMs: CANDIDATE_BUDGET_MS,
  classifyMounts: createClassifyMounts(),
  log: console,
  now: Date.now
})

/** The candidate mount roots for this OS, network mounts dropped; every part injectable for tests. */
export function createMountCandidates(
  overrides: Partial<MountCandidateDeps> = {}
): MountCandidates {
  const deps = { ...defaultDeps(), ...overrides }
  // One pending call per path: a hung mount isn't asked again on every scan.
  const pending = new Map<string, Promise<unknown>>()
  const once = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const running = pending.get(key) as Promise<T> | undefined
    if (running) return running
    const p = work().finally(() => pending.delete(key))
    pending.set(key, p)
    return p
  }
  const isDir = (p: string): Promise<boolean> =>
    withBudget(() => once(`dir:${p}`, () => deps.isDir(p)), deps.budgetMs, false)
  const children = async (dir: string): Promise<string[]> => {
    const names = await withBudget(
      () => once(`list:${dir}`, () => deps.listDirs(dir)),
      deps.budgetMs,
      [] as string[]
    )
    return names.map((n) => path.join(dir, n))
  }

  const listAll = async (): Promise<string[]> => {
    if (deps.parents) return (await Promise.all(deps.parents.map((p) => children(p)))).flat()
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

  const kinds = new Map<string, MountKind>()
  // The candidate set the last successful classification covered. A failure
  // (a cold PowerShell past its timeout) leaves it unset, so the same set is
  // tried again once `CLASSIFY_RETRY_MS` has passed.
  let lastSet: string | null = null
  let retryAt = 0

  return async () => {
    const all = await listAll()
    const key = all.join('\0')
    if (key !== lastSet && deps.now() >= retryAt) {
      const present = new Set(all)
      for (const p of kinds.keys()) if (!present.has(p)) kinds.delete(p)
      const fresh = all.filter((p) => !kinds.has(p))
      try {
        if (fresh.length > 0) {
          for (const [p, kind] of await deps.classifyMounts(fresh)) {
            if (present.has(p)) kinds.set(p, kind)
          }
        }
        lastSet = key
        retryAt = 0
      } catch (err) {
        retryAt = deps.now() + CLASSIFY_RETRY_MS
        deps.log.warn(
          `[shared-library] could not classify mounts; probing them anyway, retrying in ${CLASSIFY_RETRY_MS / 1000} s`,
          err
        )
      }
    }
    return all.filter((p) => kinds.get(p) !== 'network')
  }
}
