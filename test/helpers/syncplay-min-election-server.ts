// A modelled Syncplay server, cut down to the one mechanism this repo's
// fixtures cannot express: `Room.getPosition()`'s `min()` election over
// watchers (`server.py:597-604`), and the link latency that decides it.
//
// Every other syncplay fixture here is single-client and hand-feeds one inbound
// frame at a time, so "who the server says set the room" is an input rather
// than a result. #277 lives entirely in that gap: an unadopted client mirrors
// the room *anchored on the frame's arrival*, lands one one-way delay behind
// it, wins the election, and from then on the room's `setBy` is itself — which
// its own self-`setBy` guard then drops. At zero latency none of that happens,
// which is why neither CI nor a LAN has ever reproduced the bug.
//
// Reference behaviour modelled, against Syncplay 1.7.6:
//  - `Watcher.updateState` stores `position + forwardDelay` (`avrRtt/2`, i.e.
//    one one-way delay) and stamps `_lastUpdatedOn` at **receipt**
//    (`server.py:875-884`). Those are two different axes, which is why the
//    compensation does not cancel the mirror's deficit.
//  - `Watcher.getPosition()` advances the stored value with wall time iff **the
//    room** is playing (`server.py:780-787`) — not iff that watcher is paused.
//    A watcher that claimed `paused: true` into a playing room still walks
//    forward with everyone else, and a paused room advances nobody.
//  - The paused-room creep is a *receipt*-side effect rather than a wall-time
//    one: `_updatePositionByAge` adds `messageAge` to any frame whose `paused`
//    is falsy or absent (`server.py:870-873`), a mirror sends no `paused` key at
//    all, and the room is re-derived from the value it just stored — so the
//    stored position gains one forward delay per turn round the election loop
//    even while the room stands still.
//  - `Watcher.__lt__` excludes a watcher whose file is `None`
//    (`server.py:834-839`) — which is why a joiner with no player open still
//    hears the room, and why `Set: {file}` is the moment the deafness starts.
//  - `Room.getPosition()` re-elects `min(watchers)` whenever the room state is
//    over a second old, and sets **both** `_position` and `_setBy` from it.
//  - A `doSeek` or a pause change forces a room update (`server.py:180-187`)
//    broadcast to everyone including the setter (no sender filter), and
//    `Room.setPosition()` re-seats every watcher onto that position
//    (`server.py:615-620`) without refreshing their `_lastUpdatedOn`. That is
//    the moment the room stops being the laggard's, and the reason a pause
//    "fixes" a session that was drifting.
//  - That forced update does **not** touch the room's `_lastUpdate` — only
//    `Room.__init__` (`server.py:547`) and the election branch (`:603`) do. So
//    the room's age, and with it the next re-election, runs from the last
//    *election* rather than the last write, and a playing room reads ahead of
//    the position a seek or a pause just set (`:606`). Both artefacts are #279's
//    subject; see `forcePositionUpdate()` for the measurements.
//
// Deliberately **not** modelled: the `ignoringOnTheFly` ignore window (the
// server discarding playstates while its flag is up). `syncplay-ignoring-on-the-
// fly.test.ts` owns that seam frame by frame and does it better; a second,
// vaguer model of it here would only disagree with that one.
//
// Shared rather than file-local because #278 and #279 are written against the
// same model (#277 review) — they are the cross-fire and the room-slides-
// backwards halves of the same election.
//
// #279 adds three knobs on top, all additive and all defaulting to the
// reference's own behaviour: `forwardDelay` (the `fd` in `reported + fd`, so
// `2d − fd` can be pinned as a *relationship* rather than read off one
// measurement),
// `echoHoldCorrection` (whether the server corrects the echo of our
// `clientLatencyCalculation` for its own hold, which is what decides whether
// the client's `serverRtt` is a network RTT or a broadcast interval), and the
// `wire` readout — every outbound playstate stamped at *send*, which is the
// quantity #279 is about and the one `elections` cannot show, since it reports
// what the server made of a frame one delay after the fact.

import type { EventEmitter } from 'events'

// The socket shape the fixtures already build for `vi.mock('net'/'tls')`. The
// server takes ownership of `write` when it seats a client, and pushes inbound
// bytes back with `emit('data', …)`.
export type ModelSocket = EventEmitter & { write: (data: string) => void }

export interface MinElectionServerOptions {
  /** The room name the `Hello` and `List` replies are keyed to. */
  room?: string
  /** Where the room already is when the fixture starts. */
  position?: number
  paused?: boolean
  /** `SERVER_STATE_INTERVAL` — the reference's 1 s periodic `State`. */
  stateIntervalMs?: number
  /** `Room.getPosition()` re-elects when the room state is older than this. */
  electionAgeMs?: number
  /**
   * The `fd` rule in `Watcher.updateState`'s `position + forwardDelay` store
   * (`server.py:875-884`). `'avrRtt/2'` — the default — is the reference's own
   * rule, i.e. one one-way delay for a symmetric link. A number is a fixed
   * value in **seconds**: `0` models a server whose RTT estimate never
   * converged (no echo ever reaches it), and a larger constant models one that
   * over-compensates. #279 is written against the `2d − fd` relationship this
   * knob is the free variable of.
   */
  forwardDelay?: 'avrRtt/2' | number
  /**
   * Whether the echo of `clientLatencyCalculation` carries the server's own
   * hold correction. `true` is the reference's rule — `Watcher.getLatency
   * Calculation()` adds the time the server sat on our stamp waiting for its
   * next 1 Hz broadcast, the mirror image of our `consumeServerLatencyEcho()`
   * — and makes the client's `serverRtt` read the network RTT (`2d`).
   *
   * `false` models a server that echoes our stamp **verbatim**, billing the
   * hold to the network: measured here, a client's `serverRtt` reads ~1.05 s
   * against a 100 ms link. That is not hypothetical — it is exactly the failure
   * our own echo correction exists to spare the server — and it is the sample
   * #279's clamp on `serverRtt / 2` is sized for.
   *
   * **Default `true`: this shared harness models the reference.** The knob
   * arrived with #279 defaulting to `false`, because the #277 fixture had been
   * written and merged against the uncorrected echo and one of its cases ("lets
   * the joiner converge and adopt") sat *on* `ADOPT_TOLERANCE_S` under the
   * correction — 3.0000000477 s against a 3 s bound, with the inflated
   * `serverRtt` over-compensating `handleState()`'s `position + serverRtt / 2`
   * in the other direction. #279's own anchor back-dating changed that
   * arithmetic (the same fixture now reads 3.10 s corrected, 3.15 s with the
   * fix reverted), so the constraint that bought the `false` default is gone
   * and the default is the reference's rule. A case that wants the verbatim
   * echo — #279's clamp, which is *sized* for that sample — opts out with
   * `echoHoldCorrection: false`.
   */
  echoHoldCorrection?: boolean
}

export interface SeatOptions {
  username: string
  /** Symmetric one-way link delay, in ms. `0` is the localhost case, where #277 does not exist. */
  delayMs?: number
  /** The socket `net.createConnection` handed the client for this seat. */
  plain: ModelSocket
  /**
   * Called immediately after the TLS probe reply is delivered — i.e. once
   * `upgradeToTls()` has run and `tls.connect()` has minted the real socket.
   */
  takeTls: () => ModelSocket
}

/** One row of the `[ELECT]` log the diagnosis in #277 was read off. */
export interface Election {
  at: number
  setBy: string
  positions: Record<string, number>
}

/**
 * One outbound playstate, as the client put it on the wire — stamped at *send*
 * rather than at receipt, so it can be read against ground truth without the
 * link delay folded in. `elections` says what the server made of these; this
 * says what we asserted, which is the quantity #279 is about.
 */
export interface WireFrame {
  at: number
  username: string
  position: number
  /** Absent exactly when the frame made no pause claim — i.e. a spectator mirror. */
  paused?: boolean
  doSeek?: boolean
  /**
   * Where the server's room read at that same instant. `position - room` is the
   * quantity #279 turns on: negative is a mirror below the room (it wins the
   * election and the room is re-derived from it), zero is a mirror that agrees,
   * positive is one that has over-corrected past it.
   */
  room: number
}

interface Watcher {
  username: string
  socket: ModelSocket
  delayMs: number
  /** `Watcher._position` — already forward-delay-compensated on store. */
  position: number
  /** A mirror sends no `paused` key, so this stays `false` for one. */
  paused: boolean
  /** `Watcher._file`; `null` excludes the watcher from the election. */
  file: string | null
  ready: boolean
  /** `Watcher._lastUpdatedOn`, stamped at receipt. */
  lastUpdatedOn: number
  /** The client's own timestamp, echoed back so its RTT calibration works. */
  latencyEcho: number | null
  /** When that timestamp arrived, for the hold correction on the way out. */
  latencyEchoArrivedAt: number
}

type JsonRecord = Record<string, unknown>

const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null

export class MinElectionServer {
  /** Every re-election, in order — the fixture's window onto the mechanism. */
  readonly elections: Election[] = []
  /** Every outbound playstate, in order, as its client sent it. */
  readonly wire: WireFrame[] = []

  private readonly room: string
  private readonly stateIntervalMs: number
  private readonly electionAgeMs: number
  private readonly forwardDelay: 'avrRtt/2' | number
  private readonly echoHoldCorrection: boolean
  private readonly watchers = new Map<string, Watcher>()
  private roomPosition: number
  private roomPaused: boolean
  private roomSetBy: string | null = null
  private roomLastUpdate: number
  private serverCounter = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(opts: MinElectionServerOptions = {}) {
    this.room = opts.room ?? 'cinema'
    this.roomPosition = opts.position ?? 0
    this.roomPaused = opts.paused ?? false
    this.stateIntervalMs = opts.stateIntervalMs ?? 1000
    this.electionAgeMs = opts.electionAgeMs ?? 1000
    this.forwardDelay = opts.forwardDelay ?? 'avrRtt/2'
    this.echoHoldCorrection = opts.echoHoldCorrection ?? true
    this.roomLastUpdate = Date.now()
    this.timer = setInterval(() => this.broadcastPeriodicState(), this.stateIntervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Where the room reads *right now*, without running an election. */
  roomState(): { position: number; paused: boolean; setBy: string | null } {
    return { position: this.projectedRoom(), paused: this.roomPaused, setBy: this.roomSetBy }
  }

  /** The elections that named `username` as the `min()` watcher. */
  electionsSetBy(username: string): Election[] {
    return this.elections.filter((e) => e.setBy === username)
  }

  /** Every playstate `username` put on the wire, in send order. */
  wireOf(username: string): WireFrame[] {
    return this.wire.filter((f) => f.username === username)
  }

  /**
   * Drive one client all the way to `ready`. The handshake is delivered without
   * the link delay — it only moves `t0`, and every property under test lives in
   * the steady state — while every `State` after it pays the delay in both
   * directions, which is the whole point of the fixture.
   */
  seat(opts: SeatOptions): void {
    const now = Date.now()
    const watcher: Watcher = {
      username: opts.username,
      socket: opts.plain,
      delayMs: opts.delayMs ?? 0,
      // Seeded from the room rather than the reference's 0. A watcher with no
      // file is not a candidate, so the seed is only ever read in the sliver
      // between `Set: {file}` and that client's next `State` — where a 0 would
      // model #220 (a fresh joiner dragging the room to the start) on top of
      // the bug under test and make the fixture about two things.
      position: this.projectedRoom(),
      paused: this.roomPaused,
      file: null,
      ready: true,
      lastUpdatedOn: now,
      latencyEcho: null,
      latencyEchoArrivedAt: now
    }
    this.watchers.set(opts.username, watcher)

    opts.plain.write = (data: string): void => this.receive(opts.username, data)
    opts.plain.emit('connect')
    // The probe reply above ran `upgradeToTls()` synchronously, so the real
    // socket exists by now.
    const tls = opts.takeTls()
    watcher.socket = tls
    tls.write = (data: string): void => this.receive(opts.username, data)
    tls.emit('secureConnect')
  }

  // --- the election ------------------------------------------------------

  /** `Watcher.updateState`'s `forwardDelay`, in seconds, for this watcher. */
  private forwardDelayFor(w: Watcher): number {
    return this.forwardDelay === 'avrRtt/2' ? w.delayMs / 1000 : this.forwardDelay
  }

  private watcherPosition(w: Watcher): number {
    // `Watcher.getPosition()` (server.py:780-787) advances by wall time iff the
    // **room** is playing, not iff this watcher is paused — a watcher that
    // claimed `paused: true` in a playing room still walks with the room.
    return this.roomPaused ? w.position : w.position + (Date.now() - w.lastUpdatedOn) / 1000
  }

  private projectedRoom(): number {
    if (this.roomPaused) return this.roomPosition
    return this.roomPosition + (Date.now() - this.roomLastUpdate) / 1000
  }

  /** `Room.getPosition()` — re-elects `min(watchers)` past `electionAgeMs`. */
  private electRoomPosition(): number {
    const now = Date.now()
    // `>=`, not the reference's bare `>`: the reference's own `LoopingCall`
    // jitters either side of the second it schedules, so it re-elects on every
    // tick, which is what the `[ELECT]` log in #277 shows. A strict `>` against
    // a fixed 1000 ms interval that is *exactly* `electionAgeMs` would model a
    // server that elects every other second — a fixture artefact, not the
    // reference.
    if (now - this.roomLastUpdate >= this.electionAgeMs) {
      const candidates = [...this.watchers.values()].filter((w) => w.file !== null)
      if (candidates.length > 0) {
        let min = candidates[0]
        for (const c of candidates) {
          if (this.watcherPosition(c) < this.watcherPosition(min)) min = c
        }
        this.roomPosition = this.watcherPosition(min)
        this.roomSetBy = min.username
        this.roomLastUpdate = now
        this.elections.push({
          at: now,
          setBy: min.username,
          positions: Object.fromEntries(
            candidates.map((c) => [c.username, this.watcherPosition(c)])
          )
        })
      }
    }
    return this.projectedRoom()
  }

  private forcePositionUpdate(w: Watcher, doSeek: boolean): void {
    // Reference order: `updateState` flips the room's pause flag
    // (`Room.setPaused`) and only then does the forced update read
    // `watcher.getPosition()` (`server.py:180-187`) — so the flag is already
    // flipped by the time we read the position, and nothing here writes it.
    this.roomPosition = this.watcherPosition(w)
    this.roomSetBy = w.username
    // `_lastUpdate` is deliberately **not** written here. On the plain `Room` the
    // reference writes it in exactly two places — `Room.__init__` (`server.py:547`)
    // and `Room.getPosition()`'s election branch (`:603`); the managed-room
    // subclass we do not model adds a third (`ControlledRoom.getPosition`, `:686`).
    // Meanwhile `Room.setPosition` (`615-620`) sets `_position`, re-seats the
    // watchers and sets `_setBy`, and `forcePositionUpdate` (`180-187`) touches
    // nothing else (#282 review). Two artefacts follow, and both are the point
    // rather than a rough edge:
    //  - the age gating re-election is measured from the last *election*, so a
    //    seek or a pause buys no protection from the next one. Measured on the
    //    seek case: the first election after the forced update lands 450 ms
    //    later, not the 1450 ms a reset here manufactures.
    //  - `getPosition()` then projects the freshly written `_position` from that
    //    stale stamp (`:606`), so a *playing* room reads ahead of the playhead
    //    the forced update just set, by the room's age — 0.601 s on that same
    //    case, against the 0.051 s of forward delay alone that a reset leaves.
    //    #279 is the room ratcheting through exactly this loop, so a harness
    //    that reset the age would report that error as ~0 and answer #279
    //    confidently and wrongly.
    //
    // `Room.setPosition()` re-seats **every** watcher onto the new room position
    // (`server.py:615-620`) and deliberately leaves their `_lastUpdatedOn`
    // alone, so each one then projects forward from its own stale stamp.
    // Modelled literally, stale stamp included: this is the instant the room
    // stops being the laggard's — the recovery the user reported as "we
    // synchronized only when he paused" — and with the room's age no longer
    // reset, it is what *holds* the room. Delete this loop and the pause-recovery
    // and seek-retention cases both go red: the mirror keeps its stale value and
    // takes the room straight back on the election 450 ms later. Under the old
    // reset the same mutation was invisible, because the manufactured second let
    // our own mirror re-anchor first — a redundancy that only ever existed
    // because every watcher in these fixtures is *our* client, where a real
    // Syncplay peer asserts its own player position and is re-seated by nothing
    // else.
    for (const other of this.watchers.values()) other.position = this.roomPosition
    this.serverCounter += 1
    const playstate = {
      position: this.roomPosition,
      paused: this.roomPaused,
      doSeek,
      setBy: this.roomSetBy
    }
    for (const other of this.watchers.values()) {
      this.sendState(other, playstate, this.serverCounter)
    }
  }

  // --- the wire ----------------------------------------------------------

  private receive(username: string, data: string): void {
    for (const line of data.split('\r\n')) {
      if (!line.trim()) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(msg)) continue
      if ('TLS' in msg) {
        this.send(username, { TLS: { startTLS: 'true' } })
        continue
      }
      if ('Hello' in msg) {
        this.send(username, {
          Hello: { username, room: { name: this.room }, version: '1.7.6' }
        })
        continue
      }
      if ('List' in msg) {
        this.sendList(username)
        continue
      }
      if ('Set' in msg && isRecord(msg.Set)) {
        this.applySet(username, msg.Set)
        continue
      }
      if ('State' in msg && isRecord(msg.State)) {
        const state = msg.State
        const w = this.watchers.get(username)
        if (!w) continue
        // The wire readout is taken *here*, at send time, before the frame pays
        // the delay: #279 measures what we asserted against where the room
        // truly was at that instant, and stamping it at receipt would fold one
        // of the two delays under test into the measurement.
        const sent = isRecord(state.playstate) ? state.playstate : null
        if (sent) {
          this.wire.push({
            at: Date.now(),
            username,
            position: typeof sent.position === 'number' ? sent.position : 0,
            ...(typeof sent.paused === 'boolean' ? { paused: sent.paused } : {}),
            ...(typeof sent.doSeek === 'boolean' ? { doSeek: sent.doSeek } : {}),
            // Read, not elected: `projectedRoom()` rather than
            // `electRoomPosition()`, so taking the readout can never move the
            // room the fixture is measuring.
            room: this.projectedRoom()
          })
        }
        // Inbound frames pay the link delay: the number inside was computed at
        // the client's send, and the server stamps it at arrival.
        setTimeout(() => this.applyState(username, state), w.delayMs)
        continue
      }
    }
  }

  private applySet(username: string, set: JsonRecord): void {
    const w = this.watchers.get(username)
    if (!w) return
    let rosterDirty = false
    if (isRecord(set.file)) {
      w.file = typeof set.file.name === 'string' ? set.file.name : ''
      rosterDirty = true
    }
    if (isRecord(set.ready) && typeof set.ready.isReady === 'boolean') {
      w.ready = set.ready.isReady
      rosterDirty = true
    }
    // A fresh `List` to everyone stands in for the reference's `Set: {user}`
    // broadcast — same effect on `roomUsers`, one code path.
    if (rosterDirty) for (const other of this.watchers.keys()) this.sendList(other)
  }

  private applyState(username: string, state: JsonRecord): void {
    const w = this.watchers.get(username)
    if (!w) return
    if (isRecord(state.ping) && typeof state.ping.clientLatencyCalculation === 'number') {
      w.latencyEcho = state.ping.clientLatencyCalculation
      w.latencyEchoArrivedAt = Date.now()
    }
    const ps = isRecord(state.playstate) ? state.playstate : null
    if (!ps) return
    const position = typeof ps.position === 'number' ? ps.position : 0
    const hasPaused = typeof ps.paused === 'boolean'
    const pausedChanged = hasPaused && ps.paused !== this.roomPaused
    // `+ forwardDelay` on store, `lastUpdatedOn` at receipt: the two axes that
    // make the correction land somewhere other than the error. Only for a frame
    // whose `paused` is falsy or absent, as in `_updatePositionByAge`
    // (`server.py:870-873`) — `not None` is true, so a mirror is compensated and
    // an explicit `paused: true` is stored raw. The `fd` term is the harness's
    // free variable (`forwardDelay`), because #279's deficit is `2d − fd` and a
    // single measurement at the reference's own `fd = avrRtt/2` cannot tell that
    // apart from a bare `d`.
    w.position = position + (ps.paused === true ? 0 : this.forwardDelayFor(w))
    if (hasPaused) w.paused = ps.paused as boolean
    // `Room.setPaused` only on a change (`server.py:876-879`); the forced update
    // reads `room.isPaused()` and never writes it. Unconditionally mirroring the
    // watcher's flag from inside the forced update would let a `doSeek` frame
    // that carries no `paused` key overwrite the room's flag with that watcher's
    // last stored one — `__hasPauseChanged(None)` is `False` in the reference, so
    // the room's flag survives such a frame untouched.
    if (pausedChanged) this.roomPaused = ps.paused as boolean
    w.lastUpdatedOn = Date.now()
    if (ps.doSeek === true || pausedChanged) this.forcePositionUpdate(w, ps.doSeek === true)
  }

  private broadcastPeriodicState(): void {
    if (this.watchers.size === 0) return
    const position = this.electRoomPosition()
    const playstate = {
      position,
      paused: this.roomPaused,
      doSeek: false,
      setBy: this.roomSetBy
    }
    for (const w of this.watchers.values()) this.sendState(w, playstate)
  }

  private sendState(w: Watcher, playstate: JsonRecord, serverCounter?: number): void {
    const ping: JsonRecord = { latencyCalculation: Date.now() / 1000 }
    if (w.latencyEcho !== null) {
      // `Watcher.getLatencyCalculation()` adds the hold — the time the server
      // sat on our stamp waiting for its next 1 Hz broadcast — so the client's
      // `now − echo` is the network RTT and not the RTT plus a broadcast
      // interval. Switching it off is what makes a client's `serverRtt` read
      // ~1.1 s on a 100 ms link, which is the sample #279's clamp is sized for.
      ping.clientLatencyCalculation = this.echoHoldCorrection
        ? w.latencyEcho + (Date.now() - w.latencyEchoArrivedAt) / 1000
        : w.latencyEcho
      w.latencyEcho = null
    }
    const frame: JsonRecord = { ping, playstate }
    if (serverCounter !== undefined) frame.ignoringOnTheFly = { server: serverCounter }
    this.send(w.username, { State: frame }, w.delayMs)
  }

  private sendList(username: string): void {
    const entry: JsonRecord = {}
    for (const w of this.watchers.values()) {
      entry[w.username] = {
        isReady: w.ready,
        position: 0,
        ...(w.file === null ? {} : { file: { name: w.file, duration: 1440, size: 1 } })
      }
    }
    this.send(username, { List: { [this.room]: entry } })
  }

  private send(username: string, obj: unknown, delayMs = 0): void {
    const w = this.watchers.get(username)
    if (!w) return
    const frame = JSON.stringify(obj) + '\r\n'
    const deliver = (): void => {
      const target = this.watchers.get(username)
      if (target) target.socket.emit('data', Buffer.from(frame))
    }
    if (delayMs <= 0) deliver()
    else setTimeout(deliver, delayMs)
  }
}
