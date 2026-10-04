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
