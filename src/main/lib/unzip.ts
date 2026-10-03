// Dependency-free zip reader (#469).
//
// We fetch ffmpeg/ffprobe (and fpcalc on Windows) as `.zip` archives and used
// to hand them to the system `tar` with `-xf`. That only works when `tar` is
// bsdtar/libarchive — true on macOS and Windows 10 1803+, false on every box
// with GNU tar, which is most of Linux. ffbinaries publishes no tar-format
// asset for any slug we can request, so the archive source cannot change: the
// extractor has to read zip itself.
//
// Scope is deliberately narrow — stored (method 0) and deflate (method 8), no
// zip64, no encryption, no multi-disk. That covers every asset we fetch today;
// anything else fails with an explicit, actionable message naming the method
// number rather than a mystery.
//
// Two invariants worth keeping in mind when editing:
//
// - Entries stream. The inflated `ffmpeg` is ~79 MB, so every entry goes
//   through `pipeline` + `createInflateRaw`; never `inflateRawSync` into a
//   Buffer.
// - Entries land atomically. `ensureFfmpeg` treats "both files exist" as
//   "installed" forever, so a half-inflated binary left at its final path
//   would be accepted by every later launch. Each entry is written to
//   `<name>.partial`, its byte count checked against the central directory,
//   and renamed only on success; any throw unlinks the `.partial`.
//
// Messages thrown here are the *structural* half only — archive basename plus
// the problem. No product prefix and no recovery sentence: this module serves
// both ffmpeg-binaries.ts and fpcalc-binaries.ts, and the caller owns the
// user-facing wrapping.

import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import * as zlib from 'zlib'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

const EOCD_FIXED_SIZE = 22
const CENTRAL_FIXED_SIZE = 46
const LOCAL_FIXED_SIZE = 30
/** A zip comment is a 16-bit length, so the EOCD can sit at most this far back. */
const MAX_COMMENT_SIZE = 0xffff

const METHOD_STORED = 0
const METHOD_DEFLATE = 8

/** Info-ZIP "extended timestamp" extra field: Unix seconds, UTC (#475). */
const EXTRA_EXTENDED_TIMESTAMP = 0x5455
const EXTRA_FIXED_SIZE = 4

// Node >= 20.15 only; `engines.node` is ">=20", so feature-detect rather than
// raising the floor. The byte-count check below is the unconditional guarantee.
const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : null

interface ZipEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  externalAttributes: number
  /** Resolved modification time, or `null` when the entry records none. */
  mtime: Date | null
}

/**
 * Walk a central-directory extra field for a `0x5455` extended-timestamp
 * record and return its mtime.
 *
 * This is preferred over the DOS words because it is what the `tar` this
 * module replaced in #472 used: libarchive (bsdtar, and Windows' `tar.exe`)
 * takes the mtime from `0x5455` when present, and both assets we fetch carry
 * one. They do not agree with the DOS words — `ffprobe-6.1-win-64.zip` records
 * DOS `2023-11-11 13:55:58` against UT `2023-11-11 05:55:58Z`, i.e. the
 * packager's clock was UTC+8 — and since the DOS words carry no timezone,
 * reading them alone would stamp that binary 8 hours off for a UTC user and by
 * a different amount everywhere else (#475).
 *
 * The record's first body byte is a flags bitmap; bit 0 says an mtime follows
 * it as 32-bit Unix seconds. Access and creation times may follow under bits 1
 * and 2 and are not read.
 */
function readExtendedTimestamp(extra: Buffer): Date | null {
  let cursor = 0
  while (cursor + EXTRA_FIXED_SIZE <= extra.length) {
    const id = extra.readUInt16LE(cursor)
    const size = extra.readUInt16LE(cursor + 2)
    const body = cursor + EXTRA_FIXED_SIZE
    if (body + size > extra.length) break
    if (id === EXTRA_EXTENDED_TIMESTAMP && size >= 5 && (extra.readUInt8(body) & 1) !== 0) {
      return new Date(extra.readUInt32LE(body + 1) * 1000)
    }
    cursor = body + size
  }
  return null
}

/**
 * Convert the DOS date/time words to a `Date`, or `null` for a date that is
 * absent or impossible.
 *
 * The words are local time with no timezone and 2-second granularity, so they
 * are built with the local-time `Date` constructor rather than `Date.UTC`.
 * A zero date word is the common case here — plenty of zips in the wild record
 * no time at all — and such an entry is left alone rather than stamped 1980.
 */
function readDosTimestamp(time: number, date: number): Date | null {
  const day = date & 0x1f
  const month = (date >>> 5) & 0x0f
  const year = 1980 + ((date >>> 9) & 0x7f)
  if (day === 0 || month < 1 || month > 12) return null
  const seconds = (time & 0x1f) * 2
  const minutes = (time >>> 5) & 0x3f
  const hours = (time >>> 11) & 0x1f
  return new Date(year, month - 1, day, hours, minutes, seconds)
}

function notAZip(label: string, detail: string): Error {
  return new Error(`${label} is not a valid zip archive (${detail})`)
}

function findEocd(tail: Buffer): number {
  for (let i = tail.length - EOCD_FIXED_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  return -1
}

async function readCentralDirectory(
  handle: fsPromises.FileHandle,
  size: number,
  label: string
): Promise<ZipEntry[]> {
  const tailLength = Math.min(size, MAX_COMMENT_SIZE + EOCD_FIXED_SIZE)
  const tail = Buffer.alloc(tailLength)
  if (tailLength > 0) await handle.read(tail, 0, tailLength, size - tailLength)
  const eocd = findEocd(tail)
  if (eocd < 0) throw notAZip(label, 'no end-of-central-directory record found')

  const count = tail.readUInt16LE(eocd + 10)
  const directorySize = tail.readUInt32LE(eocd + 12)
  const directoryOffset = tail.readUInt32LE(eocd + 16)

  const directory = Buffer.alloc(directorySize)
  if (directorySize > 0) {
    const { bytesRead } = await handle.read(directory, 0, directorySize, directoryOffset)
    if (bytesRead < directorySize) throw notAZip(label, 'truncated central directory')
  }

  const entries: ZipEntry[] = []
  let cursor = 0
  for (let i = 0; i < count; i++) {
    if (
      cursor + CENTRAL_FIXED_SIZE > directory.length ||
      directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE
    ) {
      throw notAZip(label, 'truncated central directory')
    }
    const nameLength = directory.readUInt16LE(cursor + 28)
    const extraLength = directory.readUInt16LE(cursor + 30)
    const commentLength = directory.readUInt16LE(cursor + 32)
    const nameStart = cursor + CENTRAL_FIXED_SIZE
    const next = nameStart + nameLength + extraLength + commentLength
    if (next > directory.length) throw notAZip(label, 'truncated central directory')
    const extraStart = nameStart + nameLength
    const extra = directory.subarray(extraStart, extraStart + extraLength)
    entries.push({
      name: directory.toString('utf8', nameStart, nameStart + nameLength),
      method: directory.readUInt16LE(cursor + 10),
      crc: directory.readUInt32LE(cursor + 16),
      compressedSize: directory.readUInt32LE(cursor + 20),
      uncompressedSize: directory.readUInt32LE(cursor + 24),
      externalAttributes: directory.readUInt32LE(cursor + 38),
      localHeaderOffset: directory.readUInt32LE(cursor + 42),
      // Resolved here, not in `extractEntry`, so the extractor stays free of
      // format parsing. UT first, DOS only as a fallback.
      mtime:
        readExtendedTimestamp(extra) ??
        readDosTimestamp(directory.readUInt16LE(cursor + 12), directory.readUInt16LE(cursor + 14))
    })
    cursor = next
  }
  return entries
}

/**
 * Resolve an entry name against `destDir`, refusing anything that escapes it.
 * The extractor only ever writes under the caller's install directory, so an
 * absolute name or a `../` prefix is a hard rejection, not a sanitisation.
 */
function resolveEntryPath(destDir: string, name: string, label: string): string {
  const normalized = name.replace(/\\/g, '/')
  const root = path.resolve(destDir)
  const target = path.resolve(root, normalized)
  const escapes =
    path.isAbsolute(normalized) ||
    normalized.startsWith('/') ||
    (target !== root && !target.startsWith(root + path.sep))
  if (escapes) {
    throw new Error(`${label}: refusing to extract entry ${name} outside the destination directory`)
  }
  return target
}

async function localDataOffset(
  handle: fsPromises.FileHandle,
  entry: ZipEntry,
  label: string
): Promise<number> {
  const header = Buffer.alloc(LOCAL_FIXED_SIZE)
  const { bytesRead } = await handle.read(header, 0, LOCAL_FIXED_SIZE, entry.localHeaderOffset)
  if (bytesRead < LOCAL_FIXED_SIZE || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error(
      `${label}: entry ${entry.name} has no local file header at offset ${entry.localHeaderOffset}`
    )
  }
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  return entry.localHeaderOffset + LOCAL_FIXED_SIZE + nameLength + extraLength
}

async function extractEntry(
  archivePath: string,
  handle: fsPromises.FileHandle,
  entry: ZipEntry,
  destDir: string,
  label: string
): Promise<void> {
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    throw new Error(
      `cannot extract ${entry.name} from ${label} — unsupported zip compression method ` +
        `${entry.method} (only stored and deflate are supported)`
    )
  }

  const target = resolveEntryPath(destDir, entry.name, label)
  // Derived from the entry name, never from having seen a directory record:
  // the fpcalc Windows zip nests its binary one level deep, and a zip whose
  // only trace of that directory is the path prefix must still extract.
  await fsPromises.mkdir(path.dirname(target), { recursive: true })

  const partial = `${target}.partial`
  try {
    let written = 0
    let checksum = 0
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        written += chunk.length
        if (crc32) checksum = crc32(chunk, checksum)
        done(null, chunk)
      }
    })

    if (entry.compressedSize === 0) {
      await fsPromises.writeFile(partial, '')
    } else {
      const dataOffset = await localDataOffset(handle, entry, label)
      const source = fs.createReadStream(archivePath, {
        start: dataOffset,
        end: dataOffset + entry.compressedSize - 1
      })
      if (entry.method === METHOD_DEFLATE) {
        await pipeline(source, zlib.createInflateRaw(), meter, fs.createWriteStream(partial))
      } else {
        await pipeline(source, meter, fs.createWriteStream(partial))
      }
    }

    if (written !== entry.uncompressedSize) {
      throw new Error(
        `${label}: entry ${entry.name} is truncated ` +
          `(expected ${entry.uncompressedSize} bytes, got ${written})`
      )
    }
    if (crc32 && entry.crc !== 0 && checksum >>> 0 !== entry.crc) {
      throw new Error(`${label}: entry ${entry.name} failed its CRC-32 check`)
    }

    // Stamped on the `.partial`, before the rename, because `rename` preserves
    // mtime: the file turns up at its final path already carrying the
    // archive's time, and the catch below keeps its one job of unlinking a
    // leftover `.partial` (after the rename there is none left to unlink).
    // Non-fatal — a correct binary with the install time beats a failed
    // install — and skipped entirely for an entry that records no time, which
    // must not be stamped with 1980 or the epoch (#475).
    if (entry.mtime) {
      await fsPromises.utimes(partial, entry.mtime, entry.mtime).catch(() => {})
    }

    await fsPromises.rename(partial, target)

    // Unix mode lives in the high 16 bits of the external-attributes field.
    // Belt-and-braces only: ffmpeg-binaries.ts still chmods the final path.
    // Permission bits only (#472): a wider mask would copy setuid/setgid/sticky
    // out of a fetched archive, and carrying execute over is all this is for.
    const mode = (entry.externalAttributes >>> 16) & 0o777
    if (mode !== 0 && process.platform !== 'win32') {
      await fsPromises.chmod(target, mode)
    }
  } catch (err) {
    await fsPromises.unlink(partial).catch(() => {})
    throw err
  }
}

/**
 * Extract every file entry of `archivePath` under `destDir`, in-process.
 *
 * Supports stored and deflate; rejects any other compression method, an
 * archive with no end-of-central-directory record, a truncated central
 * directory, an entry whose inflated size disagrees with the central
 * directory, and any entry name that escapes `destDir`.
 */
export async function extractZip(archivePath: string, destDir: string): Promise<void> {
  const label = path.basename(archivePath)
  await fsPromises.mkdir(destDir, { recursive: true })
  const handle = await fsPromises.open(archivePath, 'r')
  try {
    const { size } = await handle.stat()
    const entries = await readCentralDirectory(handle, size, label)
    for (const entry of entries) {
      // Explicit directory records carry no data; the per-file mkdir above
      // recreates the tree regardless of whether they are present.
      if (entry.name.endsWith('/')) continue
      await extractEntry(archivePath, handle, entry, destDir, label)
    }
  } finally {
    await handle.close()
  }
}
