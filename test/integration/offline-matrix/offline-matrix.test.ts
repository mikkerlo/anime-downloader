// The offline scenario matrix (#659): one world per test, built from a row of
// `scenarios.ts`, then the row's actions, Prepare for offline's step 4, and
// one oracle over what it reported.
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

describe('one world at a time', () => {
  it('buildWorld throws while another world is live', () => {
    world = buildWorld({ titles: [] })
    expect(() => buildWorld({ titles: [] })).toThrow(/another world is still live/)
  })
})

for (const s of SCENARIOS) {
  describe(`${s.id}: ${s.title}`, () => {
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
      it(oracle, async () => {
        expect(await check(oracle, await observe(s))).toEqual([])
      })
    }
  })
}
