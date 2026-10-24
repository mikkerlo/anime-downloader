// @vitest-environment happy-dom
//
// A short scrub crossed by a peer's pause, on two peers across the server's
// ignore window (#537).
//
// S10c's residual on the real server, after #524. The pauser's pause reaches
// the server first; the server forces it to both peers and raises each one's
// ignore window, so the scrub, which left the scrubber before the forced pause
// reached it, is discarded. The scrub is shorter than SEEK_REASSERT_TOLERANCE_S,
// so main's #252 re-assert never resends it: `maybeReassertSeek()` retires the
// intent as converged on the very frame that carries the pause. Upstream loses
// the seek too, and both peers end on the pauser's frame.
//
// What kept the scrubber 2 s off that frame were two guards, and the fix
// narrows both, together:
//  - main's #278 substitution handed the renderer our own projected position
//    instead of the pause's, so the renderer's `diff` was ≈ 0; it no longer
//    substitutes on the tick the converged exit retires the intent;
//  - the renderer's #488 hold (`isUserSeekInFlight()`) declined the snap
//    because the scrubber's own seek was still loading; it now lets a pause
//    edge through when the pause lands more than ECHO_SEEK_EPSILON_S but at
//    most 3 s from that seek's own target.
// Either one alone leaves the scrubber where it was.
//
// `ignoreWindow` is what makes the crossing reachable here: without it the
// model applies the scrub and forces it to the pauser, and both peers end on
// the scrub's target for a reason that has nothing to do with this file.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer, ObservedFrame } from '../helpers/syncplay-two-peer'
import { ECHO_SEEK_EPSILON_S } from '../../src/shared/syncplay-apply-rule'
import { SEEK_REASSERT_TOLERANCE_S } from '../../src/main/syncplay'

const ROOM_START = 100
const DELAY_MS = 50
// The scrubber's seek is still loading when the forced pause reaches it, as
// it was in all four of S10c's residual runs (`pauseInFlight`).
const SEEK_LAND_MS = 400

describe('SyncplayClient — a short scrub crossed by a peer’s pause (#537)', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  const doSeeks = (username: string): number =>
    room.server.wireOf(username).filter((f) => f.doSeek === true).length

  /**
   * The pauser presses pause; the scrubber scrubs `by` seconds after the server
   * has applied that pause and before its forced update reaches the scrubber,
   * so the scrub crosses it on the wire and arrives inside the scrubber's
   * ignore window. `pausedAt` is the position the pauser sent, `carrier` the
   * frame that handed the pause to the scrubber's renderer.
   */
  const crossedScrub = async (
    by: number
  ): Promise<{
    scrubber: Peer
    pauser: Peer
    carrier: ObservedFrame
    target: number
    pausedAt: number
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

    pauser.userPause()
    const pauseFrame = (): { at: number; position: number } | undefined =>
      room.server.wireOf('joinuser').find((f) => f.paused === true)
    while (pauseFrame() === undefined) await room.advance(0.01, 10)
    // The server applies it one delay after it left and forces it back out;
    // the forced frame reaches the scrubber a second delay later. Scrub inside
    // that second delay.
    while (Date.now() < pauseFrame()!.at + DELAY_MS + 30) await room.advance(0.01, 10)
    const target = scrubber.el.currentTime + by
    scrubber.userSeek(target)
    await room.advance(4)

    const carrier = scrubber.frames.find((f) => f.state.paused && f.state.setBy === 'joinuser')
    expect(carrier, 'the pause never reached the scrubber').toBeDefined()
    return { scrubber, pauser, carrier: carrier!, target, pausedAt: pauseFrame()!.position }
  }

  it('is the S10c shape: the scrub is discarded, never re-asserted, and met while loading', async () => {
    const { carrier, target, pausedAt } = await crossedScrub(2)

    // The server threw the scrub away inside the scrubber's ignore window.
    const ignored = room.server.ignored.filter((f) => f.username === 'hostuser')
    expect(ignored.filter((f) => f.doSeek === true).map((f) => f.position)).toEqual([target])
    // Inside SEEK_REASSERT_TOLERANCE_S, so no #252 re-assert ever goes out, and
    // past ECHO_SEEK_EPSILON_S, so the pause edge has a snap to make.
    expect(Math.abs(target - pausedAt)).toBeLessThan(SEEK_REASSERT_TOLERANCE_S)
    expect(Math.abs(target - pausedAt)).toBeGreaterThan(ECHO_SEEK_EPSILON_S)
    expect(doSeeks('hostuser')).toBe(1)
    // The pause met the scrubber's own seek in flight: the element read the
    // target, not a landed playhead.
    expect(carrier.element).toBe(target)
  })

  it('lands both peers on the pauser’s frame', async () => {
    const { scrubber, pauser, carrier, target, pausedAt } = await crossedScrub(2)

    // Main hands the renderer the room's pause, not our projection: no
    // substitution on the tick the converged exit retires the intent. Red
    // before #537, where this read our own target.
    expect(carrier.state.position).toBe(pausedAt)
    // The renderer snaps to it although its own seek was still loading.
    expect(scrubber.el.seekWrites).toEqual([target, pausedAt])
    expect(scrubber.el.paused).toBe(true)
    expect(pauser.el.paused).toBe(true)
    // Red before #537: the two sat paused 2 s apart.
    expect(Math.abs(scrubber.el.currentTime - pauser.el.currentTime)).toBeLessThan(
      ECHO_SEEK_EPSILON_S
    )
    expect(room.server.roomState()).toMatchObject({ paused: true, position: pausedAt })
    // The snap is the room's move: its `seeked` goes nowhere, so the one
    // `doSeek` the scrubber ever sent is the scrub the server discarded.
    expect(doSeeks('hostuser')).toBe(1)
    // The pauser was never moved.
    expect(pauser.el.seekWrites).toEqual([])
  })

  // The coupling the narrowed hold rests on (#537 plan review). Past the
  // re-assert tolerance main still substitutes on the crossing frame, so the
  // renderer is handed our own position and the pause edge moves nothing but
  // `paused`; the #252 re-assert carries the scrub. What that re-assert then
  // does to the pause is #535's (S11), not this file's.
  it('past SEEK_REASSERT_TOLERANCE_S: the crossing frame is ours and moves nothing but paused', async () => {
    const { scrubber, carrier, target, pausedAt } = await crossedScrub(
      SEEK_REASSERT_TOLERANCE_S + 7
    )

    expect(carrier.state.paused).toBe(true)
    expect(carrier.element).toBe(target)
    expect(Math.abs(carrier.state.position - target)).toBeLessThan(ECHO_SEEK_EPSILON_S)
    // Never snapped to the pauser's frame, on that tick or after it.
    expect(scrubber.el.seekWrites[0]).toBe(target)
    expect(scrubber.el.seekWrites.every((w) => Math.abs(w - target) < ECHO_SEEK_EPSILON_S)).toBe(
      true
    )
    expect(scrubber.el.seekWrites.some((w) => Math.abs(w - pausedAt) < 1)).toBe(false)
    // And the re-assert went out.
    expect(doSeeks('hostuser')).toBeGreaterThanOrEqual(2)
  })
})
