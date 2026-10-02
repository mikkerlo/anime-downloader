// `PROTOCOL_TIMEOUT`: the reference dropping a watcher that stops sending
// `State`, and the room re-electing without it.
//
// The drop test is three lines of `Watcher.sendState` —
// `server.py:861` ("if time.time() - self._lastUpdatedOn > constants.PROTOCOL_TIMEOUT:"),
// then `server.py:862` ("self._server.removeWatcher(self)") and
// `server.py:863` ("self._connector.drop()") — and it is **sampled rather than
// continuous**: it runs only when the server sends that watcher a `State`, off
// the per-watcher 1 Hz `LoopingCall` at
// `server.py:842` ("self._sendStateTimer = task.LoopingCall(self._askForStateUpdate)")
// and `server.py:843` ("self._sendStateTimer.start(constants.SERVER_STATE_INTERVAL)").
// So the earliest possible drop is the first tick strictly past the constant,
// never the constant itself.
//
// **What this scenario is for, and it is the reason it exists rather than a
// property of it: the reset rule is READ OFF THE REFERENCE HERE, not off
// `server.py`.** #384's item 4 settled the duration by constant lookup and
// insisted the *rule* — what refreshes the clock — be confirmed against the
// running server rather than argued from prose. The confirmation is the three
// premises below, and they are asserted *before* `assertConforms`, which throws:
// the real server really emitted a `"left"` notice naming the silent peer, it
// really answered the survivor's next `List` without that peer's row, and the
// surviving peer really went the whole window on ping-only frames. Those three
// facts are what make the model's drop test a model of something.
//
// **The budget is the INVERSE of `conf-forced-ping-stamps`'s, and deliberately
// so.** That scenario keeps its suppressed peer alive across the window it
// measures, and says so as an inequality it must satisfy —
// `2 × SETTLE_MS + PING_WAIT_MS < PROTOCOL_TIMEOUT * 1000`, in the drop-budget
// block of `conformance/syncplay-forced-update.conformance.ts`. This one kills a
// peer, so it needs the other direction:
//
//     PINGS × PING_EVERY_MS + SETTLE_MS + 2 × LIST_MS  >=  IDLE_MS
//
// with `IDLE_MS = PROTOCOL_TIMEOUT_MS + IDLE_MARGIN_MS`. Both sides are derived
// from named constants and asserted in the test body rather than written as a
// comment, so moving a step re-derives the budget instead of trusting a figure.
//
// **No `manualAckPeers`, which is the other inversion and the one that would go
// quietly wrong.** `conf-forced-ping-stamps` holds a peer's automatic
// acknowledgement off; copying that shape here makes this scenario inert. With
// acking off the peer never clears the server's ignore flag,
// `protocols.py:788` ("if self.serverIgnoringOnTheFly == 0:") then discards every
// later playstate from it, the second pause change below never reaches
// `protocols.py:789` ("self._watcher.updateState(position, paused, doSeek, self._pingService.getLastForwardDelay())"),
// the clock is never refreshed by a scripted frame at all, and both backends go
// inert and agree about nothing.
//
// **Removal IS the assertion here**, which is why the two peers are deliberately
// not tied. A drop is invisible at the transport layer — a post-drop write
// returns normally and raises nothing, because
// `protocols.py:63 ("self.transport.loseConnection()")` is a flushing close —
// and a sample is pushed unconditionally, so a drop cannot show up as a missing
// sample. It shows up on the **surviving** peer, as a `roster` without the
// dropped row plus a `playstate.setBy`/`position` flip, and the flip only
// because 500 and 300 are different numbers. A tie would leave the roster as the
// single observable, and a roster read that quietly stopped working would make
// this scenario green.

import { describe, expect, it, inject } from 'vitest'
import { assertConforms, runConformance } from './helpers/conform'
import type { Scenario, Step } from './helpers/scenario'
import { PROTOCOL_TIMEOUT_MS } from '../test/helpers/syncplay-min-election-server'

const port = inject('syncplayPort')

const file = (name: string): Record<string, unknown> => ({ name, duration: 1440, size: 1 })

/**
 * How far past `PROTOCOL_TIMEOUT` the silent peer is held. Named rather than
 * folded into the idle below so the margin is visible as a margin: the drop test
 * is a strict `>` sampled on a 1 s tick, so an idle *of* `PROTOCOL_TIMEOUT_MS`
 * cannot drop at all and the earliest drop lands somewhere inside
 * `(PROTOCOL_TIMEOUT_MS, PROTOCOL_TIMEOUT_MS + one tick]`.
 */
const IDLE_MARGIN_MS = 2500

/** The silence the dropped peer has to clear. Never a literal — #384 item 4. */
const IDLE_MS = PROTOCOL_TIMEOUT_MS + IDLE_MARGIN_MS

/** The gap between the surviving peer's ping-only frames. */
const PING_EVERY_MS = 4000

/** How many of them. Three, so the window clears `IDLE_MS` with slack. */
const PINGS = 3

/** Two full `SERVER_STATE_INTERVAL`s plus slack, as everywhere else here. */
const SETTLE_MS = 2600

/** Long enough for a solicited `List` to come back on either backend. */
const LIST_MS = 400

describe('conformance: PROTOCOL_TIMEOUT drops a silent watcher', () => {
  it('drops the peer that stops sending State and re-elects the room without it', async () => {
    // `quiet` stops sending `State` after it claims 300, and is dropped; `pinger`
    // keeps its clock alive on **ping-only** frames alone — no playstate — and
    // survives. The two halves are the discriminating pair #384 asks for: a
    // client that reports no position still refreshes the clock, because
    // `server.py:877` ("self._lastUpdatedOn = time.time()") stamps above the
    // `if position is not None` guard, while a client that sends only
    // non-`State` traffic does not, because `updateState` has exactly one caller
    // and it is the tail of `handleState`.
    //
    // Every step is load-bearing, because the default failure here is not a red
    // but a green that measures nothing:
    //
    //  - **`setFile` on both peers.** `Watcher.__lt__`
    //    (`server.py:834-839` ("def __lt__(self, b):")) orders a fileless
    //    watcher last, so an all-fileless room elects by insertion order and the
    //    re-election this scenario reads would be decided by the seating order
    //    whatever the drop did.
    //  - **The unpause, then the re-pause.** `Peer.sendPingOnly()` *throws*
    //    unless a `State` carrying `ignoringOnTheFly.server > 0` has arrived, and
    //    the reference raises that flag only on a `forced` broadcast
    //    (`protocols.py:752-753` ("if forced:")). A pause change is the cheapest
    //    forced update available in a paused room, so those two steps are what
    //    make the ping-only steps legal at all. Both peers ack automatically,
    //    which clears the flag on both sides again.
    //  - **Positions 500 and 300, not a tie.** See the header.
    //  - **`requestList quiet` inside the ping loop.** `quiet` is not silent on
    //    the socket, only silent in `State`: it keeps asking for rosters right up
    //    to T + 11 s and is dropped anyway. That is the "traffic does not
    //    refresh" half, and it is also why the last of those requests sits well
    //    before the earliest possible drop — a write after the drop would be
    //    swallowed rather than raise, so it would weaken this silently.
    //  - **The settle and the `List` before each sample.** A sample reads the
    //    most recent broadcast each peer received, so both backends have to
    //    re-elect at least once after the step under test before it looks.
    const pingLoop: Step[] = []
    for (let i = 0; i < PINGS; i++) {
      pingLoop.push(
        { kind: 'pingOnly', peer: 'pinger' },
        { kind: 'requestList', peer: 'quiet' },
        { kind: 'wait', ms: PING_EVERY_MS }
      )
    }
    const SEATED_LABEL = 'both seated; quiet owns the room at 300'
    const DROPPED_LABEL = 'quiet timed out; the room re-elects to pinger at 500'
    const scenario: Scenario = {
      name: 'conf-timeout-idle-drop',
      peers: ['pinger', 'quiet'],
      // The model's drop is off by default; this is the only scenario that asks
      // for it, and it asks for the reference's own constant because anything
      // else would be sweeping rather than comparing. The band that sweep names
      // is recorded in `conformance/README.md`.
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
      steps: [
        { kind: 'seat', peer: 'pinger' },
        { kind: 'setFile', peer: 'pinger', file: file('a.mkv') },
        { kind: 'seat', peer: 'quiet' },
        { kind: 'setFile', peer: 'quiet', file: file('b.mkv') },
        // Forced update #1: the room goes playing, and both peers get a counter.
        { kind: 'state', peer: 'quiet', position: 400, paused: false },
        { kind: 'wait', ms: SETTLE_MS },
        // Forced update #2: back to paused, and `Room.setPosition` re-seats every
        // watcher onto 400, so the two claims below are the only difference left.
        { kind: 'state', peer: 'quiet', position: 400, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        // Neither of these forces anything — the room is already paused and
        // neither carries `doSeek` — so they are plain claims, and `quiet`'s is
        // the last `State` it ever sends. T = 0 is here.
        { kind: 'state', peer: 'pinger', position: 500, paused: true },
        { kind: 'state', peer: 'quiet', position: 300, paused: true },
        { kind: 'wait', ms: SETTLE_MS },
        { kind: 'requestList', peer: 'pinger' },
        { kind: 'wait', ms: LIST_MS },
        { kind: 'sample', label: SEATED_LABEL },
        ...pingLoop,
        { kind: 'requestList', peer: 'pinger' },
        { kind: 'wait', ms: LIST_MS },
        { kind: 'sample', label: DROPPED_LABEL }
      ]
    }

    const run = await runConformance(scenario, port)

    // --- premises, before the comparison, because the comparison throws ------
    //
    // These are the reason this file exists. `assertConforms` compares two
    // backends; it cannot tell agreement about a drop from agreement about
    // nothing having happened, and a scenario whose silent peer was never
    // dropped at all would satisfy it just as well.

    // 1. The real server really dropped it, and said so. `SyncFactory.removeWatcher`
    //    (`server.py:155-161` ("def removeWatcher(self, watcher):")) calls
    //    `sendLeftMessage` (`server.py:163-165` ("def sendLeftMessage(self, watcher):"))
    //    *before* `_roomManager.removeWatcher`, so the watcher still has a room
    //    and the notice carries its name; `broadcast`
    //    (`server.py:447-450` ("def broadcast(self, sender, whatLambda):")) has
    //    no sender exclusion, so the departing watcher is told it left too.
    const leaveNotices = run.realFrames.filter((f) => f.includes('"left"') && f.includes('"quiet"'))
    expect({ leaveNotices: leaveNotices.length > 0 }).toEqual({ leaveNotices: true })

    // 2. The survivor's own view of the room moved with it: the roster the real
    //    server answered `pinger`'s **final** `List` with no longer carries
    //    `quiet`. This is the half that distinguishes a live removal from a stale
    //    read — the notice above could in principle arrive while the room's
    //    membership stayed where it was.
    const finalRoster = (frames: readonly string[]): string[] | null => {
      for (let i = frames.length - 1; i >= 0; i--) {
        let msg: unknown
        try {
          msg = JSON.parse(frames[i])
        } catch {
          continue
        }
        const list = (msg as { List?: Record<string, Record<string, unknown>> }).List
        if (!list) continue
        return Object.keys(Object.values(list)[0] ?? {}).sort()
      }
      return null
    }
    expect(finalRoster(run.realByPeer.pinger)).toEqual(['pinger'])

    // 3. `pinger`'s arm really was playstate-free across the window. Asserted
    //    against the step list rather than the wire because that is where the
    //    fact lives: `ConformanceRun` carries the frames each peer *received*,
    //    and this is a claim about what `pinger` sent. A `state` step dropped in
    //    here later — to "stabilise" the scenario, say — would refresh the clock
    //    the ordinary way and quietly retire the ping-only half, with the
    //    comparison below still green. The wire-level guard for the refresh
    //    itself is `test/services/syncplay-protocol-timeout.test.ts`'s ping-only
    //    case, which runs on the pull-request gate.
    const first = scenario.steps.findIndex((s) => s.kind === 'sample' && s.label === SEATED_LABEL)
    const last = scenario.steps.findIndex((s) => s.kind === 'sample' && s.label === DROPPED_LABEL)
    const between = scenario.steps.slice(first + 1, last)
    expect(between.filter((s) => s.kind === 'state')).toEqual([])
    expect(between.filter((s) => s.kind === 'pingOnly' && s.peer === 'pinger')).toHaveLength(PINGS)

    // 4. The budget, derived rather than quoted. `quiet`'s exposure is everything
    //    between its last `State` and the final sample; `pinger`'s worst refresh
    //    gap is from its last ping-only frame to that same sample, which is one
    //    ping interval plus the `List` wait.
    const QUIET_IDLE_AT_SAMPLE_MS = PINGS * PING_EVERY_MS + SETTLE_MS + 2 * LIST_MS
    const PINGER_WORST_GAP_MS = Math.max(SETTLE_MS + LIST_MS, PING_EVERY_MS + LIST_MS)
    expect(QUIET_IDLE_AT_SAMPLE_MS).toBeGreaterThanOrEqual(IDLE_MS)
    expect(PINGER_WORST_GAP_MS).toBeLessThan(PROTOCOL_TIMEOUT_MS)

    assertConforms(run)
  })
})
