import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

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
