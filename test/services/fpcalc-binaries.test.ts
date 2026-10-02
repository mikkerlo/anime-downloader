import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'

import {
  detectFpcalcPlatform,
  ensureFpcalc,
  getFpcalcDir,
  type FpcalcPlatformInfo
} from '../../src/main/fpcalc-binaries'

// #470. chromaprint v1.5.1 publishes one asset per platform, and the `ia32`
// branch asked for a `windows-i686.zip` that release never shipped (404 against
// the live release; v1.5.0 was the last to publish one). The fix routes 32-bit
// Windows through `detectFpcalcPlatform`'s `null` return instead, which
// `ensureFpcalc` already turns into `fpcalc: unsupported platform …` *before*
// touching the network.
//
// Shape of this file follows `test/services/ffmpeg-binaries.test.ts`: the whole
// per-arch decision lives in one pure function with injectable `plat`/`arch`
// parameters, so the matrix is a table and only the "we never called fetch"
// property needs the `process` stub.

/**
 * Every arch the app can observe, with the archive each must resolve to.
 * `null` means "no asset exists; refuse without a download".
 *
 * The non-ia32 rows are not decoration — this table is the guard on the arch
 * rewrite itself. `win32`/`arm64` in particular must keep the x86_64 asset
 * (Windows 11 emulates x64), so narrowing the guard to `arch === 'x64'` has to
 * red here rather than pass as a silent behaviour change.
 */
const PLATFORM_MATRIX: ReadonlyArray<readonly [NodeJS.Platform, string, string | null]> = [
  ['linux', 'x64', 'chromaprint-fpcalc-1.5.1-linux-x86_64.tar.gz'],
  ['darwin', 'x64', 'chromaprint-fpcalc-1.5.1-macos-x86_64.tar.gz'],
  ['darwin', 'arm64', 'chromaprint-fpcalc-1.5.1-macos-x86_64.tar.gz'],
  ['win32', 'x64', 'chromaprint-fpcalc-1.5.1-windows-x86_64.zip'],
  ['win32', 'arm64', 'chromaprint-fpcalc-1.5.1-windows-x86_64.zip'],
  ['win32', 'ia32', null],
  ['linux', 'arm64', null]
] as const

const EXPECTED_ARCHIVE_FORMAT: Record<string, FpcalcPlatformInfo['archiveFormat']> = {
  linux: 'tar.gz',
  darwin: 'tar.gz',
  win32: 'zip'
}

describe('fpcalc-binaries platform mapping', () => {
  it('covers every arch the matrix claims', () => {
    // Pinned so a dropped row cannot quietly shrink the matrix: a table-driven
    // suite that loses a case still reports all-green.
    expect(PLATFORM_MATRIX).toHaveLength(7)
    expect(PLATFORM_MATRIX.filter(([, , archive]) => archive === null)).toHaveLength(2)
  })

  it.each(PLATFORM_MATRIX)('maps %s/%s to %s', (plat, arch, expectedArchive) => {
    const info = detectFpcalcPlatform(plat, arch)

    if (expectedArchive === null) {
      expect(info).toBeNull()
      return
    }

    expect(info).not.toBeNull()
    expect(info!.archiveName).toBe(expectedArchive)
    expect(info!.archiveFormat).toBe(EXPECTED_ARCHIVE_FORMAT[plat])
    expect(info!.binaryName).toBe(plat === 'win32' ? 'fpcalc.exe' : 'fpcalc')
  })

  it('never resolves an i686 archive for any arch', () => {
    // The specific dead URL, asserted by name rather than by "ia32 is null", so
    // reinstating the branch under a different arch label still reds.
    const resolved = PLATFORM_MATRIX.map(([plat, arch]) => detectFpcalcPlatform(plat, arch)).filter(
      (info): info is FpcalcPlatformInfo => info !== null
    )
    expect(resolved).toHaveLength(5)
    for (const info of resolved) {
      expect(info.archiveName).not.toContain('i686')
    }
  })

  it('returns null for platforms with no chromaprint asset', () => {
    expect(detectFpcalcPlatform('freebsd' as NodeJS.Platform, 'x64')).toBeNull()
    expect(detectFpcalcPlatform('linux', 'arm')).toBeNull()
    expect(detectFpcalcPlatform('win32', 'ia32')).toBeNull()
  })
})

describe('ensureFpcalc on an unsupported platform', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!

  beforeEach(() => {
    // The electron mock points app.getPath('userData') at /tmp/electron-mock/userData
    // (test/setup/electron-mock.ts:140), so getFpcalcDir() is a directory shared
    // with every other run in this tree. A stray fpcalc.exe left there by another
    // test would trip ensureFpcalc's existence short-circuit and this case would
    // pass without ever reaching detectFpcalcPlatform — green on the unfixed code.
    fs.rmSync(getFpcalcDir(), { recursive: true, force: true })

    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'ia32', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
    Object.defineProperty(process, 'arch', archDescriptor)
    vi.restoreAllMocks()
  })

  it('rejects win32/ia32 without attempting a download', async () => {
    expect(fs.existsSync(getFpcalcDir())).toBe(false)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(ensureFpcalc()).rejects.toThrow('fpcalc: unsupported platform win32/ia32')

    // The half that matters: before the fix detectPlatform() handed back the
    // i686 descriptor, so this reached downloadToFile and fetched a URL that
    // 404s. Asserting the message alone would pass on a pure string change.
    expect(fetchSpy).toHaveBeenCalledTimes(0)
    // And nothing was staged on disk for a download that must not happen.
    expect(fs.existsSync(getFpcalcDir())).toBe(false)
  })
})
