// The offline scenario matrix (#659): one world per test, built from a row of
// `scenarios.ts`, then the row's actions, Prepare for offline's step 4, and
// one oracle over what it reported. See `docs/testing.md`, "Scenario matrix
// (offline)".
import * as fs from 'fs'
import * as os from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { ACTION_ROUTERS, buildWorld, type World } from '../../helpers/offline-world'
import { check, ORACLE_ROUTERS, type Run } from '../../helpers/offline-oracles'
import { SCENARIOS, type Scenario } from './scenarios'

let world: World | null = null

afterEach(() => {
  world?.dispose()
  world = null
})

async function observe(s: Scenario): Promise<Run> {
  const routers = [
    ...(s.actions ?? []).flatMap((a) => ACTION_ROUTERS[a.do]),
    ...s.oracles.flatMap((o) => ORACLE_ROUTERS[o])
  ]
  const w = (world = buildWorld(s.world, routers))
  for (const a of s.actions ?? []) await w.act(a)
  const before = w.snapshot()
  const out = await w.runStep('local-integrity')
  const after = w.snapshot()
  return { scenario: s.id, world: w, before, after, out, outcomes: await w.entryOutcomes() }
}

// A read-only folder stands in for a file Windows holds open; root ignores it.
const noLock = process.platform === 'win32' || process.getuid?.() === 0

describe('one world at a time', () => {
  it('buildWorld throws while another world is live', () => {
    world = buildWorld({ titles: [] })
    expect(() => buildWorld({ titles: [] })).toThrow(/another world is still live/)
  })

  it('a build that throws partway leaves no live world, so the next build works', () => {
    // A NUL in a folder name makes `mkdirSync` throw while the files are written.
    const bad = { titles: [{ id: 1, entries: [{ ep: '1', trId: 11, under: 'Bad\0Name' }] }] }
    const roots = (): string[] =>
      fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('offline-world-'))
    const before = roots()
    expect(() => buildWorld(bad)).toThrow(/null bytes/)
    const left = roots().filter((d) => !before.includes(d))
    expect(left).toHaveLength(1)
    world = buildWorld({ titles: [] })
    expect(world.files.size).toBe(0)
    expect(roots()).not.toContain(left[0])
  })
})

for (const s of SCENARIOS) {
  describe.skipIf(s.locked && noLock)(`${s.id}: ${s.title}`, () => {
    if (s.expect) {
      it('step 4 reports exactly this', async () => {
        const { out, world: w } = await observe(s)
        expect(
          'failed' in out
            ? out
            : { status: out.status, details: out.details.map((d) => w.norm(d.text)) }
        ).toEqual(s.expect)
      })
    }
    for (const oracle of s.oracles) {
      const known = s.known?.find((k) => k.oracle === oracle)
      const agreed = s.agreed?.find((a) => a.oracle === oracle)
      const name = known
        ? `${oracle} (known: #${known.issue})`
        : agreed
          ? `${oracle} (agreed, still fires)`
          : oracle
      it(name, async () => {
        const violations = await check(oracle, await observe(s))
        if (known) expect(violations).toEqual(known.violations)
        else if (agreed) expect(violations.length).toBeGreaterThan(0)
        else expect(violations).toEqual([])
      })
    }
  })
}

// Every pair with violations needs a filed issue or a cited acceptance.
const COMMENT_URL =
  /^https:\/\/github\.com\/mikkerlo\/anime-downloader\/issues\/\d+#issuecomment-\d+$/
const RISKS_LINE = /^#\d+ Risks: ".+"$/

describe('known pins and agreed exemptions', () => {
  for (const s of SCENARIOS) {
    it(`${s.id}: each names a filed issue or a source, on an oracle the row runs`, () => {
      const exempted = [...(s.known ?? []), ...(s.agreed ?? [])].map((x) => x.oracle)
      expect(new Set(exempted).size).toBe(exempted.length)
      for (const k of s.known ?? []) {
        expect(Number.isInteger(k.issue) && k.issue > 0).toBe(true)
        expect(s.oracles).toContain(k.oracle)
        expect(k.violations.length).toBeGreaterThan(0)
        for (const v of k.violations) expect(v).toMatchObject({ scenario: s.id, oracle: k.oracle })
      }
      for (const a of s.agreed ?? []) {
        expect(COMMENT_URL.test(a.source) || RISKS_LINE.test(a.source)).toBe(true)
        expect(s.oracles).toContain(a.oracle)
      }
    })
  }

  it('row ids are unique', () => {
    const ids = SCENARIOS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
