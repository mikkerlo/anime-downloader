// Fixtures for the release asset gate (#365, #373). Each case drives `analyze()`
// or `uploadAll()` over in-memory data rather than a live release, so the
// assertions stay exact and nothing here touches the network.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Mocked for one case only — the CLI's `gh` helper is module-private, so the
// spawn options it passes can only be read from here.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
import { execFileSync } from 'node:child_process'

// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import * as releaseAssets from '../scripts/release-assets.mjs'

const {
  analyze,
  report,
  uploadAll,
  backoffMs,
  artifactNames,
  attachedAssets,
  GH_CALL_TIMEOUT_MS,
  DEFAULT_BUDGET_MS,
  REQUIRED_FEEDS
} = releaseAssets

type Result = {
  expected: string[]
  attached: string[]
  missing: string[]
  extra: string[]
  missingFeeds: string[]
}

// The three `electron-updater` feeds. Every fixture that is not about the feed
// floor itself carries them, so the case under test is the only thing failing.
const FEEDS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']

const run = (expected: string[], attached: string[]): Result =>
  analyze({ expected, attached }) as Result

// The real v4.6.93 build. Thirteen files came out of the matrix; the release
// step started all thirteen uploads at once, eight landed, one returned
// `Error saving asset` and the remaining four were abandoned silently. The
// AppImage is in the attached set because it kept going and finished eleven
// minutes after the step had already failed — which is exactly why "the step
// exited 0" is not the same fact as "the release is complete".
const V4_6_93_EXPECTED = [
  'Anime-DL-4.6.93-amd64.deb',
  'Anime-DL-4.6.93-arm64.dmg',
  'Anime-DL-4.6.93-arm64.dmg.blockmap',
  'Anime-DL-4.6.93-arm64.zip',
  'Anime-DL-4.6.93-arm64.zip.blockmap',
  'Anime-DL-4.6.93-x64-portable.exe',
  'Anime-DL-4.6.93-x64.exe',
  'Anime-DL-4.6.93-x64.exe.blockmap',
  'Anime-DL-4.6.93-x86_64.AppImage',
  'builder-debug.yml',
  'latest-linux.yml',
  'latest-mac.yml',
  'latest.yml'
]

const V4_6_93_ATTACHED = [
  'latest-linux.yml',
  'latest.yml',
  'latest-mac.yml',
  'builder-debug.yml',
  'Anime-DL-4.6.93-x86_64.AppImage',
  'Anime-DL-4.6.93-x64.exe.blockmap',
  'Anime-DL-4.6.93-arm64.zip.blockmap',
  'Anime-DL-4.6.93-arm64.dmg.blockmap'
]

describe('release-assets — verify', () => {
  it('passes when the attached set matches the artifacts exactly', () => {
    const files = [...FEEDS, 'Anime-DL-9.9.9-x64.exe']
    // Order differs on purpose: the release lists assets in upload-completion
    // order, `artifacts/` in directory order, and neither is the other.
    const r = run(files, [...files].reverse())

    expect(r.missing).toEqual([])
    expect(r.extra).toEqual([])
    expect(r.missingFeeds).toEqual([])
    expect(report(r).ok).toBe(true)
  })

  it('names every artifact that never attached', () => {
    const r = run([...FEEDS, 'Anime-DL-9.9.9-x64.exe', 'Anime-DL-9.9.9-amd64.deb'], FEEDS)

    expect(r.missing).toEqual(['Anime-DL-9.9.9-amd64.deb', 'Anime-DL-9.9.9-x64.exe'])
    const { ok, err } = report(r)
    expect(ok).toBe(false)
    expect(err.join('\n')).toContain('2 artifact(s) never attached')
    expect(err.join('\n')).toContain('Anime-DL-9.9.9-x64.exe')
  })

  it('reds on an asset the build did not produce', () => {
    // Pinned choice: an extra asset FAILS. This job is the only writer of the
    // draft, so an unaccounted-for binary means a build job published into it.
    const r = run(FEEDS, [...FEEDS, 'Anime-DL-9.9.8-x64.exe'])

    expect(r.missing).toEqual([])
    expect(r.extra).toEqual(['Anime-DL-9.9.8-x64.exe'])
    const { ok, err } = report(r)
    expect(ok).toBe(false)
    expect(err.join('\n')).toContain('did not come from this build')
  })

  it('reds on an empty artifact set rather than publishing an empty release', () => {
    const { ok, err } = report(run([], []))

    expect(ok).toBe(false)
    expect(err.join('\n')).toContain('No artifacts were found to release')
    // One diagnosis, not two. Nothing arrived, so listing all three feeds as
    // individually absent would bury the sentence that explains why.
    expect(err.join('\n')).not.toContain('electron-updater feed(s)')
  })

  it('reds when a build leg produced nothing, although everything downloaded is attached', () => {
    // The floor under the comparison. `upload-artifact` runs with
    // `if-no-files-found: ignore`, so a leg whose `dist/` globs stop matching
    // uploads nothing and the release job downloads nothing for that platform.
    // Both sets are then computed without it: every file that did arrive is
    // attached, `missing` and `extra` are empty, and a release with no Windows
    // binaries in it compares clean.
    const builtWithoutWindows = [
      'latest-linux.yml',
      'latest-mac.yml',
      'Anime-DL-9.9.9-x86_64.AppImage',
      'Anime-DL-9.9.9-arm64.dmg'
    ]
    const r = run(builtWithoutWindows, builtWithoutWindows)

    expect(r.missing).toEqual([])
    expect(r.extra).toEqual([])
    expect(r.missingFeeds).toEqual(['latest.yml'])

    const { ok, err } = report(r)
    expect(ok).toBe(false)
    expect(err.join('\n')).toContain('1 electron-updater feed(s) never reached the release')
    expect(err.join('\n')).toContain('latest.yml')
    expect(err.join('\n')).toContain('404 the update check')
  })

  it('requires exactly the three updater feeds, one per platform', () => {
    // Pinned, not looped: this set is the whole content of the floor, and a
    // name silently dropped from it would take a platform's coverage with it.
    expect([...(REQUIRED_FEEDS as string[])].sort()).toEqual([
      'latest-linux.yml',
      'latest-mac.yml',
      'latest.yml'
    ])
  })

  it('catches the real v4.6.93 loss: 13 built, 8 attached, 5 binaries named', () => {
    const r = run(V4_6_93_EXPECTED, V4_6_93_ATTACHED)

    expect(r.expected).toHaveLength(13)
    expect(r.attached).toHaveLength(8)
    expect(r.missing).toEqual([
      'Anime-DL-4.6.93-amd64.deb',
      'Anime-DL-4.6.93-arm64.dmg',
      'Anime-DL-4.6.93-arm64.zip',
      'Anime-DL-4.6.93-x64-portable.exe',
      'Anime-DL-4.6.93-x64.exe'
    ])
    expect(r.extra).toEqual([])
    expect(report(r).ok).toBe(false)
  })
})

describe('release-assets — reading the two sets back', () => {
  it('counts an asset GitHub has not finished writing as missing', () => {
    // GitHub creates the asset record before the bytes land, so a half-written
    // asset sits on the release under exactly the right name. A name-only gate
    // calls that set complete and publishes a release carrying an asset nobody
    // can download — the failure this step exists to stop, one layer in.
    const gh = vi.fn(() =>
      JSON.stringify({
        assets: [
          { name: 'latest.yml', state: 'uploaded', size: 344 },
          { name: 'latest-mac.yml', state: 'uploaded', size: 412 },
          { name: 'latest-linux.yml', state: 'uploaded', size: 388 },
          { name: 'Anime-DL-9.9.9-x64.exe', state: 'starter', size: 0 }
        ]
      })
    )

    const attached = attachedAssets('v9.9.9', gh) as string[]

    expect(gh).toHaveBeenCalledWith(['release', 'view', 'v9.9.9', '--json', 'assets'])
    expect(attached).not.toContain('Anime-DL-9.9.9-x64.exe')

    const r = run([...FEEDS, 'Anime-DL-9.9.9-x64.exe'], attached)
    expect(r.missing).toEqual(['Anime-DL-9.9.9-x64.exe'])
    expect(report(r).ok).toBe(false)
  })

  it('reads a missing artifacts/ as the empty set rather than throwing ENOENT', () => {
    // `download-artifact` creates nothing when there is nothing to download, and
    // `report()` has a much better message for an empty set than a `node:fs`
    // stack does — at the moment the log most needs to be readable.
    expect(artifactNames(join(import.meta.dirname, 'no-such-artifacts-dir'))).toEqual([])

    // …and still reads a directory that is there.
    expect(artifactNames(join(import.meta.dirname, '..', 'scripts'))).toContain(
      'release-assets.mjs'
    )
  })

  it('bounds every gh call, so an upload that never returns cannot sit forever', () => {
    // Pins the spawn option, not the kill: nothing here hangs a real process.
    // What it catches is the option being dropped, which is how the bound was
    // missing in the first place — `execFileSync` defaults to no timeout.
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ assets: [] }))

    attachedAssets('v9.9.9')

    const opts = vi.mocked(execFileSync).mock.calls[0][2] as {
      timeout?: number
      killSignal?: string
    }
    expect(opts.timeout).toBe(GH_CALL_TIMEOUT_MS)
    expect(Number.isFinite(opts.timeout)).toBe(true)
    expect(opts.killSignal).toBe('SIGKILL')
  })

  it('caps the release job below the retry budget it has to contain', () => {
    const yml = readFileSync(
      join(import.meta.dirname, '..', '.github', 'workflows', 'release.yml'),
      'utf8'
    )
    // The `release:` job only, not whichever job happens to declare one first.
    const job = yml.slice(yml.indexOf('\n  release:') + 1).split(/\n {2}(?=\w)/)[0]
    const cap = job.match(/^\s+timeout-minutes: (\d+)$/m)

    expect(cap).not.toBeNull()
    const minutes = Number(cap![1])
    expect(minutes).toBeLessThanOrEqual(30)
    // The script has to give up and report first; if the runner's kill is what
    // fires, nothing says which file was stuck.
    expect(DEFAULT_BUDGET_MS / 60_000).toBeLessThan(minutes)
  })
})

describe('release-assets — upload', () => {
  const noSleep = () => Promise.resolve()

  it('retries a flaky file and reports it uploaded', async () => {
    const tries: number[] = []
    const uploadOne = vi.fn(async (_f: string, attempt: number) => {
      tries.push(attempt)
      if (attempt < 3) throw new Error('Error saving asset')
    })

    const r = await uploadAll({ files: ['big.exe'], uploadOne, sleep: noSleep })

    expect(tries).toEqual([1, 2, 3])
    expect(r.uploaded).toEqual(['big.exe'])
    expect(r.failed).toEqual([])
  })

  it('does not abandon later files when an earlier one exhausts its retries', async () => {
    // The whole defect: on v4.6.93 one asset errored and four others still in
    // flight were dropped with no log line. Every file must get its own run.
    const seen: string[] = []
    const uploadOne = async (f: string) => {
      seen.push(f)
      if (f === 'doomed.dmg') throw new Error('Error saving asset')
    }

    const r = await uploadAll({
      files: ['a.exe', 'doomed.dmg', 'b.deb', 'c.zip'],
      uploadOne,
      attempts: 2,
      sleep: noSleep
    })

    expect(seen).toEqual(['a.exe', 'doomed.dmg', 'doomed.dmg', 'b.deb', 'c.zip'])
    expect(r.uploaded).toEqual(['a.exe', 'b.deb', 'c.zip'])
    expect(r.failed).toEqual([{ file: 'doomed.dmg', tries: 2, error: 'Error saving asset' }])
  })

  it('leaves the missing file for verify to name', async () => {
    const r = await uploadAll({
      files: ['a.exe', 'doomed.dmg'],
      uploadOne: async (f: string) => {
        if (f === 'doomed.dmg') throw new Error('nope')
      },
      attempts: 1,
      sleep: noSleep
    })

    // `upload` never decides the outcome; `verify` reads the release back and
    // does. Feeding the upload result straight through must name the same file.
    const v = run(['a.exe', 'doomed.dmg'], r.uploaded as string[])
    expect(v.missing).toEqual(['doomed.dmg'])
    expect(report(v).ok).toBe(false)
  })

  it('stops retrying a hung file, but still gives the next one its first attempt', async () => {
    // The stall case. Each attempt on a hung PUT burns the whole per-call
    // timeout, so five of them is 75 min for one file against a 30 min job cap:
    // the runner would kill the job part-way through attempt 2 and the log
    // would never say which file it was stuck on.
    //
    // The two halves of the guard are both here. A *retry* asks whether another
    // full-length call could still fit, so neither hung file gets a second
    // attempt. A *first* attempt only asks whether the budget is spent, so
    // next.deb is still tried — refusing it outright would guarantee it is
    // missing, where trying it only risks the job's backstop. third.zip is
    // refused because by then the 20 minutes really are gone.
    const callMs = 15 * 60_000
    let clock = 0
    const uploadOne = vi.fn(async () => {
      clock += callMs
      throw new Error('gh timed out')
    })

    const r = await uploadAll({
      files: ['big.AppImage', 'next.deb', 'third.zip'],
      uploadOne,
      sleep: noSleep,
      now: () => clock,
      callMs,
      budgetMs: 20 * 60_000
    })

    expect(uploadOne).toHaveBeenCalledTimes(2)
    expect(r.uploaded).toEqual([])
    expect(r.failed).toEqual([
      {
        file: 'big.AppImage',
        tries: 1,
        error: 'gh timed out (no time left in the 20 min upload budget to retry)'
      },
      {
        file: 'next.deb',
        tries: 1,
        error: 'gh timed out (no time left in the 20 min upload budget to retry)'
      },
      { file: 'third.zip', tries: 0, error: 'no time left in the 20 min upload budget' }
    ])
  })

  it('lets a slow but healthy release finish rather than refusing files untried', async () => {
    // v4.6.91's real asset set, sizes from `gh release view`, at the throughput
    // the real failing run actually managed — 722 MB whose last asset landed
    // about eleven minutes in. Nothing here is failing: every call returns.
    //
    // The regression this pins: one conservative guard for both first attempts
    // and retries reduces to "refuse anything not yet started after 5 minutes"
    // at these numbers (20 min budget less a 15 min call), so this run lost 9 of
    // its 13 assets without a single upload being attempted for them. A healthy
    // release failing outright is worse than the bug the budget was added for.
    const sizesMb: Record<string, number> = {
      'Anime-DL-amd64.deb': 106.19,
      'Anime-DL-arm64.dmg': 136.53,
      'Anime-DL-arm64.dmg.blockmap': 0.14,
      'Anime-DL-arm64.zip': 129.64,
      'Anime-DL-arm64.zip.blockmap': 0.13,
      'Anime-DL-x64-portable.exe': 105.46,
      'Anime-DL-x64.exe': 105.79,
      'Anime-DL-x64.exe.blockmap': 0.11,
      'Anime-DL-x86_64.AppImage': 137.84,
      'builder-debug.yml': 0.001,
      'latest-linux.yml': 0.001,
      'latest-mac.yml': 0.001,
      'latest.yml': 0.001
    }
    const files = Object.keys(sizesMb)
    let clock = 0
    const uploadOne = vi.fn(async (f: string) => {
      clock += (sizesMb[f] / 1.06) * 1000
    })

    // Defaults on purpose: this is about the shipped numbers, not injected ones.
    const r = await uploadAll({ files, uploadOne, sleep: noSleep, now: () => clock })

    // The run has to be long enough to have crossed the old cut-off, or it
    // proves nothing.
    expect(clock).toBeGreaterThan(DEFAULT_BUDGET_MS - GH_CALL_TIMEOUT_MS)
    expect(clock).toBeLessThan(DEFAULT_BUDGET_MS)

    expect(r.failed).toEqual([])
    expect(r.uploaded).toEqual(files)
    expect(uploadOne).toHaveBeenCalledTimes(13)
  })

  it('spends the full attempt count when the failures come back fast', () => {
    // The budget must never bind on the class this script exists for: five
    // attempts plus the backoff below is ~2.5 min per file.
    const worstCaseRetry = [1, 2, 3, 4].reduce((a, n) => a + backoffMs(n), 0)
    expect(worstCaseRetry).toBeLessThan(DEFAULT_BUDGET_MS)
  })

  it('backs off between attempts and caps the wait', () => {
    expect([1, 2, 3, 4, 5].map((a) => backoffMs(a))).toEqual([5000, 10000, 20000, 40000, 60000])
  })
})
