// Fixtures for the release asset gate (#365, #373). Each case drives `analyze()`
// or `uploadAll()` over in-memory data rather than a live release, so the
// assertions stay exact and nothing here touches the network.
import { describe, it, expect, vi } from 'vitest'

// @ts-expect-error — plain .mjs CI script, deliberately outside the tsconfig graph
import { analyze, report, uploadAll, backoffMs } from '../scripts/release-assets.mjs'

type Result = {
  expected: string[]
  attached: string[]
  missing: string[]
  extra: string[]
}

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
    const files = ['latest.yml', 'Anime-DL-9.9.9-x64.exe']
    // Order differs on purpose: the release lists assets in upload-completion
    // order, `artifacts/` in directory order, and neither is the other.
    const r = run(files, [...files].reverse())

    expect(r.missing).toEqual([])
    expect(r.extra).toEqual([])
    expect(report(r).ok).toBe(true)
  })

  it('names every artifact that never attached', () => {
    const r = run(
      ['latest.yml', 'Anime-DL-9.9.9-x64.exe', 'Anime-DL-9.9.9-amd64.deb'],
      ['latest.yml']
    )

    expect(r.missing).toEqual(['Anime-DL-9.9.9-amd64.deb', 'Anime-DL-9.9.9-x64.exe'])
    const { ok, err } = report(r)
    expect(ok).toBe(false)
    expect(err.join('\n')).toContain('2 artifact(s) never attached')
    expect(err.join('\n')).toContain('Anime-DL-9.9.9-x64.exe')
  })

  it('reds on an asset the build did not produce', () => {
    // Pinned choice: an extra asset FAILS. This job is the only writer of the
    // draft, so an unaccounted-for binary means a build job published into it.
    const r = run(['latest.yml'], ['latest.yml', 'Anime-DL-9.9.8-x64.exe'])

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

  it('backs off between attempts and caps the wait', () => {
    expect([1, 2, 3, 4, 5].map((a) => backoffMs(a))).toEqual([5000, 10000, 20000, 40000, 60000])
  })
})
