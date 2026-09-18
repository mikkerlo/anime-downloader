// The guard that makes the ignore list load-bearing.
//
// #367 asks for a field-level ignore list, each entry naming its seam, rather
// than a blanket tolerance. A list nobody checks is a comment: the reference
// could grow a field, or the model could start emitting one, and it would go
// uncompared in silence — which is the same hole a blanket tolerance leaves,
// reached more slowly. So the list is asserted against the wire.
//
// This scenario is deliberately the widest one in the suite. It drives a join,
// an announcement, a clear, a plain claim, a seek, a pause change and a roster
// request, so the frames it collects are a fair sample of everything the two
// backends say to a client of this shape.

import { describe, expect, it, inject } from 'vitest'
import { runConformance } from './helpers/conform'
import { COMPARED_FIELD_PATHS, IGNORED_FIELDS, unlistedFieldPaths } from './helpers/trace-diff'
import type { Scenario } from './helpers/scenario'

const port = inject('syncplayPort')

const file = (name: string): Record<string, unknown> => ({ name, duration: 1440, size: 1 })

const wideScenario: Scenario = {
  name: 'conf-field-coverage',
  playing: true,
  peers: ['alpha', 'bravo'],
  steps: [
    { kind: 'seat', peer: 'alpha' },
    { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
    { kind: 'state', peer: 'alpha', position: 500, paused: true },
    { kind: 'wait', ms: 1400 },
    { kind: 'seat', peer: 'bravo' },
    { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
    { kind: 'state', peer: 'bravo', position: 700, paused: true },
    { kind: 'wait', ms: 1400 },
    { kind: 'requestList', peer: 'alpha' },
    { kind: 'wait', ms: 600 },
    { kind: 'sample', label: 'roster in hand' },
    { kind: 'state', peer: 'bravo', position: 1200, paused: true, doSeek: true },
    { kind: 'wait', ms: 1400 },
    { kind: 'state', peer: 'bravo', position: 1200, paused: false },
    { kind: 'wait', ms: 1400 },
    { kind: 'setFile', peer: 'alpha', file: null },
    { kind: 'setWithoutFile', peer: 'bravo' },
    { kind: 'wait', ms: 1400 },
    { kind: 'requestList', peer: 'bravo' },
    { kind: 'wait', ms: 600 },
    { kind: 'sample', label: 'after the clear' }
  ]
}

describe('conformance: field coverage', () => {
  it('leaves no field on either wire undecided', async () => {
    const run = await runConformance(wideScenario, port)

    // The premise first: a run that collected nothing would pass both
    // assertions below while attesting to nothing at all.
    expect(run.realFrames.length).toBeGreaterThan(10)
    expect(run.modelFrames.length).toBeGreaterThan(10)

    // Both directions. A field only the model emits is as much an undecided
    // field as one only the reference emits — and the model emitting something
    // the reference never sends is the more interesting of the two.
    expect({ real: unlistedFieldPaths(run.realFrames) }).toEqual({ real: [] })
    expect({ model: unlistedFieldPaths(run.modelFrames) }).toEqual({ model: [] })
  })

  it('reaches every compared field at least once', async () => {
    // The other half of the guard. Without this, a compared path could be
    // misspelled — or the reference could stop sending it — and the suite would
    // go on reporting agreement about a field nobody was looking at.
    const run = await runConformance(wideScenario, port)
    const seen = (frames: readonly string[], path: string): boolean => {
      const head = path.split('.')[0]
      const leaf = path.split('.').pop() as string
      return frames.some((f) => f.includes(`"${head}"`) && f.includes(`"${leaf}"`))
    }
    const missing = COMPARED_FIELD_PATHS.filter((p) => !seen(run.realFrames, p))
    expect({ unreachedComparedFields: missing }).toEqual({ unreachedComparedFields: [] })
  })

  it('keeps the ignore list from swallowing a compared field', () => {
    // The one way this guard could be turned off without anyone noticing: an
    // ignore entry broad enough to cover a path the comparison reads. Adding
    // `State.playstate.*` to quiet a divergence would leave the suite reporting
    // agreement about a field nobody looks at any more, and
    // `unlistedFieldPaths()` would go on returning `[]` throughout.
    const swallowed = COMPARED_FIELD_PATHS.filter((compared) =>
      IGNORED_FIELDS.some((entry) => {
        if (!entry.path.endsWith('.*')) return entry.path === compared
        const head = entry.path.slice(0, -2)
        return compared === head || compared.startsWith(head + '.')
      })
    )
    expect({ comparedFieldsAlsoIgnored: swallowed }).toEqual({ comparedFieldsAlsoIgnored: [] })

    // And an entry with no stated seam is not an ignore, it is a shrug.
    const unreasoned = IGNORED_FIELDS.filter((e) => e.seam.trim() === '').map((e) => e.path)
    expect({ entriesWithNoSeam: unreasoned }).toEqual({ entriesWithNoSeam: [] })
  })
})
