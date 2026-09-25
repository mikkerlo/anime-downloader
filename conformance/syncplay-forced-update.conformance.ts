// Forced updates: `Watcher.updateState` (`server.py:875-884`) deciding that a
// client's `State` changes the room rather than reports on it, and
// `Room.setPaused`/`Room.setPosition` (`server.py:610-613` and
// `server.py:615-620`) re-seating every watcher when it does.
//
// This is the seam the client's own seek handling sits on, and the one where a
// model that merely stored the last playstate would still look right on the
// election suite. The observable is who gets told, and what they are told.

import { describe, expect, it, inject } from 'vitest'
import { assertConforms, assertPinnedDivergence, runConformance } from './helpers/conform'
import type { Scenario } from './helpers/scenario'

const port = inject('syncplayPort')

const file = (name: string): Record<string, unknown> => ({ name, duration: 1440, size: 1 })
const SETTLE_MS = 2600
const PING_WAIT_MS = 4000

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
    // onto **every** watcher (`server.py:617-619`). The next election therefore
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

  it('re-elects the room on a playstate-free frame, because the stamp is unconditional', async () => {
    // The frame `sendAck()` sends: a `ping` and the server's own
    // `ignoringOnTheFly` counter, with no `playstate` key at all. That frame's
    // own comment called it "provably inert server-side" until #392, and it is
    // not inert. `Watcher.updateState` (`server.py:875-884`) writes
    // `self._lastUpdatedOn = time.time()` as the second of its five
    // statements, `server.py:877`, unconditional and above the `position is
    // not None` guard — so an accepted `State` stamps whatever else it omits.
    // The other three statements are all conditional and a playstate-free
    // frame skips every one of them: `handleState` passes `position`, `paused`
    // and `doSeek` all as `None` (`protocols.py:772`, `protocols.py:780-781`),
    // so `__hasPauseChanged` returns False at `server.py:866-867`,
    // `setPosition` is guarded out, and `forcePositionUpdate`
    // (`server.py:883-884`) is too.
    //
    // The stamp is the origin of the position projection, which is what gives
    // the omission a consequence. `Watcher.getPosition()` (`server.py:780-787`)
    // returns `_position` plus the time elapsed since the stamp while the room
    // plays, and `Room.setPosition` (`server.py:615-620`) re-seats every
    // watcher's `_position` onto the seek target without touching any stamp.
    // After a forced update the stamp is therefore the only differing term
    // left, the newest stamp carries the smallest elapsed term, and the `min()`
    // in `Room.getPosition()` (`server.py:597-604`) hands the room to whoever
    // stamped last. alpha's ping-only frame takes the room off bravo, and the
    // room moves *backwards* to roughly where bravo's seek put it.
    //
    // The magnitude is `PING_WAIT_MS` rather than an incidental delay, and it
    // is measured from bravo's stamp, not alpha's: bravo's stamp is its own
    // acknowledgement of its seek, about a millisecond after it, and nothing
    // re-stamps bravo before the sample. `Peer` has no heartbeat timer at all;
    // its automatic acknowledgement is gated on an inbound `ignoringOnTheFly`,
    // which a periodic `State` does not carry; and alpha's ping-only frame
    // sets neither `position` nor `paused`, so `server.py:883` forces nothing
    // off the back of it. Against the 1.6 s floor
    // (`conformance/helpers/trace-diff.ts:54`, selected by `playing: true`)
    // that is a floor cleared by a factor of two and a half.
    //
    // Which is also why this scenario may sample mid-play where
    // `conf-forced-pause-change` above deliberately brackets the playing
    // stretch. That note is about a sub-millisecond `_lastUpdatedOn` spread the
    // two backends phase independently; here the gap under test dominates that
    // spread by three orders of magnitude. The margin is this scenario's
    // property, not an exemption from the note.
    //
    // **The model diverges here, and that divergence is the scenario working
    // rather than a fixture to repair — so it is pinned as an expected
    // divergence rather than compared for agreement.**
    // `test/helpers/syncplay-min-election-server.ts:708` returns above its own
    // stamp at `test/helpers/syncplay-min-election-server.ts:729`, so a
    // playstate-free frame genuinely is inert in the model — the mirror is
    // faithful to the old comment rather than to the server, which is why
    // nothing here caught the claim. Moving that stamp is #384's item 4. Until
    // it lands this scenario runs nightly and **passes**, holding the shape of
    // that one divergence exactly: the model lags the reference by roughly
    // `PING_WAIT_MS`, which is the projection term the missing stamp leaves in
    // place. When item 4 lands the pin stops holding and the scenario reds,
    // which is the signal to swap the pin back to a plain agreement check. See
    // the pin at the foot of this test for the full statement. This therefore
    // does not have to merge with item 4 or after it.
    //
    // Every step below is load-bearing, because the default failure in this
    // scenario is not a red. It is a green that measures nothing:
    //
    //  - **`setFile` on both peers.** `Watcher.__lt__` is guarded at
    //    `server.py:835` — false when self's position *or* self's `_file` is
    //    `None` — and at `server.py:837`, true when the other side's is. Two
    //    file-less watchers therefore compare `False` every way round and
    //    `min()` returns insertion order, so "the newest stamp wins" would be
    //    decided by the seating order whatever the stamps said.
    //  - **The unpause, and from bravo.** A fresh room is `STATE_PAUSED`
    //    (`server.py:543`) and `playing: true` only picks a tolerance; the one
    //    thing that flips the room is `updateState`'s pause-changed branch at
    //    `server.py:878-879`. While the room is paused `Watcher.getPosition()`
    //    takes its `timePassedSinceSet = 0` arm (`server.py:785-786`) and the
    //    stamp has no observable consequence whatsoever — inert on both
    //    backends, and green. From bravo rather than alpha so that alpha's
    //    seat-time `state` remains its only accepted frame, which is what makes
    //    the budget below exact rather than approximate.
    //  - **A settle between alpha's `state` and bravo's unpause.** Those two
    //    leave different sockets, with no ordering guarantee. Serviced the
    //    other way round, the unpause's forced update raises alpha's ignore
    //    flag before alpha's `state` is read, `protocols.py:788` discards it,
    //    and alpha's clock dates from `Watcher.__init__` (`server.py:734`) —
    //    the Hello, not a scripted step. The budget below has a left-hand side
    //    only while alpha's stamp is pinned to a step the script controls.
    //  - **A settle between the unpause and the seek.** The unpause is itself a
    //    forced update (`server.py:883-884`), and `broadcastRoom`
    //    (`server.py:441-445`) iterates the room with no sender exclusion, so
    //    bravo raises its *own* `serverIgnoringOnTheFly`
    //    (`protocols.py:752-753`). Without the settle bravo's seek leaves the
    //    same socket inside the same `lineReceived`, dies at
    //    `protocols.py:788`, and the room never leaves the unpause position —
    //    every run, not a race. Measured against the pin: no seek on the wire,
    //    and a room sample sitting on the unpause position rather than on the
    //    seek target. **Both halves of the pair `701.96` without the settle
    //    against `1201.73` with it are the *probe's*** — an instrumented run
    //    whose unpause step used `700` — and neither is a capture of this
    //    script. This script unpauses at `500`, so the figure it would produce
    //    without the settle is the unpause position plus the ~2 s of play
    //    before the sample, ≈`501.96`. What transfers is the seek target,
    //    `1200` in both, not the digits after it: one local run of this
    //    scenario against the pinned server sampled the real room at
    //    `1201.901` on both peers, where the probe read `1201.73`. The ~1.9 s
    //    is where the sample lands on the 1 Hz broadcast grid, so it moves run
    //    to run; the load-bearing part is which of the two positions the
    //    sample sits on, not its fractional part.
    //  - **The settle before the sample.** While alpha's ignore flag is up the
    //    server suppresses its periodic `State` to alpha (`protocols.py:761`;
    //    `forced` broadcasts still get through, which is how alpha learns the
    //    counter at all), so the frame carrying the re-elected position reaches
    //    alpha only after the echo clears the flag and the next broadcast
    //    fires. `conformance/README.md:108-112` states the rule, and states the
    //    suppression as total rather than inbound-only.
    //
    // `manualAckPeers` holds alpha's automatic acknowledgement off, because an
    // automatic one would stamp at the instant the forced update arrived —
    // collapsing the very wait this scenario measures — and would carry a full
    // playstate besides. **That alpha never acknowledges anything until the
    // scripted frame is safe only by an accident of ordering upstream, one line
    // wide.** `Watcher.setRoom` (`server.py:745-751`) issues a *forced* update
    // at join time, and it never reaches the wire because
    // `protocols.py:558-559` runs `addWatcher` *before* `self._logged = True`,
    // leaving `Watcher.sendState`'s `isLogged()` guard at `server.py:859`
    // false. Swap those two lines and alpha would hold a counter it never
    // clears, every later alpha frame would die at `protocols.py:788`, and this
    // scenario would go inert on both sides — green, measuring nothing.
    //
    // The counter alpha echoes is the *newest* one it was sent, and it is
    // captured outside the acknowledgement gate for that reason: bravo's seek
    // increments past the counter the unpause already handed alpha, and
    // `protocols.py:775-777` clears the ignore window only on an exact match.
    // A peer that kept the first counter it ever saw would echo a stale one and
    // be discarded exactly as if it had carried none.
    //
    // **The drop budget, written as an inequality rather than as a figure so
    // that moving a step means re-deriving it instead of trusting a number.** A
    // suppressed watcher is still on a clock: `Watcher.sendState` drops it once
    // the span since its stamp exceeds `PROTOCOL_TIMEOUT` (`server.py:861`),
    // and that test sits *outside* the `isLogged()` guard, so the suppression
    // above does not pause it. alpha's exposure runs from its last accepted
    // frame to its ping-only frame, which is the two settles before the seek
    // plus the wait after it:
    //
    //     2 × SETTLE_MS + PING_WAIT_MS < PROTOCOL_TIMEOUT * 1000
    //
    // `PROTOCOL_TIMEOUT` is 12.5 s — `constants.py:76` at
    // `SYNCPLAY_PINNED_COMMIT` (`conformance/helpers/real-server.ts:20`),
    // spelled out because the constant is unreachable from this repo and that
    // anchor is one the citation gate can never resolve. The left-hand side is
    // milliseconds, both terms being `ms:` fields, which is why the conversion
    // belongs on the right. Keep the inequality strict and do not tune to the
    // boundary: the drop test is sampled rather than continuous, every forced
    // update samples it off the 1 Hz grid, and the left-hand side counts
    // scheduled waits only, so it is a lower bound on the real span. Raising
    // the wait past what the inequality permits does not fail loudly —
    // measured, alpha is removed from the room before its ping goes out, its
    // `lastPlaystate` freezes at the forced-update frame, and the scenario
    // looks green on the thing under test.
    //
    // Named rather than repeated: the pin below asserts that *every* divergence
    // carries this label, and a typo in either copy would assert nothing.
    const SAMPLE_LABEL = "alpha's ping-only frame re-elects the room"
    const scenario: Scenario = {
      name: 'conf-forced-ping-stamps',
      playing: true,
      peers: ['alpha', 'bravo'],
      manualAckPeers: ['alpha'],
      steps: [
        { kind: 'seat', peer: 'alpha' },
        { kind: 'setFile', peer: 'alpha', file: file('a.mkv') },
        { kind: 'seat', peer: 'bravo' },
        { kind: 'setFile', peer: 'bravo', file: file('b.mkv') },
        { kind: 'state', peer: 'alpha', position: 500, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'state', peer: 'bravo', position: 500, paused: false },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'state', peer: 'bravo', position: 1200, paused: false, doSeek: true },
        { kind: 'wait', ms: PING_WAIT_MS },
        { kind: 'pingOnly', peer: 'alpha' },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'sample', label: SAMPLE_LABEL }
      ]
    }
    const run = await runConformance(scenario, port)
    // Premises first, and deliberately *before* the comparison: the divergence
    // below is pinned rather than absent, so a premise asserted after it would
    // be unreachable for exactly as long as it is most worth knowing.
    //
    // The seek reached `updateState` rather than dying inside bravo's own
    // ignore window — the settle before it exists for this, and without it both
    // backends agree on a room that never moved.
    expect(run.realFrames.some((f) => f.includes('"doSeek": true'))).toBe(true)
    // **A pinned expected divergence, not `assertConforms`.** What is pinned is
    // the whole shape of the one difference this scenario produces: every
    // divergence carries this scenario's single sample label, the diverging
    // fields are exactly `playstate.setBy` and `playstate.position`, the
    // reference elects alpha where the model leaves bravo, and the position gap
    // still clears the tolerance. Only the projection term is lost, so the gap
    // is about `PING_WAIT_MS` wide and the scenario passes while the model lags
    // by roughly that much.
    //
    // Pinned rather than skipped because a skip stops the *reference* half
    // running, and that half is the evidence the `sendAck()` comment in
    // `src/main/syncplay.ts` rests on — the reference really does re-elect on a
    // playstate-free frame, and this nightly is where that is measured against
    // the pinned server rather than asserted from a reading of `server.py`.
    // Pinned rather than landed red because the nightly workflow comments on
    // one standing `syncplay-conformance` issue: a known red on `main` would
    // make a genuine divergence in any of the other scenarios arrive as one
    // more copy of a comment already learned to be ignorable.
    //
    // This goes red on its own when #384's item 4 moves the model's stamp: the
    // model then re-elects too, `setBy` and `position` converge, and the pin
    // stops holding. **That red is the signal to swap these lines back to
    // `assertConforms(run)`**, and that swap belongs in item 4's own PR. It is
    // not a fixture to repair, and re-pinning it to whatever the run prints
    // would throw away the only notification that item 4 landed.
    // The ceiling is `PING_WAIT_MS` past the tolerance because that is the
    // whole of what the missing stamp can cost: the model keeps projecting
    // across the ping wait where the reference re-stamps and stops. A gap wider
    // than that is not this divergence grown, it is a second one arriving, and
    // the floor alone would pass it however far it ran. Measured margin: four
    // local runs against the pinned server gave 3.907s, 3.910s, 3.919s and
    // 3.923s, against a floor of 1.6s and this ceiling of 5.6s.
    assertPinnedDivergence(run, {
      label: SAMPLE_LABEL,
      fields: ['playstate.setBy', 'playstate.position'],
      setBy: { real: 'alpha', model: 'bravo' },
      positionDeltaCeiling: PING_WAIT_MS / 1000 + run.tolerance
    })
  })
})
