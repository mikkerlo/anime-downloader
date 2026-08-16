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
//
// Deliberately **not** modelled: the `ignoringOnTheFly` ignore window (the
// server discarding playstates while its flag is up). `syncplay-ignoring-on-the-
// fly.test.ts` owns that seam frame by frame and does it better; a second,
// vaguer model of it here would only disagree with that one.
//
// Shared rather than file-local because #278 and #279 are written against the
// same model (#277 review) — they are the cross-fire and the room-slides-
// backwards halves of the same election.

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
}

type JsonRecord = Record<string, unknown>

const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null

export class MinElectionServer {
  /** Every re-election, in order — the fixture's window onto the mechanism. */
  readonly elections: Election[] = []

  private readonly room: string
  private readonly stateIntervalMs: number
  private readonly electionAgeMs: number
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
      latencyEcho: null
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
    this.roomLastUpdate = Date.now()
    // `Room.setPosition()` re-seats **every** watcher onto the new room position
    // (`server.py:615-620`) and deliberately leaves their `_lastUpdatedOn`
    // alone, so each one then projects forward from its own stale stamp.
    // Modelled literally, stale stamp included: this is the instant the room
    // stops being the laggard's — the recovery the user reported as "we
    // synchronized only when he paused".
    //
    // No case can currently tell it from its absence, and that is worth knowing
    // rather than hiding (#282 review). The forced update resets the room's age,
    // so the next election is a full `electionAgeMs` out, and every watcher in
    // this repo's fixtures is *our* client — whose pre-adoption mirror re-anchors
    // it on the new room position a heartbeat later anyway
    // (`buildPlaystate()`'s spectator branch exists for that exact reason). The
    // two are redundant only while that stays true: a real Syncplay peer asserts
    // its own player position and nothing else re-seats it, so a model without
    // this line answers "does the room survive a seek with a stale peer in it"
    // with a confident no. Keep it, and do not read a green suite as evidence
    // that it does nothing.
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
    // an explicit `paused: true` is stored raw.
    w.position = position + (ps.paused === true ? 0 : w.delayMs / 1000)
    if (hasPaused) w.paused = ps.paused as boolean
    // `Room.setPaused` only on a change (`server.py:880-882`); the forced update
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
      ping.clientLatencyCalculation = w.latencyEcho
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
