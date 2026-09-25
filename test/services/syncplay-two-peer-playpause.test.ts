// @vitest-environment happy-dom
//
// Play/pause propagation between two peers (#361 step 4).
//
// `syncplay-two-peer-loop.test.ts` carries one direction — the host presses
// pause, the joiner's element follows — as its proof that the instrument is
// wired up. This file is about the rule rather than the wiring, so it takes the
// three shapes that direction does not reach:
//
//  - **the other direction**, where the follower is the peer that has been
//    driving the room's `min()` election, and the badge it paints names someone
//    else;
//  - **a peer joining a room that is already paused**, where nothing is
//    propagating at all — the room is simply standing still and the newcomer has
//    to be placed into it and stopped;
//  - **a peer's own action coming back**, which must propagate *nowhere*. The
//    reference server broadcasts its forced update to the setter too
//    (`server.py:187` hands it to `broadcastRoom()`, which has no sender filter,
//    `server.py:441-445`), so every discrete change a peer makes arrives back at
//    its own socket a round trip later. `src/main/syncplay.ts:2097` eats it.
//
// The third is the one worth having. The first two would survive a good deal of
// damage to the echo path; only the third goes red when the drop guard does.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const DELAY_MS = 50

/**
 * `SyncplayClient`'s `clientIgnoreCounter` — bumped once per *discrete* change
 * the client originates, and by nothing else. Read here to say "this peer
 * announced nothing of its own", which is what distinguishes following a room
 * from arguing with it. Private by design, so it arrives through the harness's
 * `Peer.counters()` rather than a cast spelled out per file.
 */
const discreteSends = (p: Peer): number => p.counters().clientIgnoreCounter

describe('SyncplayClient — play/pause across two peers', () => {
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

  it('carries a pause from the joiner back to the host, and releases it again', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const [host, joiner] = await seatBoth()
    await room.advance(4)
    expect(host.el.paused).toBe(false)
    host.frames.length = 0

    // The joiner presses pause. Nothing programmatic is armed, so the `pause`
    // its element queues is classified as the user's by `consumePlaybackOp`
    // returning nothing, and leaves through `sendLocalState('pause')`.
    joiner.userPause()
    await room.advance(1)

    expect(room.server.roomState().paused).toBe(true)
    expect(host.el.paused).toBe(true)
    expect(host.ui.syncplayPausedBy.value).toBe('joinuser')
    expect(host.ui.shouldElementPlay()).toBe(false)

    // One frame did it, and it is the server's forced update rather than a
    // periodic: the reference attributes a frame to an actor only on the
    // transition that flips the room's paused-ness, and every periodic behind it
    // carries a `setBy` re-elected to `min(watchers)`. Measured at t=4150 — the
    // press lands on the element at 4050, reaches the server at 4100 and comes
    // back at 4150 across two 50 ms hops.
    const carrier = host.frames.find((f) => f.state.paused)
    expect(carrier, 'the host never saw a paused frame').toBeDefined()
    expect(carrier!.state.setBy).toBe('joinuser')
    expect(carrier!.state.doSeek).toBe(false)
    expect(carrier!.at).toBe(4150)

    // And the host *followed*: it did not answer the room with a discrete change
    // of its own. This is the assertion that separates following from a loop —
    // a follower that re-announced what it was just told would put a second
    // pause on the wire and the two peers would take turns forever. The host's
    // 1 Hz heartbeat still reports the new paused-ness; a heartbeat bumps no
    // counter.
    expect(discreteSends(host)).toBe(0)
    expect(discreteSends(joiner)).toBe(1)

    // The same door in the other direction. `syncplayPausedBy` clears on the
    // resume rather than lingering on the last pauser.
    joiner.userPlay()
    await room.advance(1)
    expect(room.server.roomState().paused).toBe(false)
    expect(host.el.paused).toBe(false)
    expect(host.ui.syncplayPausedBy.value).toBeNull()
    expect(discreteSends(host)).toBe(0)
    expect(discreteSends(joiner)).toBe(2)
  })

  it('places and stops a peer that joins a room already standing still', async () => {
    // Nothing propagates here: no peer acts for the whole run. The room is
    // paused at 100 before the joiner exists, so what reaches it is an ordinary
    // periodic — `doSeek: false`, `paused: true` — and both halves of the apply
    // rule have to fire off that one frame. The element is seated at 0 and
    // *playing*, which is what a freshly bound `<video autoplay>` looks like.
    room = await createTwoPeerRoom({ position: ROOM_START, paused: true })
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: true,
      delayMs: DELAY_MS
    })
    await room.advance(2)
    const joiner = await room.seat({
      username: 'joinuser',
      position: 0,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)

    // The seek half: 100 s of divergence against a 3 s tolerance, on a frame
    // that never set `doSeek`. Exactly one write — a paused room's position does
    // not advance, so every later periodic repeats the same number and the
    // no-op early-out swallows it.
    expect(joiner.el.seekWrites).toEqual([ROOM_START])
    expect(joiner.el.currentTime).toBe(ROOM_START)

    // The play/pause half, and the roster half of the badge: the joiner can name
    // the peer the server attributed the standing pause to, which is a fact no
    // single-peer fixture can produce.
    expect(joiner.el.paused).toBe(true)
    expect(joiner.ui.syncplayPausedBy.value).toBe('hostuser')
    expect(joiner.ui.shouldElementPlay()).toBe(false)

    // And it arrived without announcing anything: a newcomer that answered the
    // room with a discrete state would assert `position: 0` into a `min()`
    // election and drag every other watcher back to the start of the file.
    expect(discreteSends(joiner)).toBe(0)
    expect(host.el.currentTime).toBe(ROOM_START)
    expect(room.server.roomState().position).toBe(ROOM_START)
  })

  it('never hands the pauser its own pause back', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const [host, joiner] = await seatBoth()
    await room.advance(4)
    host.frames.length = 0
    host.el.seekWrites.length = 0

    host.userPause()
    await room.advance(4.6)

    // The control: this run is not vacuously quiet. The pause did reach the
    // room and the other element, so there was a real forced update in flight —
    // and the server sends it to the setter too.
    expect(room.server.roomState().paused).toBe(true)
    expect(joiner.el.paused).toBe(true)
    expect(joiner.frames.some((f) => f.state.paused && f.state.setBy === 'hostuser')).toBe(true)

    // The claim: none of it came back. The host's renderer saw nothing at all
    // for the whole 4.6 s — not the forced update at t=4150 and not the four
    // `paused: true` periodics behind it, all of which are `setBy` the host and
    // die at `src/main/syncplay.ts:2097`.
    expect(host.frames).toEqual([])
    // So its element was never written and never re-paused programmatically.
    expect(host.el.seekWrites).toEqual([])
    // And exactly one discrete change left the host for the whole run. A peer
    // that applied its own echo would re-classify the resulting element event as
    // the user's and announce it again — the self-sustaining loop the guard
    // exists to stop.
    expect(discreteSends(host)).toBe(1)
    const pauseFrames = room.server.wireOf('hostuser').filter((f) => f.paused === true)
    expect(pauseFrames.length).toBeGreaterThan(1)
    expect(pauseFrames.every((f) => f.doSeek !== true)).toBe(true)
  })
})
