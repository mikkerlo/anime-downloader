// Copying one file into a Shared Library (#574), or out of one onto this PC
// (#579): stream to `<dest>.anime-dl-tmp` hashing as it goes, fsync, rename
// into place, then verify (the size, plus a re-read hash for files under
// 2 GB). A crash leaves at most the `.anime-dl-tmp`, which the resume deletes.

import { createHash } from 'crypto'
import * as fs from 'fs'
import { promises as fsp } from 'fs'
import * as path from 'path'
import type { Readable } from 'stream'

export const TMP_SUFFIX = '.anime-dl-tmp'
/** Above this, verify by size only, to keep USB 2 bearable. */
export const HASH_VERIFY_LIMIT = 2 * 1024 * 1024 * 1024

/** The filesystem calls an export or an import makes; injected by tests. */
export interface ExportFs {
  open: (p: string, flags: string) => Promise<WriteHandle>
  createReadStream: (p: string) => Readable
  rename: (from: string, to: string) => Promise<void>
  unlink: (p: string) => Promise<void>
  stat: (p: string) => Promise<{ size: number; dev: number; ino: number; mtimeMs: number }>
  mkdir: (p: string) => Promise<void>
  readdir: (p: string) => Promise<string[]>
  readFile: (p: string) => Promise<Buffer>
  writeFile: (p: string, data: string | Buffer) => Promise<void>
  statfs: (p: string) => Promise<{ bavail: number; bsize: number }>
}

export interface WriteHandle {
  write: (buf: Buffer) => Promise<unknown>
  sync: () => Promise<void>
  close: () => Promise<void>
}

export const nodeFs: ExportFs = {
  open: async (p, flags) => {
    const fh = await fsp.open(p, flags)
    return {
      // A write can be short; loop until the whole chunk is down.
      write: async (buf) => {
        for (let off = 0; off < buf.length; ) {
          off += (await fh.write(buf, off, buf.length - off)).bytesWritten
        }
      },
      sync: () => fh.sync(),
      close: () => fh.close()
    }
  },
  createReadStream: (p) => fs.createReadStream(p, { highWaterMark: 1024 * 1024 }),
  rename: (a, b) => fsp.rename(a, b),
  unlink: (p) => fsp.unlink(p),
  stat: (p) => fsp.stat(p),
  mkdir: async (p) => {
    await fsp.mkdir(p)
  },
  readdir: (p) => fsp.readdir(p),
  readFile: (p) => fsp.readFile(p),
  writeFile: (p, data) => fsp.writeFile(p, data),
  statfs: (p) => fsp.statfs(p)
}

export class VerifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerifyError'
  }
}

/** FAT32's largest file: 4 GiB − 1 bytes. */
export const FAT32_MAX_FILE_SIZE = 4_294_967_295
/**
 * A temp file this large has hit FAT32's limit: within one 1 MiB read chunk of
 * it, since Windows' fastfat may refuse the whole write that would cross it.
 */
export const FAT32_TEMP_THRESHOLD = FAT32_MAX_FILE_SIZE - 1024 * 1024

export const TOO_LARGE_REASON = 'too-large-for-filesystem'

/** A write the target's filesystem can't hold: the item is skipped, not failed (#575). */
export class TooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TooLargeError'
  }
}

/**
 * The run-time size rule (#575), for outputs whose size preflight couldn't
 * know (S6c #576 re-encodes, a filesystem the probe called `unknown`): a write
 * failure is "too large for the filesystem" when it is `EFBIG` or ffmpeg's
 * "File too large", or when, on `fat32` or `unknown`, the partial temp file had
 * reached the FAT32 limit (`FAT32_TEMP_THRESHOLD`) without passing it: past
 * 4 GiB − 1 bytes the drive isn't FAT32, and that is a real disk-full. Windows
 * reports the limit as a full disk (`ENOSPC`), and a probe that timed out there
 * gives `unknown`.
 * S6c's merge step reuses it.
 */
export function isTooLargeForFilesystem(
  err: unknown,
  fsType: ExportFsType,
  partialBytes: number | null
): boolean {
  if (errnoOf(err) === 'EFBIG') return true
  const message = err instanceof Error ? err.message : String(err)
  if (/file too large/i.test(message)) return true
  return (
    (fsType === 'fat32' || fsType === 'unknown') &&
    partialBytes !== null &&
    partialBytes >= FAT32_TEMP_THRESHOLD &&
    partialBytes <= FAT32_MAX_FILE_SIZE
  )
}

export function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

export async function unlinkQuiet(xfs: Pick<ExportFs, 'unlink'>, p: string): Promise<void> {
  try {
    await xfs.unlink(p)
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') throw err
  }
}

function abortError(): Error {
  const err = new Error('The copy was stopped')
  err.name = 'AbortError'
  return err
}

async function hashFile(xfs: ExportFs, p: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of xfs.createReadStream(p)) {
    if (signal?.aborted) throw abortError()
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/**
 * Copies `src` to `dest` (whose parent folder may not exist yet; only that one
 * level is created, so a vanished drive root is never recreated).
 */
export async function copyVerified(
  xfs: ExportFs,
  src: string,
  dest: string,
  opts: {
    signal?: AbortSignal
    onBytes?: (n: number) => void
    hashLimit?: number
    /** The target's filesystem, for the run-time size rule. */
    fsType?: ExportFsType
  } = {}
): Promise<{ size: number; sha256: string }> {
  const tmp = `${dest}${TMP_SUFFIX}`
  try {
    await xfs.mkdir(path.dirname(dest))
  } catch (err) {
    if (errnoOf(err) !== 'EEXIST') throw err
  }
  await unlinkQuiet(xfs, tmp)
  const hash = createHash('sha256')
  let size = 0
  const fh = await xfs.open(tmp, 'w')
  try {
    for await (const chunk of xfs.createReadStream(src)) {
      if (opts.signal?.aborted) throw abortError()
      const buf = chunk as Buffer
      hash.update(buf)
      await fh.write(buf)
      size += buf.length
      opts.onBytes?.(buf.length)
    }
    await fh.sync()
  } catch (err) {
    await fh.close().catch(() => {})
    const aborted = (err as Error | null)?.name === 'AbortError'
    const partial = aborted
      ? null
      : await xfs.stat(tmp).then(
          (s) => s.size,
          () => null
        )
    await unlinkQuiet(xfs, tmp).catch(() => {})
    if (!aborted && isTooLargeForFilesystem(err, opts.fsType ?? 'unknown', partial)) {
      throw new TooLargeError(err instanceof Error ? err.message : String(err))
    }
    throw err
  }
  await fh.close()
  return placeVerified(xfs, tmp, dest, size, hash.digest('hex'), opts)
}

/**
 * Takes a finished temp file someone else wrote (S6c #576: ffmpeg's merge
 * output) the rest of the way: fsync, hash, then the same rename and verify
 * as a copy. The temp file is deleted when that fails.
 */
export async function adoptVerified(
  xfs: ExportFs,
  tmp: string,
  dest: string,
  opts: { signal?: AbortSignal; hashLimit?: number } = {}
): Promise<{ size: number; sha256: string }> {
  try {
    const fh = await xfs.open(tmp, 'r+')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
    const size = (await xfs.stat(tmp)).size
    const sha256 = await hashFile(xfs, tmp, opts.signal)
    return await placeVerified(xfs, tmp, dest, size, sha256, opts)
  } catch (err) {
    await unlinkQuiet(xfs, tmp).catch(() => {})
    throw err
  }
}

/** Renames `tmp` (`size` bytes hashing to `sha256`) to `dest`, then verifies `dest`. */
async function placeVerified(
  xfs: ExportFs,
  tmp: string,
  dest: string,
  size: number,
  sha256: string,
  opts: { signal?: AbortSignal; hashLimit?: number }
): Promise<{ size: number; sha256: string }> {
  // Never rename onto an existing file (FAT32/exFAT, antivirus).
  await unlinkQuiet(xfs, dest)
  await xfs.rename(tmp, dest)

  const onDisk = (await xfs.stat(dest)).size
  if (onDisk !== size) {
    await unlinkQuiet(xfs, dest)
    throw new VerifyError(`size mismatch after copy: wrote ${size}, found ${onDisk}`)
  }
  if (size < (opts.hashLimit ?? HASH_VERIFY_LIMIT)) {
    const reread = await hashFile(xfs, dest, opts.signal)
    if (reread !== sha256) {
      await unlinkQuiet(xfs, dest)
      throw new VerifyError('the copy does not match the source (hash mismatch)')
    }
  }
  return { size, sha256 }
}

/** Writes a small file atomically: `.anime-dl-tmp`, fsync, delete the old one, rename. */
export async function writeSmallFile(
  xfs: ExportFs,
  dest: string,
  data: string | Buffer
): Promise<void> {
  const tmp = `${dest}${TMP_SUFFIX}`
  const fh = await xfs.open(tmp, 'w')
  try {
    await fh.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await unlinkQuiet(xfs, dest)
  await xfs.rename(tmp, dest)
}
