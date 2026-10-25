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
const HEARTBEAT_MS = 1000
// The renderer's adopted pending-pause hold,
// `src/renderer/src/composables/use-syncplay-client.ts:52 ("const ADOPTED_PENDING_PAUSE_MAX_MS = 1500")`.
const ADOPTED_PENDING_PAUSE_MAX_MS = 1500
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
  // does to the pause is #535's (S11), pinned in
  // `syncplay-two-peer-ignore-counters.test.ts`, not this file's.
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

// The mirror crossing, on the pauser (#547): the scrub reaches the server first,
// and the pause the pauser sent before hearing its forced update arrives inside
// the pauser's ignore window, so the server drops the press. The forced seek's
// `paused: false` is the only resume the pauser sees, and its adopted pending-
// pause hold declines it, and so does it decline the room's periodic, still
// playing, that can reach the pauser ahead of its next heartbeat. Before #547
// main armed #513's marker for those resumes anyway; no push ever retired it,
// so the first heartbeat after the crossing went out position-only and the
// press was re-asserted a heartbeat later, after the hold had run out. On the
// real server a resume reaching the pauser in that gap got through, and the
// press was lost: S11's `dropped` bucket from #546. This model sends the pauser
// no such resume, so here the old claim is only late, and the case pins when it
// lands: inside the hold, at every phase of the pauser's heartbeat against the
// server's periodic.
const SEAT_GAPS_S = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
describe('SyncplayClient — a pause crossed by a peer’s scrub and dropped by the server (#547)', () => {
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
   * The scrubber scrubs just after the pauser's heartbeat; the pauser presses
   * pause after the server has applied the scrub and before its forced update
   * reaches the pauser. `seatGapS` seats the pauser that long after the
   * scrubber, which sets the pauser's heartbeat phase against the server's 1 Hz
   * periodic. Returns the press instant, the crossing frame, and `t0`, the
   * epoch `ObservedFrame.at` counts from.
   */
  const pauseCrossedByScrub = async (
    seatGapS: number
  ): Promise<{
    scrubber: Peer
    pauser: Peer
    pressAt: number
    crossing: ObservedFrame
    t0: number
  }> => {
    const t0 = Date.now()
    room = await createTwoPeerRoom({
      position: ROOM_START,
      paused: false,
      server: { ignoreWindow: true }
    })
    const scrubber = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS
    })
    if (seatGapS > 0) await room.advance(seatGapS, 10)
    const pauser = await room.seat({
      username: 'joinuser',
      position: ROOM_START + seatGapS,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)
    expect(pauser.adopted() && scrubber.adopted(), 'setup: both peers adopted').toBe(true)

    // The phase lock: the pauser has just put a heartbeat on the wire, so its
    // next two are ~1 s and ~2 s away. The first lands inside the TTL of a
    // marker armed by the crossing, the second after the renderer's adopted
    // hold (ADOPTED_PENDING_PAUSE_MAX_MS) has run out.
    const beats = room.server.wireOf('joinuser').length
    while (room.server.wireOf('joinuser').length === beats) await room.advance(0.01, 10)

    scrubber.userSeek(scrubber.el.currentTime + 20)
    const seekFrame = (): { at: number } | undefined =>
      room.server.wireOf('hostuser').find((f) => f.doSeek === true)
    while (seekFrame() === undefined) await room.advance(0.01, 10)
    // The server applies the scrub one delay after it left and forces it to the
    // pauser; that frame lands a second delay later. Press inside it.
    while (Date.now() < seekFrame()!.at + DELAY_MS + 10) await room.advance(0.01, 10)
    pauser.userPause()
    const pressAt = Date.now()
    const isCrossing = (f: ObservedFrame): boolean => f.state.setBy === 'hostuser' && f.state.doSeek
    while (!pauser.frames.some(isCrossing)) await room.advance(0.01, 10)
    // The press lands one delay after it left, inside the pauser's window.
    await room.advance(0.1, 10)
    return { scrubber, pauser, pressAt, crossing: pauser.frames.find(isCrossing)!, t0 }
  }

  it('is the S11 `pauseCrossed` shape: the press crosses the forced seek, which is a resume, and the server drops it', async () => {
    const { crossing } = await pauseCrossedByScrub(0)
    expect(crossing.state.paused).toBe(false)
    expect(crossing.state.crossedOurChange).toBe(true)
    const ignored = room.server.ignored.filter((f) => f.username === 'joinuser')
    expect(ignored.filter((f) => f.paused === true)).toHaveLength(1)
    expect(room.server.roomState().paused).toBe(false)
  })

  for (const gap of SEAT_GAPS_S) {
    it(`re-asserts the dropped press on the first heartbeat after the crossing, and the room pauses on it, by the pauser, inside the hold (seat gap ${gap} s)`, async () => {
      const { scrubber, pauser, pressAt, t0 } = await pauseCrossedByScrub(gap)

      await room.advance(4)

      // The pauser's first playstate after its ack claims the pause, one
      // heartbeat after the crossing: inside what #513's TTL would have
      // withheld. Red before #547 at every phase, where it went out
      // position-only and the claim came a heartbeat later, and red at the
      // periodic-first phases if the skip covered only the crossing frame.
      const after = room.server.wireOf('joinuser').filter((w) => w.at > pressAt + 2 * DELAY_MS)
      expect(after[0].at - pressAt).toBeLessThan(HEARTBEAT_MS)
      expect(after[0].paused).toBe(true)
      // The server took it as a pause change and forced it, `setBy` the
      // pauser, to the scrubber, and before the pauser's own hold ran out: so no
      // resume the room sends in the meantime can get past the hold first. Red
      // before #547, where it reached the scrubber about 2 s after the press.
      const pauseFrame = scrubber.frames.find((f) => f.state.paused)
      expect(pauseFrame, 'the room never paused').toBeDefined()
      expect(pauseFrame!.state.setBy).toBe('joinuser')
      expect(pauseFrame!.at + t0 - pressAt).toBeLessThan(ADOPTED_PENDING_PAUSE_MAX_MS)
      // And the room ends paused, both elements with it, on the scrub's target.
      expect(room.server.roomState().paused).toBe(true)
      expect(pauser.el.paused).toBe(true)
      expect(scrubber.el.paused).toBe(true)
      expect(Math.abs(scrubber.el.currentTime - pauser.el.currentTime)).toBeLessThan(
        ECHO_SEEK_EPSILON_S
      )
    })
  }

  // The phases where the room's periodic reached the pauser before its first
  // heartbeat really do exist in this sweep, so the latch past the crossing
  // frame is under test and not just written down.
  it('reaches the periodic-first shape: a resume with no counter lands between the crossing and the first heartbeat', async () => {
    const reached: number[] = []
    for (const gap of SEAT_GAPS_S) {
      const { pauser, pressAt, t0 } = await pauseCrossedByScrub(gap)
      await room.advance(2)
      const beat = room.server.wireOf('joinuser').find((w) => w.at > pressAt + 2 * DELAY_MS)!.at
      const periodicFirst = pauser.frames.some(
        (f) =>
          f.at + t0 > pressAt &&
          f.at + t0 < beat &&
          f.state.paused === false &&
          f.state.setBy === 'hostuser' &&
          !f.state.doSeek
      )
      if (periodicFirst) reached.push(gap)
      room.dispose()
    }
    expect(reached).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
  })
})
