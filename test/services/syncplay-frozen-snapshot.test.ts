// #284's *residual*, made executable — the half the fix does not buy.
//
// The renderer gate (`use-syncplay-client.ts`, `hasAnnounceablePosition`) stops
// an element at HAVE_NOTHING putting `position: 0` on the wire during an
// in-player translation or quality switch. Its own guard is
// `test/renderer/composables/use-syncplay-client.test.ts`; a renderer change
// cannot turn *this* file red, and it is not written as if it could.
//
// What this file pins is what main then does with a snapshot that has **stopped
// updating**, which is the shape the gate creates and which no fixture in the
// repo had. Adoption is deliberately retained across the switch — the
// canonical name carries no translation component and `newPlayer` is false —
// so `buildPlaystate()` keeps taking its live branch and the heartbeat
// re-asserts the *frozen* pre-switch position once a second. The modelled
// server re-seats `w.position` on every store and only ages it forward from
// `lastUpdatedOn`, so a value re-sent at 1 Hz never ages: we win `min()` for as
// long as we keep asserting it.
//
// **This is also the A-only shape of #288**, and the reason its bound moved.
// The switch gets neither of that issue's two signals: no unmount, so no
// `syncplay:player-closed`, and no `newPlayer` (which is mount-scoped, so a
// re-push cannot carry it) — while `setFile()`'s `canonicalName` identity check
// cannot see the switch either. The tighter assert horizon is the only thing
// that caps it, which is exactly why #288 keeps A primary rather than resting
// on the event.
//
// Hence the corrected acceptance criteria, and the assertions below:
//
//   - no `position: 0` on the wire — the defect itself;
//   - the room never goes **below** our pre-switch position, so no peer is
//     seeked backwards past where we were when the switch began;
//   - the stall is bounded by `PLAYBACK_ASSERT_STALE_MS` (#288), after which the
//     snapshot is too old to assert, we fall through to the spectator mirror,
//     and the room stops being pinned on us. `PLAYBACK_STALE_MS` is still the
//     **de-adoption** horizon and still five seconds — the two thresholds are
//     deliberately separate, and the fourth case below is what pins that.
//
// "The room does not move" is *not* one of them, and a switch over ~3 s costs
// the room real time. That is the trade the fix makes: a bounded ~2 s stall in
// place of a yank to 0.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  write: (data: string) => void = vi.fn()
  destroy = vi.fn(() => {
    this.emit('close')
  })
}

const plainSockets: FakeSocket[] = []
const tlsSockets: FakeSocket[] = []

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    const s = new FakeSocket()
    plainSockets.push(s)
    return s
  })
}))

vi.mock('tls', () => ({
  connect: vi.fn(() => {
    const s = new FakeSocket()
    tlsSockets.push(s)
    return s
  })
}))

import { SyncplayClient, PLAYBACK_ASSERT_STALE_MS } from '../../src/main/syncplay'
import { MinElectionServer } from '../helpers/syncplay-min-election-server'

const ROOM_START = 600
const DELAY_MS = 50
const OPEN = 'Some Anime - 7'
/**
 * The **de-adoption** horizon. Not exported; mirrored here so both thresholds
 * are legible side by side, which is the point of the pair since #288:
 * `PLAYBACK_ASSERT_STALE_MS` (imported above) bounds what we may *assert*, this
 * one bounds when a resumed push counts as a different player.
 */
const PLAYBACK_STALE_MS = 5000

describe('SyncplayClient — an adopted client whose snapshot froze (#284)', () => {
  let server: MinElectionServer
  let clients: SyncplayClient[] = []
  let t0 = 0

  const seat = (username: string): SyncplayClient => {
    const client = new SyncplayClient()
    clients.push(client)
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room: 'cinema',
      username,
      autoReconnect: false
    })
    server.seat({
      username,
      delayMs: DELAY_MS,
      plain: plainSockets[plainSockets.length - 1],
      takeTls: () => tlsSockets[tlsSockets.length - 1]
    })
    return client
  }

  const announceFile = (client: SyncplayClient): void => {
    client.setFile({
      animeId: 1,
      malId: 2,
      episodeInt: '7',
      translationId: 3,
      canonicalName: OPEN,
      duration: 1440,
      newPlayer: true
    })
  }

  /** Where the room genuinely is by wall time, ignoring every election. */
  const trueRoomPosition = (): number => ROOM_START + (Date.now() - t0) / 1000

  /**
   * Run the session forward at the composable's 1 Hz snapshot cadence.
   * `snapshotOf` returns a client's element position, or `null` for a client
   * pushing nothing at all — which is precisely what the renderer gate does to
   * a client whose element is reloading.
   */
  const run = (
    seconds: number,
    snapshotOf: (client: SyncplayClient) => number | null,
    stepMs = 50
  ): void => {
    const steps = Math.round((seconds * 1000) / stepMs)
    let sinceSnapshot = 0
    for (let i = 0; i < steps; i++) {
      vi.advanceTimersByTime(stepMs)
      sinceSnapshot += stepMs
      if (sinceSnapshot >= 1000) {
        sinceSnapshot = 0
        for (const client of clients) {
          const snap = snapshotOf(client)
          if (snap === null) continue
          client.updateSnapshot({ position: snap, paused: false })
        }
      }
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    plainSockets.length = 0
    tlsSockets.length = 0
    clients = []
    t0 = Date.now()
    server = new MinElectionServer({ position: ROOM_START, paused: false })
  })

  afterEach(() => {
    server.stop()
    for (const client of clients) client.disconnect()
    vi.useRealTimers()
  })

  /**
   * Two clients, both with a player open on the episode and both adopted, run
   * to a push that lands on an exact second. `frozenAt` is the position the
   * switcher's last real snapshot claimed — the value main's heartbeat then
   * re-asserts for the whole switch — and `lastPushAt` is when it claimed it,
   * which is what `PLAYBACK_STALE_MS` is measured from.
   */
  const twoAdoptedWatchers = (): {
    switcher: SyncplayClient
    peer: SyncplayClient
    frozenAt: number
    lastPushAt: number
    sentBefore: number
  } => {
    const switcher = seat('switchuser')
    const peer = seat('peeruser')
    announceFile(switcher)
    announceFile(peer)
    run(4, () => trueRoomPosition())
    expect(switcher.getStatus().playbackAdopted).toBe(true)
    expect(peer.getStatus().playbackAdopted).toBe(true)
    return {
      switcher,
      peer,
      frozenAt: trueRoomPosition(),
      lastPushAt: Date.now(),
      sentBefore: server.wireOf('switchuser').length
    }
  }

  it('never announces 0 while its pushes are stopped, and holds its last real position', () => {
    const { switcher, frozenAt, lastPushAt, sentBefore } = twoAdoptedWatchers()

    // The switch: `resetMseState()` drops the `src`, the element reloads to
    // HAVE_NOTHING at 0, and the renderer gate sends nothing for the whole
    // awaited round trip. The peer plays on.
    run(4, (c) => (c === switcher ? null : trueRoomPosition()))

    const during = server.wireOf('switchuser').slice(sentBefore)
    // Anti-vacuity: the heartbeat is still talking — this is a *frozen* claim,
    // not silence.
    expect(during.length).toBeGreaterThanOrEqual(4)
    // The defect itself. Ungated, every one of these reads 0 and the room
    // follows it there.
    expect(during.some((f) => f.position === 0)).toBe(false)
    // Inside the assert window every frame is the pre-switch position, held,
    // and still making our pause claim.
    const asserted = during.filter((f) => f.at - lastPushAt <= PLAYBACK_ASSERT_STALE_MS)
    expect(asserted.length).toBeGreaterThanOrEqual(1)
    expect(asserted.every((f) => f.position === frozenAt && f.paused === false)).toBe(true)
    // And no frame at all — asserted or mirrored — is *below* it, so no peer
    // applying one is dragged behind where we were when the switch began.
    expect(during.every((f) => f.position >= frozenAt)).toBe(true)

    // The cost the corrected acceptance criteria name, asserted rather than
    // glossed: while we assert we win `min()`, so the room is stalled on us and
    // a peer past its own 3 s apply tolerance would be seeked *back* onto it.
    // "The room does not move" is not what this fix buys — but since #288 what
    // the room loses is bounded by the assert window rather than by
    // PLAYBACK_STALE_MS, so a 4 s switch no longer costs it four seconds.
    // Measured: 3.0 s on the old single-threshold code, 1.0 s here — which is
    // the ordinary one-push lag every honest client carries, i.e. by the end of
    // a 4 s switch the room has stopped paying for it at all.
    const lost = trueRoomPosition() - server.roomState().position
    expect(lost).toBeLessThan(PLAYBACK_ASSERT_STALE_MS / 1000)
  })

  it('bounds the frozen claim at PLAYBACK_ASSERT_STALE_MS and falls through to the mirror', () => {
    const { switcher, frozenAt, lastPushAt, sentBefore } = twoAdoptedWatchers()

    run(PLAYBACK_STALE_MS / 1000 + 5, (c) => (c === switcher ? null : trueRoomPosition()))
    const during = server.wireOf('switchuser').slice(sentBefore)

    const live = during.filter((f) => f.at - lastPushAt <= PLAYBACK_ASSERT_STALE_MS)
    const stale = during.filter((f) => f.at - lastPushAt > PLAYBACK_ASSERT_STALE_MS)
    expect(live.length).toBeGreaterThanOrEqual(1)
    expect(stale.length).toBeGreaterThanOrEqual(4)

    // Inside the window `buildPlaystate()` takes its live branch and re-asserts
    // the frozen snapshot, pause claim and all.
    expect(live.every((f) => f.position === frozenAt && f.paused === false)).toBe(true)

    // Past it the snapshot is too old to be evidence of anything (#288), so we
    // announce the spectator mirror instead: no `paused` key at all, and a
    // position that tracks the room forward again rather than standing still.
    // That is the bound — the stall cannot outlast PLAYBACK_ASSERT_STALE_MS
    // however long the switch runs, where it used to run to PLAYBACK_STALE_MS.
    expect(stale.every((f) => f.paused === undefined)).toBe(true)
    expect(stale.every((f) => f.position > frozenAt)).toBe(true)
    expect(stale[stale.length - 1].position).toBeGreaterThan(stale[0].position)

    // **De-adoption timing is unchanged, and this is the pin for it** — the two
    // thresholds are separate knobs and collapsing them is the obvious wrong
    // simplification. `playbackAdopted` is still latched here, well past
    // PLAYBACK_STALE_MS, because its only reset on this path is inside
    // `updateSnapshot()`, which a client that has stopped pushing never calls.
    // What changed at PLAYBACK_ASSERT_STALE_MS is the branch `buildPlaystate()`
    // takes, not the flag; what still happens at PLAYBACK_STALE_MS is the
    // *first resumed push* being read as a different player, which the fourth
    // case below owns.
    expect(Date.now() - lastPushAt).toBeGreaterThan(PLAYBACK_STALE_MS)
    expect(switcher.getStatus().playbackAdopted).toBe(true)
    // Nor does the room become the peer's outright: our mirror is a dead heat
    // with it and can still win the election, it just no longer drags it. That
    // residual is #279's, deliberately untouched here — and it is why #288 is
    // written as "ends the step, not the walk".
    expect(server.roomState().setBy).toBe('switchuser')
  })

  it('recovers the room on the first push after the load, with no 0 anywhere in between', () => {
    const { switcher } = twoAdoptedWatchers()

    // A switch comfortably inside the stale window — the ordinary case.
    run(3, (c) => (c === switcher ? null : trueRoomPosition()))
    expect(server.roomState().position).toBeLessThan(trueRoomPosition() - 1)

    // The restore writes `savedTime`, the element reaches HAVE_METADATA, and
    // the renderer gate opens again: pushes resume at the real position.
    run(3, () => trueRoomPosition())

    expect(switcher.getStatus().playbackAdopted).toBe(true)
    expect(server.wireOf('switchuser').some((f) => f.position === 0)).toBe(false)
    // The room is back on the true position — the stall was the switch's
    // length, and nothing outlives it.
    expect(Math.abs(server.roomState().position - trueRoomPosition())).toBeLessThanOrEqual(1)
  })

  // The shape the third case cannot reach (it switches for 3 s) and the second
  // deliberately stops short of: a switch that outlasts PLAYBACK_STALE_MS *and
  // then resumes*. The latch survives the silence only because nothing runs
  // while a client is silent; the first resumed push is what touches it. It
  // lands in `updateSnapshot()` with `hasLivePlayback()` already false, so
  // `syncplay.ts:770-776` clears `playbackAdopted` and nulls `seekIntent`
  // before seating the snapshot — deliberately, since a push after a stale gap
  // is a fresh element under a byte-identical canonicalName that `setFile()`'s
  // identity check cannot see. So recovery here is de-adopt → spectator mirror
  // → re-converge on the drift test, not "the latch was never touched"; and
  // crossing a de-adoption must not cost a `position: 0` on the way back, which
  // is the same defect #284 is about arriving by a different door.
  it('de-adopts on the first push past the stale window, then re-converges with no 0', () => {
    const { switcher } = twoAdoptedWatchers()

    run(PLAYBACK_STALE_MS / 1000 + 3, (c) => (c === switcher ? null : trueRoomPosition()))
    // The precondition, not the claim: still latched with the pushes stopped.
    expect(switcher.getStatus().playbackAdopted).toBe(true)

    const sentBeforeResume = server.wireOf('switchuser').length
    // The load completes and the element announces again, at the room's real
    // position. One push, asserted before the heartbeat can re-adopt us.
    switcher.updateSnapshot({ position: trueRoomPosition(), paused: false })
    expect(switcher.getStatus().playbackAdopted).toBe(false)

    // And then back: the drift test re-adopts us within a tick, because the
    // mirror kept us on the room while we were stale, so the resumed snapshot
    // is inside ADOPT_TOLERANCE_S of it.
    run(3, () => trueRoomPosition())
    expect(switcher.getStatus().playbackAdopted).toBe(true)

    // The far side of the de-adoption: every frame from the resumed push on
    // carries a real position. A de-adopted client falls to the mirror, which
    // sends the room's own position — never the element's, and never 0.
    const after = server.wireOf('switchuser').slice(sentBeforeResume)
    expect(after.length).toBeGreaterThanOrEqual(3)
    expect(after.some((f) => f.position === 0)).toBe(false)
    expect(Math.abs(server.roomState().position - trueRoomPosition())).toBeLessThanOrEqual(1)
  })

  // The main-side half of #324, on the same harness because it is the same
  // mechanism seen from the other end: a snapshot that has stopped matching the
  // element. #284's is frozen by a reload; this one is merely *late*, by the
  // one heartbeat the renderer used to take to announce an apply.
  //
  // What these two pin is not the renderer's push — that is
  // `test/renderer/composables/use-syncplay-client.test.ts` — but the payoff
  // for it: `canAssertSnapshot()` following the pushed value, in both
  // directions, before the heartbeat can assert the old one. Each case runs the
  // gap first and the push second, so the frames the fix removes are asserted
  // here rather than described.
  describe('a snapshot that lands before the heartbeat (#324)', () => {
    it('suppresses the playing assertion once a paused snapshot lands', () => {
      const { switcher, peer } = twoAdoptedWatchers()

      // The user pauses the room on peer A.
      const pausedAt = trueRoomPosition()
      peer.sendLocalState({ paused: true, position: pausedAt, cause: 'pause' })
      vi.advanceTimersByTime(DELAY_MS * 4)
      expect(server.roomState().paused).toBe(true)

      // pause-run2's gap: B has applied the pause and its element is stopped,
      // but nothing has told main — the echo consume returns above the discrete
      // send and a paused element fires no `timeupdate`. One heartbeat of that.
      const beforePush = server.wireOf('switchuser').length
      vi.advanceTimersByTime(1000)
      const stale = server.wireOf('switchuser').slice(beforePush)
      expect(stale.length).toBeGreaterThanOrEqual(1)
      // `=== false`, not `!== true`: an explicit key, so this is the assertion
      // arm and not the keyless spectator mirror — which is what makes it a
      // claim the server acts on rather than a position it merely elects. A
      // peer that performed no UI action has just told the room it is playing.
      expect(stale.every((f) => f.paused === false)).toBe(true)

      // The push. `updateSnapshot()` stamps unconditionally, so the flip is
      // immediate and the next heartbeat carries the room's own intent.
      switcher.updateSnapshot({ position: pausedAt, paused: true })
      const afterPush = server.wireOf('switchuser').length
      vi.advanceTimersByTime(1000)
      const announced = server.wireOf('switchuser').slice(afterPush)
      expect(announced.length).toBeGreaterThanOrEqual(1)
      expect(announced.every((f) => f.paused === true)).toBe(true)
    })

    // The mirror, and the more important of the two: the paused arm of
    // `canAssertSnapshot()` is `if (this.snapshot.paused) return true`, with no
    // staleness compare at all. The playing direction at least has
    // PLAYBACK_ASSERT_STALE_MS as a 2 s backstop; this one has nothing short of
    // `hasLivePlayback()`, so the push is the only thing that bounds it.
    it('suppresses the paused assertion once a playing snapshot lands', () => {
      const { switcher, peer } = twoAdoptedWatchers()

      // Both ends into the paused room the resume starts from.
      const pausedAt = trueRoomPosition()
      peer.sendLocalState({ paused: true, position: pausedAt, cause: 'pause' })
      switcher.updateSnapshot({ position: pausedAt, paused: true })
      vi.advanceTimersByTime(DELAY_MS * 4)
      expect(server.roomState().paused).toBe(true)

      // The user presses Play on peer A.
      peer.sendLocalState({ paused: false, position: pausedAt, cause: 'play' })
      const resumedAt = Date.now()
      vi.advanceTimersByTime(DELAY_MS * 4)
      expect(server.roomState().paused).toBe(false)

      // resume-run5's gap, measured at 152 ms: B has applied the resume and its
      // element is playing, and main still holds `paused: true`.
      const beforePush = server.wireOf('switchuser').length
      vi.advanceTimersByTime(1000)
      const stale = server.wireOf('switchuser').slice(beforePush)
      expect(stale.length).toBeGreaterThanOrEqual(1)
      // Again an explicit key on the assertion arm: this is the frame that in
      // run5 pushed peer A back to paused 3 ms after its own Play click landed.
      //
      // The *room* flag is deliberately not asserted here or in the case above.
      // Both clients heartbeat at 1 Hz and disagree, so `roomPaused` is simply
      // whichever frame the modelled server saw last — a scheduling artefact of
      // the fixture, not the behaviour under test. What each client asserts is
      // the behaviour, and it is what the fix changes.
      expect(stale.every((f) => f.paused === true)).toBe(true)

      // Nor does waiting it out help. Past PLAYBACK_ASSERT_STALE_MS the playing
      // direction would have fallen through to the keyless mirror; this one
      // keeps making the claim, because the paused arm never compares the
      // clock. (Under PLAYBACK_STALE_MS throughout, so `hasLivePlayback()` is
      // not what is being tested here.)
      const beforeWait = server.wireOf('switchuser').length
      vi.advanceTimersByTime(PLAYBACK_ASSERT_STALE_MS)
      expect(Date.now() - resumedAt).toBeGreaterThan(PLAYBACK_ASSERT_STALE_MS)
      const waited = server.wireOf('switchuser').slice(beforeWait)
      expect(waited.length).toBeGreaterThanOrEqual(1)
      expect(waited.every((f) => f.paused === true)).toBe(true)

      // The push ends it, and nothing else in the system would have.
      switcher.updateSnapshot({ position: pausedAt, paused: false })
      const afterPush = server.wireOf('switchuser').length
      vi.advanceTimersByTime(1000)
      const announced = server.wireOf('switchuser').slice(afterPush)
      expect(announced.length).toBeGreaterThanOrEqual(1)
      expect(announced.every((f) => f.paused === false)).toBe(true)
    })
  })
})
