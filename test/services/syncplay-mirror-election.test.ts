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

import { SyncplayClient, ADOPT_TOLERANCE_S, ECHO_SEEK_EPSILON_S } from '../../src/main/syncplay'
import { MinElectionServer } from '../helpers/syncplay-min-election-server'
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
  // (`Watcher.__lt__` excludes a watcher whose file is `None`).
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
    const { host, joiner } = joinAPlayingRoom()

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
  })

  it('recovers the room onto the pauser’s playhead, and every election after it', () => {
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
    // update does *not* reset the room's age — the next election fires 449 ms
    // after the seek, well inside the mirror's 1 Hz heartbeat, and it is the
    // re-seat alone that keeps the joiner from winning it. Measured: remove the
    // re-seat and this case and the pause-recovery one both go red.
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
