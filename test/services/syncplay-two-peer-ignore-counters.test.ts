// @vitest-environment happy-dom
//
// `ignoringOnTheFly` bookkeeping, over a real link (#361 step 4).
//
// `syncplay-ignoring-on-the-fly.test.ts` drives the counters by hand-feeding
// frames to one client. This file lets the link produce them: two peers, a
// modelled server that stamps `ignoringOnTheFly.server` on every forced update,
// and 50 ms hops, so the window in which a change of ours is outstanding is a
// real interval with real frames arriving inside it.
//
// The three private fields (`src/main/syncplay.ts:475-477`):
//
//  - `clientIgnoreCounter` — monotonic, bumped once per *discrete* change we
//    originate. Heartbeats, acks and seek re-asserts do not touch it.
//  - `pendingClientAck` — the counter of our newest outstanding change, or 0.
//    While it is non-zero `handleState` drops every inbound state
//    (`src/main/syncplay.ts:2098`).
//  - `pendingServerAck` — the server counter we owe an answer for.
//
// ── Two things this harness cannot show, stated rather than worked around ────
//
//  - **`pendingServerAck` is never observable as non-zero.** `handleState` sets
//    it and calls `sendAck()` in the same statement block, and `sendAck()` zeroes
//    it on the way out, so every sample between slices reads 0. The ack frame
//    itself carries no playstate, and `MinElectionServer.wire` records only
//    playstate-bearing frames, so it is invisible from the server side too. The
//    assertions below say "0 at every boundary", which is the true statement;
//    they are not evidence the counter was ever set. They are not inert either,
//    and the distinction matters to anyone tempted to drop the field from the
//    triple: stub out the `this.pendingServerAck = 0` in `sendAck()`
//    (`src/main/syncplay.ts:2738`) so the counter latches instead of being spent,
//    and two cases below go red on the triple — the clean round trip and the
//    crossing case, each reading `pendingServerAck: 1`. What the zeros pin is
//    "cleared before every boundary", i.e. the counter never latches, which is a
//    different regression class from "it was set at some point".
//  - **The `clientEcho === pendingClientAck` arm (`src/main/syncplay.ts:1793`)
//    is unreachable here.** `MinElectionServer` never writes a `client` key —
//    the reference only writes one when its own counter is truthy
//    (`protocols.py:758-760`) — so on this link `pendingClientAck` is only ever
//    cleared by the unconditional zero at `src/main/syncplay.ts:1782`. That is
//    the path the comment there calls the "~1 RTT of lost echo protection", and
//    the third case below is what it costs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer, IgnoreCounters } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const DELAY_MS = 50

/** The three private counters, read the way the harness reads `seekIntent`. */
const counters = (p: Peer): IgnoreCounters => p.counters()

describe('SyncplayClient — ignoringOnTheFly over a two-peer link', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  it('opens and closes the window on a clean round trip', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)

    // Four seconds of heartbeats, an adoption and a roster have gone by and
    // nothing has been bumped: the counter tracks discrete changes only.
    expect(counters(host)).toEqual({
      clientIgnoreCounter: 0,
      pendingClientAck: 0,
      pendingServerAck: 0
    })

    host.userPause()
    await room.advance(0.05)
    // t=4050. The press has been classified and `sendLocalState` has bumped the
    // counter and armed the ack with it. Both are 1 — `pendingClientAck` is
    // assigned *from* `clientIgnoreCounter`, not incremented independently.
    expect(counters(host)).toEqual({
      clientIgnoreCounter: 1,
      pendingClientAck: 1,
      pendingServerAck: 0
    })

    // t=4100. Still outstanding — the State is at the server, the forced update
    // has not started back.
    await room.advance(0.05)
    expect(counters(host).pendingClientAck).toBe(1)

    // t=4150. The forced update arrives carrying `ignoringOnTheFly.server`, and
    // the window closes. `clientIgnoreCounter` keeps its value: it is monotonic
    // and identifies the change, it is not a depth count.
    await room.advance(0.05)
    expect(counters(host)).toEqual({
      clientIgnoreCounter: 1,
      pendingClientAck: 0,
      pendingServerAck: 0
    })

    // And it stays closed under four more seconds of periodics, each of which
    // is a `State` the client answers with a heartbeat and no counter at all.
    await room.advance(4)
    expect(counters(host)).toEqual({
      clientIgnoreCounter: 1,
      pendingClientAck: 0,
      pendingServerAck: 0
    })
    expect(room.server.roomState().paused).toBe(true)
  })

  it('carries two changes in flight under one window, closed by one forced update', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)

    host.userSeek(400)
    await room.advance(0.05)
    expect(counters(host)).toEqual({
      clientIgnoreCounter: 1,
      pendingClientAck: 1,
      pendingServerAck: 0
    })

    // The second drag goes out while the first is still unanswered. The counter
    // advances and the ack is *re-armed* on the newer value: only the newest
    // change is tracked, so the first one's echo protection is given up here and
    // not when it is answered.
    host.userSeek(800)
    await room.advance(0.05)
    expect(counters(host)).toEqual({
      clientIgnoreCounter: 2,
      pendingClientAck: 2,
      pendingServerAck: 0
    })

    // t=4150. The forced update for the *first* drag arrives — counter 1, not 2
    // — and closes the window anyway: `src/main/syncplay.ts:1782` zeroes
    // `pendingClientAck` unconditionally rather than comparing it. The second
    // drag is still in flight at this instant.
    await room.advance(0.05)
    expect(counters(host)).toEqual({
      clientIgnoreCounter: 2,
      pendingClientAck: 0,
      pendingServerAck: 0
    })

    // The seek re-assert that fires on this same tick (see
    // `syncplay-two-peer-seek-echo.test.ts`) puts a third `doSeek` frame on the
    // wire and bumps nothing: it goes out through `sendStateMessage` rather than
    // `sendLocalState`, so it re-uses the window it was born in.
    await room.advance(6)
    expect(room.server.wireOf('hostuser').filter((f) => f.doSeek === true)).toHaveLength(3)
    expect(counters(host).clientIgnoreCounter).toBe(2)
  })

  it('abandons our window when a peer-initiated forced update crosses it', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    // Asymmetric links, so the crossing is deterministic rather than a tie: the
    // joiner's change reaches the host at t=4100, strictly inside the host's own
    // window of [4050, 4150).
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
      delayMs: 0
    })
    await room.advance(4)
    host.frames.length = 0

    // Both users act in the same slice.
    host.userPause()
    joiner.userSeek(700)
    await room.advance(0.05)
    expect(counters(host).pendingClientAck).toBe(1)
    expect(counters(joiner).pendingClientAck).toBe(1)

    // t=4100. The joiner's `doSeek` forced update reaches the host. Our pause is
    // still on the wire — its own echo is 50 ms away — yet the window is closed
    // and the frame is delivered rather than dropped. That is the trade-off the
    // comment above `src/main/syncplay.ts:1782` names: without that zero the
    // peer's seek would die at the drop guard, and a forced State is one-shot,
    // so the room would silently revert it.
    await room.advance(0.05)
    expect(counters(host)).toEqual({
      clientIgnoreCounter: 1,
      pendingClientAck: 0,
      pendingServerAck: 0
    })
    expect(host.frames).toHaveLength(1)
    expect(host.frames[0].state.setBy).toBe('joinuser')
    expect(host.frames[0].state.doSeek).toBe(true)
    expect(host.frames[0].at).toBe(4100)
    // And it was applied: the host's element, which the user had just paused at
    // ~103, is written to the peer's target.
    expect(host.el.seekWrites).toHaveLength(1)
    expect(host.el.seekWrites[0]).toBeCloseTo(700.1, 1)

    // Our own echo, arriving a slice later, adds nothing — it is `setBy` us and
    // dies at `src/main/syncplay.ts:2097`. One delivered frame for the whole
    // exchange.
    await room.advance(0.05)
    expect(host.frames).toHaveLength(1)
  })

  it('drops the foreign periodics that land while our change is unacked', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    // The joiner is seated first and two seconds behind, so it wins the `min()`
    // election and keeps winning it: `forcePositionUpdate` re-seats every
    // watcher onto one position, and a tied election falls back to the
    // first-inserted watcher. That keeps the host's inbound periodics
    // *foreign*-`setBy` on both sides of the window, which is what makes the gap
    // below attributable to the ack rather than to `src/main/syncplay.ts:2097`.
    const joiner = await room.seat({
      username: 'joinuser',
      position: ROOM_START - 2,
      paused: false,
      delayMs: 0
    })
    // A 1.5 s link, so the host's own echo takes 3 s to return and the window
    // spans three whole periodics instead of landing between two.
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: 1500
    })
    await room.advance(8)

    // The cadence before the change: one foreign frame per second, arriving
    // 1500 ms after the server sent it.
    const before = host.frames.map((f) => f.at)
    expect(before).toEqual([2500, 3500, 4500, 5500, 6500, 7500])
    expect(host.frames.every((f) => f.state.setBy === 'joinuser')).toBe(true)
    host.frames.length = 0

    host.userPause()
    await room.advance(0.05)
    expect(counters(host).pendingClientAck).toBe(1)

    // The window is [8050, 11050): out at 9550, back at 11050. The periodics the
    // server sends at 7000, 8000 and 9000 arrive at 8500, 9500 and 10500 — all
    // three inside it, all three foreign, and none of them reaches the renderer.
    await room.advance(2.95)
    expect(counters(host).pendingClientAck).toBe(1)
    expect(host.frames).toEqual([])

    // t=11050: our own forced update returns, closes the window and is itself
    // dropped as self-`setBy`.
    await room.advance(0.05)
    expect(counters(host).pendingClientAck).toBe(0)
    expect(host.frames).toEqual([])

    // And the cadence resumes with the next one. A 4000 ms gap in a 1 Hz stream:
    // three frames the guard ate, and the assertion is a gap rather than an
    // absence, so a fixture that simply stopped producing frames cannot pass it.
    await room.advance(1)
    expect(host.frames.map((f) => f.at)).toEqual([11500])
    expect(host.frames[0].state.setBy).toBe('joinuser')
    expect(host.frames[0].at - before[before.length - 1]).toBe(4000)
    expect(joiner.el.paused).toBe(true)
  })
})
