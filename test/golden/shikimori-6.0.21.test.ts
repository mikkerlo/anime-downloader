// The 6.0.21 goldens (#689, epic #688's hard constraint): a scripted
// Shikimori-only session reproduces the files and results captured from
// 6.0.21, ignoring timestamps and `appVersion`. Every later slice of the epic
// keeps this green. The fixtures are frozen: a slice never regenerates them,
// and the only sanctioned change to Shikimori-only output (T1's new store
// keys) goes through `GOLDEN_NEW_KEYS` in `test/helpers/golden-allow-list.ts`.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ...(await import('../helpers/golden-shikimori')).goldenApi
}))

import { runGoldenSession, STEP_TIMES, type GoldenCapture } from '../helpers/golden-session'
import { GOLDEN_NEW_KEYS } from '../helpers/golden-allow-list'
import {
  DRIVE_MASKS,
  JSON_MASKS,
  MASKED,
  comparableConfig,
  configProblems,
  loadGolden,
  maskDrive,
  maskJson
} from '../helpers/golden-compare'

const golden = loadGolden()
let actual: GoldenCapture

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: STEP_TIMES.boot })
  // Nothing in the session may reach the network: an unmocked Shikimori call
  // fails as a network error instead.
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('golden: no network')
  })
  const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    actual = await runGoldenSession()
  } finally {
    quiet.mockRestore()
  }
}, 60_000)

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const masked = (name: string, value: unknown): unknown => maskJson(value, JSON_MASKS[name]).masked

describe('a Shikimori-only session reproduces the 6.0.21 goldens', () => {
  it('config.json: the same keys and values, new keys only from the allow-list', () => {
    expect(configProblems(actual.config, golden.config)).toEqual({
      extra: [],
      missing: [],
      offDefault: [],
      notNew: []
    })
    expect(comparableConfig(actual.config)).toEqual(comparableConfig(golden.config))
  })

  it('the allow-list holds only keys the 6.0.21 golden does not have', () => {
    expect(Object.keys(GOLDEN_NEW_KEYS).filter((k) => k in golden.config)).toEqual([])
  })

  it('the userData files: the same files, and the same values', () => {
    expect(Object.keys(actual.userData).sort()).toEqual(Object.keys(golden.userData).sort())
    for (const [file, value] of Object.entries(golden.userData)) {
      expect(masked(file, actual.userData[file]), file).toEqual(masked(file, value))
    }
  })

  it('the drive’s v1 manifest/state pair: the same bytes', () => {
    expect(Object.keys(actual.drive).sort()).toEqual(['manifest.json', 'state.json'])
    for (const [file, text] of Object.entries(golden.drive)) {
      expect(maskDrive(file, actual.drive[file]).masked, file).toBe(maskDrive(file, text).masked)
    }
  })

  it('Prepare for offline: the same steps, in order, with the same results', () => {
    expect(masked('prepare.json', actual.prepare)).toEqual(masked('prepare.json', golden.prepare))
  })

  it('the auto-download tick: the same result, broadcasts and downloads', () => {
    expect(masked('tick.json', actual.tick)).toEqual(masked('tick.json', golden.tick))
  })
})

describe('the goldens are what the session meant to capture', () => {
  it('the merge left one pending raise and one conflict, and A’s queue parked', () => {
    const pending = golden.userData['sync-pending/4242.json'] as {
      rates: Record<string, Record<string, { value: number }>>
    }
    expect(pending.rates['9101'].episodes.value).toBe(6)
    const conflicts = golden.userData['sync-state/conflicts.json'] as {
      records: { fieldPath: string }[]
    }
    expect(conflicts.records.map((r) => r.fieldPath)).toEqual(['rate.score'])
    const config = golden.config as {
      shikimoriUser: { id: number }
      shikimoriUpdateQueue: unknown[]
      shikimoriParkedQueues: Record<string, { entries: unknown[] }>
    }
    expect(config.shikimoriUser.id).toBe(777)
    expect(config.shikimoriUpdateQueue).toEqual([])
    expect(config.shikimoriParkedQueues['4242'].entries).toHaveLength(2)
  })

  it('Prepare ran all six steps and the tick queued one download', () => {
    const steps = (golden.prepare as { steps: { id: string }[] }).steps.map((s) => s.id)
    expect(steps).toEqual([
      'binaries',
      'shikimori-rates',
      'metadata',
      'local-integrity',
      'attached-integrity',
      'library-sync'
    ])
    expect((golden.tick.result as { enqueued: number }).enqueued).toBe(1)
  })

  it('no mask is stale: each one masks something in the golden', () => {
    const artifacts: Record<string, unknown> = {
      'config.json': golden.config,
      'prepare.json': golden.prepare,
      'tick.json': golden.tick,
      ...golden.userData
    }
    for (const [name, masks] of Object.entries(JSON_MASKS)) {
      const { hits } = maskJson(artifacts[name], masks)
      for (const mask of masks) expect(hits[mask], `${name}: ${mask}`).toBeGreaterThan(0)
    }
    for (const name of Object.keys(DRIVE_MASKS)) {
      expect(
        maskDrive(name, golden.drive[name]).hits.every((n) => n === 1),
        name
      ).toBe(true)
    }
  })
})

describe('the comparison helpers', () => {
  it('masks only the named path', () => {
    const { masked: m } = maskJson({ a: { x: { at: 1, v: 2 } }, at: 3 }, ['a.*.at'])
    expect(m).toEqual({ a: { x: { at: MASKED, v: 2 } }, at: 3 })
  })

  it('masks one field of one block in the drive bytes, nothing else', () => {
    const text = '{\n  "at": 5,\n  "lastWriter": {\n    "appVersion": "9.9.9",\n    "at": 7\n  }\n}'
    expect(maskDrive('manifest.json', text).masked).toBe(
      `{\n  "at": 5,\n  "lastWriter": {\n    "appVersion": "${MASKED}",\n    "at": "${MASKED}"\n  }\n}`
    )
  })

  it('accepts a new key only from the allow-list, at its default', () => {
    const g = { a: 1 }
    expect(configProblems({ a: 1, b: 2 }, g, {})).toEqual({
      extra: ['b'],
      missing: [],
      offDefault: [],
      notNew: []
    })
    expect(configProblems({ a: 1, b: 2 }, g, { b: 2 })).toEqual({
      extra: [],
      missing: [],
      offDefault: [],
      notNew: []
    })
    expect(configProblems({ a: 1, b: 3 }, g, { b: 2 }).offDefault).toEqual(['b'])
    expect(configProblems({}, g, {}).missing).toEqual(['a'])
  })

  it('refuses an allow-listed key the golden already has', () => {
    // Allow-listing an existing key would drop it from both sides of the comparison.
    expect(configProblems({ a: 5 }, { a: 1 }, { a: 5 }).notNew).toEqual(['a'])
  })
})
