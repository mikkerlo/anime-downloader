// The offline scenario matrix (#659): one world per test, built from a row of
// `scenarios.ts`, then the row's actions and Prepare for offline's step 4.
import { afterEach, describe, expect, it } from 'vitest'
import { ACTION_ROUTERS, buildWorld, type World } from '../../helpers/offline-world'
import { SCENARIOS, type Scenario } from './scenarios'

let world: World | null = null

afterEach(() => {
  world?.dispose()
  world = null
})

async function prepare(s: Scenario): Promise<World> {
  world = buildWorld(
    s.world,
    (s.actions ?? []).flatMap((a) => ACTION_ROUTERS[a.do])
  )
  for (const a of s.actions ?? []) await world.act(a)
  return world
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
        const w = await prepare(s)
        const out = await w.runStep('local-integrity')
        expect(
          'failed' in out
            ? out
            : { status: out.status, details: out.details.map((d) => w.norm(d.text)) }
        ).toEqual(s.expect)
      })
    }
  })
}
