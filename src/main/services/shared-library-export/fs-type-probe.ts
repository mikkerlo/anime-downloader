// The export target's filesystem type (#575), from the OS's own tool: PowerShell
// `Get-Volume` on Windows, `df` + `diskutil info -plist` on macOS, `findmnt` on
// Linux. Each run has a 3 s budget; a timeout, a failure or output it can't
// read gives `unknown`, which raises no type-based warnings.

import { execFile } from 'child_process'

export interface FsProbeResult {
  fsType: ExportFsType
  /** The mount point holding the folder (macOS, Linux), for the Windows path-length check. */
  mountPoint: string | null
}

export type FsTypeProbe = (dir: string) => Promise<FsProbeResult>

/** Runs a command and resolves with its stdout; rejects on a non-zero exit or the timeout. */
export type RunCommand = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env?: Record<string, string> }
) => Promise<string>

export const PROBE_TIMEOUT_MS = 3000

const UNKNOWN: FsProbeResult = { fsType: 'unknown', mountPoint: null }

export const runCommand: RunCommand = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs,
        windowsHide: true,
        env: opts.env ? { ...process.env, ...opts.env } : process.env
      },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
    )
  })

/** Windows' `FileSystem` names (`Get-Volume`). */
export function parseGetVolume(stdout: string): ExportFsType {
  switch (stdout.trim().toUpperCase()) {
    case 'FAT32':
    case 'FAT':
      return 'fat32'
    case 'EXFAT':
      return 'exfat'
    case 'NTFS':
      return 'ntfs'
    case '':
      return 'unknown'
    default:
      return 'other'
  }
}

/** Linux's `findmnt -J -o FSTYPE,TARGET --target <dir>`. */
export function parseFindmnt(stdout: string): FsProbeResult {
  let fs: { fstype?: unknown; target?: unknown } | undefined
  try {
    fs = (JSON.parse(stdout) as { filesystems?: { fstype?: unknown; target?: unknown }[] })
      .filesystems?.[0]
  } catch {
    return UNKNOWN
  }
  if (!fs || typeof fs.fstype !== 'string') return UNKNOWN
  const mountPoint = typeof fs.target === 'string' ? fs.target : null
  return { fsType: linuxFsType(fs.fstype), mountPoint }
}

function linuxFsType(t: string): ExportFsType {
  switch (t) {
    case 'vfat':
    case 'msdos':
    case 'fat':
      return 'fat32'
    case 'exfat':
      return 'exfat'
    case 'ntfs':
    case 'ntfs3':
      return 'ntfs'
    case 'ext2':
    case 'ext3':
    case 'ext4':
      return 'ext'
    case 'apfs':
      return 'apfs'
    case 'hfs':
    case 'hfsplus':
      return 'hfs'
    // ntfs-3g and exfat-fuse both show as `fuseblk`: no way to tell them apart here.
    case 'fuseblk':
      return 'unknown'
    default:
      return 'other'
  }
}

/** macOS's `df -P <dir>`: the mount point is everything after the capacity column. */
export function parseDfMountPoint(stdout: string): string | null {
  const lines = stdout.trim().split('\n')
  const last = lines[lines.length - 1] ?? ''
  if (lines.length < 2) return null
  const m = /\s\d+%\s+(\/.*)$/.exec(last)
  return m ? m[1] : null
}

const plistEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

function plistString(xml: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)
  return m ? plistEntities(m[1]) : null
}

/** macOS's `diskutil info -plist <mount>`: `FilesystemType` and `MountPoint`. */
export function parseDiskutilPlist(stdout: string): FsProbeResult {
  const type = plistString(stdout, 'FilesystemType')
  if (type === null) return UNKNOWN
  const mountPoint = plistString(stdout, 'MountPoint')
  const map: Record<string, ExportFsType> = {
    msdos: 'fat32',
    exfat: 'exfat',
    ntfs: 'ntfs',
    apfs: 'apfs',
    hfs: 'hfs'
  }
  return { fsType: map[type.toLowerCase()] ?? 'other', mountPoint: mountPoint || null }
}

function withBudget<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([p.catch(() => fallback), timeout]).finally(() => clearTimeout(timer))
}

export function createFsTypeProbe(
  opts: { platform?: NodeJS.Platform; run?: RunCommand; timeoutMs?: number } = {}
): FsTypeProbe {
  const platform = opts.platform ?? process.platform
  const run = opts.run ?? runCommand
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS

  const probe = async (dir: string): Promise<FsProbeResult> => {
    if (platform === 'win32') {
      // The path goes in through the environment, so no quoting can break the command.
      const out = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-Volume -FilePath $env:ANIME_DL_PROBE_PATH).FileSystem'
        ],
        { timeoutMs, env: { ANIME_DL_PROBE_PATH: dir } }
      )
      return { fsType: parseGetVolume(out), mountPoint: null }
    }
    if (platform === 'darwin') {
      const mount = parseDfMountPoint(await run('df', ['-P', dir], { timeoutMs }))
      if (mount === null) return UNKNOWN
      const r = parseDiskutilPlist(await run('diskutil', ['info', '-plist', mount], { timeoutMs }))
      return { fsType: r.fsType, mountPoint: r.mountPoint ?? mount }
    }
    return parseFindmnt(
      await run('findmnt', ['-J', '-o', 'FSTYPE,TARGET', '--target', dir], { timeoutMs })
    )
  }

  return (dir) => withBudget(probe(dir), timeoutMs, UNKNOWN)
}
