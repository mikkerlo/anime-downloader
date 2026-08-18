// #279 — the spectator mirror is anchored on the frame's *arrival*, so it
// reports the room one one-way delay low, wins `Room.getPosition()`'s `min()`,
// and the room is re-derived from that already-lagged value once a second.
//
// Two halves, because the bug needs both and neither alone can show it:
//
//  - the **modelled server** (`test/helpers/syncplay-min-election-server.ts`),
//    where "who set the room" is a result of the election and the link delay
//    rather than a hand-fed input. The election loop is the whole mechanism:
//    per turn the room loses `2d − fd`, one `d` because we anchor on arrival
//    and one because the server stamps `_lastUpdatedOn` at receipt, less the
//    `fd` it adds on the position axis. `fd` is a knob here on purpose — a
//    single measurement at the reference's own `fd = avrRtt/2` cannot tell
//    `2d − fd` apart from a bare `d`, and that is how the earlier draft of this
//    issue got the fix's residual wrong.
//  - **hand-fed frames**, for the three `lastRoomState` consumers, where an
//    exact flip point is worth more than a trend: the shift has to be visible
//    at the consumer and it has to be *absent* while the room is paused.
//
// What the fix does and does not achieve. It removes exactly one of the two
// delays; the reference server's own `fd ≈ avrRtt/2` cancels the other, and the
// two compose to a dead heat — measured flat to 0.0000 over twelve elections at
// both 50 and 150 ms/direction. Against a server whose forward delay is 0 it
// halves the ratchet rather than ending it (`d` per election instead of `2d`),
// which is pinned below rather than glossed. And it never *returns* the room to
// where the watching peer is: whatever deficit the room holds when the mirror
// takes over is retained, because room and mirror are then derived from each
// other with no restoring force. The acceptance criterion is therefore an
// inequality — bounded, and not compounding — never an equality on `d`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  write: ((data: string) => void) & { mock?: { calls: unknown[][] } } = vi.fn()
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

import {
  SyncplayClient,
  ADOPT_TOLERANCE_S,
  SEEK_REASSERT_TOLERANCE_S,
  MAX_ROOM_ANCHOR_LAG_S
} from '../../src/main/syncplay'
import { MinElectionServer } from '../helpers/syncplay-min-election-server'
import type { MinElectionServerOptions, WireFrame } from '../helpers/syncplay-min-election-server'
import type { SyncplaySnapshot } from '../../src/main/syncplay'

const ROOM_START = 600
const DELAY_MS = 50
const OPEN = 'Some Anime - 7'

// A server that reports the round trip honestly, which is the reference's own
// behaviour (`Watcher.getLatencyCalculation()` adds its hold) and the only
// setting under which this client's `serverRtt` is a network RTT at all. The
// harness still defaults to the uncorrected echo for #277's sake; see the
// option's doc comment.
const HONEST_RTT = { echoHoldCorrection: true } as const

describe('SyncplayClient — the room ratcheting backwards through our mirror (#279)', () => {
  let server: MinElectionServer
  let clients: SyncplayClient[] = []
  let t0 = 0

  const seat = (username: string, delayMs = DELAY_MS): SyncplayClient => {
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
      delayMs,
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

  /** Where the room genuinely is, by wall time, ignoring every election. */
  const trueRoomPosition = (at = Date.now()): number => ROOM_START + (at - t0) / 1000

  const run = (
    seconds: number,
    snapshotOf: (client: SyncplayClient) => number | SyncplaySnapshot | null,
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
          client.updateSnapshot(typeof snap === 'number' ? { position: snap, paused: false } : snap)
        }
      }
    }
  }

  /**
   * The indefinite-mirror shape this issue is about, and the one #277 provably
   * does not cover: a watcher that adopted a real player, then closed it. Past
   * `PLAYBACK_STALE_MS` `hasLivePlayback()` is false, so `buildPlaystate()`
   * takes the mirror branch however firmly `playbackAdopted` is latched — and
   * `currentFile` has no clearing path, so we stay a `min()` candidate for the
   * rest of the session.
   *
   * The server's periodic is deliberately de-phased from our heartbeat by half
   * a second. At zero phase the two land in the same millisecond and the
   * election loop closes only every *other* second, which splits the series
   * into two interleaved chains a whole second apart and reports the ratchet at
   * half its rate. Any phase is a fixture artefact; this one is the ordinary
   * case, and it makes one loop equal one election.
   */
  const closedPlayerRoom = (
    opts: Partial<MinElectionServerOptions> = {},
    delayMs = DELAY_MS,
    phaseMs = 500
  ): { host: SyncplayClient; ghost: SyncplayClient } => {
    server.stop()
    for (const c of clients) c.disconnect()
    plainSockets.length = 0
    tlsSockets.length = 0
    clients = []
    t0 = Date.now()
    server = new MinElectionServer({
      position: ROOM_START,
      paused: false,
      ...HONEST_RTT,
      ...opts
    })
    if (phaseMs > 0) vi.advanceTimersByTime(phaseMs)
    const host = seat('hostuser', delayMs)
    announceFile(host)
    const ghost = seat('ghostuser', delayMs)
    announceFile(ghost)
    // Both players are live and converged, so both adopt.
    run(4, () => trueRoomPosition())
    return { host, ghost }
  }

  /**
   * The frames the ghost sent once its player closed. Everything after the last
   * frame that made a pause claim, rather than every frame without one: the
   * first heartbeat of a session is also a mirror (no snapshot has been pushed
   * yet), and mixing those in measures the frozen-snapshot handover instead of
   * the ratchet.
   */
  const mirrorFrames = (): WireFrame[] => {
    const all = server.wireOf('ghostuser')
    let lastLive = -1
    all.forEach((f, i) => {
      if (f.paused !== undefined) lastLive = i
    })
    return all.slice(lastLive + 1)
  }

  /**
   * The mirror's deficit against ground truth, one entry per frame. The
   * *increments* are what this issue is about: the absolute value carries
   * whatever the room already held when the mirror took over, which for a
   * closed player is the frozen last snapshot asserted through
   * `PLAYBACK_STALE_MS` and is a different defect.
   */
  const deficits = (frames: WireFrame[]): number[] =>
    frames.map((f) => +(f.position - trueRoomPosition(f.at)).toFixed(4))

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    plainSockets.length = 0
    tlsSockets.length = 0
    clients = []
    t0 = Date.now()
    server = new MinElectionServer({ position: ROOM_START, paused: false, ...HONEST_RTT })
  })

  afterEach(() => {
    server.stop()
    for (const client of clients) client.disconnect()
    vi.useRealTimers()
  })

  describe('the ratchet, on the modelled min() server', () => {
    // The behaviour-difference case. On head the deficit walks by `2d − fd` —
    // 0.05 s per election at 50 ms/direction against the reference's own `fd` —
    // for as long as the mirror lasts, which for a closed player is the rest of
    // the session; it crosses the renderer's 3 s apply rule in about a minute
    // and every peer that is actually watching is seeked backwards. Mutate the
    // `at` back-dating out and this reads 12 × 0.05 = 0.6 s of walk.
    it('stops compounding: twelve elections of a closed player move the room by under one delay', () => {
      const { host, ghost } = closedPlayerRoom()
      expect(ghost.getStatus().playbackAdopted).toBe(true)

      run(18, (c) => (c === host ? trueRoomPosition() : null))

      const mirrored = mirrorFrames()
      // Anti-vacuity: we are measuring the mirror branch, and enough of it.
      expect(mirrored.length).toBeGreaterThanOrEqual(12)
      // And the mirror really is the room's setter — the whole premise.
      expect(server.roomState().setBy).toBe('ghostuser')

      const series = deficits(mirrored)
      const walk = Math.abs(series[series.length - 1] - series[0])
      expect(walk).toBeLessThanOrEqual(DELAY_MS / 1000)
      // Stronger than the acceptance criterion, and true at this `fd`: the
      // reference's forward delay cancels the receipt stamping exactly, so what
      // is left is a dead heat rather than a slow drift.
      expect(new Set(series).size).toBe(1)
    })

    it('holds at 150 ms/direction too, where the walk would be three times as fast', () => {
      const { host } = closedPlayerRoom({}, 150)
      run(18, (c) => (c === host ? trueRoomPosition() : null))

      const series = deficits(mirrorFrames())
      expect(series.length).toBeGreaterThanOrEqual(12)
      expect(Math.abs(series[series.length - 1] - series[0])).toBeLessThanOrEqual(0.15)
    })

    // `fd` as a knob, which is what stops the next reader deriving a constant
    // from one measurement. Post-fix the per-election increment is `d − fd`:
    // zero at the reference's rule, one `d` of *remaining* ratchet against a
    // server that never got our echo, and one `d` of climb against one that
    // over-compensates. That the sign follows `fd` is the proof that our
    // correction and the server's land on different axes and compose, rather
    // than double-counting.
    const perElection = (frames: WireFrame[]): number => {
      const series = deficits(frames)
      return +((series[series.length - 1] - series[0]) / (series.length - 1)).toFixed(4)
    }

    it('pins the residual to d − fd across the three forward-delay rules', () => {
      const d = DELAY_MS / 1000

      const reference = closedPlayerRoom()
      run(18, (c) => (c === reference.host ? trueRoomPosition() : null))
      expect(perElection(mirrorFrames())).toBeCloseTo(0, 4)

      const none = closedPlayerRoom({ forwardDelay: 0 })
      run(18, (c) => (c === none.host ? trueRoomPosition() : null))
      expect(perElection(mirrorFrames())).toBeCloseTo(-d, 4)

      const double = closedPlayerRoom({ forwardDelay: 2 * d })
      run(18, (c) => (c === double.host ? trueRoomPosition() : null))
      expect(perElection(mirrorFrames())).toBeCloseTo(d, 4)
    })

    // The no-pause-claim property, asserted on the wire rather than on
    // behaviour. It is what keeps a spectator from flipping the room, and a
    // rewrite of this branch is exactly where it would be lost — the reference
    // reads a missing `paused` as "no claim" (`__hasPauseChanged(None)` is
    // False) while still applying the position.
    it('sends no paused key at all once the player has closed', () => {
      const { host } = closedPlayerRoom()
      run(18, (c) => (c === host ? trueRoomPosition() : null))

      const ghostFrames = server.wireOf('ghostuser')
      const mirrored = mirrorFrames()
      expect(mirrored.length).toBeGreaterThanOrEqual(12)
      expect(mirrored.every((f) => f.paused === undefined)).toBe(true)
      expect(mirrored.every((f) => f.doSeek === false)).toBe(true)
      // Anti-vacuity: while the player was live the frames *did* carry one, so
      // this is a property of the mirror branch and not of the readout.
      expect(ghostFrames.some((f) => f.paused !== undefined)).toBe(true)
    })

    // The discriminator between the `at` form and the position form, and the
    // direct regression net for `docs/syncplay.md:74`. The `at` form is inert
    // in a paused room **by construction**, not by measurement:
    // `projectedRoomPosition()` discards `at` outright when `room.paused`
    // (`elapsed = room.paused ? 0 : …`), so this holds for any value of the
    // shift and cannot regress under a future retune. The rig confirms it.
    //
    // The creep that *is* here is the one documented at `buildPlaystate()`:
    // the server's `_updatePositionByAge` compensates a frame that makes no
    // pause claim even in a paused room, and with everyone mirroring, that
    // value comes back as `lastRoomState`. It is bit-identical with and
    // without this fix — verified by mutation — which is the whole point.
    it('adds nothing to the paused-room creep, which is on the position axis', () => {
      server.stop()
      plainSockets.length = 0
      tlsSockets.length = 0
      clients = []
      t0 = Date.now()
      server = new MinElectionServer({ position: ROOM_START, paused: true, ...HONEST_RTT })
      const host = seat('hostuser')
      announceFile(host)
      const ghost = seat('ghostuser')
      announceFile(ghost)
      run(4, () => ({ position: ROOM_START, paused: true }))
      expect(ghost.getStatus().playbackAdopted).toBe(true)

      // Both players close. Everyone mirrors, so the server's own feedback is
      // the only thing that can move anything.
      run(18, () => null)

      const mirrored = mirrorFrames()
      expect(mirrored.length).toBe(13)
      // The exact series `main` produces, to the millisecond: one forward delay
      // per turn round the election loop, and no term this fix could add.
      expect(mirrored.map((f) => +f.position.toFixed(4))).toEqual([
        600, 600, 600.05, 600.05, 600.1, 600.1, 600.15, 600.15, 600.2, 600.2, 600.25, 600.25, 600.3
      ])
    })

    // The clamp, and the sample it is sized for. A server that echoes our
    // `clientLatencyCalculation` verbatim bills its own broadcast hold to the
    // network: measured here, `serverRtt` reads 0.95 s against a 100 ms link
    // (1.05 s at zero phase, where the hold is a whole broadcast interval).
    // Unclamped, half of that back-dates the anchor by 0.475 s and the mirror
    // sits 0.425 s *above* the room; with the clamp it sits 0.2 s above, inside
    // `MAX_ROOM_ANCHOR_LAG_S` by construction. Mutate the `Math.min` out and
    // this goes red on the bound below.
    //
    // Being above the room is not itself harmful — a mirror above it cannot win
    // `min()`. What the clamp defends is the two drift tests that read the same
    // anchor, where an unbounded lag walks toward `ADOPT_TOLERANCE_S`.
    it('clamps an inflated serverRtt so the mirror cannot climb far above the room', () => {
      // A 100 ms phase, rather than the usual 500: the inflation *is* the
      // server's hold, so the sample is largest when our heartbeat lands just
      // after a broadcast rather than half way between two. Zero phase is
      // larger still (1.05 s) but puts the wire readout in the same millisecond
      // as the election, which makes the series alternate on tick ordering.
      const { host, ghost } = closedPlayerRoom({ echoHoldCorrection: false }, DELAY_MS, 100)
      run(18, (c) => (c === host ? trueRoomPosition() : null))

      const rtt = (ghost as unknown as { serverRtt: number }).serverRtt
      // Anti-vacuity: the clamp has to actually bind on this sample, or the
      // case is testing nothing.
      expect(rtt).toBeGreaterThan(0.9)
      expect(rtt / 2).toBeGreaterThan(MAX_ROOM_ANCHOR_LAG_S)

      // Skip the handover frame: the room is still the host's there, a full
      // renderer-push second stale, so it measures the host's cadence.
      const above = mirrorFrames()
        .slice(1)
        .map((f) => f.position - f.room)
      expect(above.length).toBeGreaterThanOrEqual(11)
      expect(Math.max(...above)).toBeLessThanOrEqual(MAX_ROOM_ANCHOR_LAG_S + 1e-6)
      // Bounded on the other side too: over-correcting walks the room back *up*
      // toward the watching peer, and it must never overshoot past ground truth.
      expect(server.roomState().position).toBeLessThan(trueRoomPosition())
    })
  })

  // The three records that read `lastRoomState`, one case each, hand-fed so the
  // flip point is exact. `statusProjection()` is the fourth reader and is
  // deliberately absent: it reads `.paused` alone and is anchor-independent.
  describe('the anchor and its consumers', () => {
    let client: SyncplayClient
    let sock: FakeSocket

    const handshake = (): void => {
      client = new SyncplayClient()
      clients.push(client)
      client.connect({
        host: 'syncplay.test',
        port: 8999,
        room: 'cinema',
        username: 'me',
        autoReconnect: false
      })
      const plain = plainSockets[plainSockets.length - 1]
      plain.emit('connect')
      plain.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
      sock = tlsSockets[tlsSockets.length - 1]
      sock.emit('secureConnect')
      sock.emit(
        'data',
        Buffer.from('{"Hello":{"username":"me","room":{"name":"cinema"},"version":"1.7.6"}}\r\n')
      )
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

    /**
     * One inbound `State`. `rtt` seeds `serverRtt` by echoing a stale
     * `clientLatencyCalculation` — the client takes `now/1000 − myTs` and
     * accepts it inside `0 < rtt < 5` — and the ping is read *above* the
     * `lastRoomState` write, so the very first frame already carries its own
     * correction.
     */
    const serverState = (opts: {
      position: number
      paused?: boolean
      setBy?: string | null
      rtt?: number
      clientAck?: number
    }): void => {
      const ping: Record<string, unknown> = { latencyCalculation: 1_770_000_000.25 }
      if (opts.rtt !== undefined) ping.clientLatencyCalculation = Date.now() / 1000 - opts.rtt
      sock.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            State: {
              ping,
              ...(opts.clientAck === undefined
                ? {}
                : { ignoringOnTheFly: { client: opts.clientAck } }),
              playstate: {
                position: opts.position,
                paused: opts.paused ?? false,
                doSeek: false,
                setBy: opts.setBy === undefined ? 'peer' : opts.setBy
              }
            }
          }) + '\r\n'
        )
      )
    }

    const outboundStates = (): Array<{ position: number; paused?: boolean; doSeek: boolean }> =>
      (sock.write as unknown as { mock: { calls: [string][] } }).mock.calls
        .map(([raw]) => JSON.parse(raw) as Record<string, unknown>)
        .filter((f) => 'State' in f)
        .map((f) => (f.State as { playstate?: never }).playstate)
        .filter(
          (p): p is { position: number; paused?: boolean; doSeek: boolean } => p !== undefined
        )

    const anchorLagMs = (): number => {
      const room = (client as unknown as { lastRoomState: { at: number } | null }).lastRoomState
      return Date.now() - room!.at
    }

    // Consumer 1 — `buildPlaystate()`'s mirror, the one in the ratchet.
    // No snapshot is ever pushed, so `hasLivePlayback()` is false and the
    // heartbeat mirrors from the first tick.
    it('moves the mirror forward by exactly serverRtt / 2 and no further', () => {
      handshake()
      serverState({ position: 600, rtt: 0.1 })
      expect(anchorLagMs()).toBeCloseTo(50, 0)

      vi.advanceTimersByTime(1000)
      const mirrored = outboundStates().filter((p) => p.paused === undefined)
      expect(mirrored.length).toBeGreaterThanOrEqual(1)
      // 600 + one second of wall time + the half-RTT the anchor was back-dated.
      expect(mirrored[mirrored.length - 1].position).toBeCloseTo(601.05, 3)
    })

    it('degrades to the old anchor exactly while serverRtt is still 0 (#231)', () => {
      handshake()
      serverState({ position: 600 })
      expect((client as unknown as { serverRtt: number }).serverRtt).toBe(0)
      expect(anchorLagMs()).toBe(0)

      vi.advanceTimersByTime(1000)
      const mirrored = outboundStates().filter((p) => p.paused === undefined)
      expect(mirrored[mirrored.length - 1].position).toBeCloseTo(601, 6)
    })

    it('clamps the anchor at MAX_ROOM_ANCHOR_LAG_S on a wild serverRtt sample', () => {
      handshake()
      // 4 s is inside the inbound acceptance window (`rtt > 0 && rtt < 5`) and
      // would otherwise back-date the anchor by two full seconds — two thirds
      // of ADOPT_TOLERANCE_S, from one bad sample.
      serverState({ position: 600, rtt: 4 })
      expect((client as unknown as { serverRtt: number }).serverRtt).toBeGreaterThan(3.9)
      expect(anchorLagMs()).toBeCloseTo(MAX_ROOM_ANCHOR_LAG_S * 1000, 0)

      vi.advanceTimersByTime(1000)
      const mirrored = outboundStates().filter((p) => p.paused === undefined)
      expect(mirrored[mirrored.length - 1].position).toBeCloseTo(601 + MAX_ROOM_ANCHOR_LAG_S, 3)
    })

    // The pause gate, at the consumer rather than in the projection: a paused
    // room discards `at`, so the mirror is bit-identical to head however large
    // the shift is.
    it('does not move the mirror at all while the room is paused', () => {
      handshake()
      serverState({ position: 600, paused: true, rtt: 4 })
      expect(anchorLagMs()).toBeGreaterThan(0)

      vi.advanceTimersByTime(4000)
      const mirrored = outboundStates().filter((p) => p.paused === undefined)
      expect(mirrored.length).toBeGreaterThanOrEqual(1)
      for (const p of mirrored) expect(p.position).toBe(600)
    })

    // Consumer 2 — `isAdopted()`'s drift test. The flip point moves by exactly
    // the anchor lag and in the safe direction: the projection becomes a better
    // estimate of where the room is *now*, so an element that has genuinely
    // converged still adopts.
    const adoptsAt = (element: number, rtt?: number): boolean => {
      handshake()
      serverState({ position: 600, rtt })
      client.updateSnapshot({ position: element, paused: false })
      // The heartbeat is the only call that latches: sendStateMessage() →
      // buildPlaystate() → isAdopted().
      vi.advanceTimersByTime(1000)
      return client.getStatus().playbackAdopted
    }

    it('shifts the adoption drift test by the anchor lag, and by nothing more', () => {
      // At t+1 s the room projects to 601 unshifted and 601.05 with a 0.1 s
      // RTT, so the tolerance boundary sits at 598 and 598.05 respectively.
      expect(adoptsAt(598)).toBe(true)
      expect(adoptsAt(598 - ADOPT_TOLERANCE_S / 100)).toBe(false)

      expect(adoptsAt(598, 0.1)).toBe(false)
      expect(adoptsAt(598.05, 0.1)).toBe(true)
    })

    it('leaves the adoption drift test alone while the room is paused', () => {
      const adoptsPaused = (element: number, rtt?: number): boolean => {
        handshake()
        serverState({ position: 600, paused: true, rtt })
        client.updateSnapshot({ position: element, paused: true })
        vi.advanceTimersByTime(1000)
        return client.getStatus().playbackAdopted
      }
      // A paused room projects to 600 flat, so the boundary is 597 with or
      // without a live RTT — the identity, at the consumer.
      expect(adoptsPaused(597)).toBe(true)
      expect(adoptsPaused(597, 4)).toBe(true)
      expect(adoptsPaused(596.9)).toBe(false)
      expect(adoptsPaused(596.9, 4)).toBe(false)
    })

    // Consumer 3 — `maybeReassertSeek()`'s drift test.
    //
    // This one cannot run on the closed-player fixture the mirror cases use:
    // `maybeReassertSeek()` returns on `!hasLivePlayback() || !isAdopted()`,
    // which is precisely the mirroring state, so a spectator fixture would pin
    // nothing at all. It needs a live, adopted player with an armed intent and
    // the client ack cleared, and then a room far enough away to trip the
    // tolerance.
    const reassertsAt = (roomPosition: number, rtt?: number): boolean => {
      handshake()
      // Adopt on a converged element.
      serverState({ position: 600, rtt })
      client.updateSnapshot({ position: 600, paused: false })
      vi.advanceTimersByTime(1000)
      expect(client.getStatus().playbackAdopted).toBe(true)
      // A user seek: arms `seekIntent` and `pendingClientAck`.
      client.sendLocalState({ position: 900, paused: false, cause: 'seek' })
      const before = outboundStates().length
      // The server's next State echoes our counter, clearing `pendingClientAck`
      // — without which the re-assert declines on "our own frame is in flight".
      serverState({ position: roomPosition, rtt, clientAck: 1 })
      return outboundStates()
        .slice(before)
        .some((p) => p.doSeek === true)
    }

    it('shifts the re-assert drift test by the anchor lag, and by nothing more', () => {
      // The intent is at 900 and the frame is handled in the same millisecond
      // it arrives, so the room projects to `roomPosition + lag` and the
      // re-assert fires below `900 − 3 − lag`. Unshifted that boundary is 897.
      expect(reassertsAt(897)).toBe(false)
      expect(reassertsAt(897 - SEEK_REASSERT_TOLERANCE_S / 100)).toBe(true)

      // With a 0.1 s RTT the projection gains 0.05, so the room reads *closer*
      // to us and the re-assert is declined where it used to fire — the shift
      // in the safe direction, exactly one anchor lag of it.
      expect(reassertsAt(896.97, 0.1)).toBe(false)
      expect(reassertsAt(896.94, 0.1)).toBe(true)
    })
  })
})
