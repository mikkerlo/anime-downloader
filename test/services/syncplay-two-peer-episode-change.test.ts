// @vitest-environment happy-dom
//
// Both peers across an episode change (#360, #486).
//
// **Until #486 every case here was a characterisation pin of behaviour believed
// wrong.** One peer pressed next and the other pressed nothing; the room carries
// no file identity, so the old episode's number reached the new episode through
// the switcher's own heartbeat (a stale snapshot re-latched adoption under the
// new file), a parked frame applied at `loadedmetadata`, and the live 1 Hz
// frames. The switcher's element was written to the previous episode's 303 at
// every bind gap, and whether the innocent peer was dragged backwards too
// depended on a 2 s staircase in the room's own `min()` election — a comb over
// the bind gap that alternated with the switch's phase, flapped the room at 1 Hz
// one 50 ms slice off the broadcast, and had no upper end out to a 30.5 s gap.
// The measurements, the comb and the mechanism are in #360 and in this file's
// history; none of them describes the tree any more, so none of them is repeated
// here.
//
// What closed it: on a **local** episode change (`episodeSwitch: 'local'`)
// `setFile()` drops the outgoing snapshot and sends one forced seek to 0, built
// explicitly rather than through `buildPlaystate()`'s snapshot or mirror branch;
// the server's `forcePositionUpdate` overwrites every watcher's stored position,
// so nothing old is left to win the vote. The renderer holds snapshot pushes
// from the outgoing element until the new source has metadata. A **follow**
// drops the snapshot and sends nothing — the presser already did.
//
// So every case below is now a guard, not a pin, and the seatings are the ones
// the old file measured: the bind gaps 500 through 30500 at φ = 0, the off-phase
// cells (φ = 50 was the 1 Hz flap), and suspensions between the index commit and
// the rebind, which is the window the renderer hold exists for. The innocent
// peer being seeked to 0 on its own, unswitched episode is #486's stated product
// decision and is asserted, not tolerated.
//
// "Old" is anything at or above `STALE_FLOOR`. The room sits at ~300 when the
// switch lands and every new-episode position read here is under 45 s, so the
// two populations cannot overlap.
//
// This file asserts against the model server. Every room here plays except the
// paused-room cases (the one below and the #496 block), whose assertion is the
// room staying paused at 0, read off the wire.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { Peer, TwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { WireFrame } from '../helpers/syncplay-min-election-server'
import { EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { shouldSwallowLocalNext, walkEpisodeSteps } from '../../src/renderer/src/utils'
import type { EpisodeStepOutcome } from '../../src/renderer/src/utils'

const DELAY_MS = 50
const STALE_FLOOR = 50
/** The renderer's apply tolerance (`diff > 3.0`). Inside it nothing re-seeks. */
const APPLY_TOLERANCE_S = 3.0

const seeksOf = (frames: WireFrame[]): WireFrame[] => frames.filter((f) => f.doSeek === true)

describe('SyncplayClient — both peers across an episode change (#360, #486)', () => {
  let room: TwoPeerRoom | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })

  /**
   * Seat the switcher and the other peer at 300 with the room, let them agree
   * for four seconds, then `switchOffsetMs` more. `bindGapMs` lands on the
   * switcher only; a second peer that switches too takes the harness default.
   */
  const seatPair = async (
    opts: { bindGapMs?: number; switchOffsetMs?: number; paused?: boolean } = {}
  ): Promise<{ switcher: Peer; other: Peer; wireBefore: number }> => {
    const paused = opts.paused ?? false
    room = await createTwoPeerRoom({ position: 300, paused })
    const switcher = await room.seat({
      username: 'hostuser',
      position: 300,
      paused,
      delayMs: DELAY_MS,
      bindGapMs: opts.bindGapMs ?? 500
    })
    const other = await room.seat({
      username: 'joinuser',
      position: 300,
      paused,
      delayMs: DELAY_MS
    })
    await room.advance(4 + (opts.switchOffsetMs ?? 0) / 1000)
    // Every write list below is the switch's whole footprint, not a window of it.
    expect(switcher.el.seekWrites).toEqual([])
    expect(other.el.seekWrites).toEqual([])
    return { switcher, other, wireBefore: room.server.wireOf('hostuser').length }
  }

  /** Nothing either element was ever written to is an old-episode position. */
  const expectNoStaleWrite = (...peers: Peer[]): void => {
    for (const p of peers) {
      expect(
        p.el.seekWrites.filter((w) => w >= STALE_FLOOR),
        `${p.username} written to an old-episode position`
      ).toEqual([])
    }
  }

  /** Both elements inside the apply tolerance of the room, and the room on the new episode. */
  const expectConverged = (...peers: Peer[]): void => {
    const roomAt = room!.server.roomState().position
    expect(roomAt).toBeLessThan(STALE_FLOOR)
    for (const p of peers) {
      expect(Math.abs(p.el.currentTime - roomAt), `${p.username} vs room`).toBeLessThanOrEqual(
        APPLY_TOLERANCE_S
      )
    }
  }

  // [bindGapMs, switchOffsetMs, suspendMs]
  const SEATINGS: Array<[number, number, number]> = [
    [500, 0, 0],
    [3000, 0, 0],
    [5000, 0, 0],
    [5001, 0, 0],
    [6500, 0, 0],
    [7500, 0, 0],
    [8500, 0, 0],
    [29500, 0, 0],
    [30500, 0, 0],
    [500, 50, 0],
    [500, 250, 0],
    [500, 500, 0],
    [500, 750, 0],
    [6500, 500, 0],
    [7500, 500, 0],
    [500, 0, 500],
    [500, 0, 1000],
    [500, 0, 1500],
    [500, 0, 2000],
    [500, 0, 3000]
  ]

  it.each(SEATINGS)(
    'lands both peers at the new episode’s start and keeps them there — bind gap %i ms, φ = %i ms, suspend %i ms',
    async (bindGapMs, switchOffsetMs, suspendMs) => {
      const { switcher, other, wireBefore } = await seatPair({ bindGapMs, switchOffsetMs })
      const server = room!.server

      await switcher.goToEpisode('8', undefined, suspendMs)
      const window = Math.max(20, Math.ceil((bindGapMs + suspendMs) / 1000) + 10)
      await room!.advance(window - suspendMs / 1000)

      // Exactly one forced seek from the switcher, and it is to 0 in a playing
      // room. Read off the wire, so a seek routed through the mirror (the old
      // episode's ~303, `doSeek` dropped) cannot pass for it.
      const seeks = seeksOf(server.wireOf('hostuser').slice(wireBefore))
      expect(seeks).toHaveLength(1)
      expect(seeks[0].position).toBe(0)
      expect(seeks[0].paused).toBe(false)

      // The innocent peer takes that seek: written to the new episode's start
      // first, whatever comes after.
      expect(other.el.seekWrites.length).toBeGreaterThanOrEqual(1)
      expect(other.el.seekWrites[0]).toBeLessThan(1)

      expectNoStaleWrite(switcher, other)
      expect(server.roomState().paused).toBe(false)
      expectConverged(switcher, other)

      // And it holds: ten more seconds move nobody and walk the room by ten.
      const writes = [switcher.el.seekWrites.length, other.el.seekWrites.length]
      const roomAt = server.roomState().position
      await room!.advance(10)
      expect([switcher.el.seekWrites.length, other.el.seekWrites.length]).toEqual(writes)
      expect(server.roomState().position - roomAt).toBeCloseTo(10, 1)
      expectConverged(switcher, other)
    }
  )

  it('never hands the MKV spawn seed an old-episode room position', async () => {
    // Door (c): `getRoomPosition()` is what `prepareMkvForPlayback` reads to
    // seed ffmpeg's `-ss`. Sampled on every slice from the switch through the
    // bind release, across a suspension so the read window is a real one.
    const { switcher } = await seatPair()
    const reads: Array<number | null> = []
    const sample = async (seconds: number): Promise<void> => {
      for (let i = 0; i < seconds * 20; i += 1) {
        await room!.advance(0.05)
        reads.push(switcher.client.getRoomPosition('Some Anime - 8'))
      }
    }

    await switcher.goToEpisode('8', undefined, 2000)
    await sample(3)

    expect(reads.length).toBe(60)
    expect(reads.filter((r) => r !== null && r >= STALE_FLOOR)).toEqual([])
  })

  it('keeps the room owning the playhead after a local switch, so saved progress does not resume', async () => {
    // (h), a stated decision rather than a side effect: the room's 0 frame makes
    // `hasRemoteStateApplied()` true, which is what `roomOwnsPlayhead()` reads
    // and what declines `resumeFromSavedPosition` in a room.
    const { switcher } = await seatPair()

    await switcher.goToEpisode('8')
    await room!.advance(2)

    expect(switcher.ui.hasRemoteStateApplied()).toBe(true)
    expect(switcher.el.seekWrites).toHaveLength(1)
    expect(switcher.el.seekWrites[0]).toBeLessThan(1)
  })

  it('a duration re-push after the switch sends no second seek', async () => {
    const { switcher, wireBefore } = await seatPair()

    await switcher.goToEpisode('8')
    await room!.advance(2)
    // `onDurationChange` re-announces the same file once the new element knows
    // its length.
    switcher.ui.pushSyncplayFile()
    await room!.advance(5)

    expect(seeksOf(room!.server.wireOf('hostuser').slice(wireBefore))).toHaveLength(1)
  })

  it.each([200, 1000, 2000, 3000])(
    'a follower %i ms behind the presser sends no seek, and both land on the new episode',
    async (followMs) => {
      const { switcher, other, wireBefore } = await seatPair()
      const otherWireBefore = room!.server.wireOf('joinuser').length

      await switcher.goToEpisode('8')
      await room!.advance(followMs / 1000)
      await other.goToEpisode('8', undefined, 0, 'follow')
      await room!.advance(15)

      expect(seeksOf(room!.server.wireOf('hostuser').slice(wireBefore))).toHaveLength(1)
      expect(seeksOf(room!.server.wireOf('joinuser').slice(otherWireBefore))).toEqual([])
      expectNoStaleWrite(switcher, other)
      expect(room!.server.roomState().paused).toBe(false)
      expectConverged(switcher, other)
    }
  )

  it.each([0, 50, 300, 1000])(
    'both pressing %i ms apart send one seek each, and both land on the new episode',
    async (gapMs) => {
      const { switcher, other, wireBefore } = await seatPair()
      const otherWireBefore = room!.server.wireOf('joinuser').length

      await switcher.goToEpisode('8')
      if (gapMs > 0) await room!.advance(gapMs / 1000)
      await other.goToEpisode('8')
      await room!.advance(15)

      expect(seeksOf(room!.server.wireOf('hostuser').slice(wireBefore))).toHaveLength(1)
      expect(seeksOf(room!.server.wireOf('joinuser').slice(otherWireBefore))).toHaveLength(1)
      expectNoStaleWrite(switcher, other)
      expect(room!.server.roomState().paused).toBe(false)
      expectConverged(switcher, other)
    }
  )

  it('keeps a paused room paused, at 0', async () => {
    const { switcher, other, wireBefore } = await seatPair({ paused: true })

    await switcher.goToEpisode('8')
    await room!.advance(10)

    const seeks = seeksOf(room!.server.wireOf('hostuser').slice(wireBefore))
    expect(seeks).toHaveLength(1)
    expect(seeks[0].position).toBe(0)
    expect(seeks[0].paused).toBe(true)
    expect(room!.server.roomState().paused).toBe(true)
    expect(room!.server.roomState().position).toBe(0)
    expect(switcher.el.paused).toBe(true)
    expect(other.el.paused).toBe(true)
    expect(switcher.el.currentTime).toBe(0)
    expect(other.el.currentTime).toBe(0)
    expectNoStaleWrite(switcher, other)
  })

  it('chains three nexts with a follower, one seek per press and none per follow', async () => {
    const { switcher, other, wireBefore } = await seatPair()
    const otherWireBefore = room!.server.wireOf('joinuser').length

    for (const ep of ['8', '9', '10']) {
      await switcher.goToEpisode(ep)
      await room!.advance(1)
      await other.goToEpisode(ep, undefined, 0, 'follow')
      await room!.advance(1)
    }
    await room!.advance(10)

    expect(seeksOf(room!.server.wireOf('hostuser').slice(wireBefore))).toHaveLength(3)
    expect(seeksOf(room!.server.wireOf('joinuser').slice(otherWireBefore))).toEqual([])
    expectNoStaleWrite(switcher, other)
    expect(room!.server.roomState().paused).toBe(false)
    expectConverged(switcher, other)
  })
})

// ── #496: a paused room that changes episode stays paused at 0 ───────────────
//
// `keeps a paused room paused, at 0` above is the ordering that always held:
// nothing plays the new element, so a paused frame is always there to park. The
// app does play it. `PlayerView.goToEpisode` registers an `episode-start` and
// calls `v.play()` right after the source swap, and that echo's consume wrote
// "playing" unconditionally. A buffered element (canplay) then stayed playing,
// and a playing element's `timeupdate` pushed a snapshot as soon as metadata
// released the switch hold. When that push reached main ahead of the room's
// next paused frame, the room resumed. Nobody pressed Play. On the real server
// that happened in 2 of 9 E5 runs and 2 of 24 probe runs.
//
// `live()` below models the two media events the harness otherwise lacks:
// `canplay` once an element has metadata, and `timeupdate` while it plays. The
// switch suspends long enough for the presser's seek echo to land before the
// swap, so nothing is left to park on the new element. That is run 7 in #496.

describe('SyncplayClient — a paused room that changes episode stays paused (#496)', () => {
  let room: TwoPeerRoom | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })

  /** `room.advance`, plus `canplay` at metadata and `timeupdate` while playing. */
  const live = async (seconds: number): Promise<void> => {
    for (let i = 0; i < Math.round(seconds * 20); i += 1) {
      await room!.advance(0.05)
      for (const p of peers) {
        if (p.el.readyState === 1) {
          p.el.readyState = 4
          p.ui.onLocalCanPlay()
        }
        if (!p.el.paused && p.el.readyState >= 1) p.ui.onVideoTimeUpdate()
      }
    }
  }
  let peers: Peer[] = []

  const seatLive = async (
    paused: boolean,
    offsetMs: number
  ): Promise<{ switcher: Peer; other: Peer }> => {
    room = await createTwoPeerRoom({ position: 300, paused })
    const switcher = await room.seat({
      username: 'hostuser',
      position: 300,
      paused,
      delayMs: DELAY_MS,
      bindGapMs: 50
    })
    const other = await room.seat({
      username: 'joinuser',
      position: 300,
      paused,
      delayMs: DELAY_MS,
      bindGapMs: 50
    })
    peers = [switcher, other]
    await live(4 + offsetMs / 1000)
    return { switcher, other }
  }

  /** `PlayerView.goToEpisode`: swap the source, then the registered `episode-start` play. */
  const startEpisode = async (
    p: Peer,
    ep: string,
    origin: 'local' | 'follow',
    suspendMs: number
  ): Promise<void> => {
    await p.goToEpisode(ep, undefined, suspendMs, origin)
    p.ui.beginProgrammaticPlayback('play', 'episode-start')
    void p.el.play()
  }

  const resumesOnWire = (from: number[]): WireFrame[] =>
    peers.flatMap((p, i) =>
      room!.server
        .wireOf(p.username)
        .slice(from[i])
        .filter((f) => f.paused === false)
    )

  // [who reaches metadata first, episode, phase of the switch against the 1 Hz frames, suspend]
  const CASES: Array<['presser' | 'follower', string, number, number]> = [
    ['presser', '8', 0, 300],
    ['presser', '6', 0, 300],
    ['follower', '8', 250, 600],
    ['follower', '6', 250, 600]
  ]

  it.each(CASES)(
    'stays paused at 0 when the %s’s new element plays before a paused frame lands (episode %s)',
    async (who, ep, offsetMs, suspendMs) => {
      const { switcher, other } = await seatLive(true, offsetMs)
      const wireBefore = peers.map((p) => room!.server.wireOf(p.username).length)

      await startEpisode(switcher, ep, 'local', who === 'presser' ? suspendMs : 0)
      await live(0.2)
      await startEpisode(other, ep, 'follow', who === 'follower' ? suspendMs : 0)
      await live(10)

      // The property that broke: not one playstate after the switch claimed
      // playing. An end-state check alone would pass a resume-then-repause.
      expect(resumesOnWire(wireBefore)).toEqual([])
      expect(room!.server.roomState().paused).toBe(true)
      expect(switcher.el.paused).toBe(true)
      expect(other.el.paused).toBe(true)
      // "At 0" to one harness slice: `HarnessVideo` walks a playing element
      // even at HAVE_NOTHING, so the 50 ms between the `episode-start` play and
      // the gate's pause shows up as 0.05. A real element there does not move.
      for (const at of [
        room!.server.roomState().position,
        switcher.el.currentTime,
        other.el.currentTime
      ]) {
        expect(at).toBeLessThanOrEqual(0.05)
      }
    }
  )

  it('a playing room still resumes the binge through the same switch', async () => {
    const { switcher, other } = await seatLive(false, 0)

    await startEpisode(switcher, '8', 'local', 300)
    await live(0.2)
    await startEpisode(other, '8', 'follow', 0)
    await live(10)

    expect(room!.server.roomState().paused).toBe(false)
    expect(switcher.el.paused).toBe(false)
    expect(other.el.paused).toBe(false)
    expectConvergedOn(room!.server.roomState().position, switcher, other)
  })

  it('a switch inside the pending-pause hold resumes: keyed on roomPaused, not the mirror', async () => {
    // The user pauses a playing room and presses next before the room reports
    // paused. The room still plays at the consume, so the documented hold
    // clause lets the switch resume; the mirror already reads paused from the
    // user's own prediction, which is why the fix cannot key on it.
    const { switcher, other } = await seatLive(false, 0)

    switcher.userPause()
    await live(0.05)
    expect(switcher.status().roomPaused).toBe(false)
    await startEpisode(switcher, '8', 'local', 0)
    await live(0.05)
    // Consumed as playing: the gate left the new element running.
    expect(switcher.status().roomPaused).toBe(false)
    expect(switcher.el.paused).toBe(false)
    await startEpisode(other, '8', 'follow', 0)
    await live(10)

    expect(room!.server.roomState().paused).toBe(false)
    expect(switcher.el.paused).toBe(false)
    expect(other.el.paused).toBe(false)
  })

  it('a peer pressing Play before the consume resumes the room on the new episode', async () => {
    const { switcher, other } = await seatLive(true, 0)
    const broadcastsBefore = switcher.broadcasts.length

    // The play lands while the switcher is still inside the stream resolve,
    // before its swap and so before its `episode-start` consume.
    const switching = startEpisode(switcher, '8', 'local', 600)
    other.userPlay()
    await switching
    expect(switcher.status().roomPaused).toBe(false)
    await live(0.2)
    await startEpisode(other, '8', 'follow', 0)
    await live(10)

    expect(room!.server.roomState().paused).toBe(false)
    expect(switcher.el.paused).toBe(false)
    expect(other.el.paused).toBe(false)

    // The IPC ordering the consume depends on. Main emits the `roomPaused`
    // projection before it forwards the inbound state, so by the time the
    // renderer has seen the playing frame `roomPaused` is already false and a
    // consume between the two can never overwrite the fresher playing mirror
    // with `false`. In Electron those are two IPC messages and a `play` event
    // can run between them; the harness delivers them synchronously, so the
    // order is asserted here directly.
    const after = switcher.broadcasts.slice(broadcastsBefore)
    const statusAt = after.findIndex(
      (b) =>
        b.channel === EVENT_CHANNELS.SYNCPLAY_CONNECTION_STATUS &&
        (b.payload as SyncplayStatus).roomPaused === false
    )
    const playingAt = after.findIndex(
      (b) =>
        b.channel === EVENT_CHANNELS.SYNCPLAY_REMOTE_STATE &&
        (b.payload as SyncplayRemoteState).paused === false
    )
    expect(statusAt).toBeGreaterThanOrEqual(0)
    expect(playingAt).toBeGreaterThan(statusAt)
  })

  it('a peer pressing Play after the consume resumes the room on the new episode', async () => {
    const { switcher, other } = await seatLive(true, 0)

    await startEpisode(switcher, '8', 'local', 300)
    await live(0.2)
    // Consumed paused: the element was paused by the gate and the room is paused.
    expect(switcher.el.paused).toBe(true)
    expect(switcher.status().roomPaused).toBe(true)
    await startEpisode(other, '8', 'follow', 0)
    await live(2)

    other.userPlay()
    await live(10)

    expect(room!.server.roomState().paused).toBe(false)
    expect(switcher.el.paused).toBe(false)
    expect(other.el.paused).toBe(false)
    expectConvergedOn(room!.server.roomState().position, switcher, other)
  })
})

/** Both elements inside the apply tolerance of `roomAt`, on the new episode. */
function expectConvergedOn(roomAt: number, ...peers: Peer[]): void {
  expect(roomAt).toBeLessThan(STALE_FLOOR)
  for (const p of peers) {
    expect(Math.abs(p.el.currentTime - roomAt), `${p.username} vs room`).toBeLessThanOrEqual(
      APPLY_TOLERANCE_S
    )
  }
}

// ── #487: both peers press next within about a second ─────────────────────────
//
// A presses next at t = 0; B presses next at t = d. B's room follow commits N+1
// at one hop, and `navigating` is released at the source swap, a stream resolve
// later, while N+1's metadata is still loading and B's user is still looking at
// N. Before #487 a press in that window stepped from the committed N+1 to N+2,
// and A followed: both peers skipped an episode. Measured at 6 of 14 "both
// press" transitions in the real-server run behind #486.
//
// The main client, the composable, the server model, `walkEpisodeSteps` and
// `shouldSwallowLocalNext` are all real. The navigator on top is a model of
// `PlayerView`'s `goToEpisode` / `handleRemoteEpisodeChange` / `onUserNext`,
// because `PlayerView` has no mount harness; the source scans in
// `test/renderer/components/player-lifecycle-scope.test.ts` pin the component to
// the shape modelled here (who arms the token, the four owner-keyed clears, the
// one reader). The model is the probe from the `syncplay-investigation-artifacts`
// branch with the token added, and with `goToEpisode`'s pre-commit
// `unreachable` resolution arm, the return that bumps the epoch and writes
// nothing (#492 review).

const EPISODES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
/** `playerGetStreamUrl`, commit to source swap — where `navigating` is released. */
const RESOLVE_MS = 400
/** Source swap to `loadedmetadata` — where the token is cleared. */
const METADATA_MS = 1500

/** How the next step's source ends: loads, resolves to null, or never loads. */
type SourceOutcome = 'loads' | 'null-stream' | 'stalls'
type Press = 'dispatched' | 'button-disabled' | 'swallowed'

interface Navigator {
  episode(): string
  pending(): number | null
  /** `onUserNext` — the button and the keyboard. */
  pressNext(): Press
  pressPrev(): void
  /** `selectTranslation`: bumps `translationEpoch`, leaves the token alone. */
  pickTranslation(): void
  /** Outcome of the next step this peer commits; reset to `loads` after use. */
  nextSource: SourceOutcome
  /**
   * An index whose `resolveEpisodeTranslation` comes back `unreachable`: a step
   * to it bumps the epoch and returns before its commit, writing nothing.
   */
  unreachableIndex: number | null
}

function attachNavigator(peer: Peer, startIdx: number): Navigator {
  let idx = startIdx
  let navigating = false
  let navigationEpoch = 0
  let translationEpoch = 0
  // Stamped with the arming run's `myNav`, and cleared only by that run.
  let pendingFollow: { index: number; nav: number } | null = null

  // `goToEpisode(direction, origin)`.
  async function step(
    direction: 'prev' | 'next',
    origin: SyncplayEpisodeSwitch
  ): Promise<EpisodeStepOutcome> {
    const targetIndex = direction === 'prev' ? idx - 1 : idx + 1
    if (targetIndex < 0 || targetIndex >= EPISODES.length) return 'unreachable'
    if (navigating) return 'superseded'
    await Promise.resolve() // saveProgress(true)
    navigating = true
    const myNav = ++navigationEpoch
    await Promise.resolve() // resolveEpisodeTranslation
    if (navigationEpoch !== myNav) return 'superseded'
    // The pre-commit `unreachable` arm: the epoch is already bumped, nothing is
    // written, and no token is touched — an earlier step's token stays for
    // that step's own metadata to clear.
    if (targetIndex === nav.unreachableIndex) {
      if (navigationEpoch === myNav) navigating = false
      return 'unreachable'
    }
    await Promise.resolve() // playerCleanupRemux
    if (navigationEpoch !== myNav) return 'superseded'
    idx = targetIndex
    pendingFollow =
      origin === 'follow' && direction === 'next' ? { index: targetIndex, nav: myNav } : null
    const source = nav.nextSource
    nav.nextSource = 'loads'
    // The commit is what the composable's watcher announces as `Set file`.
    await peer.goToEpisode(EPISODES[targetIndex], undefined, 0, origin)
    await new Promise((r) => setTimeout(r, RESOLVE_MS))
    if (navigationEpoch !== myNav) return 'moved'
    if (source === 'null-stream') {
      if (navigationEpoch === myNav) navigating = false
      if (pendingFollow?.nav === myNav) pendingFollow = null
      return 'moved'
    }
    await Promise.resolve() // nextTick
    if (navigationEpoch !== myNav) return 'moved'
    if (source === 'loads') {
      setTimeout(() => {
        if (pendingFollow?.nav === myNav) pendingFollow = null
      }, METADATA_MS)
    }
    navigating = false
    return 'moved'
  }

  // `handleRemoteEpisodeChange`: absolute index, then a relative walk.
  const handleRemote = (episodeInt: string): void => {
    const target = EPISODES.indexOf(episodeInt)
    if (target < 0 || target === idx) return
    const dir = target > idx ? 'next' : 'prev'
    const walkTranslation = translationEpoch
    void walkEpisodeSteps(
      () => idx !== target && !navigating && translationEpoch === walkTranslation,
      () => step(dir, 'follow')
    )
  }
  // `remoteEpisodes` records rather than acts (see the harness); act on each.
  const arr = peer.remoteEpisodes as unknown as { push: (...x: unknown[]) => number }
  const origPush = Array.prototype.push
  arr.push = function (...eps: unknown[]) {
    const n = origPush.apply(this, eps)
    for (const e of eps as { episodeInt: string }[]) handleRemote(e.episodeInt)
    return n
  }

  const nav: Navigator = {
    episode: () => EPISODES[idx],
    pending: () => pendingFollow?.index ?? null,
    pressNext: () => {
      // `if (!canNext.value || navigating.value) return;`
      if (idx >= EPISODES.length - 1 || navigating) return 'button-disabled'
      if (shouldSwallowLocalNext(pendingFollow?.index ?? null, idx)) {
        pendingFollow = null
        return 'swallowed'
      }
      void step('next', 'local')
      return 'dispatched'
    },
    pressPrev: () => {
      if (idx > 0 && !navigating) void step('prev', 'local')
    },
    pickTranslation: () => {
      translationEpoch++
    },
    nextSource: 'loads',
    unreachableIndex: null
  }
  return nav
}

describe('both peers press next within about a second (#487)', () => {
  let room: TwoPeerRoom | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })

  /** Both seated on episode 6 (index 5), agreed for four seconds. */
  const seatBoth = async (): Promise<{ a: Navigator; b: Navigator }> => {
    const { A, B } = await seatPeers()
    return { a: attachNavigator(A, 5), b: attachNavigator(B, 5) }
  }

  /**
   * As `seatBoth`, but A stays a bare peer: a case that moves A's file directly
   * (a pick from the episode list) has no navigator on A to walk back after B's
   * follow announces its own steps.
   */
  const seatFollower = async (): Promise<{ A: Peer; b: Navigator }> => {
    const { A, B } = await seatPeers()
    return { A, b: attachNavigator(B, 5) }
  }

  const seatPeers = async (): Promise<{ A: Peer; B: Peer }> => {
    room = await createTwoPeerRoom({ position: 100, paused: false })
    const A = await room.seat({
      username: 'rigA',
      position: 100,
      paused: false,
      delayMs: DELAY_MS,
      episodeInt: '6'
    })
    const B = await room.seat({
      username: 'rigB',
      position: 100,
      paused: false,
      delayMs: DELAY_MS,
      episodeInt: '6'
    })
    await room.advance(4)
    return { A, B }
  }

  /** A presses at 0, B at `d`; read both once everything has settled. */
  const bothPress = async (d: number): Promise<{ a: string; b: string; bPress: Press }> => {
    const { a, b } = await seatBoth()
    expect(a.pressNext()).toBe('dispatched')
    if (d > 0) await room!.advance(d / 1000)
    const bPress = b.pressNext()
    await room!.advance(6)
    return { a: a.episode(), b: b.episode(), bPress }
  }

  // The three bands, plus the press after N+1 has loaded. B receives A's change
  // one hop in (~50 ms), its follow releases `navigating` a resolve later
  // (~455 ms) and N+1's metadata lands `METADATA_MS` after that (~1955 ms).
  it.each([
    [0, 'dispatched', '7'], // before A's change arrives: both target 7
    [200, 'button-disabled', '7'], // follow in flight: the button is disabled
    [500, 'swallowed', '7'], // after the swap, before metadata: the old double advance
    [1000, 'swallowed', '7'],
    [1500, 'swallowed', '7'],
    [1900, 'swallowed', '7'],
    [2500, 'dispatched', '8'] // after 7 has loaded: a deliberate press still goes to 8
  ] as const)('B pressing at d = %i ms is %s, and both end on episode %s', async (d, press, ep) => {
    const r = await bothPress(d)
    expect(r.bPress).toBe(press)
    expect([r.a, r.b]).toEqual([ep, ep])
  })

  it('consumes the token on the swallow, so a second press before metadata goes through', async () => {
    const { a, b } = await seatBoth()
    a.pressNext()
    await room!.advance(0.6)
    expect(b.pending()).toBe(6)
    expect(b.pressNext()).toBe('swallowed')
    expect(b.pending()).toBeNull()
    expect(b.pressNext()).toBe('dispatched')
    await room!.advance(6)
    expect([a.episode(), b.episode()]).toEqual(['8', '8'])
  })

  it('clears the token on a null-stream follow, so the next press moves to N+2', async () => {
    const { a, b } = await seatBoth()
    b.nextSource = 'null-stream'
    a.pressNext()
    await room!.advance(0.6)
    // The follow committed 7 and failed its source: no metadata is coming.
    expect(b.episode()).toBe('7')
    expect(b.pending()).toBeNull()
    expect(b.pressNext()).toBe('dispatched')
    await room!.advance(6)
    expect([a.episode(), b.episode()]).toEqual(['8', '8'])
  })

  it('keeps solo chained Next working with a stalled source — a local step arms nothing', async () => {
    const { a, b } = await seatBoth()
    a.nextSource = 'stalls'
    expect(a.pressNext()).toBe('dispatched')
    await room!.advance(0.6)
    expect(a.pending()).toBeNull()
    expect(a.pressNext()).toBe('dispatched')
    await room!.advance(6)
    // Two presses, two steps, and B follows each.
    expect([a.episode(), b.episode()]).toEqual(['8', '8'])
  })

  it('keeps the token across a translation pick, so the next press is swallowed once', async () => {
    const { a, b } = await seatBoth()
    a.pressNext()
    await room!.advance(0.5)
    b.pickTranslation()
    await room!.advance(0.1)
    expect(b.pending()).toBe(6)
    expect(b.pressNext()).toBe('swallowed')
    await room!.advance(6)
    expect([a.episode(), b.episode()]).toEqual(['7', '7'])
  })

  it('arms nothing on a remote Prev, so a Next after it is an ordinary step', async () => {
    const { a, b } = await seatBoth()
    a.pressPrev()
    await room!.advance(0.6)
    expect(b.episode()).toBe('5')
    expect(b.pending()).toBeNull()
    expect(b.pressNext()).toBe('dispatched')
    await room!.advance(6)
    expect([a.episode(), b.episode()]).toEqual(['6', '6'])
  })

  it('advances exactly once when only one peer presses, and clears the token on metadata', async () => {
    const { a, b } = await seatBoth()
    a.pressNext()
    await room!.advance(0.6)
    expect(b.pending()).toBe(6)
    await room!.advance(6)
    expect([a.episode(), b.episode()]).toEqual(['7', '7'])
    expect(b.pending()).toBeNull()
  })

  // The two pre-commit paths from #492's review. A run that bumps
  // `navigationEpoch` and returns before its commit writes no token, so the
  // token still set is the previous step's, and only that step's metadata is
  // coming to clear it. Keyed to the epoch, that clear was disarmed by the bump:
  // the token outlived the source load, and the first Next pressed afterwards,
  // whenever it came, was swallowed for a switch that had ended long ago.
  it('clears step 1’s token on its metadata when a room walk N → N+2 dies at step 2’s resolution', async () => {
    const { A, b } = await seatFollower()
    b.unreachableIndex = 7 // episode 8: the off-page fetch fails
    await A.goToEpisode('8')
    await room!.advance(0.6)
    // Step 1 committed 7 and swapped its source; step 2 ran straight after it,
    // bumped the epoch and returned `unreachable` before its commit.
    expect(b.episode()).toBe('7')
    expect(b.pending()).toBe(6)
    await room!.advance(6)
    // Episode 7 has loaded: the token cannot outlive that.
    expect(b.pending()).toBeNull()
    b.unreachableIndex = null
    expect(b.pressNext()).toBe('dispatched')
    await room!.advance(6)
    expect(b.episode()).toBe('8')
  })

  it('clears the follow’s token on its metadata when a local Prev in the load window fails to resolve', async () => {
    const { a, b } = await seatBoth()
    a.pressNext()
    await room!.advance(0.6)
    // B's follow committed 7 and swapped its source; 7 is still loading.
    expect(b.pending()).toBe(6)
    b.unreachableIndex = 5 // episode 6
    b.pressPrev()
    await room!.advance(6)
    expect(b.episode()).toBe('7')
    expect(b.pending()).toBeNull()
    b.unreachableIndex = null
    expect(b.pressNext()).toBe('dispatched')
    await room!.advance(6)
    expect([a.episode(), b.episode()]).toEqual(['8', '8'])
  })

  // The other half of the owner rule: when step 2 DOES commit it re-stamps the
  // token with its own run, so step 1's metadata, landing while step 2's source
  // is still loading, leaves it alone.
  it('keeps step 2’s token through step 1’s metadata on a room walk N → N+2', async () => {
    const { A, b } = await seatFollower()
    await A.goToEpisode('8')
    // Step 1's metadata lands ~1955 ms in, step 2's ~2355 ms.
    await room!.advance(2.1)
    expect(b.episode()).toBe('8')
    expect(b.pending()).toBe(7)
    expect(b.pressNext()).toBe('swallowed')
    await room!.advance(6)
    expect(b.episode()).toBe('8')
  })
})
