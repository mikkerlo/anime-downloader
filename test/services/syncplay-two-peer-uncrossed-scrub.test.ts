// @vitest-environment happy-dom
//
// A short scrub a peer's pause did *not* cross, still loading when the
// scrubber's renderer applies that pause (#544).
//
// S10c's uncrossed shape, which #535's 2b exposed on the real server (12 of 40
// runs, all `seekCrossed=false`). The pauser's forced pause reaches the
// scrubber's main, which acks it on receipt, before the scrub leaves; the
// scrubber's renderer is already loading the scrub when it applies that pause.
// So the server is no longer ignoring the scrubber when the scrub arrives: it
// takes it, keeps the room paused (2b: the scrub goes out position-only) and
// forces the target to the pauser. The scrub was *not* dropped, which is where
// this differs from #537's crossed shape
// (`test/services/syncplay-two-peer-crossed-scrub.test.ts`), and the #488 hold
// must stand: following the pause edge snaps the scrubber back to the
// pre-scrub position the room has just left, 2 s from where the server put the
// pauser, and nothing under 3 s corrects that later.
//
// Main says which shape a frame is (`crossedOurChange`, absent on this one),
// and the renderer releases the hold only on a crossed frame. Red with 2b
// alone: the hold was released on any pause edge 0.5–3 s from the target.
//
// The renderer leg is held at the IPC hop (`holdRemoteState()`) so main can
// receive and ack the pause before the renderer handles the user's scrub, the
// order the real-server traces show (main's emit 1–3 ms before the scrub's
// `local-state`). `ignoreWindow` is on, so a scrub that *had* crossed would be
// dropped here as it is on the real server.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer, ObservedFrame } from '../helpers/syncplay-two-peer'
import { ECHO_SEEK_EPSILON_S } from '../../src/shared/syncplay-apply-rule'
import { SEEK_REASSERT_TOLERANCE_S } from '../../src/main/syncplay'

const ROOM_START = 100
const DELAY_MS = 50
// Still loading when the renderer applies the pause, as in 11 of the 12
// drifted real-server runs (`pauseInFlight`).
const SEEK_LAND_MS = 400

describe('SyncplayClient — a short scrub a peer’s pause did not cross, still loading (#544)', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  /**
   * The pauser presses pause. The scrubber's main receives and acks the forced
   * pause while its renderer is busy; the scrubber then scrubs `by` seconds,
   * and the renderer applies the held pause with that scrub still loading.
   * `pausedAt` is the position the pauser sent, `carrier` the frame that
   * handed the pause on, `scrubAt` the instant the scrub was made.
   */
  const uncrossedScrub = async (
    by: number
  ): Promise<{
    scrubber: Peer
    pauser: Peer
    carrier: ObservedFrame
    target: number
    pausedAt: number
    scrubAt: number
  }> => {
    room = await createTwoPeerRoom({
      position: ROOM_START,
      paused: false,
      server: { ignoreWindow: true }
    })
    const scrubber = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: SEEK_LAND_MS
    })
    const pauser = await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)
    scrubber.frames.length = 0
    scrubber.el.seekWrites.length = 0
    pauser.el.seekWrites.length = 0

    scrubber.holdRemoteState()
    pauser.userPause()
    const carrier = (): ObservedFrame | undefined =>
      scrubber.frames.find((f) => f.state.paused && f.state.setBy === 'joinuser')
    while (carrier() === undefined) await room.advance(0.01, 10)
    // Main has the pause and has acked it: the scrub below is not crossed.
    expect(scrubber.counters().pendingClientAck, 'setup: acked before the scrub').toBe(0)
    const pausedAt = carrier()!.state.position
    const target = scrubber.el.currentTime + by
    const scrubAt = Date.now()
    scrubber.userSeek(target)
    expect(scrubber.el.seeking, 'setup: the scrub is loading').toBe(true)
    expect(scrubber.releaseRemoteState()).toBeGreaterThanOrEqual(1)
    await room.advance(4)
    return { scrubber, pauser, carrier: carrier()!, target, pausedAt, scrubAt }
  }

  it('is S10c’s uncrossed shape: the server takes the scrub, and main does not flag the pause', async () => {
    const { carrier, target, pausedAt } = await uncrossedScrub(2)

    // Nothing of the scrubber's was ignored: the scrub reached the room.
    expect(room.server.ignored.filter((f) => f.username === 'hostuser')).toEqual([])
    // Inside SEEK_REASSERT_TOLERANCE_S and past ECHO_SEEK_EPSILON_S, so #537's
    // band release would have had a snap to make.
    expect(Math.abs(target - pausedAt)).toBeLessThan(SEEK_REASSERT_TOLERANCE_S)
    expect(Math.abs(target - pausedAt)).toBeGreaterThan(ECHO_SEEK_EPSILON_S)
    // The frame crossed nothing of ours, so main hands it on unflagged.
    expect(carrier.state).not.toHaveProperty('crossedOurChange')
  })

  it('keeps the scrub: both peers end paused on its target, and the scrubber never snaps back', async () => {
    const { scrubber, pauser, target, pausedAt, scrubAt } = await uncrossedScrub(2)

    // The hold stands: the only write is the user's own scrub. Red with 2b
    // alone, where the pause edge snapped the scrubber back to `pausedAt`.
    expect(scrubber.el.seekWrites).toEqual([target])
    expect(scrubber.el.seekWrites.some((w) => Math.abs(w - pausedAt) < 1)).toBe(false)
    expect(scrubber.el.paused).toBe(true)
    expect(pauser.el.paused).toBe(true)
    expect(Math.abs(scrubber.el.currentTime - pauser.el.currentTime)).toBeLessThan(
      ECHO_SEEK_EPSILON_S
    )
    expect(Math.abs(scrubber.el.currentTime - target)).toBeLessThan(ECHO_SEEK_EPSILON_S)
    // The room kept the pause, at the scrub's target, and forced it to the pauser.
    expect(room.server.roomState().paused).toBe(true)
    expect(room.server.roomState().position).toBeCloseTo(target, 0)
    expect(pauser.el.seekWrites.map((w) => Math.round(w))).toEqual([Math.round(target)])
    // And the scrubber never claimed the stale `paused: false` (2b): red without
    // the kept marker, where the scrub itself resumed the room.
    expect(
      room.server.wireOf('hostuser').filter((w) => w.at >= scrubAt && w.paused === false)
    ).toEqual([])
  })
})
