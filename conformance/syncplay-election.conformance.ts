// `Room.getPosition()`'s `min()` election, against the real Syncplay 1.7.6.
//
// This is the mechanism `test/helpers/syncplay-min-election-server.ts` exists to
// model and the one it has already been wrong about once (#307). Nothing here
// touches `SyncplayClient`: a scenario is peers on sockets, and the observable
// is what the server broadcast back.

import { describe, expect, it, inject } from 'vitest'
import { assertConforms, runConformance } from './helpers/conform'
import type { Scenario } from './helpers/scenario'

const port = inject('syncplayPort')

/** A file object of the shape our client announces. */
const file = (name: string): Record<string, unknown> => ({ name, duration: 1440, size: 1 })

/**
 * Two full `SERVER_STATE_INTERVAL`s plus slack. Every sample in this suite reads
 * the most recent broadcast a peer received, so a scenario has to let both
 * backends re-elect at least once after the step under test before it looks —
 * otherwise it is comparing one backend's settled answer against the other's
 * in-flight one and calling the cadence a divergence.
 */
const SETTLE_MS = 2600

describe('conformance: Room.getPosition() elects min(watchers)', () => {
  it('names the lowest announced watcher as the room setter', async () => {
    const scenario: Scenario = {
      name: 'conf-elect-lowest',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 700, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'alpha alone at 700' },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'state', peer: 'bravo', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'bravo below alpha' }
      ]
    }
    assertConforms(await runConformance(scenario, port))
  })

  it('elects the first-inserted watcher once every watcher is fileless (#307)', async () => {
    // The historical bug modelled `__lt__` as a filter. A filter and an ordering
    // differ only here, and only when the standing setter is **not** the
    // first-inserted watcher — which is why this scenario puts `bravo` (second
    // in) below `alpha` before both clear.
    //
    //   ordering (the reference): the all-fileless room still holds an election,
    //     Python's `min()` keeps its first-inserted running best because no
    //     comparison ever succeeds, and the room is re-read from `alpha` — setBy
    //     flips to `alpha` and the position jumps 500 -> 700.
    //   filter (the #307 bug): no candidates, no election; setBy stays `bravo`
    //     and the room stays at 500.
    //
    // Two observables move together, in opposite directions from the same step.
    const scenario: Scenario = {
      name: 'conf-elect-all-fileless',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 700, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'state', peer: 'bravo', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'bravo is the standing setter at 500' },
        { kind: 'setFile', peer: 'alpha', file: null },
        { kind: 'setFile', peer: 'bravo', file: null },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'nobody has a file' }
      ]
    }
    const run = await runConformance(scenario, port)
    assertConforms(run)
    // The premise, asserted rather than assumed: if the reference stopped
    // flipping setBy here, agreement above would be agreement about nothing.
    // `run.report` carries the real server's own frames, so this reads the
    // captured transcript rather than a re-derivation of it.
    expect(run.report).toContain('"setBy": "alpha"')
  })

  it('lets an announcing watcher beat fileless peers seated before it', async () => {
    const scenario: Scenario = {
      name: 'conf-elect-announce-beats',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        // alpha never announces, so `__lt__` orders it last for ever.
        { kind: 'state', peer: 'alpha', position: 100, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'alpha seated, fileless, claiming 100' },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'state', peer: 'bravo', position: 900, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'bravo announces above alpha and still wins' }
      ]
    }
    assertConforms(await runConformance(scenario, port))
  })

  it('seats a joiner on the room position, so it can win without ever reporting', async () => {
    // The `seat()` seed at `test/helpers/syncplay-min-election-server.ts:361`,
    // and the reference's `Room.addWatcher` (`server.py:634-637`), which calls
    // `watcher.setPosition(self.getPosition())` for any room that is not empty.
    // bravo sends **no** `State` at all, announces a file, and then takes the
    // room the moment alpha claims a position above the seed.
    const scenario: Scenario = {
      name: 'conf-elect-seeded-joiner',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'bravo seated and announced, never heard from' },
        { kind: 'state', peer: 'alpha', position: 900, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'alpha jumps above the seed bravo still holds' }
      ]
    }
    assertConforms(await runConformance(scenario, port))
  })

  it('never lets a fileless peer displace the setter', async () => {
    const scenario: Scenario = {
      name: 'conf-elect-fileless-inert',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'bravo seated with no file' },
        { kind: 'state', peer: 'alpha', position: 900, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'alpha still owns the room at 900' }
      ]
    }
    assertConforms(await runConformance(scenario, port))
  })
})
