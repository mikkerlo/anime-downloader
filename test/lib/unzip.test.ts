// Unit seam for the dependency-free zip reader (#469).
//
// Fully offline: every fixture archive is assembled byte-by-byte in-process
// with `zlib.deflateRawSync`, so there is no committed binary fixture and
// nothing reaches the network. The builder below is deliberately a real zip
// writer rather than a mock — the whole point of the module under test is that
// it parses the on-disk format correctly, so a fixture that only resembles a
// zip would prove nothing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
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
}

function crc32(data: Buffer): number {
  return zlib.crc32(data) >>> 0
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
    header.writeUInt32LE(crc32(raw), 16)
    header.writeUInt32LE(payload.length, 20)
    header.writeUInt32LE(declaredSize, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt32LE(entry.mode ? entry.mode << 16 : 0, 38)
    header.writeUInt32LE(offset, 42)

    chunks.push(local, nameBytes, payload)
    central.push(header, nameBytes)
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
