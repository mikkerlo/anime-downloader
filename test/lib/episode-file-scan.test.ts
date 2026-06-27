import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  createEpisodeFileScanner,
  type EpisodeFileScanner
} from '../../src/main/lib/episode-file-scan'

// Identity "sanitize" so the on-disk dir/file names match the anime + episode
// strings verbatim, keeping the fixtures readable.
const identity = (s: string): string => s

function writeFiles(dir: string, names: string[]): void {
  fs.mkdirSync(dir, { recursive: true })
  for (const name of names) fs.writeFileSync(path.join(dir, name), 'x')
}

describe('episode-file-scan', () => {
  let tmpDir: string
  let downloadDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-file-scan-'))
    downloadDir = path.join(tmpDir, 'downloads')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeScanner(onChanged: (name: string, result: unknown) => void = () => {}): {
    scanner: EpisodeFileScanner
    dirScans: () => number
  } {
    let dirScanCount = 0
    const scanner = createEpisodeFileScanner({
      getDirsToScan: () => {
        dirScanCount++
        return [downloadDir]
      },
      sanitizeFilename: identity,
      onEpisodesChanged: onChanged
    })
    return { scanner, dirScans: () => dirScanCount }
  }

  it('async scan returns the same result as the sync scan (characterization)', async () => {
    writeFiles(path.join(downloadDir, 'Show'), [
      'Show - 01 [AuthorA].mkv',
      'Show - 01 [AuthorB].mp4',
      'Show - 02 [AuthorA].mkv',
      'unrelated.txt'
    ])
    const { scanner } = makeScanner()

    const sync = scanner.scanEpisodeFiles('Show')
    const async = await scanner.scanEpisodeFilesAsync('Show')

    expect(async).toEqual(sync)
    expect(Object.keys(sync).sort()).toEqual(['Show - 01', 'Show - 02'])
    expect(sync['Show - 01'].map((e) => e.author).sort()).toEqual(['AuthorA', 'AuthorB'])
  })

  it('checkEpisodeFiles first-hit resolves the filtered shared async scan result', async () => {
    writeFiles(path.join(downloadDir, 'Show'), [
      'Show - 01 [AuthorA].mkv',
      'Show - 02 [AuthorA].mkv'
    ])
    const { scanner } = makeScanner()

    // First call: cache miss → async scan via the shared scanner.
    const result = await scanner.checkEpisodeFiles('Show', ['1'])

    // Filtered down to the requested episode-int, matching what the sync scan +
    // filter would have produced for that subset.
    expect(Object.keys(result)).toEqual(['1'])
    expect(result['1'].map((e) => e.author)).toEqual(['AuthorA'])
  })

  it('dedupes concurrent first-scans for the same anime into a single scan', async () => {
    writeFiles(path.join(downloadDir, 'Show'), ['Show - 01 [AuthorA].mkv'])
    const { scanner, dirScans } = makeScanner()

    const [a, b] = await Promise.all([
      scanner.checkEpisodeFiles('Show', ['1']),
      scanner.checkEpisodeFiles('Show', ['1'])
    ])

    // Exactly one underlying scan (getDirsToScan is invoked once per scan). Both
    // callers get an equivalent result. Without the in-flight Map this is 2.
    expect(dirScans()).toBe(1)
    expect(a).toEqual(b)
    expect(Object.keys(a)).toEqual(['1'])
  })

  it('serves a cache hit and broadcasts only when a background rescan finds a change', async () => {
    writeFiles(path.join(downloadDir, 'Show'), ['Show - 01 [AuthorA].mkv'])
    const changes: { name: string; keys: string[] }[] = []
    const { scanner } = makeScanner((name, result) =>
      changes.push({ name: name as string, keys: Object.keys(result as object) })
    )

    // Prime the cache.
    await scanner.checkEpisodeFiles('Show', ['1'])
    // A new file lands on disk; the next call serves the (stale) cache hit then
    // a background rescan detects the change and broadcasts.
    writeFiles(path.join(downloadDir, 'Show'), [
      'Show - 01 [AuthorA].mkv',
      'Show - 02 [AuthorA].mkv'
    ])
    await scanner.checkEpisodeFiles('Show', ['1', '2'])
    // Let the fire-and-forget background rescan settle (real async readdir).
    for (let i = 0; i < 50 && changes.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(changes).toHaveLength(1)
    expect(changes[0].keys.sort()).toEqual(['Show - 01', 'Show - 02'])
  })

  it('invalidate during an in-flight miss-scan suppresses the stale cache write', async () => {
    // FS holds only ep01 for the whole duration of the in-flight scan.
    writeFiles(path.join(downloadDir, 'Show'), ['Show - 01 [AuthorA].mkv'])
    const { scanner } = makeScanner()

    // Start a cache-miss scan but don't await it; invalidate while it's pending.
    const pending = scanner.checkEpisodeFiles('Show', ['1', '2'])
    scanner.invalidate('Show')
    await pending

    // A new episode lands. The next check must run a FRESH scan (the cache was
    // NOT repopulated with the stale in-flight result), so it reflects ep02. On
    // the old unconditional-`set` code the cache holds the stale {ep01} and
    // serves a hit → ep02 is missing from the returned result.
    writeFiles(path.join(downloadDir, 'Show'), [
      'Show - 01 [AuthorA].mkv',
      'Show - 02 [AuthorA].mkv'
    ])
    const result = await scanner.checkEpisodeFiles('Show', ['1', '2'])
    expect(Object.keys(result).sort()).toEqual(['1', '2'])
  })

  it('invalidate / invalidateByDirName / clear drop cache entries', async () => {
    writeFiles(path.join(downloadDir, 'Show'), ['Show - 01 [AuthorA].mkv'])
    const { scanner, dirScans } = makeScanner()

    await scanner.checkEpisodeFiles('Show', ['1']) // scan #1, primes cache
    scanner.invalidate('Show')
    await scanner.checkEpisodeFiles('Show', ['1']) // scan #2 (cache dropped)
    scanner.invalidateByDirName('Show')
    await scanner.checkEpisodeFiles('Show', ['1']) // scan #3
    scanner.clear()
    await scanner.checkEpisodeFiles('Show', ['1']) // scan #4

    expect(dirScans()).toBe(4)
  })
})
