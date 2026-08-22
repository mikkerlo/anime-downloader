// #281 slice B — the room is past the end of *our* file, so main stops
// asserting: `handleState()` clears `playbackAdopted` and `buildPlaystate()`
// falls through to the spectator mirror instead of electing our own position
// into `Room.getPosition()`'s `min()`.
//
// On the **min-election harness**, not on a hand-fed fixture, and the choice is
// load-bearing rather than stylistic. Every claim below turns on `setBy` being a
// *result* of the election — of the link delay, and of what our own mirror
// asserted one delay ago — which is the distinction
// `test/helpers/syncplay-min-election-server.ts` exists for. The assertion that
// discriminates a real `playbackAdopted = false` write from a gate term (the
// flag left `true` while `buildPlaystate()` mirrors) is *"while de-adopted we
// still receive the room"*, and it is only observable against a server that
// re-elects: under a gate term `isRoomVoice()` — which reads the raw flag —
// stays false, our mirror wins the election, every periodic comes back
// `setBy` us and dies at the self-guard, and the renderer hears nothing at all
// for the length of the divergence.
//
// The shape: two peers on different cuts of the same episode. `hostuser` has
// the 50-minute release, `shortuser` a 24-minute one. The host seeks to 33:20 —
// past the end of the short file — and the short client's renderer refuses the
// position (slice A, shipped in #286), so its element stays where it was.

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

import { SyncplayClient } from '../../src/main/syncplay'
import { MinElectionServer } from '../helpers/syncplay-min-election-server'
import type { MinElectionServerOptions, WireFrame } from '../helpers/syncplay-min-election-server'
import type { SyncplayRemoteState, SyncplaySnapshot } from '../../src/main/syncplay'

const ROOM_START = 600
const DELAY_MS = 50
const OPEN = 'Some Anime - 7'
/** The 24-minute cut — the client the divergence happens to. */
const SHORT_DURATION = 1440
/** The 50-minute cut. */
const LONG_DURATION = 3000
/** Where the host seeks: comfortably past `SHORT_DURATION`. */
const OUT_OF_FILE = 2000

describe('SyncplayClient — the room past the end of our file (#281 slice B)', () => {
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

  // `useSyncplayClient`'s onMounted push. The duration is the whole subject
  // here: `setFile()` stores the IPC payload verbatim, so this is exactly the
  // value main's predicate reads.
  const announceFile = (client: SyncplayClient, duration: number): void => {
    client.setFile({
      animeId: 1,
      malId: 2,
      episodeInt: '7',
      translationId: 3,
      canonicalName: OPEN,
      duration,
      newPlayer: true
    })
  }

  const trueRoomPosition = (): number => ROOM_START + (Date.now() - t0) / 1000

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

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    plainSockets.length = 0
    tlsSockets.length = 0
    clients = []
    t0 = Date.now()
    server = new MinElectionServer({ position: ROOM_START, paused: false })
  })

  // Same contract as `syncplay-mirror-election.test.ts`: legal only before the
  // first `seat()`.
  const rebuildServer = (opts: Partial<MinElectionServerOptions>): void => {
    server.stop()
    server = new MinElectionServer({ position: ROOM_START, paused: false, ...opts })
  }

  /**
   * The server class in which the mirror still carries a deficit after #279 —
   * one we have sent no `clientLatencyCalculation` echo to, which is every
   * session's first round trips. It is also the class the divergence is
   * *measured* in below, per the issue's Q-B1b.
   */
  const NO_FORWARD_DELAY = { forwardDelay: 0 } as const

  afterEach(() => {
    server.stop()
    for (const client of clients) client.disconnect()
    vi.useRealTimers()
  })

  /**
   * Both peers seated, both converged on the room, both adopted — the steady
   * state the divergence then opens from. The short client is the one under
   * test throughout.
   */
  const convergedPair = (): {
    host: SyncplayClient
    short: SyncplayClient
    frames: SyncplayRemoteState[]
    statuses: { playbackAdopted?: boolean; outOfFile?: boolean }[]
  } => {
    const host = seat('hostuser')
    announceFile(host, LONG_DURATION)
    const short = seat('shortuser')
    announceFile(short, SHORT_DURATION)

    const frames: SyncplayRemoteState[] = []
    short.on('remote-state', (s: SyncplayRemoteState) => frames.push(s))
    const statuses: { playbackAdopted?: boolean; outOfFile?: boolean }[] = []
    short.on('connection-status', (s: { playbackAdopted?: boolean; outOfFile?: boolean }) =>
      statuses.push({ playbackAdopted: s.playbackAdopted, outOfFile: s.outOfFile })
    )

    // Both elements are on the room, so both adopt on the drift test.
    run(4, () => trueRoomPosition())
    expect(host.getStatus().playbackAdopted).toBe(true)
    expect(short.getStatus().playbackAdopted).toBe(true)
    expect(short.getStatus().outOfFile).toBe(false)
    return { host, short, frames, statuses }
  }

  /**
   * The host seeks the room past the end of the short cut, and from then on the
   * short client's renderer refuses the position (slice A) so its element keeps
   * playing its own file forward from where it already was.
   */
  const openDivergence = (
    host: SyncplayClient,
    short: SyncplayClient,
    seconds: number
  ): { seekAt: number; shortAt: number } => {
    // Off the tick, so the forced update does not coincide with a periodic.
    vi.advanceTimersByTime(500)
    const shortAt = trueRoomPosition()
    const seekAt = Date.now()
    host.sendLocalState({ paused: false, position: OUT_OF_FILE, cause: 'seek' })
    run(seconds, (c) =>
      c === host
        ? OUT_OF_FILE + (Date.now() - seekAt) / 1000
        : Math.min(SHORT_DURATION, shortAt + (Date.now() - seekAt) / 1000)
    )
    return { seekAt, shortAt }
  }

  it('de-adopts the short client and puts the mirror on the wire instead of its own position', () => {
    const { host, short } = convergedPair()
    const { shortAt } = openDivergence(host, short, 6)

    // The write itself, and the projection that tells the renderer *which*
    // de-adoption this is.
    expect(short.getStatus().playbackAdopted).toBe(false)
    expect(short.getStatus().outOfFile).toBe(true)

    // And what it buys, asserted on the wire rather than inferred from the
    // latch: a mirror carries no `paused` key at all (the reference reads a
    // missing `paused` as "no claim"), and it sits at the room's projection
    // rather than at our own playhead. On head the short client stays latched
    // and asserts ~`shortAt`, which wins `min()` outright and yanks the host
    // back by the better part of a file length.
    const late = server.wireOf('shortuser').slice(-3)
    expect(late.length).toBe(3)
    expect(late.every((f) => f.paused === undefined)).toBe(true)
    for (const f of late) {
      expect(f.position).toBeGreaterThan(OUT_OF_FILE)
      expect(Math.abs(f.position - f.room)).toBeLessThan(0.5)
    }
    // Anti-vacuity: our own playhead really is far from what we put on the wire.
    expect(shortAt).toBeLessThan(SHORT_DURATION)
    expect(server.roomState().position).toBeGreaterThan(OUT_OF_FILE)
  })

  it('keeps delivering the room to the de-adopted client, including the state that carries it back into range', () => {
    // The case that *pins* the answer to Q-B1 rather than restating it. With
    // `fd = 0` our mirror wins the election outright, so the server names
    // **us** as the room's setter and every periodic comes back self-`setBy`.
    // Under a gate term `isRoomVoice()` reads the raw flag, stays false, and
    // all of them die at the self-guard: the renderer hears nothing for the
    // whole divergence — including the state that carries the room back into
    // our file. A real clear turns `isRoomVoice` on and they are emitted with
    // attribution stripped.
    rebuildServer(NO_FORWARD_DELAY)
    const { host, short, frames } = convergedPair()
    const { seekAt, shortAt } = openDivergence(host, short, 6)

    // The premise: the room's setter really is us.
    expect(server.electionsSetBy('shortuser').length).toBeGreaterThanOrEqual(3)
    expect(server.roomState().setBy).toBe('shortuser')

    frames.length = 0
    run(5, (c) =>
      c === host
        ? OUT_OF_FILE + (Date.now() - seekAt) / 1000
        : Math.min(SHORT_DURATION, shortAt + (Date.now() - seekAt) / 1000)
    )
    // The self-`setBy` class specifically: those are the frames the guard eats
    // under a gate term, and they are emitted with attribution stripped because
    // the username on the wire is our own. Zero of them if the de-adoption does
    // not genuinely clear the flag; the foreign frames in the same stream would
    // arrive either way, which is why the filter is the assertion.
    const mirrorSourced = frames.filter((f) => f.setBy === null)
    expect(mirrorSourced.length).toBeGreaterThanOrEqual(3)
    // They carry the room, not us.
    expect(mirrorSourced.every((f) => f.position > OUT_OF_FILE)).toBe(true)

    // And the state that carries the room back into our file lands too. The
    // host seeks back to a position the short cut does reach; the short client
    // is still de-adopted at that instant, so nothing about this frame's
    // delivery depends on our having re-adopted first.
    frames.length = 0
    const backInRange = shortAt + 30
    host.sendLocalState({ paused: false, position: backInRange, cause: 'seek' })
    run(2, (c) => (c === host ? server.roomState().position : shortAt))

    const inRange = frames.filter((f) => f.position < SHORT_DURATION)
    expect(inRange.length).toBeGreaterThanOrEqual(1)
    expect(inRange[inRange.length - 1].position).toBeGreaterThan(backInRange - 2)
  })

  it('announces the divergence to a client that was already de-adopted when it arrived', () => {
    // The join-mid-episode shape, and the reason `emitStatusIfProjectionChanged()`
    // has to compare the new field as well as the two old ones. A client whose
    // player opens into an already-out-of-range room is de-adopted *before* the
    // first out-of-file state lands, so `playbackAdopted` never flips and
    // `roomPaused` never moves: a field nothing else moves would go true with no
    // `setStatus({})` behind it, and the renderer's pause rule would never
    // engage on the case slice A calls its primary one.
    const host = seat('hostuser')
    announceFile(host, LONG_DURATION)
    // Drive the room past the short cut's end before the joiner exists.
    vi.advanceTimersByTime(500)
    const seekAt = Date.now()
    host.sendLocalState({ paused: false, position: OUT_OF_FILE, cause: 'seek' })
    run(3, () => OUT_OF_FILE + (Date.now() - seekAt) / 1000)

    const joiner = seat('shortuser')
    const statuses: { playbackAdopted?: boolean; outOfFile?: boolean }[] = []
    joiner.on('connection-status', (s: { playbackAdopted?: boolean; outOfFile?: boolean }) =>
      statuses.push({ playbackAdopted: s.playbackAdopted, outOfFile: s.outOfFile })
    )
    announceFile(joiner, SHORT_DURATION)
    // Its element is open at 0 and nothing has moved it — the renderer refuses
    // every position the room offers, so it never converges.
    run(5, (c) => (c === host ? OUT_OF_FILE + (Date.now() - seekAt) / 1000 : 0))

    // The premise: it never adopted, so the old two fields are both flat.
    expect(joiner.getStatus().playbackAdopted).toBe(false)
    expect(statuses.every((s) => s.playbackAdopted === false)).toBe(true)
    // And the divergence is nonetheless announced.
    expect(joiner.getStatus().outOfFile).toBe(true)
    expect(statuses.some((s) => s.outOfFile === true)).toBe(true)
  })

  it('does not de-adopt at the ordinary end of an episode on identical files', () => {
    // The drift conjunct, and the main-side twin of slice A's `wouldSeek` gate.
    // On identical files the room's projected position crosses our duration by
    // fractions of a second at the end of **every** episode: main emits
    // `position + serverRtt / 2` for a playing room and the room's `min()` sits
    // at essentially the duration once both peers are there. Without the
    // `> ADOPT_TOLERANCE_S` conjunct this de-adopts every episode end and flips
    // the status projection twice on the way through.
    server.stop()
    t0 = Date.now()
    server = new MinElectionServer({ position: SHORT_DURATION - 2, paused: false })

    const host = seat('hostuser')
    announceFile(host, SHORT_DURATION)
    const short = seat('shortuser')
    announceFile(short, SHORT_DURATION)
    const statuses: { playbackAdopted?: boolean; outOfFile?: boolean }[] = []
    short.on('connection-status', (s: { playbackAdopted?: boolean; outOfFile?: boolean }) =>
      statuses.push({ playbackAdopted: s.playbackAdopted, outOfFile: s.outOfFile })
    )

    const atEnd = (): number =>
      Math.min(SHORT_DURATION, SHORT_DURATION - 2 + (Date.now() - t0) / 1000)
    run(6, () => atEnd())

    // The premise: the room really did cross the end of the file.
    expect(server.roomState().position).toBeGreaterThan(SHORT_DURATION)
    // And nothing moved.
    expect(short.getStatus().playbackAdopted).toBe(true)
    expect(short.getStatus().outOfFile).toBe(false)
    expect(statuses.some((s) => s.playbackAdopted === false)).toBe(false)
    expect(statuses.some((s) => s.outOfFile === true)).toBe(false)
  })

  it('re-adopts after the renderer has converged us, and not before', () => {
    // Both halves, because "re-adoption once the room comes back into range" is
    // what was ambiguous between the two candidate placements and a one-sided
    // assertion passes under either. Re-adoption is the ordinary drift path, so
    // the room being back in range is necessary and not sufficient.
    const { host, short } = convergedPair()
    const { shortAt } = openDivergence(host, short, 6)
    expect(short.getStatus().playbackAdopted).toBe(false)

    // The room comes back into range while our element is still a long way
    // behind it — the renderer has not applied anything yet.
    const backInRange = shortAt + 200
    host.sendLocalState({ paused: false, position: backInRange, cause: 'seek' })
    run(3, (c) => (c === host ? server.roomState().position : shortAt))

    expect(server.roomState().position).toBeLessThan(SHORT_DURATION)
    expect(short.getStatus().playbackAdopted).toBe(false)
    expect(short.getStatus().outOfFile).toBe(false)

    // Now the renderer applies it and our snapshot converges. Only then.
    run(3, (c) => (c === host ? server.roomState().position : server.roomState().position))
    expect(short.getStatus().playbackAdopted).toBe(true)
  })

  it('announces no projection change to a client alone in a room parked past the end of its file', () => {
    // A solo client's room is its own echo, and `isAdopted()`'s roster-alone
    // branch re-latches unconditionally — but the de-adopt write is
    // unconditional on the roster, so the two have to be checked against each
    // other rather than assumed. A flip announced here would reach the
    // renderer's pause rule in a room where nobody can override anything.
    // The room it walked into is parked at 33:20, where the previous occupant
    // left it; its own element is at 600 on a 24-minute file.
    rebuildServer({ position: OUT_OF_FILE })
    const client = seat('lonely')
    const statuses: { playbackAdopted?: boolean; outOfFile?: boolean }[] = []
    client.on('connection-status', (s: { playbackAdopted?: boolean; outOfFile?: boolean }) =>
      statuses.push({ playbackAdopted: s.playbackAdopted, outOfFile: s.outOfFile })
    )
    announceFile(client, SHORT_DURATION)
    run(6, () => 600)

    expect(client.getStatus().playbackAdopted).toBe(true)
    expect(client.getStatus().outOfFile).toBe(false)
    expect(statuses.some((s) => s.outOfFile === true)).toBe(false)
    expect(statuses.some((s) => s.playbackAdopted === false)).toBe(false)
  })

  it('pins the per-election residual the divergence sits in at fd = 0', () => {
    // The cost of slice B, measured rather than argued (Q-B1b). Against a
    // server that has had no `clientLatencyCalculation` echo from us the
    // mirror's deficit walks by one one-way delay **per election** — ~0.05 s/s
    // at 50 ms/direction — which crosses the renderer's 3 s apply rule in about
    // a minute, so the peer on the longer cut is seeked backwards *repeatedly*
    // for the length of the divergence rather than once. That is bounded by our
    // own file ending or by the room re-entering it, and by nothing slice B
    // does; it is here so a later change to the anchoring cannot move it
    // silently.
    rebuildServer(NO_FORWARD_DELAY)
    const { host, short } = convergedPair()
    const { seekAt, shortAt } = openDivergence(host, short, 18)

    // Only the mirror frames: the ones before the divergence carried a `paused`
    // key, and mixing those in measures the handover instead of the ratchet.
    const all = server.wireOf('shortuser')
    let lastLive = -1
    all.forEach((f, i) => {
      if (f.paused !== undefined) lastLive = i
    })
    const mirrored: WireFrame[] = all.slice(lastLive + 1)
    expect(mirrored.length).toBeGreaterThanOrEqual(12)

    // Ground truth is where the host's playhead actually is, which is what the
    // room would read with no mirror in it.
    const deficits = mirrored.map(
      (f) => +(f.position - (OUT_OF_FILE + (f.at - seekAt) / 1000)).toFixed(4)
    )
    const perElection = +(
      (deficits[deficits.length - 1] - deficits[0]) /
      (deficits.length - 1)
    ).toFixed(4)
    expect(perElection).toBeCloseTo(-DELAY_MS / 1000, 3)
    // Anti-vacuity: the divergence really was open for the whole measurement.
    expect(short.getStatus().playbackAdopted).toBe(false)
    expect(shortAt).toBeLessThan(SHORT_DURATION)
  })

  it('emits no frame carrying a live seek intent and the room voice together', () => {
    // The invariant the emit's own comment asserts — `isRoomVoice()` is gated on
    // `!playbackAdopted`, `sendLocalState()` arms the intent only below the
    // adoption gate, and every writer of `playbackAdopted = false` nulls the
    // intent beside it. The fourth writer is the one added here, and the tick
    // the divergence opens is the tick an `isAdopted()` placement would have
    // broken it on: `seekIntentWasLive` is captured *above* the
    // `maybeReassertSeek()` call whose `!isAdopted()` branch would have nulled
    // the intent.
    const { host, short, frames } = convergedPair()

    // Arm a real seek intent on the short client first — it is adopted, so this
    // goes out and the intent is live.
    vi.advanceTimersByTime(200)
    const ours = trueRoomPosition() + 120
    short.sendLocalState({ paused: false, position: ours, cause: 'seek' })

    // …and open the divergence on the very next tick, with the intent still
    // unresolved.
    frames.length = 0
    const seekAt = Date.now()
    host.sendLocalState({ paused: false, position: OUT_OF_FILE, cause: 'seek' })
    run(4, (c) => (c === host ? OUT_OF_FILE + (Date.now() - seekAt) / 1000 : ours))

    // A frame emitted with the room's voice carries `setBy: null`; a frame
    // emitted while the intent was live carries *our* snapshot instead of the
    // room's. The invariant is that no frame is both, which here reads: every
    // unattributed frame carries the room's position rather than ours.
    for (const f of frames) {
      if (f.setBy === null) expect(Math.abs(f.position - ours)).toBeGreaterThan(1)
    }
    expect(short.getStatus().playbackAdopted).toBe(false)
  })
})
