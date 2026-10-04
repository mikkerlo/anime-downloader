// @vitest-environment happy-dom
//
// The post-agreement re-election, in both roles (#368, #488).
//
// This file used to be a test that a bug **survives**. The scrubber was the
// peer with the unbuffered element: its big forward seek was a bare
// `currentTime` write, the element reported the target (645) for the whole
// flight, and its 1 Hz snapshot carried that target with `doSeek: false`. On
// that periodic `Room.getPosition()`'s `min()` over watchers
// (`server.py:597-604`) elected the *buffered* peer, genuinely down at ~106, and
// the losing frame came back and dragged the scrubber off its own target —
// measured as `t=7050 host <- 105.99 setBy=joinuser doSeek=false el=645`, a
// 539 s backwards jump. Its `seekIntent` was never armed at all: the yank
// replaced the in-flight write before it came due, an interrupted seek fires no
// `seeked` of its own, and the surviving `seeked` was the apply's, consumed in
// `onVideoSeeked`. The user's 645 was never announced. The yank reproduced at
// landing times of 6000 / 12000 / 20000 ms and was absent at 300…3000 — but
// only because the file swept **one role**, the room's `setBy` (host), whose
// own frames main drops at the foreign-`setBy` guard. The other role is
// handed a foreign frame about once a second and was exposed at every landing
// time; #488 measured it and `syncplay-two-peer-seek-revert.test.ts` sweeps it
// by tick phase.
//
// #488 removed the cause rather than the symptom. A user seek is announced at
// intent (`seekAsUser`: register a `value` operation, write, then announce), so:
//
//  - the room is told 645 by a `doSeek` frame the moment the user lets go, the
//    intent is armed at once, and main's ignore counter covers the flight;
//  - the buffered peer follows to 645 one round trip later, so there is no
//    peer left genuinely down at ~106 to win `min()`;
//  - and while the scrubber's seek is still in flight the apply holds any
//    heartbeat-shaped `diff > 3.0` correction (the belt), so a frame that
//    still names an old position cannot abort it.
//
// So both roles are swept here, at the old landing grid, and the claim is the
// inverse of what this file used to pin: the scrubber is never yanked.
//
// What is **not** claimed: that nothing moves the *buffered* peer. At landing
// times of 3 s and longer the scrubber's element still reports its in-flight
// 645 while the room plays on, so it is the minimum and the server re-elects
// it; the buffered peer is pulled back by up to the landing time — seconds, not
// minutes — and that is the in-flight-target mechanism
// `syncplay-two-peer-inflight-seek.test.ts` owns. It is bounded below by the
// target, which is asserted here.
//
// Driven by the two-peer harness (`test/helpers/syncplay-two-peer.ts`, #361
// step 3): both peers run the real composable over the real preload bridge and
// the real IPC router, so the apply rule under test is the shipped one and not
// a copy of it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { TwoPeerRoom, Peer } from '../helpers/syncplay-two-peer'

const ROOM_START = 100
const SEEK_TO = 645
const DELAY_MS = 50
/** The landing grid this file swept before #488, with 6000 / 12000 / 20000 the
 *  values at which the host-role yank reproduced. */
const LANDINGS_MS = [300, 600, 1200, 2000, 3000, 6000, 12000, 20000]
/** Long enough for the slowest landing to complete, with the room still
 *  running for a few seconds afterwards. */
const RUN_AFTER_S = 25
/** The renderer's seek-operation TTL (`APPLIED_SEEK_TTL_MS`), which is also
 *  how long the apply's belt can hold a correction for one user seek. */
const USER_SEEK_TTL_MS = 15000

type Role = 'hostuser' | 'joinuser'

describe('SyncplayClient — a scrubber seek survives the post-agreement re-election', () => {
  let room: TwoPeerRoom | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    room = null
    vi.useRealTimers()
  })

  const seat = async (scrubber: Role, landMs: number): Promise<[Peer, Peer]> => {
    room = await createTwoPeerRoom({ position: ROOM_START, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: scrubber === 'hostuser' ? landMs : 0
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: ROOM_START,
      paused: false,
      delayMs: DELAY_MS,
      seekLandMs: scrubber === 'joinuser' ? landMs : 0
    })
    return scrubber === 'hostuser' ? [host, joiner] : [joiner, host]
  }

  for (const scrubber of ['hostuser', 'joinuser'] as const) {
    for (const landMs of LANDINGS_MS) {
      it(`${scrubber} scrubbing with a ${landMs} ms landing is never yanked`, async () => {
        const [me, other] = await seat(scrubber, landMs)
        await room!.advance(4)
        expect(me.status().playbackAdopted).toBe(true)
        expect(other.status().playbackAdopted).toBe(true)
        // The role is the room's election, not a label: the host is `setBy`
        // at the drag, so the joiner is the peer handed foreign frames.
        const joiner = scrubber === 'joinuser' ? me : other
        expect(joiner.frames.at(-1)?.state.setBy).toBe('hostuser')

        const myWritesBefore = me.el.seekWrites.length
        const otherWritesBefore = other.el.seekWrites.length
        const wireBefore = room!.server.wireOf(scrubber).length
        me.userSeek(SEEK_TO)
        const intentAtDrag = me.seekIntent()

        await room!.advance(RUN_AFTER_S)

        // 1. Never yanked: the drag is the only write the scrubber's element
        //    ever takes — no apply put an old position back over it.
        expect(me.el.seekWrites.slice(myWritesBefore)).toEqual([SEEK_TO])
        expect(me.el.currentTime).toBeGreaterThan(SEEK_TO)
        // Announced at intent: the intent was armed in the drag's own call,
        // where before #488 it was never armed at all on an unbuffered
        // scrubber. Asserted after the yank check so that a regression reports
        // the yank, which is the symptom, rather than this.
        expect(intentAtDrag).not.toBeNull()

        // 2. Announced once. Past the TTL the belt has let go and main's own
        //    re-assert may spend one attempt; inside it, exactly one.
        const doSeekOut = room!.server
          .wireOf(scrubber)
          .slice(wireBefore)
          .filter((f) => f.doSeek === true).length
        if (landMs < USER_SEEK_TTL_MS) expect(doSeekOut).toBe(1)
        else expect(doSeekOut).toBeGreaterThanOrEqual(1)

        // 3. The other peer followed the drag — its first write is the
        //    `doSeek`, one round trip after the user let go — and nothing ever
        //    took it back below the target.
        const otherWrites = other.el.seekWrites.slice(otherWritesBefore)
        expect(otherWrites[0]).toBeCloseTo(SEEK_TO + 2 * (DELAY_MS / 1000), 2)
        expect(otherWrites.every((w) => w >= SEEK_TO && w < SEEK_TO + 5)).toBe(true)
        expect(other.el.currentTime).toBeGreaterThan(SEEK_TO)
        expect(room!.server.roomState().position).toBeGreaterThan(SEEK_TO)
      })
    }
  }
})
