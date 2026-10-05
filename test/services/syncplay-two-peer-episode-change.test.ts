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
// paused-room case, whose assertion is the room staying paused at 0, read off
// this client's own wire.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { Peer, TwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { WireFrame } from '../helpers/syncplay-min-election-server'
import {
  shouldSwallowLocalNext,
  walkEpisodeSteps,
  FOLLOW_GRACE_MS
} from '../../src/renderer/src/utils'
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
/** Source swap to `loadedmetadata` — the resume, no longer the token (#500). */
const METADATA_MS = 1500
/** Source swap to `loadeddata`, the first frame — where the grace starts (#500). */
const LOADEDDATA_MS = 1600

/** How the next step's source ends: loads, resolves to null, or never loads. */
type SourceOutcome = 'loads' | 'null-stream' | 'stalls'
type Press = 'dispatched' | 'button-disabled' | 'swallowed'

interface Navigator {
  episode(): string
  /** `handleRemoteEpisodeChange`'s `moved to episode` toasts, in order. */
  toasts: string[]
  /** A pick from the episode list: straight to `episodeInt`, one commit. */
  pick(episodeInt: string): Promise<void>
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
  /** Commit to source swap for this peer's steps; `RESOLVE_MS` by default. */
  resolveMs: number
}

function attachNavigator(peer: Peer, startIdx: number): Navigator {
  let idx = startIdx
  let navigating = false
  let navigationEpoch = 0
  let translationEpoch = 0
  // Stamped with the arming run's `myNav`, and cleared only by that run.
  let pendingFollow: { index: number; nav: number } | null = null
  // `followGraceTimer`: one handle, cancelled at every commit and failure arm.
  let grace: ReturnType<typeof setTimeout> | null = null
  const cancelGrace = (): void => {
    if (grace) clearTimeout(grace)
    grace = null
  }

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
    cancelGrace()
    pendingFollow =
      origin === 'follow' && direction === 'next' ? { index: targetIndex, nav: myNav } : null
    const source = nav.nextSource
    nav.nextSource = 'loads'
    // The commit is what the composable's watcher announces as `Set file`.
    await peer.goToEpisode(EPISODES[targetIndex], undefined, 0, origin)
    await new Promise((r) => setTimeout(r, nav.resolveMs))
    if (navigationEpoch !== myNav) return 'moved'
    if (source === 'null-stream') {
      if (navigationEpoch === myNav) navigating = false
      if (pendingFollow?.nav === myNav) pendingFollow = null
      cancelGrace()
      return 'moved'
    }
    await Promise.resolve() // nextTick
    if (navigationEpoch !== myNav) return 'moved'
    // `onTargetMetadata` at `METADATA_MS` is the resume and leaves the token
    // alone; `onTargetFirstFrame` at `LOADEDDATA_MS` starts the grace (#500).
    if (source === 'loads') {
      setTimeout(() => {
        if (pendingFollow?.nav !== myNav) return
        cancelGrace()
        grace = setTimeout(() => {
          grace = null
          if (pendingFollow?.nav === myNav) pendingFollow = null
        }, FOLLOW_GRACE_MS)
      }, LOADEDDATA_MS)
    }
    navigating = false
    return 'moved'
  }

  // `handleRemoteEpisodeChange`: absolute index, then a relative walk, held
  // between the composable's real `beginFollowWalk` / `settleFollowWalk` (#501).
  const handleRemote = (ep: SyncplayRemoteEpisode): void => {
    const target = EPISODES.indexOf(ep.episodeInt)
    if (target < 0 || target === idx) return
    nav.toasts.push(`${ep.fromUser} moved to episode ${ep.episodeInt}`)
    const dir = target > idx ? 'next' : 'prev'
    const walkTranslation = translationEpoch
    peer.ui.beginFollowWalk()
    void walkEpisodeSteps(
      () => idx !== target && !navigating && translationEpoch === walkTranslation,
      () => step(dir, 'follow')
    ).finally(() => peer.ui.settleFollowWalk())
  }
  // `remoteEpisodes` records rather than acts (see the harness); act on each.
  const arr = peer.remoteEpisodes as unknown as { push: (...x: unknown[]) => number }
  const origPush = Array.prototype.push
  arr.push = function (...eps: unknown[]) {
    const n = origPush.apply(this, eps)
    for (const e of eps as SyncplayRemoteEpisode[]) handleRemote(e)
    return n
  }

  const nav: Navigator = {
    episode: () => EPISODES[idx],
    toasts: [],
    pick: async (episodeInt: string) => {
      idx = EPISODES.indexOf(episodeInt)
      await peer.goToEpisode(episodeInt, undefined, 0, 'local')
    },
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
    unreachableIndex: null,
    resolveMs: RESOLVE_MS
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

  const seatPeers = async (paused = false): Promise<{ A: Peer; B: Peer }> => {
    room = await createTwoPeerRoom({ position: 100, paused })
    const A = await room.seat({
      username: 'rigA',
      position: 100,
      paused,
      delayMs: DELAY_MS,
      episodeInt: '6'
    })
    const B = await room.seat({
      username: 'rigB',
      position: 100,
      paused,
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

  // The three bands, plus the press after N+1 is on screen. B receives A's
  // change one hop in (~50 ms), its follow releases `navigating` a resolve
  // later (~455 ms), N+1's metadata lands `METADATA_MS` after that (~1955 ms),
  // its first frame `LOADEDDATA_MS` after it (~2055 ms), and the token clears
  // `FOLLOW_GRACE_MS` later still (~2655 ms).
  it.each([
    [0, 'dispatched', '7'], // before A's change arrives: both target 7
    [200, 'button-disabled', '7'], // follow in flight: the button is disabled
    [500, 'swallowed', '7'], // after the swap, before metadata: the old double advance
    [1000, 'swallowed', '7'],
    [1500, 'swallowed', '7'],
    [1900, 'swallowed', '7'],
    [2000, 'swallowed', '7'], // after metadata, before the first frame: 8 until #500
    [2500, 'swallowed', '7'], // inside the grace: a reflex press, 8 until #500
    [3000, 'dispatched', '8'] // past it: a deliberate press still goes to 8
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

  it('advances exactly once when only one peer presses, and clears the token after the first frame', async () => {
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
  it('keeps step 2’s token through step 1’s first frame on a room walk N → N+2', async () => {
    const { A, b } = await seatFollower()
    await A.goToEpisode('8')
    // Step 1's first frame lands ~2055 ms in, with step 2's token already
    // armed, so it starts no timer; step 2's lands ~2455 ms.
    await room!.advance(2.1)
    expect(b.episode()).toBe('8')
    expect(b.pending()).toBe(7)
    expect(b.pressNext()).toBe('swallowed')
    await room!.advance(6)
    expect(b.episode()).toBe('8')
  })

  // #500 review, the lifecycle half: a grace timer started for step 1's token
  // must not clear the token a later follow step armed while it ran. Guarded
  // twice — the commit cancels the timer, and the timer compares on its owner
  // — so this goes red only with both removed; the single-guard mutations are
  // pinned on the component's own statements in `player-lifecycle-scope.test.ts`.
  it('keeps a second follow’s token through the first follow’s grace timer', async () => {
    const { a, b } = await seatBoth()
    a.pressNext()
    // B's 7 shows its first frame ~2055 ms in; its grace runs until ~2655 ms.
    await room!.advance(2.2)
    expect(b.pending()).toBe(6)
    a.pressNext()
    // B's follow to 8 commits ~50 ms later and re-stamps the token; 8 itself
    // has no frame until ~4300 ms.
    await room!.advance(0.6)
    expect([a.episode(), b.episode()]).toEqual(['8', '8'])
    expect(b.pending()).toBe(7)
    expect(b.pressNext()).toBe('swallowed')
    await room!.advance(6)
    expect([a.episode(), b.episode()]).toEqual(['8', '8'])
  })

  // #496's paused room: the followed episode may never play, and `loadeddata`
  // fires playing or paused, so the same clear covers it with no second path.
  it('clears the token in a paused room, so the next real Next goes through', async () => {
    const { A, B } = await seatPeers(true)
    const a = attachNavigator(A, 5)
    const b = attachNavigator(B, 5)
    expect(room!.server.roomState().paused).toBe(true)
    a.pressNext()
    await room!.advance(2.1)
    // First frame shown (~2055 ms), grace still running.
    expect(b.episode()).toBe('7')
    expect(b.pending()).toBe(6)
    await room!.advance(FOLLOW_GRACE_MS / 1000)
    expect(b.pending()).toBeNull()
    expect(b.pressNext()).toBe('dispatched')
    await room!.advance(6)
    expect([a.episode(), b.episode()]).toEqual(['8', '8'])
  })
})

// ── #501: a follow walk announces only where it ends up ───────────────────────
//
// The leader picks N+k from the list. The follower reaches it through k
// one-step follows, and every step's commit fires the composable's
// episode-change watcher. Pushed, the intermediate episode is a new
// `user|anime|episode` key on the leader, and the leader's own
// `handleRemoteEpisodeChange` walks it back toward it: measured 6/6 on the real
// server with the `await` fix alone. The walk now holds every file push until
// it settles, then announces the reached index once.
//
// Both peers carry a navigator here, unlike `seatFollower`, because the
// subject is what the follower's pushes do to the leader. The hold is the real
// composable's; the navigator only calls `beginFollowWalk` / `settleFollowWalk`
// where `PlayerView` does, which the source scans in
// `test/renderer/components/player-lifecycle-scope.test.ts` pin.

describe('a follow walk announces only where it ends up (#501)', () => {
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

  interface Seated {
    A: Peer
    B: Peer
    a: Navigator
    b: Navigator
    /** B's `setFile` pushes from the moment of seating, as [episode, switch, ms]. */
    bPushes: [string, SyncplayEpisodeSwitch | undefined, number][]
    /** B's snapshot pushes, by `Date.now()`. */
    bSnapshots: number[]
    /** B's `loadedmetadata` deliveries, by `Date.now()`. */
    bMetadata: number[]
    /** The episodes A's main handed A's renderer from B since seating. */
    fromB: () => string[]
  }

  /** Both on episode 6 (index 5), agreed for four seconds. */
  const seat = async (bindGapMs?: number): Promise<Seated> => {
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
      episodeInt: '6',
      ...(bindGapMs !== undefined ? { bindGapMs } : {})
    })
    await room.advance(4)
    const bPushes: Seated['bPushes'] = []
    const bSnapshots: number[] = []
    const bMetadata: number[] = []
    const setFile = B.api.syncplaySetFile.bind(B.api)
    vi.spyOn(B.api, 'syncplaySetFile').mockImplementation((f: SyncplayFilePayload) => {
      bPushes.push([f.episodeInt, f.episodeSwitch, Date.now()])
      return setFile(f)
    })
    const snapshot = B.api.syncplaySendLocalSnapshot.bind(B.api)
    vi.spyOn(B.api, 'syncplaySendLocalSnapshot').mockImplementation((s) => {
      bSnapshots.push(Date.now())
      return snapshot(s)
    })
    const metadata = B.ui.onVideoLoadedMetadata.bind(B.ui)
    vi.spyOn(B.ui, 'onVideoLoadedMetadata').mockImplementation(() => {
      bMetadata.push(Date.now())
      metadata()
    })
    // B's seating announced episode 6 to A; only what follows the pick counts.
    const heardBefore = A.remoteEpisodes.length
    const fromB = (): string[] =>
      A.remoteEpisodes
        .slice(heardBefore)
        .filter((e) => e.fromUser === 'rigB')
        .map((e) => e.episodeInt)
    return {
      A,
      B,
      a: attachNavigator(A, 5),
      b: attachNavigator(B, 5),
      bPushes,
      bSnapshots,
      bMetadata,
      fromB
    }
  }

  /** Run `seconds` in slices, sampling the leader's episode after each, and
   *  the room's position into `positions` when given. */
  const sampleLeader = async (
    a: Navigator,
    seconds: number,
    positions?: number[]
  ): Promise<string[]> => {
    const seen: string[] = []
    for (let t = 0; t < seconds * 1000; t += 50) {
      await room!.advance(0.05)
      seen.push(a.episode())
      positions?.push(room!.server.roomState().position)
    }
    return seen
  }

  it.each([
    [1, '7'],
    [2, '8'],
    [3, '9']
  ] as const)(
    'a +%i pick: the leader stays on %s and hears exactly one file from the follower',
    async (_k, target) => {
      const { a, b, bPushes, fromB } = await seat()
      await a.pick(target)
      const positions: number[] = []
      const leader = await sampleLeader(a, 8, positions)

      // Main keeps B's episode-6 file and snapshot until the settle; neither
      // may put episode 6's ~100 s back into the room the pick took to 0.
      expect(Math.max(...positions)).toBeLessThan(STALE_FLOOR)
      expect(b.episode()).toBe(target)
      expect(new Set(leader)).toEqual(new Set([target]))
      expect(a.toasts).toEqual([])
      expect(bPushes.map(([ep, sw]) => [ep, sw])).toEqual([[target, 'follow']])
      expect(fromB()).toEqual([target])
    }
  )

  it('an intermediate source’s durationchange re-push is held', async () => {
    const { B, a, b, bPushes, fromB } = await seat()
    await a.pick('8')
    // Step 1 has committed episode 7 and its source is resolving.
    while (b.episode() !== '7') await room!.advance(0.05)
    // `onDurationChange` → `pushSyncplayFile()`, on the intermediate source.
    B.ui.pushSyncplayFile()
    expect(bPushes).toEqual([])
    const leader = await sampleLeader(a, 8)

    expect(new Set(leader)).toEqual(new Set(['8']))
    expect(bPushes.map(([ep, sw]) => [ep, sw])).toEqual([['8', 'follow']])
    expect(fromB()).toEqual(['8'])
  })

  // (b1): the follower can't fetch N+2's page. It announces N+1, where it really
  // is, once, and the leader is pulled back once. That is the decision's
  // expected outcome and the follow-up issue's subject, pinned here so a change
  // to it is deliberate.
  it('a walk that dies at step 2 announces N+1 exactly once', async () => {
    const { a, b, bPushes, fromB } = await seat()
    b.unreachableIndex = 7 // episode 8
    await a.pick('8')
    await sampleLeader(a, 8)

    expect(b.episode()).toBe('7')
    expect(bPushes.map(([ep, sw]) => [ep, sw])).toEqual([['7', 'follow']])
    expect(fromB()).toEqual(['7'])
    expect(a.toasts).toEqual(['rigB moved to episode 7'])
  })

  it('holds the follower’s snapshots across an intermediate loadedmetadata', async () => {
    // A 200 ms bind gap against a 1.5 s resolve: each step's source reaches
    // metadata, and so drops #486's per-source hold, 1.3 s before the walk
    // takes its next step, while main still holds episode 6 as B's file.
    const { a, b, bPushes, bSnapshots, bMetadata } = await seat(200)
    b.resolveMs = 1500
    const pickedAt = Date.now()
    await a.pick('8')
    await sampleLeader(a, 10)

    expect(b.episode()).toBe('8')
    expect(bPushes).toHaveLength(1)
    const settledAt = bPushes[0][2]
    // Both sources reached metadata inside the walk…
    expect(bMetadata.filter((t) => t > pickedAt && t < settledAt)).toHaveLength(2)
    // …and no snapshot went out until the walk had announced where it ended.
    expect(bSnapshots.filter((t) => t > pickedAt && t < settledAt)).toEqual([])
    expect(bSnapshots.some((t) => t >= settledAt)).toBe(true)
  })
})
