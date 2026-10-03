// Unit seam for the dependency-free zip reader (#469).
//
// Fully offline: every fixture archive is assembled byte-by-byte in-process
// with `zlib.deflateRawSync`, so there is no committed binary fixture and
// nothing reaches the network. The builder below is deliberately a real zip
// writer rather than a mock — the whole point of the module under test is that
// it parses the on-disk format correctly, so a fixture that only resembles a
// zip would prove nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import * as zlib from 'zlib'

import { extractZip } from '../../src/main/lib/unzip'

const METHOD_STORED = 0
const METHOD_DEFLATE = 8

interface FixtureEntry {
  name: string
  /** Omit for a directory entry. */
  data?: Buffer
  method?: number
  /** Unix mode recorded in the high 16 bits of the external-attributes field. */
  mode?: number
  /** Override the uncompressed size written into both headers (truncation cases). */
  declaredSize?: number
  /** DOS time word (offset 12 of the central header). Zero when omitted. */
  dosTime?: number
  /** DOS date word (offset 14). Zero when omitted, which means "no time". */
  dosDate?: number
  /** Raw central-directory extra field, e.g. a `0x5455` timestamp record. */
  extra?: Buffer
}

function crc32(data: Buffer): number {
  return zlib.crc32(data) >>> 0
}

/** The DOS date/time words for a wall-clock instant, as a zip writer packs them. */
function dosWords(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number
): { dosTime: number; dosDate: number } {
  return {
    dosTime: (hours << 11) | (minutes << 5) | (seconds >>> 1),
    dosDate: ((year - 1980) << 9) | (month << 5) | day
  }
}

/** An Info-ZIP `0x5455` extended-timestamp record carrying only an mtime. */
function utExtra(unixSeconds: number): Buffer {
  const extra = Buffer.alloc(9)
  extra.writeUInt16LE(0x5455, 0)
  extra.writeUInt16LE(5, 2)
  // Flags: bit 0 = mtime present.
  extra.writeUInt8(0x01, 4)
  extra.writeUInt32LE(unixSeconds, 5)
  return extra
}

/** Assemble a real zip: local headers, then the central directory, then the EOCD. */
function buildZip(entries: FixtureEntry[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const raw = entry.data ?? Buffer.alloc(0)
    const method = entry.method ?? (entry.data ? METHOD_DEFLATE : METHOD_STORED)
    const payload = method === METHOD_DEFLATE ? zlib.deflateRawSync(raw) : raw
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const declaredSize = entry.declaredSize ?? raw.length
    const extraBytes = entry.extra ?? Buffer.alloc(0)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(declaredSize, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt16LE(entry.dosTime ?? 0, 12)
    header.writeUInt16LE(entry.dosDate ?? 0, 14)
    header.writeUInt32LE(crc32(raw), 16)
    header.writeUInt32LE(payload.length, 20)
    header.writeUInt32LE(declaredSize, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt16LE(extraBytes.length, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt32LE(entry.mode ? entry.mode << 16 : 0, 38)
    header.writeUInt32LE(offset, 42)

    chunks.push(local, nameBytes, payload)
    central.push(header, nameBytes, extraBytes)
    offset += local.length + nameBytes.length + payload.length
  }

  const body = Buffer.concat(chunks)
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, directory, eocd])
}

/** EOCD that claims a central directory the file does not actually contain. */
function buildEocdOnly(entryCount: number, directorySize: number): Buffer {
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entryCount, 8)
  eocd.writeUInt16LE(entryCount, 10)
  eocd.writeUInt32LE(directorySize, 12)
  eocd.writeUInt32LE(0, 16)
  return eocd
}

function listRecursively(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listRecursively(path.join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

describe('extractZip', () => {
  let root: string
  let destDir: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'unzip-test-'))
    destDir = path.join(root, 'dest')
    fs.mkdirSync(destDir)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function writeArchive(name: string, bytes: Buffer): string {
    const archive = path.join(root, name)
    fs.writeFileSync(archive, bytes)
    return archive
  }

  it('round-trips a deflate (method 8) entry', async () => {
    // Repetitive content so deflate actually compresses — a stored-only
    // implementation cannot accidentally produce these bytes.
    const content = Buffer.from('ffmpeg-fake-binary\n'.repeat(500), 'utf8')
    const archive = writeArchive('deflate.zip', buildZip([{ name: 'ffmpeg', data: content }]))

    await extractZip(archive, destDir)

    expect(listRecursively(destDir)).toEqual(['ffmpeg'])
    expect(fs.readFileSync(path.join(destDir, 'ffmpeg'))).toEqual(content)
  })

  it('round-trips a stored (method 0) entry', async () => {
    const content = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])
    const archive = writeArchive(
      'stored.zip',
      buildZip([{ name: 'ffprobe', data: content, method: METHOD_STORED }])
    )

    await extractZip(archive, destDir)

    expect(fs.readFileSync(path.join(destDir, 'ffprobe'))).toEqual(content)
  })

  it('extracts every entry of a multi-entry archive, skipping directory records', async () => {
    const one = Buffer.from('first payload', 'utf8')
    const two = Buffer.from('second payload', 'utf8')
    const three = Buffer.from('third payload', 'utf8')
    const archive = writeArchive(
      'multi.zip',
      buildZip([
        { name: 'one.bin', data: one },
        { name: 'nested/' },
        { name: 'nested/two.bin', data: two },
        { name: 'three.bin', data: three, method: METHOD_STORED }
      ])
    )

    await extractZip(archive, destDir)

    // The exact path set, not "something appeared": a dropped entry reds here.
    expect(listRecursively(destDir)).toEqual(['nested/two.bin', 'one.bin', 'three.bin'])
    expect(fs.readFileSync(path.join(destDir, 'one.bin'))).toEqual(one)
    expect(fs.readFileSync(path.join(destDir, 'nested', 'two.bin'))).toEqual(two)
    expect(fs.readFileSync(path.join(destDir, 'three.bin'))).toEqual(three)
    expect(fs.statSync(path.join(destDir, 'nested')).isDirectory()).toBe(true)
  })

  it('creates the parent directory of a nested file entry with no directory record', async () => {
    // The fpcalc Windows layout minus its directory entry. An implementation
    // that only mkdirs when it sees a directory record reds here.
    const content = Buffer.from('fpcalc.exe payload', 'utf8')
    const archive = writeArchive(
      'nested-only.zip',
      buildZip([{ name: 'chromaprint-fpcalc-1.5.1-windows-x86_64/fpcalc.exe', data: content }])
    )

    await extractZip(archive, destDir)

    expect(listRecursively(destDir)).toEqual(['chromaprint-fpcalc-1.5.1-windows-x86_64/fpcalc.exe'])
    expect(
      fs.readFileSync(path.join(destDir, 'chromaprint-fpcalc-1.5.1-windows-x86_64', 'fpcalc.exe'))
    ).toEqual(content)
  })

  it('produces the same path set from the real fpcalc shape regardless of entry order', async () => {
    // Measured on chromaprint-fpcalc-1.5.1-windows-x86_64.zip: a stored
    // directory entry, then the deflated binary inside it. Both orderings must
    // land identically so ordering cannot quietly become load-bearing.
    const content = Buffer.from('fpcalc.exe payload', 'utf8')
    const dirName = 'chromaprint-fpcalc-1.5.1-windows-x86_64/'
    const fileName = `${dirName}fpcalc.exe`
    const expected = [fileName]

    const inOrder = writeArchive(
      'fpcalc-dir-first.zip',
      buildZip([{ name: dirName }, { name: fileName, data: content }])
    )
    await extractZip(inOrder, destDir)
    expect(listRecursively(destDir)).toEqual(expected)
    expect(fs.readFileSync(path.join(destDir, fileName))).toEqual(content)

    const reversedDest = path.join(root, 'dest-reversed')
    const reversed = writeArchive(
      'fpcalc-file-first.zip',
      buildZip([{ name: fileName, data: content }, { name: dirName }])
    )
    await extractZip(reversed, reversedDest)
    expect(listRecursively(reversedDest)).toEqual(expected)
    expect(fs.readFileSync(path.join(reversedDest, fileName))).toEqual(content)
  })

  it.skipIf(process.platform === 'win32')(
    'applies the Unix mode recorded in the external-attributes field',
    async () => {
      const archive = writeArchive(
        'mode.zip',
        buildZip([
          { name: 'ffmpeg', data: Buffer.from('x'), mode: 0o755 },
          { name: 'notes.txt', data: Buffer.from('y'), mode: 0o644 }
        ])
      )

      await extractZip(archive, destDir)

      expect(fs.statSync(path.join(destDir, 'ffmpeg')).mode & 0o777).toBe(0o755)
      expect(fs.statSync(path.join(destDir, 'notes.txt')).mode & 0o777).toBe(0o644)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'drops setuid/setgid/sticky from the recorded mode and keeps the permission bits',
    async () => {
      // A zip we fetched over the network gets to say "0755" and nothing more
      // (#472). The mask used to be `& 0o7777`, which copied all three special
      // bits straight out of the archive; `& 0o777` keeps only the bits this
      // line exists to carry. Asserted against the full `& 0o7777` on purpose —
      // the test above masks to `& 0o777` and is blind to exactly these bits.
      const archive = writeArchive(
        'special-bits.zip',
        buildZip([
          { name: 'ffmpeg', data: Buffer.from('x'), mode: 0o7755 },
          { name: 'notes.txt', data: Buffer.from('y'), mode: 0o4644 }
        ])
      )

      await extractZip(archive, destDir)

      expect(fs.statSync(path.join(destDir, 'ffmpeg')).mode & 0o7777).toBe(0o755)
      expect(fs.statSync(path.join(destDir, 'notes.txt')).mode & 0o7777).toBe(0o644)
    }
  )

  // The archive's recorded mtime, restored (#475). The `tar` this module
  // replaced in #472 restored it; `extractZip` shipped stamping the install
  // time instead, which is the behaviour difference these seven cases pin.
  it('restores the extended-timestamp (0x5455) mtime, to the exact second', async () => {
    // 2023-11-11 05:55:58 UTC — the ffprobe 6.1 asset's real UT value. Integer
    // seconds, so this is an equality assertion with no tolerance.
    const unixSeconds = Math.floor(Date.UTC(2023, 10, 11, 5, 55, 58) / 1000)
    const archive = writeArchive(
      'ut.zip',
      buildZip([{ name: 'ffprobe', data: Buffer.from('x'), extra: utExtra(unixSeconds) }])
    )

    await extractZip(archive, destDir)

    expect(fs.statSync(path.join(destDir, 'ffprobe')).mtime.getTime()).toBe(unixSeconds * 1000)
  })

  it('falls back to the DOS date/time words, read as local time, when no UT record is present', async () => {
    // The DOS words carry no timezone, so the expectation is built with the
    // local-time `Date` constructor and the case holds in any TZ. 2-second
    // granularity is all the words have, hence the tolerance.
    const expected = new Date(2021, 11, 23, 6, 5, 26)
    const archive = writeArchive(
      'dos.zip',
      buildZip([
        { name: 'fpcalc.exe', data: Buffer.from('x'), ...dosWords(2021, 12, 23, 6, 5, 26) }
      ])
    )

    await extractZip(archive, destDir)

    const actual = fs.statSync(path.join(destDir, 'fpcalc.exe')).mtime.getTime()
    expect(Math.abs(actual - expected.getTime())).toBeLessThanOrEqual(2000)
  })

  it('prefers the UT record over disagreeing DOS words', async () => {
    // The real ffprobe-6.1-win-64.zip numbers: DOS `2023-11-11 13:55:58`
    // against UT `2023-11-11 05:55:58Z`, the packager's clock being UTC+8.
    // libarchive takes UT, so DOS-first would have moved every tar-era install
    // by 8 hours for a UTC user and by a different amount everywhere else.
    const unixSeconds = Math.floor(Date.UTC(2023, 10, 11, 5, 55, 58) / 1000)
    // `ffmpeg` carries the same UT second against DOS words that no UTC offset
    // can turn into it, so a DOS-first reader reds here even on a UTC+8 box,
    // where the faithful ffprobe fixture alone would pass by coincidence.
    const archive = writeArchive(
      'ut-vs-dos.zip',
      buildZip([
        {
          name: 'ffprobe',
          data: Buffer.from('x'),
          extra: utExtra(unixSeconds),
          ...dosWords(2023, 11, 11, 13, 55, 58)
        },
        {
          name: 'ffmpeg',
          data: Buffer.from('y'),
          extra: utExtra(unixSeconds),
          ...dosWords(2020, 1, 2, 3, 4, 6)
        }
      ])
    )

    await extractZip(archive, destDir)

    expect(fs.statSync(path.join(destDir, 'ffprobe')).mtime.getTime()).toBe(unixSeconds * 1000)
    expect(fs.statSync(path.join(destDir, 'ffmpeg')).mtime.getTime()).toBe(unixSeconds * 1000)
  })

  it('leaves an entry with a zero DOS date and no UT record at the write time, not 1980', async () => {
    const before = Date.now()
    const archive = writeArchive(
      'no-time.zip',
      buildZip([{ name: 'ffmpeg', data: Buffer.from('x') }])
    )

    await extractZip(archive, destDir)

    const actual = fs.statSync(path.join(destDir, 'ffmpeg')).mtime.getTime()
    expect(actual).toBeGreaterThanOrEqual(before - 2000)
    expect(actual).toBeLessThanOrEqual(Date.now() + 2000)
  })

  it('leaves an entry whose DOS time word is out of range at the write time, not the rolled-over instant', async () => {
    // The time word has room for values the clock does not: hours 24–31,
    // minutes 60–63, and a seconds field of 30–31 (60–62 s). The `Date`
    // constructor carries each overflow into the next unit, so an unchecked
    // reader turns `2023-11-11 31:63:62` into `2023-11-12 08:04:02` — a
    // plausible-looking wrong time. Refusing it leaves the write time instead.
    //
    // `ffprobe` overflows the minutes within the same day, so the `getDate()`
    // check cannot refuse it and only the range test on the time word can — the
    // same blind-spot-closing trick the UT-vs-DOS case uses a second entry for.
    const ffmpegRollover = new Date(2023, 10, 12, 8, 4, 2).getTime()
    const ffprobeRollover = new Date(2023, 10, 11, 11, 4, 2).getTime()
    const before = Date.now()
    const archive = writeArchive(
      'bad-time.zip',
      buildZip([
        { name: 'ffmpeg', data: Buffer.from('x'), ...dosWords(2023, 11, 11, 31, 63, 62) },
        { name: 'ffprobe', data: Buffer.from('y'), ...dosWords(2023, 11, 11, 10, 63, 62) }
      ])
    )

    await extractZip(archive, destDir)

    for (const [name, rolledOver] of [
      ['ffmpeg', ffmpegRollover],
      ['ffprobe', ffprobeRollover]
    ] as const) {
      const actual = fs.statSync(path.join(destDir, name)).mtime.getTime()
      expect(actual).not.toBe(rolledOver)
      expect(actual).toBeGreaterThanOrEqual(before - 2000)
      expect(actual).toBeLessThanOrEqual(Date.now() + 2000)
    }
  })

  it('leaves an entry whose DOS day is past the end of a short month at the write time', async () => {
    // Day is 5 bits, so 31 fits a 30-day November; the constructor rolls it
    // into December rather than rejecting it, which is what the
    // post-construction `getDate()` check catches.
    const rolledOver = new Date(2023, 11, 1, 6, 5, 26).getTime()
    const before = Date.now()
    const archive = writeArchive(
      'short-month.zip',
      buildZip([{ name: 'ffmpeg', data: Buffer.from('x'), ...dosWords(2023, 11, 31, 6, 5, 26) }])
    )

    await extractZip(archive, destDir)

    const actual = fs.statSync(path.join(destDir, 'ffmpeg')).mtime.getTime()
    expect(actual).not.toBe(rolledOver)
    expect(actual).toBeGreaterThanOrEqual(before - 2000)
    expect(actual).toBeLessThanOrEqual(Date.now() + 2000)
  })

  it('survives a failing utimes — the file lands and no .partial is left behind', async () => {
    // A wrong timestamp on a correct binary must never fail an install, and
    // the stamp happens before the rename, so a throw here would reach the
    // catch that unlinks the `.partial` and lose the file entirely.
    //
    // `vi.spyOn(fsPromises, 'utimes')` cannot redefine a non-configurable ESM
    // namespace export (the same wall `download-manager-merge-cold-move`
    // documents for `fs.renameSync`), and a file-wide `vi.mock('fs/promises')`
    // would put every other case in this file through the stub. So the mock is
    // scoped to one fresh module graph: `doMock` + a dynamic re-import, undone
    // in the `finally`.
    const utimes = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('EPERM: operation not permitted'), { syscall: 'utimes' })
      )
    vi.resetModules()
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual<typeof fsPromises>('fs/promises')
      return { ...actual, default: actual, utimes }
    })
    try {
      const { extractZip: extractWithFailingUtimes } = await import('../../src/main/lib/unzip')
      const content = Buffer.from('ffmpeg payload', 'utf8')
      const archive = writeArchive(
        'utimes-fails.zip',
        buildZip([
          {
            name: 'ffmpeg',
            data: content,
            extra: utExtra(Math.floor(Date.UTC(2023, 10, 11, 5, 55, 58) / 1000))
          }
        ])
      )

      await expect(extractWithFailingUtimes(archive, destDir)).resolves.toBeUndefined()

      // That the stub was reached at all: without this, a build that never
      // calls `utimes` would pass this case for the wrong reason.
      expect(utimes).toHaveBeenCalledTimes(1)
      expect(listRecursively(destDir)).toEqual(['ffmpeg'])
      expect(fs.readFileSync(path.join(destDir, 'ffmpeg'))).toEqual(content)
    } finally {
      vi.doUnmock('fs/promises')
      vi.resetModules()
    }
  })

  it('refuses an entry whose name escapes the destination directory', async () => {
    const archive = writeArchive(
      'traversal.zip',
      buildZip([{ name: '../evil', data: Buffer.from('pwned', 'utf8') }])
    )

    await expect(extractZip(archive, destDir)).rejects.toThrow(
      /refusing to extract entry \.\.\/evil outside the destination directory/
    )
    expect(listRecursively(destDir)).toEqual([])
    expect(fs.existsSync(path.join(root, 'evil'))).toBe(false)
  })

  it('refuses an absolute entry name', async () => {
    const archive = writeArchive(
      'absolute.zip',
      buildZip([{ name: '/tmp/unzip-test-absolute', data: Buffer.from('pwned', 'utf8') }])
    )

    await expect(extractZip(archive, destDir)).rejects.toThrow(
      /refusing to extract entry \/tmp\/unzip-test-absolute outside the destination directory/
    )
    expect(listRecursively(destDir)).toEqual([])
  })

  it('rejects an archive with no end-of-central-directory record', async () => {
    const archive = writeArchive('garbage.zip', Buffer.from('this is not a zip at all', 'utf8'))

    await expect(extractZip(archive, destDir)).rejects.toThrow(
      'garbage.zip is not a valid zip archive (no end-of-central-directory record found)'
    )
  })

  it('rejects a truncated central directory', async () => {
    // A valid EOCD claiming one 46-byte central header the file does not hold.
    const archive = writeArchive('truncated.zip', buildEocdOnly(1, 46))

    await expect(extractZip(archive, destDir)).rejects.toThrow(
      'truncated.zip is not a valid zip archive (truncated central directory)'
    )
  })

  it('rejects an unsupported compression method, naming the method number', async () => {
    const archive = writeArchive(
      'lzma.zip',
      buildZip([{ name: 'ffmpeg', data: Buffer.from('payload', 'utf8'), method: 14 }])
    )

    await expect(extractZip(archive, destDir)).rejects.toThrow(
      'cannot extract ffmpeg from lzma.zip — unsupported zip compression method 14 ' +
        '(only stored and deflate are supported)'
    )
    expect(listRecursively(destDir)).toEqual([])
  })

  it('rejects an entry whose inflated size disagrees with the central directory and leaves nothing behind', async () => {
    const content = Buffer.from('ffmpeg-fake-binary\n'.repeat(100), 'utf8')
    const archive = writeArchive(
      'short.zip',
      buildZip([{ name: 'ffmpeg', data: content, declaredSize: content.length + 4096 }])
    )

    await expect(extractZip(archive, destDir)).rejects.toThrow(
      `short.zip: entry ffmpeg is truncated (expected ${content.length + 4096} bytes, got ${content.length})`
    )
    // The listing, not just the absence of `ffmpeg`: a leftover `ffmpeg.partial`
    // is exactly the half-installed binary the `.partial` dance exists to avoid.
    expect(listRecursively(destDir)).toEqual([])
  })

  it("throws structural messages only — the product prefix is the caller's job", async () => {
    const cases = [
      writeArchive('no-eocd.zip', Buffer.from('nope', 'utf8')),
      writeArchive('short-cd.zip', buildEocdOnly(1, 46)),
      writeArchive(
        'bad-method.zip',
        buildZip([{ name: 'ffmpeg', data: Buffer.from('p', 'utf8'), method: 99 }])
      )
    ]

    for (const archive of cases) {
      let thrown: unknown
      try {
        await extractZip(archive, destDir)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(Error)
      const message = (thrown as Error).message
      expect(message).not.toContain('ffmpeg:')
      expect(message).not.toContain('Settings → Debug')
      expect(message).toContain(path.basename(archive))
    }
  })
})
