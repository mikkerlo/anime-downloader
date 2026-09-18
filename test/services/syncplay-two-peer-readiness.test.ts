// @vitest-environment happy-dom
//
// The readiness gate across two peers (#361 step 4).
//
// Readiness is the one Syncplay mechanism in this stack that has **no wire
// playstate at all**. A peer that starts buffering does not pause the room; it
// sends `Set: {ready: {isReady: false}}`, the server folds that into the roster,
// and every *other* peer's renderer pauses its own element off a roster change.
// So the whole mechanism is a claim about a second peer by construction, and
// before this file none of it was covered here: `setReady`,
// `setSyncplayLocalReady` and `allUsersReady` appeared in no two-peer fixture.
// (The "go ready" in `syncplay-two-peer-loop.test.ts` is the *connection* state,
// `status().state === 'ready'`, which is an unrelated word.)
//
// The chain each case runs end to end, and every hop of it is real here:
//
//   ui.setSyncplayLocalReady(false)   the renderer's own gate, locally
//     → syncplaySetReady IPC          the preload bridge and the real router
//     → SyncplayClient.setReady()     main, which sends Set: {ready}
//     → MinElectionServer.applySet    the roster changes, a fresh List goes out
//     → the far peer's handleList     main there emits room-users
//     → its Pinia store               roomUsers replaced
//     → watch(syncplayRoomUsers)      applySyncplayReadyGate() on the far peer
//     → that peer's element pauses
//
// The far peer reaches the gate through the roster watcher and through nothing
// else — it makes no call of its own and receives no playstate that would move
// it. That is what separates these cases from `use-syncplay-client`'s own
// readiness unit cases, which hand one composable a roster and read the
// reaction: here the roster is a *result*, produced by the other peer's press
// travelling the length of the stack.
//
// Two properties are asserted on every frame of both cases rather than at the
// end, because they are what makes readiness different from a pause:
//
//  - **no pause claim.** The gate moves the element through
//    `beginProgrammaticPlayback('pause')`, and the snapshot announces
//    `intentOr(v)` — the user's intent — rather than `v.paused`. So every frame
//    both peers put on the wire carries `paused: false` right through the stall,
//    and the room's own flag never moves. A regression that let the gate's pause
//    read as intent would pause the room for everyone, including peers that were
//    not buffering.
//  - **nothing discrete.** `clientIgnoreCounter` stays 0 on both peers, so
//    neither one announced a change or armed an ignore window for one.
//
// What this file does **not** claim is the direction of the position drag. The
// stalled peers' snapshots freeze, `Room.getPosition()`'s `min()` then elects one
// of them, and the room falls behind free-running playback — which is the
// intended shape (the room waits for the buffering peer rather than leaving it),
// but the exact deficit is `MinElectionServer`'s election arithmetic, and
// `syncplay-two-peer-adoption.test.ts` is where that model is pinned. The second
// case reads the deficit as an inequality against free-running playback, not as
// a number.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { Peer, TwoPeerRoom } from '../helpers/syncplay-two-peer'

const DELAY_MS = 50
/** Where the room, and both elements, start. */
const START = 300

/** What this peer's renderer believes about everyone's readiness — read off its
 *  own store, so the two peers' rosters are two independent observations rather
 *  than one shared object seen twice. */
const readiness = (peer: Peer): string[] =>
  peer.ui.syncplayRoomUsers.value.map((u) => `${u.username}:${u.isReady}`)

describe('SyncplayClient — the readiness gate across two peers', () => {
  let room: TwoPeerRoom

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    vi.useRealTimers()
  })

  /** Both peers seated on the room and playing, as every case here starts.
   *  Seated together for the reason `syncplay-two-peer-adoption.test.ts`
   *  records: a peer alone in the room hears no `remote-state` at all, because
   *  the room's `setBy` is itself. */
  const playingRoom = async (): Promise<{ host: Peer; joiner: Peer }> => {
    room = await createTwoPeerRoom({ position: START, paused: false })
    const host = await room.seat({
      username: 'hostuser',
      position: START,
      paused: false,
      delayMs: DELAY_MS
    })
    const joiner = await room.seat({
      username: 'joinuser',
      position: START,
      paused: false,
      delayMs: DELAY_MS
    })
    await room.advance(4)
    return { host, joiner }
  }

  it('pauses the far peer when one peer stops being ready, and tells the room nothing', async () => {
    const { host, joiner } = await playingRoom()

    // The premise. Both elements are running and the room agrees, so the pause
    // below is a change rather than a state that was already true — without
    // this every assertion after it would hold of a room that never started.
    expect(host.el.paused).toBe(false)
    expect(joiner.el.paused).toBe(false)
    expect(room.server.roomState().paused).toBe(false)
    expect(readiness(host)).toEqual(['hostuser:true', 'joinuser:true'])

    joiner.ui.setSyncplayLocalReady(false)
    await room.advance(3)

    // The far peer heard about it, in its own renderer's roster. This is the
    // whole `Set: {ready}` → `List` → `handleList` → `room-users` leg, and it is
    // the only thing that reaches the host at all.
    expect(readiness(host)).toEqual(['hostuser:true', 'joinuser:false'])
    expect(readiness(joiner)).toEqual(['hostuser:true', 'joinuser:false'])

    // The claim. The host never touched its own readiness and received no
    // playstate that would move it, and its element is stopped — held by a
    // roster row belonging to somebody else.
    expect(host.ui.shouldElementPlay()).toBe(false)
    expect(host.el.paused).toBe(true)
    // And the peer that pressed it, through its own local gate rather than
    // through the roster.
    expect(joiner.el.paused).toBe(true)

    // Stopped, not moved: readiness holds the playhead where it is, and neither
    // element was written at any point in the run.
    expect(host.el.seekWrites).toEqual([])
    expect(joiner.el.seekWrites).toEqual([])
    expect(host.el.currentTime).toBe(302.95)
    expect(joiner.el.currentTime).toBe(302.95)

    // The room was never told. Its flag is untouched and it is still running —
    // a peer buffering is not a peer pausing.
    expect(room.server.roomState().paused).toBe(false)

    // Counted on both sides of the discriminator so neither filter can pass by
    // being empty: every frame either peer put on the wire, across the stall,
    // claims `paused: false`. The gate's pause went through
    // `beginProgrammaticPlayback`, so the snapshot announces the user's intent
    // and not the element's state.
    const hostWire = room.server.wireOf('hostuser')
    const joinerWire = room.server.wireOf('joinuser')
    expect(hostWire).toHaveLength(6)
    expect(joinerWire).toHaveLength(6)
    expect(hostWire.filter((f) => f.paused === false)).toHaveLength(6)
    expect(joinerWire.filter((f) => f.paused === false)).toHaveLength(6)
    expect([...hostWire, ...joinerWire].filter((f) => f.paused !== false)).toHaveLength(0)

    // Readiness is not a discrete change, so neither peer announced one or armed
    // an ignore window for one.
    expect(host.counters().clientIgnoreCounter).toBe(0)
    expect(joiner.counters().clientIgnoreCounter).toBe(0)
  })

  it('releases both elements when readiness comes back, and the room waited rather than running on', async () => {
    const { host, joiner } = await playingRoom()
    // Read before the stall, not after: the room is already ~2 s behind wall
    // time here, because the election is anchored to snapshots a link delay old.
    // Measuring the deficit from this point keeps the claim about readiness
    // instead of about that pre-existing lag.
    const beforeStall = room.server.roomState().position

    joiner.ui.setSyncplayLocalReady(false)
    await room.advance(3)
    // The stall really happened — otherwise the release below is a no-op and
    // everything after it is vacuously true of a room that never stopped.
    expect(host.el.paused).toBe(true)
    expect(joiner.el.paused).toBe(true)
    const stalledAt = room.server.roomState().position

    joiner.ui.setSyncplayLocalReady(true)
    await room.advance(3)

    // Both rosters back, and the gate reopened on both peers — the far one again
    // without a call of its own.
    expect(readiness(host)).toEqual(['hostuser:true', 'joinuser:true'])
    expect(readiness(joiner)).toEqual(['hostuser:true', 'joinuser:true'])
    expect(host.ui.shouldElementPlay()).toBe(true)
    expect(joiner.ui.shouldElementPlay()).toBe(true)
    expect(host.el.paused).toBe(false)
    expect(joiner.el.paused).toBe(false)

    // They resumed from where they stopped, on the same frame as each other, and
    // neither was seeked to get there — the gate only ever presses play.
    expect(host.el.currentTime).toBe(joiner.el.currentTime)
    expect(host.el.currentTime).toBe(305.95)
    expect(host.el.seekWrites).toEqual([])
    expect(joiner.el.seekWrites).toEqual([])

    // Which is the point of the mechanism, read as a deficit rather than as a
    // position: six seconds of wall time pass across the stall and the release,
    // and the room advances through three of them. It waited out the stall with
    // the peer that called it instead of leaving that peer behind — and it did so
    // without its pause flag ever moving.
    //
    // The bound is on the deficit for a reason. Against an absolute position most
    // of the margin would come from the election lag read at `beforeStall` rather
    // than from the stall: a room that ignored readiness lands 6 s on from there,
    // which clears an absolute bound by under a second but misses this one by two.
    const roomNow = room.server.roomState().position
    expect(roomNow).toBeGreaterThan(stalledAt)
    expect(roomNow - beforeStall).toBeLessThan(4)
    expect(room.server.roomState().paused).toBe(false)

    // Still no pause claim anywhere, and still nothing discrete, across the
    // whole stall-and-release.
    const wire = [...room.server.wireOf('hostuser'), ...room.server.wireOf('joinuser')]
    expect(wire).toHaveLength(18)
    expect(wire.filter((f) => f.paused === false)).toHaveLength(18)
    expect(host.counters().clientIgnoreCounter).toBe(0)
    expect(joiner.counters().clientIgnoreCounter).toBe(0)
  })
})
