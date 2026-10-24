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
//    (`src/main/syncplay.ts:2238`).
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
    // dies at `src/main/syncplay.ts:2237`. It moves nothing: |102.049 − 103.95|
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
    // below attributable to the ack rather than to `src/main/syncplay.ts:2237`.
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
    // `src/main/syncplay.ts:2237` before the ack guard at
    // `src/main/syncplay.ts:2238` is ever reached — and the case then passes with
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
    }
  )

  it('a peer’s pause at the old position in the same slice settles both peers on the pause in one round trip (#494)', async () => {
    // Symmetric 50 ms links, and the joiner pauses at ~304 in the slice the
    // host presses next. The server takes the host's seek first and the
    // joiner's pause second, so the room's outcome is paused at ~304. The
    // joiner applies the host's seek (it crossed the joiner's unacked pause, so
    // #232 lets it through), and its own pause's echo then disagrees with what
    // that seek handed the element: since #494 the echo is delivered instead of
    // dying at the self-`setBy` guard, and both peers settle on it.
    //
    // Before #494 this pinned a flap: each peer asserted the state the other
    // one handed it and the room swapped between ~0 and ~304 every heartbeat,
    // 10 writes per element over the window, half of them at ~304.
    //
    // The control is the same crossing with a same-episode user seek in place
    // of the episode change; it behaves the same, write for write, apart from
    // the user's own scrub to 0. Under server order the episode run lands
    // paused at ~304 *on episode 8* — accepted here; stripping an old-file
    // position from the crossing is #502.
    const settle = async (press: (host: Peer) => Promise<void>): Promise<[number[], number[]]> => {
      const { host, joiner } = await seatSwitch(DELAY_MS)
      const joinerToasts = toastLog(joiner)
      await press(host)
      joiner.userPause()
      await room.advance(10)
      // The joiner's own pause echo seeks its element from ~0 back to ~304;
      // that is the joiner's pause, not a seek, and never "joinuser seeked to".
      expect(joinerToasts.filter((t) => t.includes('joinuser'))).toEqual([])
      expect(room.server.roomState().paused).toBe(true)
      expect(room.server.roomState().position).toBeCloseTo(303.95, 1)
      for (const p of [host, joiner]) {
        expect(p.el.paused).toBe(true)
        expect(p.el.currentTime).toBeCloseTo(303.95, 1)
      }
      const writes: [number[], number[]] = [
        host.el.seekWrites.map((w) => Math.round(w)),
        joiner.el.seekWrites.map((w) => Math.round(w))
      ]
      room.dispose()
      return writes
    }

    const episode = await settle(async (host) => {
      await host.goToEpisode('8')
    })
    const control = await settle(async (host) => host.userSeek(0))

    // The host: the joiner's pause, once. The joiner: the host's seek, then
    // its own pause handed back by the server.
    expect(episode).toEqual([[304], [0, 304]])
    // The control's host carries one more write: the user's own scrub to 0.
    expect(control).toEqual([
      [0, 304],
      [0, 304]
    ])
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

    await room.advance(10)
    expect(room.server.roomState().paused).toBe(false)
    expect(room.server.roomState().position).toBeLessThan(STALE_FLOOR)
    expect(room.server.roomState().setBy).toBe('hostuser')
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
