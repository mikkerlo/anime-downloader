import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as zlib from 'zlib'

import {
  archiveUrl,
  detectFfmpegPlatform,
  ensureFfmpeg,
  getFfmpegDir,
  getFfmpegPath,
  getFfprobePath,
  clearFfmpegPaths
} from '../../src/main/ffmpeg-binaries'

describe('ffmpeg-binaries platform mapping', () => {
  it.each([
    ['win32', 'x64', 'win-64', 'ffmpeg.exe'],
    ['win32', 'ia32', 'win-64', 'ffmpeg.exe'],
    ['darwin', 'x64', 'macos-64', 'ffmpeg'],
    ['darwin', 'arm64', 'macos-64', 'ffmpeg'],
    ['linux', 'x64', 'linux-64', 'ffmpeg'],
    ['linux', 'ia32', 'linux-32', 'ffmpeg'],
    ['linux', 'arm64', 'linux-arm-64', 'ffmpeg'],
    ['linux', 'arm', 'linux-armhf-32', 'ffmpeg']
  ] as const)('maps %s/%s to %s', (plat, arch, expectedSlug, expectedBin) => {
    const info = detectFfmpegPlatform(plat as NodeJS.Platform, arch)
    expect(info).not.toBeNull()
    expect(info!.slug).toBe(expectedSlug)
    expect(info!.binaryName).toBe(expectedBin)
  })

  it('returns null for unsupported platforms', () => {
    expect(detectFfmpegPlatform('freebsd' as NodeJS.Platform, 'x64')).toBeNull()
    expect(detectFfmpegPlatform('linux', 'mips' as string)).toBeNull()
  })
})

describe('ffmpeg-binaries URL construction', () => {
  it('builds the ffmpeg / ffprobe release URL against ffbinaries-prebuilt', () => {
    expect(archiveUrl('ffmpeg', 'linux-64')).toBe(
      'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-linux-64.zip'
    )
    expect(archiveUrl('ffprobe', 'win-64')).toBe(
      'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffprobe-6.1-win-64.zip'
    )
    expect(archiveUrl('ffmpeg', 'macos-64')).toBe(
      'https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-macos-64.zip'
    )
  })
})

describe('ensureFfmpeg short-circuit', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-bin-test-'))
    clearFfmpegPaths()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    clearFfmpegPaths()
    vi.restoreAllMocks()
  })

  it('skips download and resolves with existing paths when both binaries are already present', async () => {
    // The electron mock points app.getPath('userData') at /tmp/electron-mock/userData;
    // create the ffmpeg subdir there and seed both expected files so ensureFfmpeg
    // returns the existing-path branch without hitting the network.
    const ffmpegDir = getFfmpegDir()
    fs.mkdirSync(ffmpegDir, { recursive: true })
    const ext = process.platform === 'win32' ? '.exe' : ''
    const ffmpegBin = path.join(ffmpegDir, `ffmpeg${ext}`)
    const ffprobeBin = path.join(ffmpegDir, `ffprobe${ext}`)
    fs.writeFileSync(ffmpegBin, 'fake-ffmpeg')
    fs.writeFileSync(ffprobeBin, 'fake-ffprobe')

    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await ensureFfmpeg()

    expect(result).toBe(ffmpegBin)
    expect(getFfmpegPath()).toBe(ffmpegBin)
    expect(getFfprobePath()).toBe(ffprobeBin)
    expect(fetchSpy).not.toHaveBeenCalled()

    fs.unlinkSync(ffmpegBin)
    fs.unlinkSync(ffprobeBin)
  })

  it('propagates fetch failure with a clear message and surfaces "failed" progress to window', async () => {
    const ffmpegDir = getFfmpegDir()
    try {
      fs.rmSync(ffmpegDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404, statusText: 'Not Found' })
    )

    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as Parameters<
      typeof ensureFfmpeg
    >[0]

    await expect(ensureFfmpeg(win)).rejects.toThrow(/ffmpeg download failed: 404/)
    const failed = send.mock.calls.find((c) => c[1]?.status === 'failed')
    expect(failed).toBeDefined()
  })
})

/**
 * Single-entry zip, assembled in-process (#469). No committed fixture and no
 * network: the point is that the real on-disk zip format is parsed, so the
 * bytes handed to `fetch` are a genuine archive rather than a stand-in.
 */
function buildSingleEntryZip(name: string, content: Buffer, mode = 0o755): Buffer {
  const payload = zlib.deflateRawSync(content)
  const nameBytes = Buffer.from(name, 'utf8')
  const crc = zlib.crc32(content) >>> 0

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(payload.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)

  const body = Buffer.concat([local, nameBytes, payload])

  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(8, 10)
  header.writeUInt32LE(crc, 16)
  header.writeUInt32LE(payload.length, 20)
  header.writeUInt32LE(content.length, 24)
  header.writeUInt16LE(nameBytes.length, 28)
  header.writeUInt32LE(mode << 16, 38)
  header.writeUInt32LE(0, 42)

  const directory = Buffer.concat([header, nameBytes])

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(body.length, 16)

  return Buffer.concat([body, directory, eocd])
}

describe('ensureFfmpeg zip install', () => {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const ffmpegEntry = `ffmpeg${ext}`
  const ffprobeEntry = `ffprobe${ext}`
  const ffmpegBytes = Buffer.from(`fake-ffmpeg-binary\n`.repeat(200), 'utf8')
  const ffprobeBytes = Buffer.from(`fake-ffprobe-binary\n`.repeat(150), 'utf8')

  beforeEach(() => {
    clearFfmpegPaths()
    fs.rmSync(getFfmpegDir(), { recursive: true, force: true })
  })

  afterEach(() => {
    fs.rmSync(getFfmpegDir(), { recursive: true, force: true })
    clearFfmpegPaths()
    vi.restoreAllMocks()
  })

  it('installs ffmpeg from a real zip archive without an external extractor', async () => {
    // Reds on main: `runTar(['-xf', …])` hands a zip to GNU tar, which exits 2
    // with "This does not look like a tar archive". CI runs on Linux with GNU
    // tar, so the red is the bug, not an environment accident.
    const archives: Record<string, Buffer> = {
      [`ffmpeg-6.1-`]: buildSingleEntryZip(ffmpegEntry, ffmpegBytes),
      [`ffprobe-6.1-`]: buildSingleEntryZip(ffprobeEntry, ffprobeBytes)
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      const key = Object.keys(archives).find((prefix) => url.includes(prefix))
      if (!key) throw new Error(`unexpected fetch ${url}`)
      return new Response(new Uint8Array(archives[key]), {
        status: 200,
        headers: { 'content-length': String(archives[key].length) }
      })
    })

    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as Parameters<
      typeof ensureFfmpeg
    >[0]

    const ffmpegBin = path.join(getFfmpegDir(), ffmpegEntry)
    const ffprobeBin = path.join(getFfmpegDir(), ffprobeEntry)

    await expect(ensureFfmpeg(win)).resolves.toBe(ffmpegBin)

    expect(getFfmpegPath()).toBe(ffmpegBin)
    expect(getFfprobePath()).toBe(ffprobeBin)
    // Exact bytes + the directory listing, so a stub that writes an empty file
    // (or leaves a `.partial` behind) cannot pass.
    expect(fs.readFileSync(ffmpegBin)).toEqual(ffmpegBytes)
    expect(fs.readFileSync(ffprobeBin)).toEqual(ffprobeBytes)
    expect(fs.readdirSync(getFfmpegDir()).sort()).toEqual([ffmpegEntry, ffprobeEntry].sort())
    if (process.platform !== 'win32') {
      expect(fs.statSync(ffmpegBin).mode & 0o777).toBe(0o755)
      expect(fs.statSync(ffprobeBin).mode & 0o777).toBe(0o755)
    }
    expect(send.mock.calls.some((c) => c[1]?.status === 'done')).toBe(true)
  })

  it('wraps an extractZip failure with the ffmpeg prefix and the recovery step', async () => {
    const notAZip = Buffer.from('definitely not a zip archive', 'utf8')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(new Uint8Array(notAZip), {
        status: 200,
        headers: { 'content-length': String(notAZip.length) }
      })
    })

    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as Parameters<
      typeof ensureFfmpeg
    >[0]

    const slug = detectFfmpegPlatform()!.slug
    await expect(ensureFfmpeg(win)).rejects.toThrow(
      `ffmpeg: ffmpeg-6.1-${slug}.zip is not a valid zip archive ` +
        '(no end-of-central-directory record found) — the download was probably truncated. ' +
        'Delete the ffmpeg binaries in Settings → Debug and relaunch to retry.'
    )

    // The same text has to reach the renderer, or the failure stays invisible.
    const failed = send.mock.calls.find((c) => c[1]?.status === 'failed')
    expect(failed).toBeDefined()
    expect(failed![1].message).toContain('is not a valid zip archive')
    expect(failed![1].message).toContain('Settings → Debug')
  })

  it('prefixes a bare transport error so the modal is readable', async () => {
    // An offline launch rejects `fetch` with the two words `fetch failed`, and
    // that string used to be the entire contents of the new error modal. The
    // rethrown error is deliberately left alone — only the broadcast is dressed.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'))

    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as Parameters<
      typeof ensureFfmpeg
    >[0]

    await expect(ensureFfmpeg(win)).rejects.toThrow('fetch failed')

    const failed = send.mock.calls.find((c) => c[1]?.status === 'failed')
    expect(failed).toBeDefined()
    expect(failed![1].message).toBe(
      'ffmpeg: download failed (fetch failed). Check your connection; the install retries on next launch.'
    )
  })

  it('leaves a message that already names ffmpeg alone', async () => {
    // `downloadToFile`'s `!res.ok` text reads well on its own; double-prefixing
    // it would produce "ffmpeg: download failed (ffmpeg download failed: 404…)".
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 404, statusText: 'Not Found' })
    )

    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as Parameters<
      typeof ensureFfmpeg
    >[0]

    await expect(ensureFfmpeg(win)).rejects.toThrow(/ffmpeg download failed: 404/)

    const failed = send.mock.calls.find((c) => c[1]?.status === 'failed')
    expect(failed![1].message).toMatch(/^ffmpeg download failed: 404 Not Found /)
    expect(failed![1].message).not.toContain('Check your connection')
  })

  it('reports an unsupported platform as "failed" instead of throwing silently', async () => {
    // The throw used to run above both the `try` and `sendProgress`, so this was
    // the one install failure the renderer never heard about (#469). Stub the
    // arch rather than the platform so the userData layout is untouched.
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const realArch = Object.getOwnPropertyDescriptor(process, 'arch')!
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'mips', configurable: true })

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as Parameters<
      typeof ensureFfmpeg
    >[0]

    try {
      await expect(ensureFfmpeg(win)).rejects.toThrow('ffmpeg: unsupported platform linux/mips')
    } finally {
      Object.defineProperty(process, 'platform', realPlatform)
      Object.defineProperty(process, 'arch', realArch)
    }

    expect(fetchSpy).not.toHaveBeenCalled()
    const failed = send.mock.calls.find((c) => c[1]?.status === 'failed')
    expect(failed).toBeDefined()
    expect(failed![1].message).toBe('ffmpeg: unsupported platform linux/mips')
    // And nothing claimed the download had started.
    expect(send.mock.calls.some((c) => c[1]?.status === 'downloading')).toBe(false)
  })
})
