// Forced updates: `Watcher.updateState` (`server.py:783-800`) deciding that a
// client's `State` changes the room rather than reports on it, and
// `Room.setPaused`/`Room.setPosition` (`server.py:606-617`) re-seating every
// watcher when it does.
//
// This is the seam the client's own seek handling sits on, and the one where a
// model that merely stored the last playstate would still look right on the
// election suite. The observable is who gets told, and what they are told.

import { describe, expect, it, inject } from 'vitest'
import { assertConforms, runConformance } from './helpers/conform'
import type { Scenario } from './helpers/scenario'

const port = inject('syncplayPort')

const file = (name: string): Record<string, unknown> => ({ name, duration: 1440, size: 1 })
const SETTLE_MS = 2600

/**
 * The playstate on a raw frame, or `null` if it carries none. Parsed rather
 * than substring-matched: the reference serialises with `json.dumps` spacing
 * (`"paused": false`) and the model with `JSON.stringify` (`"paused":false`),
 * so a literal search would silently only ever match one of the two backends.
 */
const playstateOf = (
  raw: string
): { position: number; paused: boolean; doSeek: boolean } | null => {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  const ps = (msg as { State?: { playstate?: Record<string, unknown> } }).State?.playstate
  if (!ps) return null
  return {
    position: typeof ps.position === 'number' ? ps.position : Number.NaN,
    paused: ps.paused === true,
    doSeek: ps.doSeek === true
  }
}

describe('conformance: forced updates', () => {
  it('broadcasts a seek to every watcher including the one that sent it', async () => {
    // `sendState(..., doSeek, senderLatency, forced=True)` goes out through
    // `Room.getWatchers()` with no sender exclusion, so the seeker is told about
    // its own seek. A model that echoed to the others only would still satisfy
    // every election scenario.
    const scenario: Scenario = {
      name: 'conf-forced-seek-broadcast',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'state', peer: 'bravo', position: 700, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'alpha owns the room at 500' },
        { kind: 'state', peer: 'bravo', position: 1200, paused: true, doSeek: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: "bravo's seek re-seats the whole room at 1200" }
      ]
    }
    const run = await runConformance(scenario, port)
    assertConforms(run)
    // The premise: a seek really did land, and it really did carry bravo's name
    // back out. Without it, two backends that both ignored `doSeek` would agree.
    expect(run.realFrames.some((f) => f.includes('"doSeek": true'))).toBe(true)
  })

  it('lets a seek from a losing watcher override the election', async () => {
    // A forced update calls `Room.setPosition`, which writes the new position
    // onto **every** watcher (`server.py:613-617`). The next election therefore
    // re-reads a room where nobody is below the seek target — so the seeker
    // wins even though it lost the ordering a moment earlier. `doSeek` is the
    // only way a higher watcher moves the room.
    const scenario: Scenario = {
      name: 'conf-forced-seek-overrides',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'state', peer: 'bravo', position: 900, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'alpha owns the room at 500' },
        // Not a seek: a plain claim from the losing watcher is a report, and the
        // election discards it.
        { kind: 'state', peer: 'bravo', position: 300, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: "bravo's plain claim of 300 wins on merit" },
        { kind: 'state', peer: 'alpha', position: 2000, paused: true, doSeek: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'alpha seeks above everyone and still takes the room' }
      ]
    }
    assertConforms(await runConformance(scenario, port))
  })

  it('re-seats the room on a pause change with no seek', async () => {
    // `updateState` treats a changed `paused` as forced in its own right
    // (`server.py:876-884`), separately from `doSeek`, and `__hasPauseChanged`
    // (`server.py:865-868`) measures it against the **room** rather than the
    // sender, so an unpause from a watcher the room already considers playing is
    // not forced at all.
    //
    // The samples deliberately bracket the playing stretch rather than sit
    // inside it. In a paused room `Watcher.getPosition()` (`server.py:779-787`)
    // returns `_position` verbatim, so the post-`setPosition` tie is broken by
    // insertion order and the election is deterministic. Once the room plays,
    // the same call adds `time.time() - self._lastUpdatedOn` — a per-watcher
    // stamp that `Room.setPosition` does not touch — so the winner is decided by
    // which peer's acknowledgement reached the server first. Measured here:
    // `real setBy="bravo" model="alpha"` on the mid-play sample, at a spread of
    // under a millisecond. That is the `messageAge` seam, recorded as
    // unreachable at ~0 RTT in `conformance/README.md`, not a model bug — so the
    // unpause is asserted on the frames it produced instead.
    const scenario: Scenario = {
      name: 'conf-forced-pause-change',
      peers: ['alpha', 'bravo'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'state', peer: 'bravo', position: 700, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'paused room at 500' },
        { kind: 'state', peer: 'bravo', position: 700, paused: false },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'state', peer: 'bravo', position: 720, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'bravo pauses again at 720, and the room re-seats' }
      ]
    }
    const run = await runConformance(scenario, port)
    assertConforms(run)

    // Both halves of the forced unpause, per peer and on both backends: the
    // room went playing, and every watcher was told — including bravo, which
    // asked for it. Asserted on captured frames because the sample above
    // cannot look while the room plays.
    const unpaused = (frames: readonly string[]): boolean =>
      frames.some((raw) => playstateOf(raw)?.paused === false)
    for (const peer of ['alpha', 'bravo']) {
      expect({ peer, real: unpaused(run.realByPeer[peer]) }).toEqual({ peer, real: true })
      expect({ peer, model: unpaused(run.modelByPeer[peer]) }).toEqual({ peer, model: true })
    }
  })

  it('advances a playing room between broadcasts', async () => {
    // The playing clock itself, with one watcher so the election has a single
    // candidate and the `_lastUpdatedOn` race above cannot arise. This is the
    // scenario `POSITION_TOLERANCE_PLAYING_S` is measured from.
    const scenario: Scenario = {
      name: 'conf-forced-playing-clock',
      playing: true,
      peers: ['alpha'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'paused at 500' },
        { kind: 'state', peer: 'alpha', position: 500, paused: false },
        { kind: 'wait', ms: 4200 },
        { kind: 'sample', label: 'four seconds of play later' }
      ]
    }
    const run = await runConformance(scenario, port)
    assertConforms(run)
    // The premise: the room really did advance, on both backends. Two that
    // both froze the playhead would agree at any tolerance, and the sample
    // above would be attesting to nothing.
    const advanced = (frames: readonly string[]): boolean =>
      frames.some((raw) => {
        const ps = playstateOf(raw)
        return ps !== null && !ps.paused && ps.position > 503
      })
    expect({ real: advanced(run.realFrames) }).toEqual({ real: true })
    expect({ model: advanced(run.modelFrames) }).toEqual({ model: true })
  })

  it('holds the room position while paused, however long the wait', async () => {
    // The control for the case above. `Room.getPosition` only adds elapsed time
    // when the room is playing, so a paused room that is left alone for three
    // broadcast intervals must report the same position at the end as at the
    // start — compared at the paused tolerance, which is far below the ~3 s that
    // a running clock would have added.
    const scenario: Scenario = {
      name: 'conf-forced-paused-clock',
      peers: ['alpha'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'state', peer: 'alpha', position: 640, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: 'settled at 640' },
        { kind: 'wait', ms: 3200 },
        { kind: 'sample', label: 'still 640 three intervals later' }
      ]
    }
    assertConforms(await runConformance(scenario, port))
  })
})
