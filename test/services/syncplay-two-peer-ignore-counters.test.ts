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
// The three private fields (`src/main/syncplay.ts:510-512`):
//
//  - `clientIgnoreCounter` — monotonic, bumped once per *discrete* change we
//    originate. Heartbeats, acks and seek re-asserts do not touch it.
//  - `pendingClientAck` — the counter of our newest outstanding change, or 0.
//    While it is non-zero `handleState` drops every inbound state
//    (`src/main/syncplay.ts:2240`).
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
//    (`src/main/syncplay.ts:2972`) so the counter latches instead of being spent,
//    and two cases below go red on the triple — the clean round trip and the
//    crossing case, each reading `pendingServerAck: 1`. What the zeros pin is
//    "cleared before every boundary", i.e. the counter never latches, which is a
//    different regression class from "it was set at some point".
//  - **The `clientEcho === pendingClientAck` arm (`src/main/syncplay.ts:1911`)
//    is unreachable here.** `MinElectionServer` never writes a `client` key —
//    the reference only writes one when its own counter is truthy
//    (`protocols.py:758-760`) — so on this link `pendingClientAck` is only ever
//    cleared by the unconditional zero at `src/main/syncplay.ts:1900`. That is
//    the path the comment there calls the "~1 RTT of lost echo protection", and
//    the third case below is what it costs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { watch } from 'vue'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer, IgnoreCounters } from '../helpers/syncplay-two-peer'
import { DEFAULT_PLAYING_SET_BY } from '../helpers/syncplay-min-election-server'
import type { WireFrame } from '../helpers/syncplay-min-election-server'
import { ECHO_SEEK_EPSILON_S } from '../../src/shared/syncplay-apply-rule'
import { SEEK_REASSERT_TOLERANCE_S } from '../../src/main/syncplay'

/** Every non-empty value the peer's toast takes, in order, from here on. */
const toastLog = (p: Peer): string[] => {
  const log: string[] = []
  watch(
    p.ui.syncplayToast,
    (t) => {
      if (t) log.push(t)
    },
    { flush: 'sync' }
  )
  return log
}

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
    //
    // Read in the same call, at t=4050: since #488 a drag is announced at
    // intent, inside `userSeek`, so each change leaves one slice earlier than
    // the `seeked`-borne sends this file was first written against.
    host.userSeek(800)
    expect(counters(host)).toEqual({
      clientIgnoreCounter: 2,
      pendingClientAck: 2,
      pendingServerAck: 0
    })

    // t=4100. The forced update for the *first* drag arrives — counter 1, not 2
    // — and closes the window anyway: `src/main/syncplay.ts:1900` zeroes
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

    // Both changes leave in the same slice. The joiner drags one slice after the
    // host presses pause: since #488 a drag is announced at intent, inside
    // `userSeek`, so pressing both at t=4000 would put the seek on the wire a
    // slice *ahead* of the pause — which is only classified, and sent, when its
    // `pause` event is delivered at t=4050 — and the crossing would collapse
    // into a tie. Dragging at t=4050 is when the `seeked`-borne send this case
    // was written against left anyway.
    host.userPause()
    await room.advance(0.05)
    joiner.userSeek(700)
    expect(counters(host).pendingClientAck).toBe(1)
    expect(counters(joiner).pendingClientAck).toBe(1)

    // t=4100. The joiner's `doSeek` forced update reaches the host. Our pause is
    // still on the wire — its own echo is 50 ms away — yet the window is closed
    // and the frame is delivered rather than dropped. That is the trade-off the
    // comment above `src/main/syncplay.ts:1900` names: without that zero the
    // peer's seek would die at the drop guard, and a forced State is one-shot,
    // so the room would silently revert it.
    await room.advance(0.05)
    expect(counters(host)).toEqual({
      clientIgnoreCounter: 1,
      pendingClientAck: 0,
      pendingServerAck: 0
    })
    // Two, not one: the periodic the server broadcast at t=4000 arrives at 4050,
    // a slice *before* our press is classified, so the window is not open yet
    // and it is foreign — #384's join-time State moved the 4000 election from us
    // (`hostuser` by 49 ms) to the joiner (by 951 ms), so this periodic no longer
    // dies at `src/main/syncplay.ts:2239`. It moves nothing: |102.049 − 103.95|
    // < 3, so the renderer applies no seek.
    expect(host.frames).toHaveLength(2)
    expect(host.frames[0].at).toBe(4050)
    expect(host.frames[0].state.doSeek).toBe(false)
    expect(host.frames[1].state.setBy).toBe('joinuser')
    expect(host.frames[1].state.doSeek).toBe(true)
    expect(host.frames[1].at).toBe(4100)
    // And it was applied: the host's element, which the user had just paused at
    // ~103, is written to the peer's target.
    expect(host.el.seekWrites).toHaveLength(1)
    // 700 plus the 50 ms flight; 700.1 before #488, when the drag left on its
    // `seeked` carrying the slice the joiner's element had walked since.
    expect(host.el.seekWrites[0]).toBeCloseTo(700.05, 1)

    // Our own echo, arriving a slice later, is the server's verdict on our pause
    // — ordered *after* the peer's seek — and since #494 it is delivered rather
    // than dying at the self-`setBy` guard: the crossing handed the element
    // 700 and playing, and the echo disagrees with that pair. Before #494 the
    // host stayed playing at ~700 while the room was paused at ~104.
    await room.advance(0.05)
    expect(host.frames).toHaveLength(3)
    expect(host.frames[2].at).toBe(4150)
    expect(host.frames[2].state.setBy).toBe('hostuser')
    expect(host.frames[2].state.paused).toBe(true)
    expect(host.frames[2].state.position).toBeCloseTo(103.95, 1)
    expect(host.el.seekWrites).toHaveLength(2)
    expect(host.el.seekWrites[1]).toBeCloseTo(103.95, 1)
  })

  it('keeps the pause that reached the server last when a peer’s seek crosses it (#494)', async () => {
    // The same crossing, run to rest. Server order is the pause last, so the
    // room must end paused at the host's ~104 with every element on it. On
    // `main` before #494 the host's pause was silently lost: the host's own
    // echo was dropped, it kept asserting the peer's 700, and the room ended
    // `~708, playing, setBy joinuser`.
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
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
    const hostToasts = toastLog(host)

    host.userPause()
    await room.advance(0.05)
    joiner.userSeek(700)
    // t=4100: the joiner's seek crosses our pause and is toasted, correctly.
    await room.advance(0.05)
    expect(host.ui.syncplayToast.value).toBe('joinuser seeked to 11:40')
    // t=4150: our own pause's echo is delivered (#494) and seeks the element
    // back from ~700 to ~104, with `setBy` still our username for the badge.
    // It must not toast: "hostuser seeked to 1:43" named the user to
    // themselves, called their pause a seek, and replaced the peer's toast.
    await room.advance(0.05)
    expect(host.ui.syncplayPausedBy.value).toBe('hostuser')
    expect(host.ui.syncplayToast.value).toBe('joinuser seeked to 11:40')
    await room.advance(10)
    expect(hostToasts.filter((t) => t.includes('hostuser'))).toEqual([])

    expect(room.server.roomState().paused).toBe(true)
    expect(room.server.roomState().position).toBeCloseTo(103.95, 1)
    expect(room.server.roomState().setBy).toBe('hostuser')
    for (const p of [host, joiner]) {
      expect(p.el.paused).toBe(true)
      expect(p.el.currentTime).toBeCloseTo(103.95, 1)
    }
    // One round trip: the peer's seek, then the pause, and nothing after.
    expect(host.el.seekWrites.map((w) => Math.round(w))).toEqual([700, 104])
    expect(joiner.el.seekWrites.map((w) => Math.round(w))).toEqual([700, 104])
  })

  it('drops the foreign periodics that land while our change is unacked', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    // The joiner is seated first and two seconds behind, so it wins the `min()`
    // election and keeps winning it: `forcePositionUpdate` re-seats every
    // watcher onto one position, and a tied election falls back to the
    // first-inserted watcher. That keeps the host's inbound periodics
    // *foreign*-`setBy` on both sides of the window, which is what makes the gap
    // below attributable to the ack rather than to `src/main/syncplay.ts:2239`.
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
    await room.advance(4)

    // The cadence before the change: one foreign frame per second, arriving
    // 1500 ms after the server sent it.
    const before = host.frames.map((f) => f.at)
    expect(before).toEqual([1500, 2500, 3500])
    // The first is the reference's join-time `State`, 1500 ms of link behind the
    // connect; the rest are the periodics. All foreign either way.
    expect(host.frames[0].state.setBy).toBe(DEFAULT_PLAYING_SET_BY)
    expect(host.frames.slice(1).every((f) => f.state.setBy === 'joinuser')).toBe(true)
    host.frames.length = 0

    // The press is at t=4000, not the t=8000 this case used before #384's
    // join-time `State`. That frame moves the host's mirror anchor a second
    // earlier, and the joiner's win above is therefore not eternal: left
    // unpressed, the host takes the `min()` election from the server's t=6000
    // broadcast onward — visible as the frame that would land at 7500 going
    // missing, dropped as self-`setBy`. A press at t=8000 gives a window over the
    // broadcasts at 7000, 8000 and 9000, all past that flip, so all three die at
    // `src/main/syncplay.ts:2239` before the ack guard at
    // `src/main/syncplay.ts:2240` is ever reached — and the case then passes with
    // the ack guard deleted, which is the one thing it exists to hold. Pressing
    // at t=4000 puts the window over the broadcasts at 3000, 4000 and 5000
    // instead, all still the joiner's, so the ack guard is what drops them.
    host.userPause()
    await room.advance(0.05)
    expect(counters(host).pendingClientAck).toBe(1)

    // The window is [4050, 7050): out at 5550, back at 7050. The periodics the
    // server sends at 3000, 4000 and 5000 arrive at 4500, 5500 and 6500 — all
    // three inside it, all three foreign, and none of them reaches the renderer.
    await room.advance(2.95)
    expect(counters(host).pendingClientAck).toBe(1)
    expect(host.frames).toEqual([])

    // t=7050: our own forced update returns, closes the window and is itself
    // dropped as self-`setBy`.
    await room.advance(0.05)
    expect(counters(host).pendingClientAck).toBe(0)
    expect(host.frames).toEqual([])

    // And the cadence resumes with the next one. A 4000 ms gap in a 1 Hz stream:
    // three frames the guard ate, and the assertion is a gap rather than an
    // absence, so a fixture that simply stopped producing frames cannot pass it.
    await room.advance(1)
    expect(host.frames.map((f) => f.at)).toEqual([7500])
    expect(host.frames[0].state.setBy).toBe('joinuser')
    expect(host.frames[0].at - before[before.length - 1]).toBe(4000)
    expect(joiner.el.paused).toBe(true)
  })
})

// #486's file-change seek opens the same window as any local seek, and the
// unconditional zero at `src/main/syncplay.ts:1900` closes it early on any
// frame carrying `ignoringOnTheFly.server`. So the in-flight drop guard is not
// what keeps the old episode's position out of the new one; these cases are.
describe('SyncplayClient — a forced update crossing the file-change seek (#486)', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  const OLD = 300
  const STALE_FLOOR = 50

  const seatSwitch = async (
    joinerDelayMs: number,
    paused = false
  ): Promise<{ host: Peer; joiner: Peer }> => {
    room = await createTwoPeerRoom({ position: OLD, paused })
    const host = await room.seat({ username: 'hostuser', position: OLD, paused, delayMs: DELAY_MS })
    const joiner = await room.seat({
      username: 'joinuser',
      position: OLD,
      paused,
      delayMs: joinerDelayMs
    })
    await room.advance(4)
    host.frames.length = 0
    return { host, joiner }
  }

  it('a peer’s seek to 0 crossing ours (both press) closes the window early and is benign', async () => {
    // The joiner's link is 0 ms, so its own file-change seek reaches the host at
    // t=4050, inside the host's window [4000, 4100).
    const { host, joiner } = await seatSwitch(0)

    await host.goToEpisode('8')
    await joiner.goToEpisode('8')
    expect(counters(host).pendingClientAck).toBe(1)

    await room.advance(0.05)
    // Zeroed by the crossing frame, a slice before our own echo.
    expect(counters(host)).toEqual({
      clientIgnoreCounter: 1,
      pendingClientAck: 0,
      pendingServerAck: 0
    })
    expect(host.frames).toHaveLength(1)
    expect(host.frames[0].at).toBe(4050)
    expect(host.frames[0].state.setBy).toBe('joinuser')
    expect(host.frames[0].state.doSeek).toBe(true)
    expect(host.frames[0].state.position).toBeLessThan(1)

    await room.advance(10)
    expect(host.el.seekWrites.filter((w) => w >= STALE_FLOOR)).toEqual([])
    expect(joiner.el.seekWrites.filter((w) => w >= STALE_FLOOR)).toEqual([])
    expect(room.server.roomState().position).toBeLessThan(STALE_FLOOR)
    expect(room.server.roomState().paused).toBe(false)
  })

  it.each([50, 100])(
    'a peer’s pause %i ms after the switch lands the room paused at the new episode’s start',
    async (afterMs) => {
      const { host, joiner } = await seatSwitch(DELAY_MS)

      await host.goToEpisode('8')
      await room.advance(afterMs / 1000)
      joiner.userPause()
      await room.advance(10)

      expect(host.el.seekWrites.filter((w) => w >= STALE_FLOOR)).toEqual([])
      expect(joiner.el.seekWrites.filter((w) => w >= STALE_FLOOR)).toEqual([])
      expect(room.server.roomState().paused).toBe(true)
      expect(room.server.roomState().position).toBeLessThan(1)
      expect(host.el.paused).toBe(true)
      expect(joiner.el.paused).toBe(true)
      // #502: the joiner's pause comes from a peer the host's roster still
      // lists on episode 7, but it is already at the new episode's start, so it
      // stays on #494's path and the host sends nothing beyond its own seek.
      expect(room.server.wireOf('hostuser').filter((f) => f.doSeek)).toHaveLength(1)
      expect(counters(host).clientIgnoreCounter).toBe(1)
    }
  )

  it('a peer’s pause at the old position in the same slice lands the room paused at 0 on the new episode; the same-episode control keeps the pause (#494, #502)', async () => {
    // Symmetric 50 ms links, and the joiner pauses at ~304 in the slice the
    // host presses next. The server takes the host's seek first and the
    // joiner's pause second (ordering A), so under #494's server order the
    // room's outcome is the pause. The joiner applies the host's seek (it
    // crossed the joiner's unacked pause, so #232 lets it through), and its own
    // pause's echo then disagrees with what that seek handed the element: since
    // #494 the echo is delivered instead of dying at the self-`setBy` guard.
    //
    // Before #494 this pinned a flap: each peer asserted the state the other
    // one handed it and the room swapped between ~0 and ~304 every heartbeat,
    // 10 writes per element over the window, half of them at ~304.
    //
    // The control is the same crossing with a same-episode user seek in place
    // of the episode change, and it keeps #494's outcome: paused at ~304. Until
    // #502 the episode run did the same and landed paused at ~304 *on episode
    // 8*, `[[304], [0, 304]]`. Now the host's roster still lists the joiner on
    // episode 7 when the pause arrives (it paused before it navigated), so the
    // host keeps the pause, hands its renderer 0, and sends one corrective seek.
    const settle = async (
      press: (host: Peer) => Promise<void>
    ): Promise<{ writes: [number[], number[]]; room: number; hostSeeks: number }> => {
      const { host, joiner } = await seatSwitch(DELAY_MS)
      const joinerToasts = toastLog(joiner)
      await press(host)
      joiner.userPause()
      await room.advance(10)
      // The joiner's own pause echo seeks its element from ~0 back to ~304;
      // that is the joiner's pause, not a seek, and never "joinuser seeked to".
      expect(joinerToasts.filter((t) => t.includes('joinuser'))).toEqual([])
      expect(room.server.roomState().paused).toBe(true)
      for (const p of [host, joiner]) {
        expect(p.el.paused).toBe(true)
        expect(p.el.currentTime).toBeCloseTo(room.server.roomState().position, 1)
      }
      const out = {
        writes: [
          host.el.seekWrites.map((w) => Math.round(w)),
          joiner.el.seekWrites.map((w) => Math.round(w))
        ] as [number[], number[]],
        room: Math.round(room.server.roomState().position),
        hostSeeks: room.server.wireOf('hostuser').filter((f) => f.doSeek).length
      }
      room.dispose()
      return out
    }

    const episode = await settle(async (host) => {
      await host.goToEpisode('8')
    })
    const control = await settle(async (host) => host.userSeek(0))

    // The host: one write, at 0 — never the joiner's ~304. The joiner (not
    // driven to follow here, so all three land on its episode-7 element): the
    // host's seek, its own pause handed back by the server, and the corrective
    // seek to 0. The host's two seeks are the file-change seek and the
    // corrective one.
    expect(episode).toEqual({ writes: [[0], [0, 304, 0]], room: 0, hostSeeks: 2 })
    // The control's host carries one more write: the user's own scrub to 0.
    expect(control).toEqual({
      writes: [
        [0, 304],
        [0, 304]
      ],
      room: 304,
      hostSeeks: 1
    })
  })

  // #502, ordering A with the follow driven: the harness does not navigate a
  // peer on its own (the helper header's "What is not modelled"), so the joiner's
  // follow is called the way `PlayerView` would, half a second after it is told.
  // Both origins: an auto-advance's playing seek loses to a pause the server
  // took after it just as a press does, and the strip is origin-blind.
  // In a paused room the crossing frame is the joiner's *play* at ~300, and it
  // stands the same way — except under an auto-advance, whose seek already set
  // the room playing, so the joiner's play changes nothing on the server and no
  // forced frame (and no corrective seek) exists.
  it.each<[SyncplayEpisodeSwitch, 'playing' | 'paused', boolean, number]>([
    ['local', 'playing', true, 2],
    ['auto-advance', 'playing', true, 2],
    ['local', 'paused', false, 2],
    ['auto-advance', 'paused', false, 1]
  ])(
    'ordering A, %s from a %s room: the old-file frame’s `paused` stands at 0 on episode 8 (#502)',
    async (origin, roomWas, endsPaused, hostSeeks) => {
      const roomPaused = roomWas === 'paused'
      const { host, joiner } = await seatSwitch(DELAY_MS, roomPaused)
      await host.goToEpisode('8', undefined, 0, origin)
      if (roomPaused) joiner.userPlay()
      else joiner.userPause()

      // t=4150: the joiner's frame reaches the host with nothing of ours
      // unacked: the host's own echo closed the window at 4100.
      await room.advance(0.15)
      expect(counters(host).pendingClientAck).toBe(hostSeeks === 2 ? 2 : 0)
      // Rewritten above the `lastRoomState` write, not just at the emit: the
      // de-adopted heartbeat mirrors this record.
      expect(host.client['lastRoomState']!.position).toBeLessThan(1)
      expect(host.frames.every((f) => f.state.position < STALE_FLOOR)).toBe(true)

      let switchedAt = -1
      for (let t = 0; t < 10_000; t += 50) {
        if (switchedAt < 0 && joiner.remoteEpisodes.length > 0 && room.elapsed() >= 4550) {
          switchedAt = joiner.el.seekWrites.length
          await joiner.goToEpisode('8', undefined, 0, 'follow')
        }
        await room.advance(0.05)
      }
      expect(switchedAt).toBeGreaterThanOrEqual(0)

      expect(room.server.roomState().paused).toBe(endsPaused)
      expect(room.server.roomState().position).toBeLessThan(STALE_FLOOR)
      expect(room.server.wireOf('hostuser').filter((f) => f.doSeek)).toHaveLength(hostSeeks)
      // The host's renderer is never handed an old-episode position, and its
      // element never writes one.
      expect(host.frames.filter((f) => f.state.position >= STALE_FLOOR)).toEqual([])
      expect(host.el.seekWrites.filter((w) => w >= STALE_FLOOR)).toEqual([])
      // The joiner's own crossed echo lands on its episode-7 element, before
      // the follow (the trace's answer); after its switch nothing stale is
      // written.
      expect(joiner.el.seekWrites.slice(switchedAt).filter((w) => w >= STALE_FLOOR)).toEqual([])
      for (const p of [host, joiner]) {
        expect(p.el.paused).toBe(endsPaused)
        expect(p.el.currentTime).toBeLessThan(STALE_FLOOR)
      }
      expect(Math.abs(host.el.currentTime - joiner.el.currentTime)).toBeLessThan(1)
      // Settled: the joiner's follow announce disarmed the host's marker.
      expect(host.client['fileChangeInFlight']).toBeNull()
    }
  )

  // #502, ordering B with an episode change — the pin main did not have; the
  // two cases below keep `host.userSeek(0)` and are the same-episode control.
  // The joiner's frame reaches the server first, our file-change seek second,
  // so our seek is the room's last word. The host drops the old-file frame
  // whole: nothing is emitted, no corrective seek goes out, and the
  // `crossedByForeign` latch stays empty, so our own echo is handled as on an
  // uncrossed episode change. The room ends on our seek's state at 0: playing
  // for an auto-advance, the room's `paused` at send time for a press.
  it.each<[SyncplayEpisodeSwitch, 'playing' | 'paused', boolean]>([
    ['local', 'playing', false],
    ['auto-advance', 'playing', false],
    ['local', 'paused', true],
    ['auto-advance', 'paused', false]
  ])(
    'ordering B, %s from a %s room: the old-file frame is dropped and our seek’s state stands at 0 (#502)',
    async (origin, roomWas, endsPaused) => {
      const roomPaused = roomWas === 'paused'
      const { host, joiner } = await seatSwitch(DELAY_MS, roomPaused)
      if (roomPaused) joiner.userPlay()
      else joiner.userPause()
      await room.advance(0.1)
      await host.goToEpisode('8', undefined, 0, origin)
      expect(counters(host).pendingClientAck).toBe(1)

      // t=4150: the joiner's frame crosses the host's unacked seek.
      const roomBefore = host.client['lastRoomState']
      await room.advance(0.05)
      expect(host.frames).toEqual([])
      expect(host.client['crossedByForeign']).toBeNull()
      expect(host.client['lastRoomState']).toBe(roomBefore)
      expect(counters(host).clientIgnoreCounter).toBe(1)

      // t=4200: our own echo, uncrossed.
      await room.advance(0.05)
      expect(host.frames).toHaveLength(1)
      expect(host.frames[0].state.paused).toBe(endsPaused)
      expect(host.frames[0].state.position).toBeLessThan(1)

      let switchedAt = -1
      for (let t = 0; t < 10_000; t += 50) {
        if (switchedAt < 0 && joiner.remoteEpisodes.length > 0 && room.elapsed() >= 4650) {
          switchedAt = joiner.el.seekWrites.length
          await joiner.goToEpisode('8', undefined, 0, 'follow')
        }
        await room.advance(0.05)
      }
      expect(switchedAt).toBeGreaterThanOrEqual(0)

      expect(room.server.roomState().paused).toBe(endsPaused)
      expect(room.server.roomState().position).toBeLessThan(STALE_FLOOR)
      expect(room.server.wireOf('hostuser').filter((f) => f.doSeek)).toHaveLength(1)
      expect(host.frames.filter((f) => f.state.position >= STALE_FLOOR)).toEqual([])
      expect(joiner.el.seekWrites.slice(switchedAt).filter((w) => w >= STALE_FLOOR)).toEqual([])
      for (const p of [host, joiner]) {
        expect(p.el.paused).toBe(endsPaused)
        expect(p.el.currentTime).toBeLessThan(STALE_FLOOR)
        expect(p.el.seekWrites.filter((w) => w >= STALE_FLOOR)).toEqual([])
      }
      expect(Math.abs(host.el.currentTime - joiner.el.currentTime)).toBeLessThan(1)
    }
  )

  // #502's slow-link row (the plan review's): the joiner's link is slower than
  // the host's bind gap, so the new element is up before the old-file pause
  // arrives. The marker's `sendLocalState()` clear would disarm the strip if
  // the new element's first post-bind push were asserted ahead of the pause.
  // It is not: the host's startup events stay unasserted until it re-adopts,
  // and the pause still lands while the marker is armed.
  it('ordering A over a joiner link slower than the host’s bind gap still lands paused at 0 (#502)', async () => {
    const { host, joiner } = await seatSwitch(500)
    await host.goToEpisode('8')
    joiner.userPause()
    await room.advance(0.55)
    // The host's new element has already loaded by now.
    expect(host.el.seekWrites).toHaveLength(1)
    expect(host.el.seekWrites[0]).toBeLessThan(1)
    expect(host.client['fileChangeInFlight']).not.toBeNull()
    await room.advance(10)

    expect(room.server.roomState().paused).toBe(true)
    expect(room.server.roomState().position).toBeLessThan(1)
    expect(room.server.wireOf('hostuser').filter((f) => f.doSeek)).toHaveLength(2)
    expect(host.frames.filter((f) => f.state.position >= STALE_FLOOR)).toEqual([])
    expect(host.el.seekWrites.filter((w) => w >= STALE_FLOOR)).toEqual([])
    expect(host.el.paused).toBe(true)
    expect(joiner.el.paused).toBe(true)
  })

  it('a seek crossing a peer’s pause the server took first settles both peers on the seek (#494)', async () => {
    // The other server ordering. The joiner's pause reaches the server first
    // (t=4100); the host seeks to 0 a slice later, before it has heard the
    // pause, so the host's seek is the room's last word: playing from 0. Here
    // the roles swap: the *host* applies the crossing foreign frame (the pause)
    // and then needs its own echo.
    const { host, joiner } = await seatSwitch(DELAY_MS)
    joiner.userPause()
    await room.advance(0.1)
    host.userSeek(0)
    expect(counters(host).pendingClientAck).toBe(1)

    // t=4150: the joiner's pause crosses the host's unacked seek. The host's
    // seek intent is live, so the frame is handed over with the host's own
    // position (#278) — the pause half applies, the playhead stays at 0. That
    // rewritten value is what the crossing latch records; the element is
    // asserted here so the gate's comparand is pinned against what the
    // renderer actually got, not the frame's ~304.
    await room.advance(0.05)
    expect(host.frames).toHaveLength(1)
    expect(host.frames[0].state.setBy).toBe('joinuser')
    expect(host.frames[0].state.paused).toBe(true)
    expect(host.frames[0].state.position).toBeLessThan(1)
    expect(host.el.paused).toBe(true)
    expect(host.el.currentTime).toBeLessThan(1)

    // t=4200: the host's own seek, ordered after the pause, disagrees with that
    // pair (playing vs paused) and is delivered. Before #494 it died at the
    // self-`setBy` guard and the host stayed paused in a playing room.
    await room.advance(0.05)
    expect(host.frames).toHaveLength(2)
    expect(host.frames[1].state.setBy).toBe('hostuser')
    expect(host.frames[1].state.paused).toBe(false)
    expect(host.el.paused).toBe(false)
    // That echo is also the seek intent's converged tick: the room came to us.
    // Since #537 the converged tick is handed over unrewritten, at the room's
    // compensated position rather than our projection, and it is about ours.
    expect(host.seekIntent()).toBeNull()
    expect(host.frames[1].state.position).toBeCloseTo(0.1, 6)
    expect(Math.abs(host.frames[1].state.position - host.frames[1].element)).toBeLessThan(
      ECHO_SEEK_EPSILON_S
    )

    await room.advance(10)
    expect(room.server.roomState().paused).toBe(false)
    expect(room.server.roomState().position).toBeLessThan(STALE_FLOOR)
    // Not `setBy`: after ten seconds of elections it names the `min()`, and the
    // two peers sit one forward delay apart either way. The projection the
    // echo carried before #537 left the host 0.05 s behind the room, so the
    // host was the `min()`; the room's own position puts the joiner there.
    expect(room.server.roomState().setBy).toBe('joinuser')
    for (const p of [host, joiner]) {
      expect(p.el.paused).toBe(false)
      expect(p.el.currentTime).toBeLessThan(STALE_FLOOR)
      expect(p.el.seekWrites.filter((w) => w >= STALE_FLOOR)).toEqual([])
    }
    expect(Math.abs(host.el.currentTime - joiner.el.currentTime)).toBeLessThan(1)
  })

  it('both frames in one slice, with the renderer’s snapshot push still in flight, still settle on the seek (#494)', async () => {
    // The host seeks a slice earlier than above, so its seek and the joiner's
    // pause reach the server in the same slice (pause first) and both forced
    // updates land on the host back to back at t=4150.
    //
    // In the app the renderer→main snapshot push is an async IPC, so main
    // handles the second frame before the push answering the first one has
    // landed: `this.snapshot` still reads the host's own pre-crossing seek
    // (~0, playing). This harness's IPC is synchronous, so that is modelled by
    // holding the host's pushes for the slice and replaying the newest after.
    // It is what makes the gate's comparand observable here: compared against
    // that stale snapshot, the host's seek echo (~0, playing) "matches" and is
    // dropped; compared against the pair the pause handed the renderer (~0,
    // paused) it disagrees and is delivered.
    const { host, joiner } = await seatSwitch(DELAY_MS)
    joiner.userPause()
    await room.advance(0.05)
    host.userSeek(0)
    expect(counters(host).pendingClientAck).toBe(1)
    await room.advance(0.05)

    const push = host.client.updateSnapshot.bind(host.client)
    const held: Parameters<typeof push>[] = []
    const hold = vi.spyOn(host.client, 'updateSnapshot').mockImplementation((...a) => {
      held.push(a)
    })
    await room.advance(0.05)
    hold.mockRestore()
    const newest = held.at(-1)
    if (newest) push(...newest)

    expect(host.frames).toHaveLength(2)
    expect(host.frames[0].at).toBe(4150)
    expect(host.frames[1].at).toBe(4150)
    expect(host.frames[0].state.setBy).toBe('joinuser')
    expect(host.frames[0].state.paused).toBe(true)
    expect(host.frames[0].state.position).toBeLessThan(1)
    expect(host.frames[1].state.setBy).toBe('hostuser')
    expect(host.frames[1].state.paused).toBe(false)

    await room.advance(10)
    expect(room.server.roomState().paused).toBe(false)
    expect(room.server.roomState().position).toBeLessThan(STALE_FLOOR)
    for (const p of [host, joiner]) {
      expect(p.el.paused).toBe(false)
      expect(p.el.seekWrites.filter((w) => w >= STALE_FLOOR)).toEqual([])
    }
    expect(Math.abs(host.el.currentTime - joiner.el.currentTime)).toBeLessThan(1)
  })
})

// #515: the same-slice crossing above, with the pauser's renderer one step
// behind its main. On the real server (run 3) B's main had already received A's
// `doSeek` to 500 when the user pressed Pause, but B's renderer handled the press
// before it applied that frame, so the press reported B's *pre-seek* position.
// The server had taken A's seek first, so the room's outcome is "paused at 500";
// asserting the pre-seek position yanked A back to it, and B's later adoption of
// the seek went out as `setBy rigB` and toasted A's own seek as B's.
//
// The harness's renderer-delivery knob (`Peer.holdRemoteState()`) parks the seek
// at B's IPC hop, so the press lands in exactly that gap.
describe('SyncplayClient — a pause pressed inside the apply gap of a peer’s seek (#515)', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  const FROM = 1100
  const TO = 500

  const seatPlaying = async (): Promise<[Peer, Peer]> => {
    room = await createTwoPeerRoom({ position: FROM, paused: false })
    const A = await room.seat({
      username: 'rigA',
      position: FROM,
      paused: false,
      delayMs: DELAY_MS
    })
    const B = await room.seat({
      username: 'rigB',
      position: FROM,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)
    expect(A.adopted() && B.adopted(), 'setup: both peers adopted').toBe(true)
    return [A, B]
  }

  /** Advance until `to`'s main has been handed `from`'s forced seek. */
  const untilSeekReaches = async (to: Peer, from: Peer): Promise<void> => {
    const n = to.frames.length
    const hit = (): boolean =>
      to.frames.slice(n).some((f) => f.state.doSeek && f.state.setBy === from.username)
    for (let i = 0; !hit(); i++) {
      expect(i, `${from.username}'s seek never reached ${to.username}`).toBeLessThan(200)
      await room.advance(0.05)
    }
  }

  /** Main's echo target: the position it last handed the renderer to seek to. */
  const target = (p: Peer): number | null => p.client['lastAppliedRemotePosition']

  /** The scrub, the seek parked at the pauser's IPC hop, the press, the release. */
  const crossInGap = async (
    scrubber: Peer,
    pauser: Peer
  ): Promise<{ pressAt: number; armed: number; deliveredAtPress: number }> => {
    pauser.holdRemoteState()
    scrubber.userSeek(TO)
    await untilSeekReaches(pauser, scrubber)
    const armed = target(pauser)
    expect(armed).not.toBeNull()
    // Main knows the room is at the target; the element is still pre-seek.
    expect(pauser.el.currentTime).toBeGreaterThan(FROM)
    const pressAt = Date.now()
    pauser.userPause()
    pauser.tick()
    return { pressAt, armed: armed!, deliveredAtPress: pauser.el.delivered.length }
  }

  it.each([
    ['rigA scrubs and rigB pauses (run 3)', 0, 1],
    ['rigB scrubs and rigA pauses (run 4, the mirror)', 1, 0]
  ])(
    '%s: the pause lands at the scrub’s target, the scrubber never moves and is not toasted',
    async (_label, s, p) => {
      const peers = await seatPlaying()
      const scrubber = peers[s]
      const pauser = peers[p]
      const scrubberToasts = toastLog(scrubber)

      const { pressAt, armed, deliveredAtPress } = await crossInGap(scrubber, pauser)
      expect(armed).toBeCloseTo(TO, 0)
      expect(pauser.releaseRemoteState()).toBeGreaterThanOrEqual(1)
      await room.advance(10)

      // The press itself goes out at the target, not at the pre-seek ~1104, and
      // nothing the pauser sends afterwards goes back there either.
      const pauserWire = room.server.wireOf(pauser.username).filter((w) => w.at >= pressAt)
      expect(pauserWire[0].paused).toBe(true)
      expect(pauserWire[0].doSeek).toBe(false)
      expect(pauserWire[0].position).toBe(armed)
      expect(pauserWire.filter((w) => w.position > TO + 10)).toHaveLength(0)
      // …and no resume: every claim after the press is a pause (#513 shape 2's
      // hold, which this crossing relies on).
      expect(pauserWire.filter((w) => w.paused === false)).toHaveLength(0)

      expect(room.server.roomState().paused).toBe(true)
      expect(room.server.roomState().setBy).toBe(pauser.username)
      expect(room.server.roomState().position).toBeCloseTo(TO, 0)
      for (const peer of peers) {
        expect(peer.el.paused).toBe(true)
        expect(peer.el.currentTime).toBeCloseTo(TO, 0)
      }
      // (a) The scrubber never leaves ~500: its own scrub is its only write.
      expect(scrubber.el.seekWrites.map((w) => Math.round(w))).toEqual([TO])
      // The pauser: the scrub, applied once, after the press.
      expect(pauser.el.seekWrites.map((w) => Math.round(w))).toEqual([TO])
      // (b) No seek toast naming the pauser on the scrubber.
      expect(scrubberToasts.filter((t) => t.startsWith(`${pauser.username} seeked`))).toEqual([])
      // (c) The pauser's element never plays after the press.
      expect(pauser.el.delivered.slice(deliveredAtPress)).not.toContain('play')
    }
  )

  it('keeps the target armed on that path, so the element’s seeked there is still an echo', async () => {
    // The renderer's own seek op normally absorbs that `seeked` before it reaches
    // main; this is main's belt for when the op expired or missed. Delivered by
    // hand, as the late `seeked` would be, before the parked frame is released.
    const [A, B] = await seatPlaying()
    const { pressAt, armed } = await crossInGap(A, B)
    expect(target(B)).toBe(armed)

    B.client.sendLocalState({ paused: true, position: armed, cause: 'seek' })
    expect(room.server.wireOf('rigB').filter((w) => w.at >= pressAt && w.doSeek)).toHaveLength(0)
    expect(target(B)).toBeNull()
  })

  it('a pause made seconds after an applied peer seek goes out at the element’s own position', async () => {
    // The ordinary path, and the one the TTL exists for. B applies A's seek, the
    // renderer's seek op consumes the `seeked`, so main's echo guard never runs
    // and the target stays armed — nothing else retires it until B asserts.
    const [A, B] = await seatPlaying()
    A.userSeek(TO)
    await untilSeekReaches(B, A)
    await room.advance(0.1)
    expect(B.el.seekWrites.map((w) => Math.round(w))).toEqual([TO])
    const armed = target(B)
    expect(armed).not.toBeNull()

    await room.advance(5)
    expect(target(B)).toBe(armed)
    const pressAt = Date.now()
    B.userPause()
    B.tick()
    const own = B.el.currentTime
    expect(own - armed!).toBeGreaterThan(4)

    const press = room.server.wireOf('rigB').filter((w) => w.at >= pressAt)
    expect(press).toHaveLength(1)
    expect(press[0].paused).toBe(true)
    expect(press[0].position).toBeCloseTo(own, 3)
    expect(target(B)).toBeNull()
    await room.advance(3)
    expect(room.server.roomState().paused).toBe(true)
    expect(room.server.roomState().position).toBeCloseTo(own, 1)
    // A was never pulled back to the old target.
    expect(A.el.seekWrites.map((w) => Math.round(w))).toEqual([TO])
    expect(A.el.currentTime).toBeCloseTo(own, 0)
  })

  it('a pause already at the target retires it, so a small genuine seek right after still goes out', async () => {
    // Inside the window but within ECHO_SEEK_EPSILON_S of the target, the
    // substitution would change nothing; it must not keep the target armed
    // either, or main's echo guard would swallow the user's next nudge.
    const [A, B] = await seatPlaying()
    A.userSeek(TO)
    await untilSeekReaches(B, A)
    const armed = target(B)
    expect(armed).not.toBeNull()
    expect(Math.abs(B.el.currentTime - armed!)).toBeLessThan(0.5)

    B.userPause()
    B.tick()
    expect(target(B)).toBeNull()

    const nudgeAt = Date.now()
    B.userSeek(armed! + 0.3)
    const nudge = room.server.wireOf('rigB').filter((w) => w.at >= nudgeAt && w.doSeek)
    expect(nudge).toHaveLength(1)
    expect(nudge[0].position).toBeCloseTo(armed! + 0.3, 3)
  })
})

// A pause (or resume) pressed a few ms before a peer's far scrub (#535, S11).
// The scrubber's main has *received* the flip and its renderer has not applied
// it yet, so the snapshot still holds the pre-flip `paused`. In the crossed
// shape (2a) the scrub crosses the forced flip and the server's ignore window
// drops it; on the forced frame's tick main acks, then `maybeReassertSeek()`
// re-sends the scrub, and the server applies that. Before #535 the re-assert
// claimed the stale `paused` and undid the flip at the scrub's target; the
// marker is now armed above it, so it goes out position-only. Both directions:
// a resume crossing a paused peer's scrub has the same shape. The uncrossed
// shape (2b, the seek itself carrying the stale `paused`) is #544.
describe('SyncplayClient — a pause or resume a few ms before a peer’s far scrub (#535)', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  // S11's 30 s, well past SEEK_REASSERT_TOLERANCE_S: the 2a hop exists.
  const FAR = 10 * SEEK_REASSERT_TOLERANCE_S

  const seat = async (paused: boolean, ignoreWindow: boolean): Promise<[Peer, Peer]> => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused, server: { ignoreWindow } })
    const A = await room.seat({ username: 'rigA', position: ROOM_START, paused, delayMs: DELAY_MS })
    const B = await room.seat({ username: 'rigB', position: ROOM_START, paused, delayMs: DELAY_MS })
    await room.advance(4)
    expect(A.adopted() && B.adopted(), 'setup: both peers adopted').toBe(true)
    return [A, B]
  }

  const press = (A: Peer, to: boolean): void => (to ? A.userPause() : A.userPlay())

  const bWireSince = (at: number): WireFrame[] =>
    room.server.wireOf('rigB').filter((w) => w.at >= at)

  /** The settled room: both elements on the flip A pressed, together, at the
   *  scrub's target (aged by wall time when playing). */
  const expectSettled = (A: Peer, B: Peer, to: boolean, target: number): void => {
    expect(room.server.roomState().paused, 'the room kept A’s flip').toBe(to)
    for (const p of [A, B]) expect(p.el.paused, `${p.username} on A’s flip`).toBe(to)
    expect(Math.abs(A.el.currentTime - B.el.currentTime)).toBeLessThan(ECHO_SEEK_EPSILON_S)
    if (to) expect(room.server.roomState().position).toBeCloseTo(target, 0)
    else expect(room.server.roomState().position).toBeGreaterThan(target)
  }

  describe.each([
    ['pause', true],
    ['resume', false]
  ])('A’s %s', (_label, to) => {
    it('2a, crossed: B’s re-assert carries no stale `paused`, and the room keeps the flip at B’s target', async () => {
      const [A, B] = await seat(!to, true)
      const pressAt = Date.now()
      press(A, to)
      const flipFrame = (): WireFrame | undefined =>
        room.server.wireOf('rigA').find((f) => f.at >= pressAt && f.paused === to)
      while (flipFrame() === undefined) await room.advance(0.01, 10)
      // The server applies it one delay after it left and forces it back out;
      // B scrubs inside the second delay, so the scrub crosses the forced frame.
      while (Date.now() < flipFrame()!.at + DELAY_MS + 30) await room.advance(0.01, 10)
      const target = B.el.currentTime + FAR
      const scrubAt = Date.now()
      B.userSeek(target)
      await room.advance(6)

      // The crossing: the scrub carried the pre-flip `paused` and was dropped.
      const ignored = room.server.ignored.filter((f) => f.username === 'rigB' && f.doSeek)
      expect(ignored.map((f) => [f.position, f.paused])).toEqual([[target, !to]])
      // The frame the server applied instead is the re-assert, and it claims
      // only the position. Red before #535, where it claimed `paused: !to`.
      const reasserts = bWireSince(scrubAt)
        .filter((w) => w.doSeek)
        .slice(1)
      expect(reasserts.length).toBeGreaterThanOrEqual(1)
      for (const r of reasserts) expect(r).not.toHaveProperty('paused')
      expect(bWireSince(scrubAt + 1).filter((w) => w.paused === !to)).toEqual([])
      expectSettled(A, B, to, target)
    })
  })
})
