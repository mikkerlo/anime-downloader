// #277 — an unadopted client's mirror wins the server's `min()` election, so
// every periodic comes back `setBy` **us** and dies at the self-guard: a joiner
// hears nothing at all while the room plays.
//
// This is the first fixture in the repo driven by a *modelled server*
// (`test/helpers/syncplay-min-election-server.ts`) rather than by hand-fed
// frames. It has to be: "who the server says set the room" is the input every
// other syncplay fixture hard-codes, and here it is the **result** — of the
// election, of the link delay, and of what our own mirror asserted one delay
// ago. At zero latency none of it happens, which is why neither CI nor a LAN
// has ever reproduced this.
//
// Two clients, a symmetric 50 ms/direction link on both, and a room that keeps
// playing throughout — the shape of the user report ("we synchronized only when
// he paused"), minus the pause.

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

import {
  SyncplayClient,
  ADOPT_TOLERANCE_S,
  ECHO_SEEK_EPSILON_S,
  PLAYBACK_ASSERT_STALE_MS
} from '../../src/main/syncplay'
import { MinElectionServer } from '../helpers/syncplay-min-election-server'
import type { MinElectionServerOptions } from '../helpers/syncplay-min-election-server'
import type { SyncplayRemoteState, SyncplaySnapshot } from '../../src/main/syncplay'

const ROOM_START = 600
const DELAY_MS = 50
const OPEN = 'Some Anime - 7'

/** The playstate as it appears on an outbound `State` frame. */
type JsonPlaystate = { position: number; paused?: boolean; doSeek?: boolean }

describe('SyncplayClient — the room speaking back through our own mirror (#277)', () => {
  let server: MinElectionServer
  let clients: SyncplayClient[] = []
  let t0 = 0

  // One seated client, driven through the whole handshake by the modelled
  // server. `takeTls` is read *after* `upgradeToTls()` has run, which is why it
  // is a thunk rather than a socket.
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

  // `useSyncplayClient`'s onMounted push — and, on the reference server, the
  // exact moment this client stops being immune to the election
  // (`Watcher.__lt__` orders a watcher whose file is `None` last, so until this
  // lands it can only win a room where nobody else has announced either).
  //
  // The `playerSessionId` is what a later `playerClosed()` has to quote back to
  // retire this membership (#307); the cases that never close pass none, which
  // is also the shape of a renderer that has not been plumbed.
  const announceFile = (client: SyncplayClient, playerSessionId?: string): void => {
    client.setFile({
      animeId: 1,
      malId: 2,
      episodeInt: '7',
      translationId: 3,
      canonicalName: OPEN,
      duration: 1440,
      newPlayer: true,
      ...(playerSessionId === undefined ? {} : { playerSessionId })
    })
  }

  /** Where the room genuinely is, by wall time, ignoring every election. */
  const trueRoomPosition = (): number => ROOM_START + (Date.now() - t0) / 1000

  // Run the session forward, pushing each client's renderer snapshot at the
  // composable's 1 Hz cadence. `snapshotOf` returns the element position for a
  // client — or a whole snapshot, for the one case where the element is paused —
  // or `null` for a client with no player driving it at all.
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

  // Re-seat the fixture on a differently-configured server. Only legal before
  // the first `seat()`, which `beforeEach` has not reached.
  //
  // Needed since #279, which is the other half of this mechanism and removes
  // its trigger on a *reference* server: with the room's arrival stamp
  // back-dated by one one-way delay, our mirror reports the room's own
  // projection exactly, the server's `+ fd` exactly cancels its receipt
  // stamping, and the two compose to a dead heat — a mirror that can no longer
  // drag the room even when it wins the election. The cases below still need it
  // to *win*, so they drive the server class where a deficit survives #279:
  // `forwardDelay: 0`, i.e. a server we have not echoed to yet. That is not a
  // hypothetical server — the reference derives `_forwardDelay` from *our* echo
  // of its `latencyCalculation` (`docs/syncplay.md:157`), which is absent for
  // the first round trips of every session and permanently whenever
  // `consumeServerLatencyEcho()`'s hold guard drops the pair. The echo's hold
  // correction — the same server's *other*, independent half — is left at the
  // harness default, which is `true`, the reference's actual behaviour: without
  // it this client's `serverRtt` reads the broadcast interval rather than the
  // network RTT and #279's clamp — correctly — refuses to trust it.
  const rebuildServer = (opts: Partial<MinElectionServerOptions>): void => {
    server.stop()
    server = new MinElectionServer({ position: ROOM_START, paused: false, ...opts })
  }

  /** The server class in which #279's ratchet survives, per `rebuildServer`. */
  const NO_FORWARD_DELAY = { forwardDelay: 0 } as const

  afterEach(() => {
    server.stop()
    for (const client of clients) client.disconnect()
    vi.useRealTimers()
  })

  // The scenario, assembled once: a host playing at ~600 s with a converged
  // player, then a joiner whose player opens mid-episode and sits at 0.
  const joinAPlayingRoom = (): {
    host: SyncplayClient
    joiner: SyncplayClient
    frames: SyncplayRemoteState[]
  } => {
    const host = seat('hostuser')
    announceFile(host)
    // The host's element is the room: it adopts on its first heartbeat and
    // asserts a real position from then on.
    run(3, (c) => (c === host ? trueRoomPosition() : null))
    expect(host.getStatus().playbackAdopted).toBe(true)

    const joiner = seat('joinuser')
    const frames: SyncplayRemoteState[] = []
    joiner.on('remote-state', (s: SyncplayRemoteState) => frames.push(s))
    announceFile(joiner)
    return { host, joiner, frames }
  }

  // The element of a joiner whose player is open at 0 and which nothing has
  // moved — the pre-adoption shape, and the one the whole bug lives in.
  const unconvergedJoiner =
    (host: SyncplayClient) =>
    (c: SyncplayClient): number | null =>
      c === host ? trueRoomPosition() : 0

  it('reproduces the ratchet: the unadopted joiner wins the election once it announces a file', () => {
    rebuildServer(NO_FORWARD_DELAY)
    const { host, joiner } = joinAPlayingRoom()
    run(8, unconvergedJoiner(host))

    // The mechanism itself, asserted on the server rather than inferred from
    // the client: before `Set: {file}` the joiner is not even a candidate, and
    // after it, it is the `min()` on essentially every election.
    expect(server.electionsSetBy('joinuser').length).toBeGreaterThanOrEqual(6)
    expect(joiner.getStatus().playbackAdopted).toBe(false)

    // And the room is therefore *behind* where it truly is — the deficit that
    // compounds one one-way delay per election (#279's half of the same
    // mechanism; asserted here only as proof the model is the real one).
    expect(server.roomState().setBy).toBe('joinuser')
    expect(server.roomState().position).toBeLessThan(trueRoomPosition())
  })

  it('delivers the room to the unadopted joiner at ~1 Hz while the room plays', () => {
    const { host, joiner, frames } = joinAPlayingRoom()
    run(8, unconvergedJoiner(host))

    // 1 in 8 s on head (the single frame from before the joiner became a
    // candidate), 8 in 8 s with the fix — the measured numbers from the issue.
    expect(frames.length).toBeGreaterThanOrEqual(7)

    // They carry the room, and they track it: monotonically increasing, and
    // landing inside the renderer's own apply tolerance of where the room truly
    // is. Not *exactly* on it — the residual is the room sliding backwards at
    // one one-way delay per election, which is #279 and deliberately still
    // present here: this fix changes what we hear, not what we send.
    const positions = frames.map((f) => f.position)
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
    expect(Math.abs(positions[positions.length - 1] - trueRoomPosition())).toBeLessThan(
      ADOPT_TOLERANCE_S
    )
    expect(frames.every((f) => f.doSeek === false)).toBe(true)
    expect(joiner.getStatus().playbackAdopted).toBe(false)
  })

  it('names nobody as the setter of a mirror-sourced frame', () => {
    rebuildServer(NO_FORWARD_DELAY)
    const { host, frames } = joinAPlayingRoom()
    run(8, unconvergedJoiner(host))

    // The wire says `joinuser` — us — on every frame past the first election.
    // Emitting that would toast "<me> seeked to 10:06" for a move nobody made
    // and write `syncplayPausedBy` to the local user.
    expect(frames.filter((f) => f.setBy === null).length).toBeGreaterThanOrEqual(5)
    expect(frames.some((f) => f.setBy === 'joinuser')).toBe(false)
    // Anti-vacuity on the other half: the frames from before the joiner became
    // a candidate are genuinely foreign and keep their author, so the stripping
    // is scoped to the mirror class rather than blanket.
    expect(frames.some((f) => f.setBy === 'hostuser')).toBe(true)
  })

  it('keeps getRoomPosition() honest past the 15 s age cap', () => {
    // On the reference server #279's back-dating lands the seed within tolerance
    // whether or not the mirror is heard, so this case passes on a mutated
    // `handleState()` too — it stops being a #277 net (review of #279). The
    // deficit-bearing server is what makes the refresh observable, so it is
    // driven here for the same reason the three cases above drive it.
    rebuildServer(NO_FORWARD_DELAY)
    const { host, joiner } = joinAPlayingRoom()
    run(20, unconvergedJoiner(host))

    // `lastRemoteRoomState` is refreshed *only* below the emit, so on head it
    // freezes at the last pre-election frame and `ROOM_POSITION_MAX_AGE_MS`
    // kills the join-time MKV seed 15 s later — the cap doing exactly the job
    // `docs/syncplay.md:203` argued it could never be called on to do.
    const seed = joiner.getRoomPosition(OPEN)
    expect(seed).not.toBeNull()
    expect(Math.abs(seed! - trueRoomPosition())).toBeLessThan(ADOPT_TOLERANCE_S)
  })

  it('lets the joiner converge and adopt once its element can honour a write', () => {
    const { host, joiner, frames } = joinAPlayingRoom()

    // The joiner's element, with the one piece of production timing that
    // decides whether a *single* frame is enough: it cannot honour a
    // `currentTime` write until `loadedmetadata`. Below HAVE_METADATA the
    // renderer parks the state instead (#240) and **overwrites** the park with
    // each newer one, so what lands at metadata is the freshest state main
    // emitted — not the first. Five seconds is an ordinary MKV prep (probe plus
    // the remux spawn and its buffer-ahead), and it is the difference between
    // "the room told us once, a while ago" and "the room is telling us now".
    const METADATA_MS = 5000
    const metadataAt = Date.now() + METADATA_MS
    let element: { position: number; at: number } | null = null
    let parked: SyncplayRemoteState | null = null
    const elementPosition = (): number =>
      element === null ? 0 : element.position + (Date.now() - element.at) / 1000

    joiner.on('remote-state', (s: SyncplayRemoteState) => {
      if (element === null) {
        parked = s
        return
      }
      // The renderer's apply rule: seek on `doSeek` or a drift over 3 s.
      if (s.doSeek || Math.abs(elementPosition() - s.position) > 3) {
        element = { position: s.position, at: Date.now() }
      }
    })

    run(12, (c) => {
      if (c === host) return trueRoomPosition()
      if (element === null && Date.now() >= metadataAt) {
        // loadedmetadata: the freshest parked state is written, once.
        element = { position: parked ? Math.max(0, parked.position) : 0, at: Date.now() }
      }
      // The element exists and reports from the first push either way — at 0
      // until the write lands, which is the drift that holds adoption off.
      return elementPosition()
    })

    // On head this is where the joiner is stranded: the only frame it ever
    // received arrived before it became a candidate, so the park is that many
    // seconds stale by the time it can be written, the drift stays over
    // `ADOPT_TOLERANCE_S`, and no later frame ever arrives to correct it.
    expect(joiner.getStatus().playbackAdopted).toBe(true)
    expect(Math.abs(elementPosition() - trueRoomPosition())).toBeLessThan(ADOPT_TOLERANCE_S)
    // Adoption retires the mirror, which is what ends #279's ratchet in this
    // scenario: the joiner asserts its own converged element from here.
    expect(Math.abs(server.roomState().position - trueRoomPosition())).toBeLessThan(
      ADOPT_TOLERANCE_S
    )
    // Anti-vacuity: adoption here is driven by the mirror frames rather than
    // incidental to them. The bounds above hold on a reference server whether or
    // not the mirror is heard (review of #279), so this is what keeps the case
    // honest to its own name.
    expect(frames.some((f) => f.setBy === null)).toBe(true)
  })

  it('recovers the room onto the pauser’s playhead, and every election after it', () => {
    rebuildServer(NO_FORWARD_DELAY)
    const { host, joiner, frames } = joinAPlayingRoom()
    run(8, unconvergedJoiner(host))

    // The ratchet is live first: the mirror owns the room and has dragged it
    // below where the host actually is.
    expect(server.roomState().setBy).toBe('joinuser')
    expect(server.roomState().position).toBeLessThan(trueRoomPosition())
    const electionsBefore = server.elections.length
    frames.length = 0

    // "we synchronized only when he paused" — the other half of the user report,
    // and the only path that bypasses the election entirely: `updateState` sees
    // `pausedChanged`, and `forcePositionUpdate` takes the *setter's* position,
    // re-seats every watcher onto it (`Room.setPosition`) and broadcasts it to
    // everyone including the setter, carrying the `ignoringOnTheFly.server`
    // counter no other path emits. Without this case none of that ran: nothing
    // else in this file pauses or seeks (#282 review).
    const pausedAt = trueRoomPosition()
    host.sendLocalState({ paused: true, position: pausedAt, cause: 'pause' })
    run(4, (c) => (c === host ? { position: pausedAt, paused: true } : 0))

    // The joiner hears the pause, attributed to the host — and hears it at the
    // host's own playhead rather than one forward delay past it, because
    // `_updatePositionByAge` leaves a frame with an explicit `paused: true`
    // uncompensated.
    const pauseFrame = frames.find((f) => f.paused)
    expect(pauseFrame).toBeDefined()
    expect(pauseFrame!.setBy).toBe('hostuser')
    expect(pauseFrame!.position).toBeCloseTo(pausedAt, 2)

    // It keeps hearing the room while the room stands still…
    expect(frames.filter((f) => f.paused).length).toBeGreaterThanOrEqual(3)
    // …and the room stays where the pause put it, because the re-seat moved
    // every watcher onto that point: the mirror no longer holds the `min()`, so
    // every election from here names the host. Skip the re-seat and the joiner
    // keeps its own drifted value and takes the room straight back on the very
    // next election — which is the instant #278 and #279 are both asking about.
    const after = server.elections.slice(electionsBefore)
    expect(after.length).toBeGreaterThanOrEqual(3)
    expect(after.every((e) => e.setBy === 'hostuser')).toBe(true)
    expect(server.roomState().paused).toBe(true)
    expect(server.roomState().position).toBeCloseTo(pausedAt, 2)
    expect(joiner.getStatus().playbackAdopted).toBe(false)
  })

  it('keeps a room seek the mirror would otherwise be elected over', () => {
    const { host, joiner, frames } = joinAPlayingRoom()
    run(8, unconvergedJoiner(host))

    // Off the tick, so the forced update does not coincide with a periodic.
    vi.advanceTimersByTime(500)
    const electionsBefore = server.elections.length
    frames.length = 0

    // A real seek, 5 minutes on. The host's element goes there and keeps
    // playing; the joiner's is still parked at 0 and still not adopted.
    const seekTo = trueRoomPosition() + 300
    const seekedAt = Date.now()
    host.sendLocalState({ paused: false, position: seekTo, cause: 'seek' })
    run(4, (c) => (c === host ? seekTo + (Date.now() - seekedAt) / 1000 : 0))

    // The joiner hears it, with `doSeek` set and the host's name on it.
    const seekFrame = frames.find((f) => f.doSeek)
    expect(seekFrame).toBeDefined()
    expect(seekFrame!.setBy).toBe('hostuser')
    expect(seekFrame!.position).toBeGreaterThan(seekTo - 1)

    // And the room stays where the seek put it, rather than being elected back
    // to the mirror's 300-s-stale value. Two things close that window: the
    // `Room.setPosition()` re-seat lands every watcher on the new position
    // immediately, and the joiner's own mirror re-anchors it one heartbeat
    // later. The re-seat is what carries the assertion, because the forced
    // update does *not* reset the room's age — the next election fires 450 ms
    // after the forced update lands (500 ms after the seek call), well inside
    // the mirror's 1 Hz heartbeat, and it is the re-seat alone that keeps the
    // joiner from winning it. Measured: remove the re-seat and this case and the
    // pause-recovery one both go red.
    const after = server.elections.slice(electionsBefore)
    expect(after.length).toBeGreaterThanOrEqual(3)
    expect(after.every((e) => e.positions.joinuser > seekTo)).toBe(true)
    expect(server.roomState().position).toBeGreaterThan(seekTo)
    expect(joiner.getStatus().playbackAdopted).toBe(false)
  })

  it('reads a playing room ahead of the playhead a forced update just set (#279)', () => {
    const { host } = joinAPlayingRoom()
    run(8, unconvergedJoiner(host))

    // Off the tick, so the room already carries a measurable age when the forced
    // update lands mid-second.
    vi.advanceTimersByTime(500)
    const lastElectionAt = server.elections[server.elections.length - 1].at

    const seekTo = trueRoomPosition() + 300
    host.sendLocalState({ paused: false, position: seekTo, cause: 'seek' })
    // One link delay: the seek frame arrives and `forcePositionUpdate` runs. No
    // periodic fires inside this window, so the last election is still the one
    // sampled above.
    vi.advanceTimersByTime(DELAY_MS + 1)

    // `Room.setPosition` writes `_position` and leaves `_lastUpdate` alone
    // (`server.py:615-620`), so `getPosition()` projects that fresh value from
    // the *last election's* stamp (`server.py:606`): the room now reads a whole
    // room-age ahead of the playhead the seek set. This is the artefact #279
    // measures, and it is the assertion that fails if the harness ever goes back
    // to resetting the room's age inside the forced update — that reset would
    // leave only the forward delay, an order of magnitude smaller.
    const roomAgeS = (Date.now() - lastElectionAt) / 1000
    expect(roomAgeS).toBeGreaterThan(0.5)
    const readAhead = server.roomState().position - seekTo
    expect(readAhead).toBeGreaterThan(roomAgeS)
    // And no more than that age plus the single forward delay
    // `_updatePositionByAge` added on store — the error is one room-age, not a
    // compounding one.
    expect(readAhead).toBeLessThan(roomAgeS + DELAY_MS / 1000 + 0.01)
  })

  it('stays deaf to its own echo when we are alone in the room', () => {
    const solo = seat('hostuser')
    const frames: SyncplayRemoteState[] = []
    solo.on('remote-state', (s: SyncplayRemoteState) => frames.push(s))
    announceFile(solo)

    // No renderer pushes at all — the Watch-Together shape with no live player
    // — so `isAdopted()` is never reached and the client stays unadopted while
    // it mirrors. It is a candidate (it announced a file) and it is the only
    // one, so every election names it and every periodic comes back `setBy`
    // us. What holds this shut is `rosterReceived && peers > 0` and nothing
    // else: emitting any of it would make `hasRemoteStateApplied()` true, let
    // `roomOwnsPlayhead()` eat the saved position on every solo episode open,
    // and make `getRoomPosition()` answer from our own echo — the regression
    // pinned at `syncplay-room-position.test.ts:143`.
    run(8, () => null)

    expect(solo.getStatus().playbackAdopted).toBe(false)
    expect(server.electionsSetBy('hostuser').length).toBeGreaterThanOrEqual(6)
    expect(frames).toEqual([])
    expect(solo.getRoomPosition(OPEN)).toBeNull()
  })

  // ------------------------------------------------------------------------
  // #288 — a closed player keeps asserting a frozen snapshot.
  //
  // The same election, driven from the other end: not a joiner that has never
  // converged, but a *converged, adopted* watcher whose player goes away. Main
  // used to infer "the player is gone" from silence alone, on the 5 s
  // `PLAYBACK_STALE_MS` horizon, and for that whole window `buildPlaystate()`
  // kept asserting a **frozen** position — one that no longer advances while
  // the room does. It wins `min(watchers)` from the moment it falls below the
  // room, and the room is pinned to it.
  //
  // Two changes are under test here and they are deliberately separable:
  //
  //   A — a second, tighter *assert* horizon (`PLAYBACK_ASSERT_STALE_MS`),
  //       which covers the crash / kill / hang shapes where nothing fires; and
  //   B — `playerClosed()`, the explicit signal the composable's unmount sends,
  //       which removes the window entirely for the ordinary close.
  //
  // Everything below asserts on the **server's** room state and on the peer's
  // `remote-state` stream rather than on the closing client's internals: "who
  // set the room" has to stay a result of the election, which is the whole
  // reason this harness exists.
  // ------------------------------------------------------------------------

  /** One `remote-state` frame, plus how far under ground truth it landed. */
  type HeardFrame = SyncplayRemoteState & { behind: number }

  // The mount IDs `twoWatchers()` announces under (#307). The #288 cases below
  // deliberately close with **no** ID — an unmatchable close, which is head's
  // behaviour exactly — so what they characterise is untouched by #307; the
  // #307 cases quote `CLOSER_MOUNT` back and get the file clear as well.
  const HOST_MOUNT = 'host-mount-1'
  const CLOSER_MOUNT = 'closer-mount-1'

  // Two watchers whose elements are both on the room and both adopted — the
  // shape a close actually happens from, and the one `joinAPlayingRoom()` (a
  // joiner parked at 0) cannot express.
  const twoWatchers = (): {
    host: SyncplayClient
    closer: SyncplayClient
    heard: HeardFrame[]
  } => {
    const host = seat('hostuser')
    announceFile(host, HOST_MOUNT)
    const closer = seat('closeruser')
    announceFile(closer, CLOSER_MOUNT)
    // The watching peer's ear. `behind` is stamped at *arrival* against
    // `trueRoomPosition()`, which is where this peer's own element is — so it
    // is exactly the `diff` the renderer's apply rule computes
    // (`use-syncplay-client.ts`: seek on `doSeek` or `diff > 3.0`).
    const heard: HeardFrame[] = []
    host.on('remote-state', (s: SyncplayRemoteState) =>
      heard.push({ ...s, behind: trueRoomPosition() - s.position })
    )
    run(4, () => trueRoomPosition())
    expect(host.getStatus().playbackAdopted).toBe(true)
    expect(closer.getStatus().playbackAdopted).toBe(true)
    return { host, closer, heard }
  }

  // The room's structural floor, and the reason none of the bounds below is
  // zero: main asserts the position the renderer last *pushed*, so at the
  // composable's 1 Hz cadence a perfectly honest client is reporting a reading
  // up to one interval old and the server ages it from receipt. The issue's own
  // head trace starts at `deficit=1.000` for this reason. What #288 is about is
  // everything *above* this line.
  const PUSH_LAG_S = 1

  /** The room's shortfall against ground truth, sampled once a second. */
  const deficitsOver = (
    seconds: number,
    snapshotOf: (client: SyncplayClient) => number | SyncplaySnapshot | null
  ): number[] => {
    const out: number[] = []
    for (let i = 0; i < seconds; i += 1) {
      run(1, snapshotOf)
      out.push(trueRoomPosition() - server.roomState().position)
    }
    return out
  }

  /** The watching peer keeps watching; the closer's renderer says nothing. */
  const closerSilent =
    (closer: SyncplayClient) =>
    (c: SyncplayClient): number | null =>
      c === closer ? null : trueRoomPosition()

  // The behaviour difference, on the server the reference actually is. On head
  // the deficit walks 1 → 2 → 3 → 4 → 5 across this window and the room stops
  // advancing entirely from t+3s on; the bound below is the assert window plus
  // one election period, and 5 s does not fit inside it.
  it('caps the room’s loss at the assert window when a player stops pushing', () => {
    const { closer } = twoWatchers()
    // Anti-vacuity: with both players honest the room is already one push-lag
    // behind and no more, so everything past that is the close's own cost
    // rather than a deficit the fixture arrived with.
    expect(trueRoomPosition() - server.roomState().position).toBeLessThan(PUSH_LAG_S + 0.5)

    const deficits = deficitsOver(6, closerSilent(closer))

    // Head: 1.0, 1.0, 2.0, 3.0, 4.0, 5.0. The frozen claim cannot outlive the
    // assert window, so the loss is bounded by it plus the election period
    // rather than by PLAYBACK_STALE_MS.
    expect(Math.max(...deficits)).toBeLessThan(PLAYBACK_ASSERT_STALE_MS / 1000 + 1)
    // And it stops growing: the last three samples are inside the same
    // envelope, rather than climbing one second per second.
    expect(deficits[5] - deficits[3]).toBeLessThan(0.5)
  })

  // The same close against a server whose forward compensation has not
  // converged — every session's first round trips, and permanent wherever
  // `consumeServerLatencyEcho()`'s hold guard drops the pair.
  //
  // The bound here is deliberately weaker, and the difference is the point:
  // **A+B ends the step, not the walk.** A closed player still has
  // `currentFile` set, still mirrors and still sits in the election, so against
  // `fd = 0` the room keeps losing one one-way delay per election for as long
  // as it sits there. What must not survive is the *step*.
  it('ends the step, not the walk, against a server that does not forward-compensate', () => {
    rebuildServer(NO_FORWARD_DELAY)
    const { closer } = twoWatchers()

    const deficits = deficitsOver(6, closerSilent(closer))

    // Head on this server: 1.05, 1.05, 2.05, 3.05, 4.05, 5.05.
    expect(Math.max(...deficits)).toBeLessThan(PLAYBACK_ASSERT_STALE_MS / 1000 + 1)
    // The residual walk, stated rather than asserted away: it is measured in
    // one-way delays, not in seconds, so six elections cannot move it far.
    expect(deficits[5] - deficits[3]).toBeLessThan(0.5)
  })

  // The user-visible symptom, in the renderer's own units. Head sends the
  // watching peer four identical frames ~4.5 s under its element, `setBy` the
  // person who closed — so it is seeked backwards in one step and told
  // somebody else did it.
  it('never seeks the watching peer backwards when a player stops pushing', () => {
    const { closer, heard } = twoWatchers()
    heard.length = 0

    run(6, closerSilent(closer))

    // Head: 8 frames over the renderer's 3.0 apply rule. Not "no frames" —
    // hearing the room is fine, being dragged by it is not.
    const wouldSeek = heard.filter((f) => f.doSeek || Math.abs(f.behind) > 3.0)
    expect(wouldSeek).toEqual([])
  })

  // The pause inverse from the issue's second trace: the live branch asserts
  // `paused: this.snapshot.paused`, so a player closed while *playing* keeps
  // claiming `paused: false` and the very next heartbeat unpauses a room a peer
  // just paused.
  it('leaves a peer’s pause standing after a player stops pushing', () => {
    const { host, closer } = twoWatchers()
    run(2, closerSilent(closer))

    const pausedAt = trueRoomPosition()
    host.sendLocalState({ paused: true, position: pausedAt, cause: 'pause' })

    // Sampled every second rather than only at the end: on head the room is
    // unpaused on the very next heartbeat and re-paused only when
    // PLAYBACK_STALE_MS expires, so an end-state assertion alone would pass.
    const pausedSamples: boolean[] = []
    for (let i = 0; i < 4; i += 1) {
      run(1, (c) => (c === closer ? null : { position: pausedAt, paused: true }))
      pausedSamples.push(server.roomState().paused)
    }
    expect(pausedSamples).toEqual([true, true, true, true])
  })

  // B. The ordinary close: `useSyncplayClient`'s unmount says so out loud, and
  // the fall-through is immediate rather than N ms later.
  it('hands the room over on the next heartbeat when the player says it closed', () => {
    const { closer, heard } = twoWatchers()
    heard.length = 0

    closer.playerClosed()
    const deficits = deficitsOver(6, closerSilent(closer))

    // No window at all — the room never loses more than the push lag it was
    // already carrying, against A's ~N and head's 5 s. This is what B buys over
    // A, and it is why the scope is both rather than A alone.
    expect(Math.max(...deficits)).toBeLessThan(PUSH_LAG_S + 0.5)
    expect(heard.filter((f) => f.doSeek || Math.abs(f.behind) > 3.0)).toEqual([])
  })

  // B's ordering, direction one — the real one. The handler clears
  // unconditionally, so what this pins is that it does not need to be
  // conditional: the unmount runs before the reopen mounts, so the reopen's
  // `setFile({newPlayer: true})` is what re-establishes adoption, on its own
  // account rather than through the handler declining to act.
  it('lets a reopen re-adopt through setFile() after a player-closed clear', () => {
    const { closer } = twoWatchers()

    closer.playerClosed()
    expect(closer.getStatus().playbackAdopted).toBe(false)
    // The reopen, in the order one renderer's `invoke` queue delivers it.
    closer.setFile({
      animeId: 1,
      malId: 2,
      episodeInt: '7',
      translationId: 3,
      canonicalName: OPEN,
      duration: 1440,
      newPlayer: true
    })
    const sentBefore = server.wireOf('closeruser').length
    run(3, () => trueRoomPosition())

    expect(closer.getStatus().playbackAdopted).toBe(true)
    // Adopted *and asserting*: a mirror carries no `paused` key at all, so the
    // presence of one is what says the new player owns the wire again.
    const after = server.wireOf('closeruser').slice(sentBefore)
    expect(after.length).toBeGreaterThanOrEqual(2)
    expect(after[after.length - 1].paused).toBe(false)
  })

  // B's ordering, direction two — a **characterisation**, not a requirement.
  // Delivered after the reopen's push, the clear does de-adopt a live player.
  // That is precisely why the design argues the renderer's unmount ordering
  // (`PlayerView` is `v-if`-gated, no `key`, no `<KeepAlive>`, one mount site)
  // rather than testing for it at runtime — the channel is payload-free and has
  // nothing to feed a guard with. Nobody should "fix" this case.
  it('de-adopts a live player if a player-closed clear arrives after its first push', () => {
    const { closer } = twoWatchers()

    closer.setFile({
      animeId: 1,
      malId: 2,
      episodeInt: '7',
      translationId: 3,
      canonicalName: OPEN,
      duration: 1440,
      newPlayer: true
    })
    run(3, () => trueRoomPosition())
    expect(closer.getStatus().playbackAdopted).toBe(true)

    closer.playerClosed()

    expect(closer.getStatus().playbackAdopted).toBe(false)
    // Cheap rather than free: one push re-converges it, which is the whole of
    // the exposure if that invariant ever breaks.
    run(2, () => trueRoomPosition())
    expect(closer.getStatus().playbackAdopted).toBe(true)
  })

  // ------------------------------------------------------------------------
  // #307 — ending the *walk*, by leaving the election rather than merely
  // falling silent inside it.
  //
  // #288's own bound stops at "the step": a closed player still had
  // `currentFile`, still mirrored, and still sat in `min(watchers)`, so against
  // a server whose forward compensation has not converged the room kept losing
  // one one-way delay per election for as long as that dead seat sat there. The
  // seat is what this removes.
  //
  // These are modelled rather than hand-fed because the quantity under test is
  // an *election outcome*: whether `Set: {file: null}` takes us out of the
  // reference's ordering is a statement about `Watcher.__lt__` and `min()`, not
  // about which bytes we wrote. The absence assertions live in the hand-fed
  // `#307` describe at the bottom of this file for the mirror-image reason.
  // ------------------------------------------------------------------------

  /** The modelled socket the server took over for a given client. */
  const socketOf = (client: SyncplayClient): FakeSocket => tlsSockets[clients.indexOf(client)]

  /** Put a raw frame on a client's socket, as a peer this app cannot express. */
  const sendRaw = (client: SyncplayClient, obj: unknown): void => {
    socketOf(client).write(JSON.stringify(obj) + '\r\n')
  }

  // The regression, on the server class where #288's residual is measurable
  // (`fd = 0`, i.e. a server we have not echoed to yet). On head — and with a
  // close that quotes no ID — the closed player keeps its file, keeps mirroring
  // one delay low and keeps winning the election; here it drops out of the
  // ordering entirely and the host takes the room back for good.
  it('takes the closed player out of the election once its file membership is retired', () => {
    rebuildServer(NO_FORWARD_DELAY)
    const { closer } = twoWatchers()

    closer.playerClosed(CLOSER_MOUNT)
    const before = server.elections.length
    run(6, closerSilent(closer))

    const after = server.elections.slice(before)
    expect(after.length).toBeGreaterThanOrEqual(4)
    // Head, and any close that does not match: `closeruser` keeps taking the
    // room. This is the assertion the fix exists for.
    expect(after.filter((e) => e.setBy === 'closeruser')).toEqual([])
    expect(after.every((e) => e.setBy === 'hostuser')).toBe(true)
    // Still *considered*, though — `__lt__` orders it last, it does not delete
    // it — which is why the positions map is the wrong place to read membership
    // off since #307.
    expect(Object.keys(after[0].positions).sort()).toEqual(['closeruser', 'hostuser'])
  })

  // The other half of the same statement: `Set: {file: {}}` is non-`None`
  // membership in the reference (`if file_ and "name" in file_:` skips the
  // store, `_file` keeps the empty mapping, and `__lt__` tests `is None`), so it
  // does **not** retire the seat. Sent raw, because main has no code path that
  // produces it — and that is the point: only the null form clears.
  it('keeps the seat for Set:{file:{}}, which is membership rather than a clear', () => {
    rebuildServer(NO_FORWARD_DELAY)
    const { closer } = twoWatchers()

    closer.playerClosed()
    sendRaw(closer, { Set: { file: {} } })
    const before = server.elections.length
    run(6, closerSilent(closer))

    const after = server.elections.slice(before)
    expect(after.filter((e) => e.setBy === 'closeruser').length).toBeGreaterThan(0)
  })

  // …and an absent `file` key is not a command at all. The reference's `Set`
  // dispatch never reaches `setFile`, so whatever membership the watcher had
  // survives a `Set` about something else entirely.
  it('leaves the seat alone for a Set that carries no file key', () => {
    rebuildServer(NO_FORWARD_DELAY)
    const { closer } = twoWatchers()

    closer.playerClosed()
    sendRaw(closer, { Set: { ready: { isReady: true, manuallyInitiated: false } } })
    const before = server.elections.length
    run(6, closerSilent(closer))

    const after = server.elections.slice(before)
    expect(after.filter((e) => e.setBy === 'closeruser').length).toBeGreaterThan(0)
  })

  // The election the old filter suppressed outright. `Room.getPosition()` folds
  // `min()` over *every* watcher, so a room in which nobody has announced still
  // elects — the first inserted one, since no `__lt__` comparison ever succeeds
  // — and still writes `_position`, `_setBy` and `_lastUpdate`. Head's model
  // held no election here at all, which made the room's age run on and the
  // fixture's cadence a fiction.
  it('elects the first-inserted watcher in a room where nobody has announced', () => {
    seat('firstuser')
    seat('seconduser')

    run(3, () => null)

    expect(server.elections.length).toBeGreaterThanOrEqual(2)
    expect(server.elections.every((e) => e.setBy === 'firstuser')).toBe(true)
    expect(Object.keys(server.elections[0].positions).sort()).toEqual(['firstuser', 'seconduser'])
    expect(server.roomState().setBy).toBe('firstuser')
  })

  // And the ordering that matters in a mixed room: anything with a file and a
  // known position beats every fileless watcher, whatever the insertion order —
  // here the fileless ones are seated *first*, so a naive `min()` without
  // `__lt__` would keep one of them.
  it('lets an announcing watcher beat fileless peers seated before it', () => {
    seat('quietuser')
    seat('anotherquietuser')
    const active = seat('activeuser')
    announceFile(active)

    run(3, (c) => (c === active ? trueRoomPosition() : null))

    expect(server.elections.length).toBeGreaterThanOrEqual(2)
    expect(server.elections.every((e) => e.setBy === 'activeuser')).toBe(true)
    // Membership, not candidacy: all three are compared, and the positions map
    // says so. A fixture that reads this map as "who has a file" is reading it
    // wrong since #307.
    expect(Object.keys(server.elections[0].positions).sort()).toEqual([
      'activeuser',
      'anotherquietuser',
      'quietuser'
    ])
  })

  // `List` renders a `None` file as `file: {}` (`protocols.py:695`), key present
  // and empty, rather than omitting it. Read off the raw reply rather than off
  // `getRoomUsers()`, because main maps both shapes to `null` and would report
  // the two as identical — which is exactly why this needs pinning at the
  // helper's own boundary.
  it('renders a fileless watcher as file:{} in the modelled List reply', () => {
    const quiet = seat('quietuser')
    const lists: Array<Record<string, Record<string, { file?: unknown }>>> = []
    socketOf(quiet).on('data', (buf: Buffer) => {
      for (const line of String(buf).split('\r\n')) {
        if (!line.trim()) continue
        const msg = JSON.parse(line) as {
          List?: Record<string, Record<string, { file?: unknown }>>
        }
        if (msg.List) lists.push(msg.List)
      }
    })
    // Somebody else announcing is what makes the server re-`List` everyone.
    const active = seat('activeuser')
    announceFile(active)

    const last = lists[lists.length - 1]
    expect(last.cinema.quietuser.file).toEqual({})
    expect(last.cinema.activeuser.file).toEqual(
      expect.objectContaining({ name: OPEN, duration: 1440 })
    )
  })
})

// The conjuncts of `isRoomVoice()`, one at a time. Hand-fed rather than
// modelled: each of these is a statement about *the predicate*, and a frame
// built by hand says which axis is under test in a way an emergent election
// cannot.
describe('SyncplayClient.isRoomVoice conjuncts (#277)', () => {
  let client: SyncplayClient
  let frames: SyncplayRemoteState[]

  const tls = (): FakeSocket => tlsSockets[tlsSockets.length - 1]

  const handshake = (): void => {
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
    tls().emit('secureConnect')
    tls().emit(
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

  const roster = (entries: Record<string, unknown>, room = 'cinema'): void => {
    tls().emit('data', Buffer.from(JSON.stringify({ List: { [room]: entries } }) + '\r\n'))
  }

  // A periodic the server's `min()` re-election has stamped with *our* name.
  const selfState = (position: number, paused = false): void => {
    tls().emit(
      'data',
      Buffer.from(
        JSON.stringify({
          State: {
            ping: { latencyCalculation: 1_770_000_000.25 },
            playstate: { position, paused, doSeek: false, setBy: 'me' }
          }
        }) + '\r\n'
      )
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    plainSockets.length = 0
    tlsSockets.length = 0
    client = new SyncplayClient()
    frames = []
    client.on('remote-state', (s: SyncplayRemoteState) => frames.push(s))
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  it('emits a self-setBy periodic while unadopted with a peer present', () => {
    handshake()
    roster({ me: { isReady: true, file: {} }, peer: { isReady: true, file: {} } })
    selfState(606)

    expect(frames).toHaveLength(1)
    expect(frames[0].position).toBeCloseTo(606, 1)
    expect(frames[0].setBy).toBeNull()
  })

  it('drops it once adoption has latched — the #220 self-seek loop', () => {
    handshake()
    roster({ me: { isReady: true, file: {} }, peer: { isReady: true, file: {} } })
    // Converge and latch the way production does: a renderer push on the room's
    // position, then one heartbeat through `buildPlaystate()` → `isAdopted()`.
    selfState(606)
    frames.length = 0
    client.updateSnapshot({ position: 606, paused: false })
    vi.advanceTimersByTime(1000)
    expect(client.getStatus().playbackAdopted).toBe(true)

    selfState(608)
    expect(frames).toEqual([])
  })

  it('drops it when the roster says we are alone', () => {
    handshake()
    roster({ me: { isReady: true, file: {} } })
    selfState(606)

    expect(client.getStatus().playbackAdopted).toBe(false)
    expect(frames).toEqual([])
    expect(client.getRoomPosition(OPEN)).toBeNull()
  })

  it('drops it on a #223 server, whose List reply never keys to our room', () => {
    handshake()
    // A `List` covering rooms that are not ours. Two of them, because
    // `pickOwnRoom()`'s single-entry fallback would otherwise adopt the reply
    // as ours — the #223 shape is a busy server whose reply we cannot key, so
    // `rosterReceived` stays permanently false. Reading that unknown roster as
    // "peers present" is the reading that re-opens the solo-room regression, so
    // the fix is deliberately inert here.
    tls().emit(
      'data',
      Buffer.from(
        JSON.stringify({
          List: {
            'other-room': { someone: { isReady: true, file: {} } },
            'third-room': { another: { isReady: true, file: {} } }
          }
        }) + '\r\n'
      )
    )
    // …and a peer arriving the only way one can on such a server: a
    // `Set: {user}` join broadcast, which seats them in `roomUsers` without
    // ever making the roster *confirmed*. This is what makes `rosterReceived`
    // load-bearing rather than implied by `peers > 0` — without it the fix
    // would switch itself on off an unconfirmed roster, which is precisely the
    // reading that re-opens the solo-room regression.
    tls().emit(
      'data',
      Buffer.from(
        JSON.stringify({ Set: { user: { peer: { room: { name: 'cinema' } } } } }) + '\r\n'
      )
    )
    expect(client.getRoomUsers().some((u) => u.username === 'peer')).toBe(true)

    selfState(606)

    expect(frames).toEqual([])
  })

  it('still drops a setBy-less frame, which carries no claim about who moved the room', () => {
    handshake()
    roster({ me: { isReady: true, file: {} }, peer: { isReady: true, file: {} } })
    tls().emit(
      'data',
      Buffer.from(
        JSON.stringify({
          State: {
            ping: { latencyCalculation: 1_770_000_000.25 },
            playstate: { position: 606, paused: false, doSeek: false, setBy: null }
          }
        }) + '\r\n'
      )
    )

    expect(frames).toEqual([])
  })

  it('keeps a foreign frame’s attribution, so only the mirror class is anonymised', () => {
    handshake()
    roster({ me: { isReady: true, file: {} }, peer: { isReady: true, file: {} } })
    tls().emit(
      'data',
      Buffer.from(
        JSON.stringify({
          State: {
            ping: { latencyCalculation: 1_770_000_000.25 },
            playstate: { position: 606, paused: false, doSeek: false, setBy: 'peer' }
          }
        }) + '\r\n'
      )
    )

    expect(frames).toHaveLength(1)
    expect(frames[0].setBy).toBe('peer')
  })

  // The one Implementation Plan box #277 opened and nothing else here closes:
  // what the new frame class does to `lastAppliedRemotePosition`'s arming rule
  // (#282 review). It lands benign, and this is the case that keeps it that way.
  it('arms the echo target from a mirror frame and swallows only the convergence seek', () => {
    handshake()
    roster({ me: { isReady: true, file: {} }, peer: { isReady: true, file: {} } })

    const seeksSent = (): Array<{ position: number }> =>
      vi
        .mocked(tls().write)
        .mock.calls.flatMap(([data]) => String(data).split('\r\n'))
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { State?: { playstate?: JsonPlaystate } })
        .map((f) => f.State?.playstate)
        .filter((p): p is JsonPlaystate => p?.doSeek === true)

    // The mirror-sourced periodic #277 makes reachable pre-adoption: 606 against
    // an element still at 0, so it clears `ADOPT_TOLERANCE_S` and arms
    // `lastAppliedRemotePosition` under #236's rule. These arrive at ~1 Hz with a
    // large diff, so the arming fires on every one of them.
    selfState(606)
    expect(frames).toHaveLength(1)

    // Pre-adoption that arming has no consumer: the echo gate in
    // `sendLocalState()` sits *below* the adoption gate, so a freshly opened
    // element's spurious `seeked` at ~0 returns above it — nothing on the wire,
    // and the armed target deliberately left in place for the seek that will
    // genuinely echo it.
    vi.mocked(tls().write).mockClear()
    client.sendLocalState({ paused: false, position: 0.2, cause: 'seek' })
    expect(seeksSent()).toEqual([])

    // Converge and latch, the way the renderer does: the applied state moves the
    // element onto the room, the snapshot follows, one heartbeat adopts.
    client.updateSnapshot({ position: 606, paused: false })
    vi.advanceTimersByTime(1000)
    expect(client.getStatus().playbackAdopted).toBe(true)

    // Now the gate is reachable, and the first thing through it is the `seeked`
    // for that convergence write — within `ECHO_SEEK_EPSILON_S` of the value
    // main handed the renderer, so it is swallowed. That is the whole cost of
    // arming from a mirror frame: one echo suppressed, the one that is an echo.
    vi.mocked(tls().write).mockClear()
    client.sendLocalState({ paused: false, position: 606 + ECHO_SEEK_EPSILON_S / 2, cause: 'seek' })
    expect(seeksSent()).toEqual([])

    // And only that one — the target is consumed on the swallow, so the user's
    // own next seek reaches the room.
    client.sendLocalState({ paused: false, position: 900, cause: 'seek' })
    const sent = seeksSent()
    expect(sent).toHaveLength(1)
    expect(sent[0].position).toBeCloseTo(900, 3)
  })
})

// #307 — the *other* half of a player close: retiring our file membership.
//
// Deliberately hand-fed rather than modelled, and the reason is mechanical
// rather than stylistic. `MinElectionServer.seat()` takes ownership of both
// `FakeSocket.write` spies (it replaces them with its own `receive`), and the
// helper's readouts (`wire`, `wireOf`) record `State` frames only. So neither
// can witness the **absence** of a `Set: {file: null}` — which is exactly what
// the mismatch cases below have to prove. Here `write` is still a `vi.fn()`, so
// every serialized frame is inspectable, present or absent.
describe('SyncplayClient.playerClosed — file membership (#307)', () => {
  let client: SyncplayClient

  const tls = (): FakeSocket => tlsSockets[tlsSockets.length - 1]

  /** Every JSON frame this client has put on the current socket, in order. */
  const framesSent = (): Array<Record<string, unknown>> =>
    vi
      .mocked(tls().write)
      .mock.calls.flatMap(([data]) => String(data).split('\r\n'))
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  /** The `Set: {file: …}` frames, so a clear and an announce read alike. */
  const fileSets = (): unknown[] =>
    framesSent()
      .map((f) => (f as { Set?: { file?: unknown } }).Set)
      .filter((s): s is { file?: unknown } => !!s && 'file' in s)
      .map((s) => s.file)

  const clears = (): unknown[] => fileSets().filter((f) => f === null)

  // Also the reconnect driver: `connect()` runs `disconnectInternal(false)`
  // first, and `currentFile` deliberately survives that — which is precisely
  // what makes `finishHandshake()`'s re-announce the honest probe for "does main
  // still hold a file?" below.
  const handshake = (): void => {
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
    tls().emit('secureConnect')
    tls().emit(
      'data',
      Buffer.from('{"Hello":{"username":"me","room":{"name":"cinema"},"version":"1.7.6"}}\r\n')
    )
  }

  // What `currentFile` still holds, read the only way main will ever act on it
  // without a fresh `setFile()`: reconnect and see what goes out. A brand-new
  // `FakeSocket` means a brand-new `write` spy, so the readout is exactly this
  // handshake's frames.
  const fileAfterReconnect = (): unknown[] => {
    handshake()
    return fileSets()
  }

  // The roster that makes adoption reachable without a peer's `State`: alone in
  // the room is `isAdopted()`'s second test, and it latches on the first
  // heartbeat. These cases are about the close, not about convergence.
  const rosterAlone = (): void => {
    tls().emit(
      'data',
      Buffer.from(
        JSON.stringify({ List: { cinema: { me: { isReady: true, file: {} } } } }) + '\r\n'
      )
    )
  }

  const announce = (playerSessionId: string, canonicalName = OPEN): void => {
    client.setFile({
      animeId: 1,
      malId: 2,
      episodeInt: canonicalName.slice(-1),
      translationId: 3,
      canonicalName,
      duration: 1440,
      newPlayer: true,
      playerSessionId
    })
  }

  /** Latch adoption the way production does: a converged push, then a heartbeat. */
  const adopt = (position: number): void => {
    client.updateSnapshot({ position, paused: false })
    vi.advanceTimersByTime(1000)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    plainSockets.length = 0
    tlsSockets.length = 0
    client = new SyncplayClient()
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  // The whole feature in one case. On head there is no clear at all — the closed
  // player stays file-bearing, keeps its seat in `Room.getPosition()`'s `min()`
  // and is re-advertised on the next reconnect — so both the `clears()` and the
  // `fileAfterReconnect()` assertions fail without the fix.
  it('clears the file and sends exactly one null Set for a close that matches', () => {
    handshake()
    rosterAlone()
    announce('mount-1')
    adopt(600)
    expect(client.getStatus().playbackAdopted).toBe(true)
    vi.mocked(tls().write).mockClear()

    client.playerClosed('mount-1')

    // The unconditional #288/#300 half, which the session guard must never
    // reach past.
    expect(client.getStatus().playbackAdopted).toBe(false)
    // One clear, not one per subsequent heartbeat: the handler is edge-shaped,
    // and `currentPlayerSessionId` is nulled with the file so a repeat close
    // cannot match again.
    expect(clears()).toEqual([null])

    vi.advanceTimersByTime(5000)
    client.playerClosed('mount-1')
    expect(clears()).toEqual([null])

    // Gone locally too, not merely announced as gone: nothing to re-advertise.
    expect(fileAfterReconnect()).toEqual([])
  })

  // The defensive ordering the design argues rather than relies on: B announces,
  // then A's close arrives. Not reachable under today's single-mount `v-if`
  // lifecycle and FIFO `invoke` queue — it is what a `<KeepAlive>`, a swapping
  // `key`, or a second mount site would make reachable, and the point is that
  // the damage stays bounded to the cheap, self-repairing half.
  it('de-adopts but keeps B’s file when a stale close from A arrives after B announced', () => {
    handshake()
    rosterAlone()
    announce('mount-a')
    adopt(600)
    announce('mount-b', 'Some Anime - 8')
    adopt(120)
    expect(client.getStatus().playbackAdopted).toBe(true)
    vi.mocked(tls().write).mockClear()

    client.playerClosed('mount-a')

    // Reset: unconditional, so it lands even on a mismatch. Cheap — one push
    // re-converges it, which the modelled #288 characterisation pins.
    expect(client.getStatus().playbackAdopted).toBe(false)
    // File: untouched. Proved from the raw socket writes, because "no frame" is
    // the assertion and only a real write spy can carry it — `wireOf()` records
    // `State` frames and would report the same empty list either way.
    expect(clears()).toEqual([])

    // And B is still the file main would re-advertise, read through the one path
    // that re-announces without a fresh `setFile()`.
    expect(fileAfterReconnect()).toEqual([
      expect.objectContaining({ name: 'Some Anime - 8', duration: 1440 })
    ])
  })

  // The mismatch that *is* reachable today, and the reason the guard cannot be
  // "any close clears": a mount that opens while the session is not `ready`
  // skips its push at `pushSyncplayFile()`'s guard, so main's stored ID still
  // belongs to the previous mount. Its close is honest and must still reset the
  // player state — but the file it never announced is not its to retire.
  it('resets player state but keeps the file when an unannounced mount closes', () => {
    handshake()
    rosterAlone()
    announce('mount-1')
    adopt(600)
    vi.mocked(tls().write).mockClear()

    client.playerClosed('mount-2')

    expect(client.getStatus().playbackAdopted).toBe(false)
    expect(clears()).toEqual([])
    expect(fileAfterReconnect()).toEqual([expect.objectContaining({ name: OPEN })])
  })

  // The un-plumbed caller. `undefined` is unmatchable rather than a wildcard, so
  // a renderer that never learned to send an ID keeps head's behaviour exactly
  // — the #288 reset, and nothing else.
  it('treats a close with no session id as unmatchable', () => {
    handshake()
    rosterAlone()
    announce('mount-1')
    adopt(600)
    vi.mocked(tls().write).mockClear()

    client.playerClosed()

    expect(client.getStatus().playbackAdopted).toBe(false)
    expect(clears()).toEqual([])
    expect(fileAfterReconnect()).toEqual([expect.objectContaining({ name: OPEN })])
  })

  // A matching close with nowhere to send it. The local half still runs — and it
  // is the half that matters here, because `finishHandshake()` re-announces
  // `currentFile` on every reconnect. On head that re-announcement puts the dead
  // player's file back into the room's election the moment the socket returns.
  it('clears local membership with no session, so a reconnect re-advertises nothing', () => {
    // Announced before the handshake completes: `setFile()` stores it and skips
    // the wire at its own readiness gate.
    announce('mount-1')
    client.playerClosed('mount-1')

    handshake()

    expect(fileSets()).toEqual([])
    expect(clears()).toEqual([])
  })
})
