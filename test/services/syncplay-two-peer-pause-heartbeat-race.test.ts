// @vitest-environment happy-dom
//
// A pause undone by a stale `paused: false` crossing it (#513, shape 1).
//
// When a peer's forced pause reaches us, `handleState()` acks it at once
// (`sendAck()`) and only then emits `remote-state`. The renderer applies it and
// pushes a fresh snapshot, but until that push reaches main `snapshot.paused`
// still holds the *pre-apply* value. A heartbeat in that gap asserts it, and the
// server — no longer ignoring us — takes it as a resume, `setBy` us. In CI's
// P6f/P7f traces the gap was 4 ms and the heartbeat landed in it about once in
// sixty presses.
//
// The fixture cannot hit a 4 ms gap by luck, so it widens it on purpose: the
// harness's renderer-delivery knob (`Peer.holdRemoteState()`) parks the frame at
// the IPC hop while main runs on, and the press is phase-locked so B's next
// heartbeat lands inside the hold. That makes the race deterministic rather than
// ~1.7 % per press, which is what lets case 1 fail on `main` every time.
//
// Every assertion reads B's *outbound* playstates off the server's wire log,
// counted, not shaped: "no `paused: false` in the gap" is only evidence if the
// gap is shown to contain the heartbeat at all.
//
// The second describe is shape 2, the same knob used the other way round: the
// press reaches the renderer *between* main emitting a stale frame and the
// renderer applying it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer } from '../helpers/syncplay-two-peer'
import type { WireFrame } from '../helpers/syncplay-min-election-server'

const ROOM_START = 100
const DELAY_MS = 50

describe('SyncplayClient — a heartbeat inside the apply gap (#513 shape 1)', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  const seatPlaying = async (paused = false): Promise<[Peer, Peer]> => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused })
    const A = await room.seat({ username: 'rigA', position: ROOM_START, paused, delayMs: DELAY_MS })
    const B = await room.seat({ username: 'rigB', position: ROOM_START, paused, delayMs: DELAY_MS })
    await room.advance(4)
    expect(A.adopted() && B.adopted(), 'setup: both peers adopted').toBe(true)
    return [A, B]
  }

  /** Advance slice by slice until B has just put a heartbeat on the wire, so the
   *  next one is a full `HEARTBEAT_MS` away — the phase lock. */
  const afterBHeartbeat = async (): Promise<void> => {
    const n = room.server.wireOf('rigB').length
    while (room.server.wireOf('rigB').length === n) await room.advance(0.05)
  }

  /** Advance until B's main has been handed a frame with `paused === to`. */
  const untilBReceives = async (B: Peer, to: boolean): Promise<number> => {
    const from = B.frames.length
    for (;;) {
      const hit = B.frames.slice(from).find((f) => f.state.paused === to)
      if (hit) return Date.now()
      await room.advance(0.05)
    }
  }

  const bWireSince = (at: number): WireFrame[] =>
    room.server.wireOf('rigB').filter((w) => w.at > at)

  it("does not let B's heartbeat undo A's pause before B's renderer applies it", async () => {
    const [A, B] = await seatPlaying()
    await afterBHeartbeat()

    B.holdRemoteState()
    A.userPause()
    const receivedAt = await untilBReceives(B, true)
    // Hold across exactly one of B's heartbeats: the gap the CI traces show,
    // stretched from 4 ms to most of a second.
    await afterBHeartbeat()
    const gap = bWireSince(receivedAt)
    expect(gap, 'the gap must contain B’s heartbeat').toHaveLength(1)
    expect(gap.filter((w) => w.paused === false)).toHaveLength(0)
    // Position only — the marker withholds the claim rather than inverting it.
    expect(gap[0]).not.toHaveProperty('paused')
    expect(room.server.roomState().paused).toBe(true)

    expect(B.releaseRemoteState()).toBeGreaterThanOrEqual(1)
    await room.advance(3)
    expect(bWireSince(receivedAt).filter((w) => w.paused === false)).toHaveLength(0)
    expect(room.server.roomState().paused).toBe(true)
    expect(A.el.paused).toBe(true)
    expect(B.el.paused).toBe(true)
  })

  it("does not let B's heartbeat undo A's resume either (the reverse direction)", async () => {
    // `canAssertSnapshot()` asserts a *paused* snapshot regardless of its age,
    // so the stale claim in this direction is `paused: true`, re-pausing a room
    // A just resumed.
    const [A, B] = await seatPlaying()
    A.userPause()
    await room.advance(3)
    expect(room.server.roomState().paused).toBe(true)
    expect(B.el.paused).toBe(true)
    await afterBHeartbeat()

    B.holdRemoteState()
    A.userPlay()
    const receivedAt = await untilBReceives(B, false)
    await afterBHeartbeat()
    const gap = bWireSince(receivedAt)
    expect(gap, 'the gap must contain B’s heartbeat').toHaveLength(1)
    expect(gap.filter((w) => w.paused === true)).toHaveLength(0)
    expect(room.server.roomState().paused).toBe(false)

    B.releaseRemoteState()
    await room.advance(3)
    expect(bWireSince(receivedAt).filter((w) => w.paused === true)).toHaveLength(0)
    expect(room.server.roomState().paused).toBe(false)
    expect(A.el.paused).toBe(false)
    expect(B.el.paused).toBe(false)
  })

  it('still sends the pause claim of a real local press made inside the gap', async () => {
    // `sendLocalState()` shares `buildPlaystate()` with the heartbeat. A press
    // made while the marker is armed is the user replacing what the room just
    // said, so it must carry `paused` — position-only, it would bump the ignore
    // counter and claim nothing.
    const [A, B] = await seatPlaying()
    await afterBHeartbeat()
    B.holdRemoteState()
    A.userPause()
    const receivedAt = await untilBReceives(B, true)

    B.client.sendLocalState({ paused: false, position: B.el.currentTime, cause: 'play' })
    await afterBHeartbeat()
    const gap = bWireSince(receivedAt - 1)
    // The press, then the heartbeat — both claim the user's `paused: false`.
    expect(gap).toHaveLength(2)
    expect(gap.map((w) => w.paused)).toEqual([false, false])
  })

  it('is not retired by a snapshot push sent before the renderer applied the flip', async () => {
    // Renderer pushes are unordered relative to `remote-state`: a `timeupdate`
    // or 1 s interval push that left before the apply still says `paused:
    // false`. Clearing on any push would re-open the race one IPC hop later.
    const [A, B] = await seatPlaying()
    await afterBHeartbeat()
    B.holdRemoteState()
    A.userPause()
    const receivedAt = await untilBReceives(B, true)

    B.client.updateSnapshot({ position: B.el.currentTime, paused: false })
    await afterBHeartbeat()
    const gap = bWireSince(receivedAt)
    expect(gap).toHaveLength(1)
    expect(gap[0]).not.toHaveProperty('paused')
  })

  it('is retired by the push that reports the flip applied', async () => {
    // The other half of the clear rule: once the renderer has applied the pause
    // and pushed `paused: true`, the very next heartbeat claims it again —
    // inside the TTL, so it is the push and not the timer that re-opened it.
    const [A, B] = await seatPlaying()
    await afterBHeartbeat()
    B.holdRemoteState()
    A.userPause()
    const receivedAt = await untilBReceives(B, true)
    B.releaseRemoteState()
    await room.advance(0.05)
    expect(B.el.paused).toBe(true)

    await afterBHeartbeat()
    const gap = bWireSince(receivedAt)
    expect(gap).toHaveLength(1)
    expect(Date.now() - receivedAt).toBeLessThan(1000)
    expect(gap[0].paused).toBe(true)
  })

  it('withholds the claim for one heartbeat, not forever, when the renderer never catches up', async () => {
    // The TTL. A `play()` refused by autoplay policy, or a renderer that died
    // mid-apply, never pushes the matching snapshot; the marker must not
    // silence the pause claim for the rest of the session. Two heartbeats, not
    // one, because the room's periodic between them repeats the same flip: a
    // marker re-stamped by every repeat would never expire.
    const [A, B] = await seatPlaying()
    await afterBHeartbeat()
    B.holdRemoteState()
    A.userPause()
    const receivedAt = await untilBReceives(B, true)
    await afterBHeartbeat()
    await afterBHeartbeat()

    const gap = bWireSince(receivedAt)
    expect(gap).toHaveLength(2)
    expect(gap[0]).not.toHaveProperty('paused')
    expect(gap[1]).toHaveProperty('paused')
  })
})

// Shape 2: the presser applies a `paused: false` the server sent before our
// pause reached it. Main emitted it before the press's `sendLocalState` IPC, so
// `pendingClientAck` was still 0 and nothing dropped it; the renderer handles the
// press first and the stale frame second. The cover is the renderer's pending-
// pause hold, armed post-adoption since #513 — main's marker cannot see this
// one, because the frame agreed with the snapshot when it was emitted.
describe('SyncplayClient — a stale resume applied after the press (#513 shape 2)', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  it('does not let the presser resume the room on a periodic that crossed its pause', async () => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    // B seated first and two seconds behind, so it wins every `min()` election
    // and A's inbound periodics are foreign-`setBy` — the shape in the CI trace,
    // and the only one that survives main's self-`setBy` guard to be applied.
    const B = await room.seat({
      username: 'rigB',
      position: ROOM_START - 2,
      paused: false,
      delayMs: 0
    })
    const A = await room.seat({
      username: 'rigA',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)
    expect(A.adopted() && B.adopted(), 'setup: both peers adopted').toBe(true)

    // Park A's next periodic at the IPC hop: main has emitted it, the renderer
    // has not applied it.
    A.holdRemoteState()
    const from = A.frames.length
    while (A.frames.length === from) await room.advance(0.05)
    const stale = A.frames[from].state
    expect(stale.paused).toBe(false)
    expect(stale.setBy).toBe('rigB')
    expect(A.counters().pendingClientAck).toBe(0)

    // The press reaches the renderer first, and main through `sendLocalState`.
    A.userPause()
    A.tick()
    const pressAt = Date.now()
    expect(A.counters().pendingClientAck).toBe(1)
    // …and only then the stale frame.
    expect(A.releaseRemoteState()).toBe(1)
    await room.advance(4)

    const aWire = room.server.wireOf('rigA').filter((w) => w.at >= pressAt)
    expect(aWire[0].paused).toBe(true)
    expect(aWire.filter((w) => w.paused === false)).toHaveLength(0)
    expect(room.server.roomState().paused).toBe(true)
    expect(A.el.paused).toBe(true)
    expect(B.el.paused).toBe(true)
  })
})
