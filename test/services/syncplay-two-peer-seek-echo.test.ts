// @vitest-environment happy-dom
//
// A user drag, its echo, and the re-assert behind it (#361 step 4).
//
// Three claims, in the order the code makes them:
//
//  1. a scrubber drag on one peer reaches the other peer's element;
//  2. the *same* drag, broadcast back to the peer that made it, moves nothing
//     there — the reference server has no sender filter
//     (`server.py:187`, `server.py:441-445`), so every discrete change returns
//     to its own
//     socket one round trip later;
//  3. a drag the room did **not** take is re-asserted, and `seekIntent` is the
//     record of that. `src/main/syncplay.ts:2995` retires the intent the moment
//     the room agrees, so a fixture can pin the exact instant it is spent.
//
// (2) and (3) are the ones with teeth, and they are two sides of one predicate:
// `maybeReassertSeek()` compares our snapshot against the room's projection and
// retires the intent at `SEEK_REASSERT_TOLERANCE_S`. A single converged seek
// must be *below* it and a crossed pair must be *above* it, so the two cases
// here go red under opposite moves of that literal — which is the only way to
// pin the tolerance as the cause rather than merely pin that something happened.
//
// What this file deliberately does not claim to isolate: the renderer's
// `consumeSeekOp` guard in `onVideoSeeked`. That echo is caught twice — once
// there and once by `ECHO_SEEK_EPSILON_S` in `sendLocalState` — so no assertion
// available from outside can tell which one did it. The observable below is the
// *inbound* half instead (`host.frames`), where `src/main/syncplay.ts:2227` is
// the only guard standing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SEEK_REASSERT_TOLERANCE_S } from '../../src/main/syncplay'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const DELAY_MS = 50
const FIRST_SEEK = 400
const SECOND_SEEK = 800

describe('SyncplayClient — a seek, its echo and its re-assert', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  const seatBoth = async (): Promise<[Peer, Peer]> => {
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    return [host, joiner]
  }

  /** Every `doSeek: true` frame this peer put on the wire, drags and re-asserts alike. */
  const seekFrames = (peer: Peer): number =>
    room.server.wireOf(peer.username).filter((f) => f.doSeek === true).length

  it('carries one drag to the other element and re-applies nothing on the originator', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const [host, joiner] = await seatBoth()
    await room.advance(4)
    // Exactly one frame, and which one it is matters for the `host.frames` claim
    // below: the reference's join-time `State` at t=50, whose `setBy` is the room's
    // constructor seed rather than ours, so `src/main/syncplay.ts:2227` admits it.
    // It is also what hands this peer a `lastRoomState` a second before the first
    // periodic would, lifting `isAdopted()`'s `if (!room) return false` and moving
    // the latch from t=2000 to t=1000 — which is what gets the t=1050 periodic
    // dropped here rather than emitted with `setBy` nulled at
    // `src/main/syncplay.ts:2320`. So the window below starts empty because of the
    // drop guard *and* this line, which is why the claim there is scoped to the
    // frames that follow it rather than to the path.
    host.frames.length = 0
    expect(host.el.seekWrites).toEqual([])

    // t=4000: a scrubber drag. Since #488 it is announced at intent —
    // `seekAsUser` registers a `value` operation, writes, and leaves through
    // `sendLocalState('seek')` in the same call — so the `seeked` the write
    // queues is consumed rather than sent a second time.
    host.userSeek(FIRST_SEEK)

    // Still t=4000: the intent is armed at the send, with no attempt spent yet.
    // Before #488 this needed one slice, for the `seeked` that carried the send.
    expect(host.seekIntent()).not.toBeNull()
    expect(host.seekIntent()!.attempts).toBe(0)

    await room.advance(0.05)
    expect(host.seekIntent()!.attempts).toBe(0)

    // t=4100: the server's forced update lands, the room agrees with us, and
    // `maybeReassertSeek()` spends the intent on the drift test rather than on
    // an attempt.
    await room.advance(0.05)
    expect(host.seekIntent()).toBeNull()

    await room.advance(6.05)

    // Propagation: the far element was written once, to our target — one link
    // delay each way after the drag, where it used to be one slice more.
    expect(joiner.el.seekWrites).toHaveLength(1)
    expect(joiner.el.seekWrites[0]).toBeCloseTo(FIRST_SEEK + 0.1, 2)

    // No self-apply: the originator's element carries the drag and nothing else,
    // across ten seconds in which the server broadcast the forced update back to
    // it and then six `doSeek: false` periodics naming it as the setter.
    expect(host.el.seekWrites).toEqual([FIRST_SEEK])

    // And the reason: none of the frames naming the host ever reached the host's
    // renderer — `src/main/syncplay.ts:2227` returns above the emit for them, the
    // single guard on this path, which is why this assertion is the one worth
    // making rather than a claim about the element.
    //
    // What does reach it since #488 is four periodics the server re-elected to
    // the joiner, at t=7050 through t=10050. Announcing at intent put the
    // joiner's landing exactly one round trip behind the drag, so from t=7000
    // the two peers report bit-identical positions and the election's tie goes
    // the joiner's way. They are foreign, so they pass the guard, and they sit
    // one second inside the 3 s tolerance, so they move nothing — the element
    // line above is what says so.
    expect(host.frames.filter((f) => f.state.setBy === 'hostuser')).toEqual([])
    expect(host.frames.map((f) => f.at)).toEqual([7050, 8050, 9050, 10050])
    expect(host.frames.every((f) => f.state.setBy === 'joinuser' && !f.state.doSeek)).toBe(true)

    // No re-assert, and this is the arm that pins the tolerance from below: one
    // drag the room took produces exactly one `doSeek` frame. The joiner, which
    // dragged nothing, produces none and holds no intent at any point.
    expect(seekFrames(host)).toBe(1)
    expect(seekFrames(joiner)).toBe(0)
    // The set is counted before it is quantified over, per
    // docs/testing.md:389 ("Pin the count, never just loop over the set"):
    // `every()` on an empty array is `true`, so without the pin a harness change
    // that stopped handing the joiner frames at all — a widened drop guard, a
    // rewired observer — would leave the line below green while asserting
    // nothing. Eight is what this fixture delivers: the six 1 Hz periodics at
    // t=1050 through t=6050, the forced update at t=4100 that carried the drag,
    // and — ahead of both — the reference's join-time `State` at t=50. That one
    // is admitted for the same reason the host's copy of it is (see the clear
    // above): no election runs inside a fresh room's own election age, so it
    // carries the `setBy` the room was constructed with and is nobody here's
    // echo. Twelve before #488: the periodics from t=7050 on now name the
    // joiner itself (the tie described above), so its own drop guard takes
    // them.
    expect(joiner.frames).toHaveLength(8)
    expect(joiner.frames.every((f) => f.intent === null)).toBe(true)
  })

  it('re-asserts a drag the room did not take, once, and stops when it lands', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const [host, joiner] = await seatBoth()
    await room.advance(4)
    host.frames.length = 0

    // Two drags one slice apart. The second crosses the first's forced update on
    // the wire, so the room is still being told about 400 while we are already
    // at 800 — the shape `maybeReassertSeek()` exists for. A single drag cannot
    // produce it: the room agrees within one round trip and the intent is spent
    // on the drift test (the case above).
    //
    // Both drags are announced at intent (#488), so each leaves in the call that
    // makes it — t=4000 and t=4050 — one slice earlier than the `seeked`-borne
    // sends this file was first measured against.
    host.userSeek(FIRST_SEEK)
    await room.advance(0.05)
    host.userSeek(SECOND_SEEK)

    // t=4050. Both changes are outstanding, so `maybeReassertSeek()` is still
    // returning at its `pendingClientAck !== 0` gate and the intent is
    // untouched. The two numbers below are the drift test's own operands one
    // link delay early: the room reading here is exactly what the host is handed
    // at t=4100, and `host.el.currentTime` is what its snapshot reports.
    const roomInFlight = room.server.roomState().position
    const elementNow = host.el.currentTime
    expect(host.seekIntent()!.attempts).toBe(0)
    expect(roomInFlight).toBeCloseTo(FIRST_SEEK + 0.1, 1)
    expect(elementNow).toBe(SECOND_SEEK)
    // Not a tie. #363's review called out a fixture that sat on the tolerance
    // exactly; this disagreement is ~400 s in absolute terms, so the outcome
    // cannot turn on a rounding of either operand.
    expect(Math.abs(elementNow - roomInFlight)).toBeGreaterThan(300)

    // t=4100: the forced update for the *first* drag arrives, clears the ack,
    // and the drift test now runs against a room 400 s behind us. One attempt is
    // spent and a third `doSeek` frame goes out.
    await room.advance(0.05)
    expect(host.seekIntent()).not.toBeNull()
    expect(host.seekIntent()!.attempts).toBe(1)
    expect(seekFrames(host)).toBe(3)
    const reassert = room.server.wireOf('hostuser').filter((f) => f.doSeek === true)[2]
    expect(reassert.position).toBeCloseTo(SECOND_SEEK + 0.05, 1)
    // The regime that produced it, asserted *after* the effect rather than
    // before: the drift the attempt was spent on is outside the tolerance. Held
    // second on purpose — a widened literal has to red the attempt above, not
    // this line, or the mutation control would only be re-reading the constant.
    expect(Math.abs(elementNow - roomInFlight)).toBeGreaterThan(SEEK_REASSERT_TOLERANCE_S)

    // t=4150: the forced update for the *second* drag arrives, the room agrees,
    // and the intent is retired rather than re-asserted again. The cap is 3
    // attempts; this run never reaches it because convergence gets there first.
    await room.advance(0.05)
    expect(host.seekIntent()).toBeNull()

    await room.advance(6)
    expect(seekFrames(host)).toBe(3)

    // The re-assert is a real frame with real consequences, not bookkeeping: the
    // far element is written three times — once per drag and once for the
    // re-assert — and the last two land on the same target.
    expect(joiner.el.seekWrites).toHaveLength(3)
    expect(joiner.el.seekWrites[1]).toBeCloseTo(SECOND_SEEK + 0.1, 2)
    expect(joiner.el.seekWrites[2]).toBeCloseTo(SECOND_SEEK + 0.1, 2)

    // Both peers end on the second target, and the originator still applied
    // nothing of its own: two drags in, two writes on its element.
    expect(host.el.seekWrites).toEqual([FIRST_SEEK, SECOND_SEEK])
    expect(room.server.roomState().position).toBeGreaterThan(SECOND_SEEK)
  })
})
