// Pins the manual-update helper backing the Windows-portable update flow
// (#189): version comparison, portable-build detection, and the GitHub
// latest-release check (fetch-injected — no network).
import { describe, it, expect, vi } from 'vitest'
import {
  isNewerVersion,
  isPortableBuild,
  checkLatestRelease,
  RELEASES_LATEST_API,
  RELEASES_LATEST_PAGE
} from '../../src/main/lib/manual-update'

describe('isNewerVersion', () => {
  it.each([
    ['4.2.3', '4.2.2', true],
    ['4.2.2', '4.2.2', false],
    ['4.2.1', '4.2.2', false],
    ['5.0.0', '4.9.9', true],
    ['v4.3.0', '4.2.2', true], // tag-style v prefix
    ['4.2.10', '4.2.9', true], // numeric, not lexicographic
    ['4.3', '4.2.9', true], // shorter candidate
    ['4.2', '4.2.0', false], // missing segments are zero
    ['4.2.2.1', '4.2.2', true], // longer candidate
    ['abc', '4.2.2', false] // garbage compares as zeros
  ])('(%s newer than %s) === %s', (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected)
  })
})

describe('isPortableBuild', () => {
  it('true only for win32 with PORTABLE_EXECUTABLE_DIR set', () => {
    expect(isPortableBuild('win32', { PORTABLE_EXECUTABLE_DIR: 'C:\\Users\\x\\AppData' })).toBe(
      true
    )
    expect(isPortableBuild('win32', {})).toBe(false)
    expect(isPortableBuild('win32', { PORTABLE_EXECUTABLE_DIR: '' })).toBe(false)
    expect(isPortableBuild('linux', { PORTABLE_EXECUTABLE_DIR: '/tmp' })).toBe(false)
    expect(isPortableBuild('darwin', { PORTABLE_EXECUTABLE_DIR: '/tmp' })).toBe(false)
  })
})

describe('checkLatestRelease', () => {
  function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
    return vi.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch
  }

  it('reports a newer release as available with its release-page url', async () => {
    const fetchImpl = fakeFetch({
      tag_name: 'v9.9.9',
      html_url: 'https://github.com/mikkerlo/anime-downloader/releases/tag/v9.9.9'
    })
    const result = await checkLatestRelease('4.2.2', fetchImpl)
    expect(result).toEqual({
      status: 'available',
      version: '9.9.9',
      url: 'https://github.com/mikkerlo/anime-downloader/releases/tag/v9.9.9'
    })
    expect(fetchImpl).toHaveBeenCalledWith(RELEASES_LATEST_API, expect.anything())
  })

  it('reports up-to-date when the latest tag is not newer', async () => {
    const same = await checkLatestRelease('4.2.2', fakeFetch({ tag_name: 'v4.2.2' }))
    expect(same.status).toBe('up-to-date')
    const older = await checkLatestRelease('4.2.2', fakeFetch({ tag_name: 'v4.1.0' }))
    expect(older.status).toBe('up-to-date')
  })

  it('falls back to the releases page url and up-to-date when the payload has no tag', async () => {
    const result = await checkLatestRelease('4.2.2', fakeFetch({}))
    expect(result).toEqual({ status: 'up-to-date', url: RELEASES_LATEST_PAGE })
  })

  it('throws on HTTP failure so the caller can broadcast an error state', async () => {
    await expect(checkLatestRelease('4.2.2', fakeFetch({}, false, 403))).rejects.toThrow('HTTP 403')
  })
})
