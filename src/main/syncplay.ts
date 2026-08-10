import * as net from 'net'
import * as tls from 'tls'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'

const CLIENT_VERSION = '1.6.9'
const HEARTBEAT_MS = 1000
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_BASE_MS = 1000
// Pre-ready protocol garbage detection (#215): a handshake that has produced
// this many JSON parse failures, or received this many bytes without a single
// valid message, is not talking to a Syncplay server. The threshold is >1 so a
// benign malformed MOTD line can't abort a working handshake; post-ready a
// corrupt line keeps today's skip-and-log behavior (a live session shouldn't
// die on one bad frame).
const GARBAGE_PARSE_FAILURE_LIMIT = 5
const GARBAGE_BYTE_CAP = 64 * 1024
const GARBAGE_REASON = 'Server sent data that is not Syncplay protocol — is this a Syncplay server?'
// Handshake watchdog (#215): 8 s, deliberately strictly below the Settings
// test button's 10 s renderer timer — equal intervals would make the visible
// message depend on an IPC race, and the renderer's copy is the uninformative
// "Timed out after 10s". Still an order of magnitude above a real
// three-round-trip handshake. Also always beats the OS SYN timeout (~130 s),
// so `connect ETIMEDOUT` is unreachable pre-ready — deliberate: the
// `connecting` wording below is faster and clearer.
const WATCHDOG_MS = 8000
// A local player pushes a snapshot every second (`syncplay:local-snapshot`).
// Older than this and nothing is driving playback here — the Watch Together
// view joins a room with no player at all, and closing the player stops the
// pushes — so our `snapshot` is not a playstate we may assert. 5× the push
// cadence: long enough that a stuttering renderer never flips us to spectator
// mid-playback, short enough that closing the player stops our assertions
// within one heartbeat or two. See sendStateMessage().
const PLAYBACK_STALE_MS = 5000
// How close to the room our local position must be before we start asserting
// it. Same 3 s the renderer's apply rule uses to decide a seek is needed: at or
// under it the renderer wouldn't move us anyway, so we have converged. A
// freshly mounted <video> starts at {0, paused} and the renderer pushes that
// snapshot before the first remote State has seeked it, so without this the
// player path re-creates the very bug the spectator rule fixes.
const ADOPT_TOLERANCE_S = 3
// A "seek" this close to where the room already is didn't come from the user —
// it's the element finishing the seek we applied from the room, arriving after
// the renderer's suppression window. Tight on purpose: a real user seek lands
// somewhere else, and a real seek to within half a second of the room's own
// position is a no-op for everyone anyway.
const ECHO_SEEK_EPSILON_S = 0.5

function watchdogWording(phase: AttemptPhase): { long: string; short: string } {
  // In `connecting` nothing has been written to the socket yet (the probe goes
  // out inside the 'connect' handler), so "no reply received" would report a
  // missing reply to a message never sent. Neither form carries a "Connection
  // closed" prefix — that would be factually false here, *we* closed the
  // socket — and neither attributes the silence: a client-side hang produces
  // the same observation as a mute server.
  const secs = `${WATCHDOG_MS / 1000}s`
  if (phase === 'connecting') {
    return {
      long: `Could not establish a TCP connection within ${secs} — the host may be unreachable or the port filtered`,
      short: `could not establish a TCP connection within ${secs}`
    }
  }
  return {
    long: `No reply received in ${secs} while in ${phase}`,
    short: `no reply received in ${secs} while in ${phase}`
  }
}
const DEBUG = process.env.SYNCPLAY_DEBUG === '1' || process.env.SYNCPLAY_DEBUG === 'true'

function log(...args: unknown[]): void {
  if (DEBUG) console.log('[syncplay]', ...args)
}

export interface SyncplayConfig {
  host: string
  port: number
  room: string
  username: string
  password?: string
  autoReconnect: boolean
}

export type SyncplayState =
  | 'idle'
  | 'connecting'
  | 'tls-probing'
  | 'tls-handshake'
  | 'hello-sent'
  | 'ready'
  | 'reconnecting'
  | 'disconnected'

export interface SyncplayStatus {
  state: SyncplayState
  host?: string
  port?: number
  room?: string
  username?: string
  tls?: boolean
  error?: string
}

export interface SyncplaySnapshot {
  position: number
  paused: boolean
}

export interface SyncplayFileInfo {
  animeId: number
  malId: number | null
  episodeInt: string
  translationId: number | null
  canonicalName: string
  duration: number
}

export interface SyncplayRemoteState {
  paused: boolean
  position: number
  setBy: string | null
  doSeek: boolean
}

export interface SyncplayRoomUser {
  username: string
  file: { name: string; duration: number; size?: number } | null
  isReady?: boolean
  animeDlAppMeta?: {
    animeId: number
    malId: number | null
    episodeInt: string
    translationId: number | null
  }
}

export interface SyncplayRemoteEpisode {
  animeId: number
  malId: number | null
  episodeInt: string
  translationId: number | null
  canonicalName: string
  fromUser: string
}

export interface SyncplayRoomEvent {
  level: 'info' | 'warn' | 'error' | 'chat'
  text: string
}

type JsonObject = Record<string, unknown>

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function md5Hex(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex')
}

// The five phases a single connection attempt walks through. `lastAttemptPhase`
// tracks the furthest one the *current* attempt reached — `status.state` can't
// be used for close reasons because on the default auto-reconnect config the
// close that produces the final disconnected status belongs to a retry, whose
// state has already been overwritten to 'reconnecting' (#215).
const ATTEMPT_PHASES = [
  'connecting',
  'tls-probing',
  'tls-handshake',
  'hello-sent',
  'ready'
] as const satisfies readonly SyncplayState[]
type AttemptPhase = (typeof ATTEMPT_PHASES)[number]

// Long form fills status.error on its own; the short form goes after the
// "Max reconnect attempts reached — " prefix so the message stays one sentence.
const PHASE_CLOSE_REASON: Record<AttemptPhase, { long: string; short: string }> = {
  connecting: {
    long: 'Connection closed before it was established',
    short: 'never established'
  },
  'tls-probing': {
    long: 'Server closed the connection during the TLS probe — it may not be a Syncplay server, or may not support TLS (Syncplay 1.6.3+ required)',
    short: 'no reply to TLS probe'
  },
  'tls-handshake': {
    long: 'Server closed the connection during the TLS handshake',
    short: 'TLS handshake incomplete'
  },
  'hello-sent': {
    long: 'Server closed the connection during login without a reply',
    short: 'no reply to login'
  },
  ready: {
    long: 'Connection to the server was lost',
    short: 'connection lost'
  }
}

export class SyncplayClient extends EventEmitter {
  private config: SyncplayConfig | null = null
  private socket: net.Socket | tls.TLSSocket | null = null
  private rxBuffer = ''
  private status: SyncplayStatus = { state: 'idle' }

  private heartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0

  private snapshot: SyncplaySnapshot = { position: 0, paused: true }
  // When the renderer last pushed a real playback snapshot. 0 = never, i.e. no
  // player has ever driven this session (joined from the Watch Together view).
  // Guards every outbound playstate assertion — see sendStateMessage().
  private lastSnapshotAt = 0
  // The room's own playstate as the server last reported it, kept raw (no RTT
  // compensation — this goes back out on the wire). Lets a spectator echo the
  // room instead of asserting a position it doesn't have.
  private lastRoomState: { position: number; paused: boolean; at: number } | null = null
  // Whether local playback has converged with the room. False for a freshly
  // opened file — its <video> reports {0, paused} until the first remote State
  // seeks it — so that startup state is never asserted at the room.
  private playbackAdopted = false
  // The last position we emitted to the renderer as a remote state, i.e. the
  // value it seeks the element to. The element reports exactly this back once
  // the seek completes — that's the echo, and it's the only reliable way to
  // tell it apart from a user seek.
  private lastAppliedRemotePosition: number | null = null
  private currentFile: SyncplayFileInfo | null = null
  private serverMotd = ''
  private tlsUpgraded = false
  // Garbage-detection counters: per-attempt (reset in resetTransportState(),
  // so attempts 1–4 can't accumulate onto a healthy attempt 5) but deliberately
  // NOT reset by the TLS upgrade — plaintext-phase garbage counts toward the
  // same attempt's verdict even though upgradeToTls() swaps rxBuffer/sockets.
  private garbageParseFailures = 0
  private garbageBytes = 0
  private sawValidMessage = false
  private roomUsers: SyncplayRoomUser[] = []
  private ownIsReady = true

  private clientIgnoreCounter = 0
  private pendingClientAck = 0
  private pendingServerAck = 0
  private lastAppliedRoomEpisode: string | null = null

  private serverRtt = 0
  // Per-attempt detail slots for the disconnect reason (#213/#215). All three
  // reset in openSocket() — never in resetTransportState(), which runs at the
  // top of onSocketClose() before the reason is composed — so the surfaced
  // detail always belongs to the *last* attempt, whatever kind it is. The
  // errorless close always has a phase reason to fall back on, which is what
  // allows lastSocketError to be per-attempt instead of #213's session scope.
  private lastSocketError: string | null = null
  // Text of a non-escalated server Error frame, recorded only pre-ready: it
  // exists to explain login-phase closes ("Room name is invalid" then FIN must
  // not read "without a reply"). Post-ready frames stay room-events only.
  private lastServerError: string | null = null
  private lastAttemptPhase: AttemptPhase = 'connecting'
  // Watchdog state. The timer is per-socket (cleared in resetTransportState()
  // like the other timers, so attempt N's watchdog can never fire into attempt
  // N+1); the detail and fired flag are per-attempt detail slots (reset in
  // openSocket() — resetTransportState() runs at the top of onSocketClose(),
  // before the reason is composed, and would erase them).
  private watchdogTimer: NodeJS.Timeout | null = null
  private watchdogDetail: { long: string; short: string } | null = null
  private watchdogFired = false

  connect(config: SyncplayConfig): void {
    this.disconnectInternal(false)
    this.config = config
    this.reconnectAttempts = 0
    this.lastAppliedRoomEpisode = null
    this.openSocket()
  }

  disconnect(): void {
    this.disconnectInternal(true)
  }

  getStatus(): SyncplayStatus {
    return { ...this.status }
  }

  getRoomUsers(): SyncplayRoomUser[] {
    return this.roomUsers.map((u) => ({ ...u }))
  }

  setFile(file: SyncplayFileInfo): void {
    // A different file means a fresh <video> at position 0 — it has to converge
    // on the room again before it may assert. Identity, not object equality:
    // the player re-pushes the same file once real duration is known.
    if (this.currentFile?.canonicalName !== file.canonicalName) this.playbackAdopted = false
    this.currentFile = file
    // The renderer's readiness is player-scoped and only pushes on a change, so
    // a player closed mid-buffer leaves main stuck at isReady:false: the next
    // player starts its closure at `true`, hits the equality guard, and sends
    // nothing. That pins us as "Buffering" in every peer's roster and holds
    // their ready gate down for the rest of the session. A new player is ready
    // until it says otherwise.
    if (!this.ownIsReady) this.setReady(true)
    if (this.status.state === 'ready') this.sendSetFile(file)
  }

  setReady(isReady: boolean): void {
    this.ownIsReady = isReady
    if (this.status.state === 'ready') this.sendSetReady(isReady)
    this.updateOwnReadinessInRoom()
  }

  private updateOwnReadinessInRoom(): void {
    if (!this.config) return
    const me = this.roomUsers.find((u) => u.username === this.config!.username)
    if (me) {
      if (me.isReady === this.ownIsReady) return
      me.isReady = this.ownIsReady
    } else {
      this.roomUsers.push({ username: this.config.username, file: null, isReady: this.ownIsReady })
    }
    this.emit('room-users', this.roomUsers.slice())
  }

  sendLocalState(payload: {
    paused: boolean
    position: number
    cause: 'play' | 'pause' | 'seek'
  }): void {
    this.snapshot = { position: payload.position, paused: payload.paused }
    this.lastSnapshotAt = Date.now()
    // These arrive from the <video> element's own play/pause/seeked events,
    // which a freshly opened player fires at ~0 while it loads — before any
    // remote state has been applied, so the renderer's suppression window
    // isn't up yet. That is not the user driving the room, and treating it as
    // such is what pulled everyone back to 0 on "Join & watch". Until we have
    // converged, such an event changes nothing on the wire: no assertion, and
    // no ignore-counter bump either — the counter makes handleState() drop
    // inbound states, which would starve the very convergence we're waiting
    // for and desync the session outright.
    if (!this.isAdopted()) {
      log('local-state (pre-adoption, not sent)', payload.cause, 'pos=', payload.position)
      return
    }
    // Belt to the renderer's braces: a seek that lands where the room already
    // is carries no intent — it is the element finishing the seek we applied
    // *from* the room. Re-asserting it with doSeek hands the peer their own
    // position back, drags the room to a stale point if it has moved on, and
    // bumps the ignore counter so inbound states get dropped. Live sessions
    // showed exactly this: `local-state seek pos=309.228948` answering
    // `remote-state position: 309.2289481359405 setBy: mikkerlo`.
    // Compared against the position we *handed the renderer*, not the room's
    // projected one: the element reports back exactly what it was told to seek
    // to, however long it took, while the room has moved on in the meantime.
    if (
      payload.cause === 'seek' &&
      this.lastAppliedRemotePosition !== null &&
      Math.abs(payload.position - this.lastAppliedRemotePosition) < ECHO_SEEK_EPSILON_S
    ) {
      log('local-state (seek echoes an applied remote state, not sent) pos=', payload.position)
      this.lastAppliedRemotePosition = null
      return
    }
    // Asserting makes our position the room's, which retires any in-flight
    // target: leaving it armed would silently drop a later, genuine seek that
    // happened to land on a peer's old position.
    this.lastAppliedRemotePosition = null
    this.clientIgnoreCounter += 1
    this.pendingClientAck = this.clientIgnoreCounter
    log(
      'local-state',
      payload.cause,
      'counter=',
      this.clientIgnoreCounter,
      'pos=',
      payload.position
    )
    this.sendStateMessage({ doSeek: payload.cause === 'seek' })
  }

  updateSnapshot(snap: SyncplaySnapshot): void {
    // A push arriving after a stale gap is a *different* <video>, not the old
    // one continuing: reopening the same episode gets a fresh element at 0 and
    // setFile()'s identity check can't see it (same canonicalName). Re-converge
    // before asserting; a false positive re-adopts on the next tick.
    if (!this.hasLivePlayback()) this.playbackAdopted = false
    this.snapshot = snap
    this.lastSnapshotAt = Date.now()
  }

  private tearDown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeat()
    if (this.socket) {
      try {
        this.socket.removeAllListeners()
        this.socket.destroy()
      } catch {
        // ignore
      }
      this.socket = null
    }
    this.resetTransportState()
    this.roomUsers = []
    this.ownIsReady = true
    // Session-scoped, like roomUsers: a new session must not inherit the last
    // one's playback claim (which would let a stale snapshot move the next
    // room) or its room state. A *reconnect* keeps both — it doesn't come
    // through here — because the player and the room are still the same.
    this.snapshot = { position: 0, paused: true }
    this.lastSnapshotAt = 0
    this.lastRoomState = null
    this.playbackAdopted = false
    this.lastAppliedRemotePosition = null
  }

  // State that belongs to one socket, not to the session. The reconnect path in
  // onSocketClose() opens a brand-new socket without going through tearDown(),
  // so it has to clear this too — most importantly `tlsUpgraded`: leaving it set
  // makes handleTls() treat the new socket's probe reply as a spurious
  // post-upgrade message, so we never call tls.connect() again and the retry
  // hangs in 'tls-probing' until the server times it out. Room membership and
  // the readiness toggle deliberately survive a reconnect — the server replaces
  // them with a fresh List and finishHandshake() re-sends readiness.
  private resetTransportState(): void {
    this.rxBuffer = ''
    this.tlsUpgraded = false
    this.clientIgnoreCounter = 0
    this.pendingClientAck = 0
    this.pendingServerAck = 0
    this.serverRtt = 0
    this.garbageParseFailures = 0
    this.garbageBytes = 0
    this.sawValidMessage = false
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  private disconnectInternal(userInitiated: boolean): void {
    this.tearDown()
    if (userInitiated) {
      this.config = null
      // Clear any prior failure: the popover renders status.error unconditional
      // on state, and setStatus() merges — without this an explicit Disconnect
      // after a failed connect keeps the old diagnosis rendered under 'idle'.
      this.setStatus({ state: 'idle', error: undefined })
    }
  }

  private openSocket(): void {
    if (!this.config) return
    const { host, port } = this.config
    this.lastAttemptPhase = 'connecting'
    this.lastSocketError = null
    this.lastServerError = null
    this.watchdogDetail = null
    this.watchdogFired = false
    this.setStatus({
      state: this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting',
      host,
      port,
      room: this.config.room,
      username: this.config.username,
      tls: false,
      error: undefined
    })
    log('connecting', host, port)

    const sock = net.createConnection({ host, port })
    sock.setKeepAlive(true, 30_000)
    this.socket = sock
    this.rxBuffer = ''

    sock.on('connect', () => {
      log('tcp connected — probing TLS')
      this.setStatus({ state: 'tls-probing' })
      // TLS-only: probe before sending Hello so credentials are never on the
      // wire in plaintext. The key MUST be `startTLS` — a Syncplay server reads
      // `message["startTLS"]` and drops the connection outright on anything else
      // (we shipped `option` until #216, which made every connect fail instantly).
      // The server replies with {TLS:{startTLS:'true'|'false'}}; anything other
      // than 'true' aborts the connection.
      this.sendJson({ TLS: { startTLS: 'send' } })
    })
    sock.on('data', (chunk) => this.onData(chunk))
    sock.on('error', (err) => this.onSocketError(err))
    sock.on('close', () => this.onSocketClose())

    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null
      this.onWatchdogFire()
    }, WATCHDOG_MS)
  }

  private onWatchdogFire(): void {
    const wording = watchdogWording(this.lastAttemptPhase)
    this.watchdogDetail = wording
    this.watchdogFired = true
    log('watchdog fired in', this.lastAttemptPhase)
    this.emit('room-event', { level: 'warn', text: wording.long })
    // Destroy this.socket, not a captured local: after the TLS upgrade the
    // openSocket() closure's socket is the raw one underneath the live
    // tls.TLSSocket, and destroying it produces a different event sequence.
    // The 'close' that follows runs the normal reconnect path — a transient
    // hang gets the retries auto-reconnect exists for; hard aborts stay
    // reserved for failures a retry provably can't fix.
    this.socket?.destroy()
  }

  private onData(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (this.status.state !== 'ready' && !this.sawValidMessage) {
      // Catches garbage with no newlines at all (nothing ever reaches the
      // parser): an attempt that has received this much without one valid
      // message is not a Syncplay handshake.
      this.garbageBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      if (this.garbageBytes >= GARBAGE_BYTE_CAP) {
        this.failHandshake(GARBAGE_REASON)
        return
      }
    }
    this.rxBuffer += text
    let idx: number
    while ((idx = this.rxBuffer.indexOf('\n')) >= 0) {
      const line = this.rxBuffer.slice(0, idx).trim()
      this.rxBuffer = this.rxBuffer.slice(idx + 1)
      if (!line) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch (err) {
        log('json parse error', err, line.slice(0, 200))
        // Read the live state, not a pre-loop snapshot: dispatch() below can
        // reach finishHandshake() mid-chunk, and a Hello packed together with
        // unparseable lines must not let the garbage detector abort a session
        // that already reached ready.
        if (this.status.state !== 'ready') {
          this.garbageParseFailures += 1
          if (this.garbageParseFailures >= GARBAGE_PARSE_FAILURE_LIMIT) {
            this.failHandshake(GARBAGE_REASON)
            return
          }
        }
        continue
      }
      this.sawValidMessage = true
      if (!isObject(msg)) continue
      this.dispatch(msg)
    }
  }

  private dispatch(msg: JsonObject): void {
    const keys = Object.keys(msg).join(',')
    log('<<', keys)
    if (DEBUG) this.emit('trace', { dir: 'in', keys, msg })
    if ('Hello' in msg) this.handleHello(msg.Hello)
    if ('Set' in msg) this.handleSet(msg.Set)
    if ('List' in msg) this.handleList(msg.List)
    if ('State' in msg) this.handleState(msg.State)
    if ('Chat' in msg) this.handleChat(msg.Chat)
    if ('Error' in msg) this.handleError(msg.Error)
    if ('TLS' in msg) this.handleTls(msg.TLS)
  }

  private handleHello(payload: unknown): void {
    if (!isObject(payload) || !this.config) return
    const motd = typeof payload.motd === 'string' ? payload.motd : ''
    this.serverMotd = motd

    const advertisedUsername =
      typeof payload.username === 'string' ? payload.username : this.config.username
    if (advertisedUsername !== this.config.username) {
      this.emit('room-event', {
        level: 'info',
        text: `Joined as "${advertisedUsername}" (server rewrote username)`
      })
      this.config = { ...this.config, username: advertisedUsername }
    }

    // Adopt the room name the server actually seated us in — it may have
    // canonicalized ours, and the `List` roster is keyed by the server's name.
    if (isObject(payload.room) && typeof payload.room.name === 'string' && payload.room.name) {
      this.config = { ...this.config, room: payload.room.name }
    }

    if (motd) this.emit('room-event', { level: 'info', text: motd })

    this.finishHandshake()
  }

  private finishHandshake(): void {
    if (!this.config) return
    // A failure from an earlier phase must not outlive a successful
    // connection — without this, a clean server FIN hours later would
    // resurface the stale pre-ready detail as the disconnect reason. The
    // per-attempt reset in openSocket() does not cover a login-phase server
    // Error on an attempt that reaches ready anyway ("Room name is invalid"
    // then Hello), so the clear has to happen here too.
    this.lastSocketError = null
    this.lastServerError = null
    this.watchdogDetail = null
    this.watchdogFired = false
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
    this.setStatus({
      state: 'ready',
      host: this.config.host,
      port: this.config.port,
      room: this.config.room,
      username: this.config.username,
      tls: this.tlsUpgraded,
      error: undefined
    })
    this.reconnectAttempts = 0
    if (this.currentFile) this.sendSetFile(this.currentFile)
    this.sendSetReady(this.ownIsReady)
    this.updateOwnReadinessInRoom()
    // Ask for the membership roster. The server only *broadcasts* `Set: {user}`
    // for changes that happen while we're connected, so without this request
    // everyone already sitting in the room stays invisible and the view reads
    // "Room is empty — you're the first one here". Re-requested on every
    // reconnect, which is also how membership resyncs after a drop.
    this.sendJson({ List: null })
    this.startHeartbeat()
  }

  private handleTls(payload: unknown): void {
    if (!isObject(payload)) return
    if (this.tlsUpgraded) {
      // Spurious post-upgrade TLS message — ignore.
      return
    }
    if (payload.startTLS === 'true' || payload.startTLS === true) {
      this.upgradeToTls()
    } else {
      this.failHandshake(
        'Server does not support TLS — TLS-only mode requires a TLS-capable Syncplay server (1.6.3+).'
      )
    }
  }

  private upgradeToTls(): void {
    if (!this.socket || !this.config) return
    log('upgrading to TLS')
    this.setStatus({ state: 'tls-handshake' })
    const raw = this.socket
    raw.removeAllListeners('data')
    raw.removeAllListeners('error')
    raw.removeAllListeners('close')
    const tlsSock = tls.connect({
      socket: raw,
      servername: this.config.host
    })
    this.socket = tlsSock
    this.rxBuffer = ''
    tlsSock.on('secureConnect', () => {
      log('tls secured')
      this.tlsUpgraded = true
      this.setStatus({ state: 'hello-sent' })
      this.sendHello()
    })
    tlsSock.on('data', (chunk) => this.onData(chunk))
    tlsSock.on('error', (err) => this.onSocketError(err))
    tlsSock.on('close', () => this.onSocketClose())
  }

  private failHandshake(reason: string): void {
    log('handshake failed:', reason)
    this.emit('room-event', { level: 'error', text: reason })
    // Single broadcast: tear down quietly, then emit one disconnected status
    // that carries the error. Going through disconnectInternal would emit a
    // separate 'idle' event afterward and clobber the error for any consumer
    // that reads status.error after the fact.
    this.tearDown()
    this.config = null
    this.setStatus({ state: 'disconnected', error: reason })
  }

  private handleSet(payload: unknown): void {
    if (!isObject(payload)) return
    let usersDirty = false
    if (isObject(payload.user)) {
      const ownRoom = this.config?.room
      for (const [username, data] of Object.entries(payload.user)) {
        if (!isObject(data)) continue

        // Scope the entry to our own room (#230). With `isolateRooms` off —
        // the reference server's default — `RoomManager.broadcast` fans
        // `Set: {user}` out to *every* room, so an unscoped handler seats
        // strangers, logs their episode changes and lets their file frames
        // navigate our player. `sendUserSetting` always writes `room` into the
        // entry; a missing one only comes from a proxy or a non-reference
        // server, and is read as ours to preserve today's behavior.
        //
        // The filter is ordered, not flat, and it has to sit at the loop head:
        // gating inside absorbRemoteFile would still seat the stranger, since
        // that function pushes the user and emits `room-users` before it ever
        // reaches its own self-guard.
        const entryRoom =
          isObject(data.room) && typeof data.room.name === 'string' ? data.room.name : undefined
        // No `ownRoom !== undefined` clause: `config.room` is a `string`, so an
        // undefined own room means `this.config` is null — and both sites that
        // null it tear the transport down first, clearing `rxBuffer` mid-drain
        // and stripping the socket's listeners, so no frame reaches here
        // without a config. Comparing straight through therefore changes no
        // reachable behavior; it just makes an unknown own room read as
        // *off*-room rather than as "no filter", so the failure mode if that
        // invariant ever breaks is dropping strangers, not seating them.
        const offRoom = entryRoom !== undefined && entryRoom !== ownRoom
        // Rule 0: never filter ourselves. A self entry naming another room
        // can't come from a reference server (the server only relocates a
        // watcher that asked to move, and we never send `Set: {room}`), so we
        // take the cheap guard. Note it exempts, it does not skip: our own
        // file push is broadcast back to us without sender exclusion, and
        // absorbRemoteFile is what keeps our roster row's file current between
        // `List` replies.
        if (username !== this.config?.username && offRoom) {
          // Rule 2: a peer switching out reaches us as one entry naming their
          // **destination**, with no `left` event — `sendRoomSwitchMessage`
          // broadcasts after `moveWatcher` has already reassigned the room.
          // So any off-room entry naming someone we have seated is a leave.
          // This must precede the `file` branch, or absorbRemoteFile re-seats
          // the user we just removed on a frame carrying both.
          if (this.roomUsers.some((u) => u.username === username)) {
            this.emit('room-event', { level: 'info', text: `${username} left the room` })
            this.roomUsers = this.roomUsers.filter((u) => u.username !== username)
            usersDirty = true
          }
          // Rule 3: an off-room stranger is ignored whole — `file` and
          // `isReady` included.
          continue
        }
        // Rule 1: an in-room entry carrying a room and neither `event` nor
        // `file` is a switch *into* our room, which otherwise reaches us as
        // nothing at all. The announcement is gated on `file` because
        // `sendFileUpdate` emits `{room, file}` with no `event` on the hot
        // path, and there absorbRemoteFile already announces the switch and
        // owns the seating. `isReady` is excluded on the same principle: the
        // branch at the bottom of the loop seats the user itself, so a
        // `{room, isReady}` entry would announce a join in front of it. That
        // shape is unreachable against a reference server (live readiness is a
        // *top-level* `Set: {ready}`, and `user[X].isReady` is dead code —
        // see docs/syncplay.md), so this keeps the announcement to frames that
        // carry a room and nothing that already speaks for itself.
        if (
          entryRoom !== undefined &&
          username !== this.config?.username &&
          !isObject(data.event) &&
          !isObject(data.file) &&
          data.isReady === undefined &&
          !this.roomUsers.some((u) => u.username === username)
        ) {
          this.emit('room-event', { level: 'info', text: `${username} joined the room` })
          this.roomUsers.push({ username, file: null })
          usersDirty = true
        }

        if (isObject(data.event)) {
          if (data.event.left === true) {
            this.emit('room-event', { level: 'info', text: `${username} left the room` })
            this.roomUsers = this.roomUsers.filter((u) => u.username !== username)
            usersDirty = true
          } else if (data.event.joined === true) {
            this.emit('room-event', { level: 'info', text: `${username} joined the room` })
            if (!this.roomUsers.find((u) => u.username === username)) {
              this.roomUsers.push({ username, file: null })
              usersDirty = true
            }
          }
        }
        if (isObject(data.file)) {
          this.absorbRemoteFile(username, data.file)
        }
        if (isObject(data.isReady) || typeof data.isReady === 'boolean') {
          const isReady =
            typeof data.isReady === 'boolean' ? data.isReady : data.isReady.isReady === true
          let u = this.roomUsers.find((x) => x.username === username)
          if (!u) {
            u = { username, file: null }
            this.roomUsers.push(u)
          }
          if (u.isReady !== isReady) {
            u.isReady = isReady
            usersDirty = true
          }
        }
      }
    }
    // No top-level `payload.room` branch: that field is a client→server
    // command (the server consumes it, no server-side `sendSet` emits it).
    // Since the room filter above keys off `this.config.room`, honouring it
    // would let one unsolicited frame rewrite the filter's reference name
    // mid-session and re-expose every stranger. `handleHello` already adopts
    // the server's canonical name at the only moment that can legitimately
    // happen.
    if (usersDirty) this.emit('room-users', this.roomUsers.slice())
  }

  // `Set: {user:{X:{file}}}` and the `List` roster carry the same file shape,
  // and "Join & watch" only offers a peer whose metadata survived the parse —
  // so both paths must read it the same way.
  private extractAppMeta(file: JsonObject): SyncplayRoomUser['animeDlAppMeta'] {
    if (!isObject(file.features) || !isObject(file.features.animeDlAppMeta)) return undefined
    const m = file.features.animeDlAppMeta
    if (typeof m.animeId !== 'number' || typeof m.episodeInt !== 'string') return undefined
    return {
      animeId: m.animeId,
      malId: typeof m.malId === 'number' ? m.malId : null,
      episodeInt: m.episodeInt,
      translationId: typeof m.translationId === 'number' ? m.translationId : null
    }
  }

  // The server's `List` reply covers *every* room it knows, so flattening it
  // would seat strangers from other rooms in ours. Prefer our own room by
  // name; if the server canonicalized the name out from under us, a payload
  // with exactly one room must still be ours — we're in it.
  //
  // Despite the name this is a **mutator** on the fallback arm: it adopts that
  // entry's key into `config.room` *and* `status.room` (see below).
  private pickOwnRoom(payload: JsonObject): unknown {
    // hasOwnProperty, not `payload[name] !== undefined`: a room named
    // `constructor` or `toString` would otherwise resolve to the prototype's
    // member, skip the fallback, and fail isObject() — an empty roster.
    const ownName = this.config?.room ?? ''
    if (Object.prototype.hasOwnProperty.call(payload, ownName)) return payload[ownName]
    const rooms = Object.entries(payload)
    if (rooms.length !== 1) return undefined
    // Adopt the fallback room's *name*, not just its roster. `handleSet`'s
    // room filter (#230) keys off `this.config.room`, so leaving the stale
    // name here would make every subsequent in-room `Set` entry read as
    // off-room and evict each peer as they push a file — a roster that fills
    // from `List` and then empties itself.
    const [name, entry] = rooms[0]
    if (this.config) {
      this.config = { ...this.config, room: name }
      // `status.room` is the third copy of the name and the one the view
      // renders. `finishHandshake` already emitted the pre-adoption name, and
      // every later setStatus that carries a room reads it back off the config
      // (openSocket, both scheduleReconnect arms) — so without this the
      // displayed room would silently change on the next reconnect.
      this.setStatus({ room: name })
    }
    return entry
  }

  private absorbRemoteFile(username: string, file: JsonObject): void {
    const name = typeof file.name === 'string' ? file.name : ''
    const duration = typeof file.duration === 'number' ? file.duration : 0
    const size = typeof file.size === 'number' ? file.size : undefined
    const meta = this.extractAppMeta(file)
    let user = this.roomUsers.find((u) => u.username === username)
    if (!user) {
      user = { username, file: null }
      this.roomUsers.push(user)
    }
    user.file = { name, duration, size }
    user.animeDlAppMeta = meta

    this.emit('room-users', this.roomUsers.slice())
    if (username !== this.config?.username) {
      this.emit('room-event', {
        level: 'info',
        text: `${username} switched to "${name}"`
      })
    }

    if (meta && username !== this.config?.username) {
      const key = `${username}|${meta.animeId}|${meta.episodeInt}`
      if (key !== this.lastAppliedRoomEpisode) {
        this.lastAppliedRoomEpisode = key
        this.emit('remote-episode-change', {
          animeId: meta.animeId,
          malId: meta.malId,
          episodeInt: meta.episodeInt,
          translationId: meta.translationId,
          canonicalName: name,
          fromUser: username
        })
      }
    }
  }

  private handleList(payload: unknown): void {
    if (!isObject(payload) || !this.config) return
    const users: SyncplayRoomUser[] = []
    const roomEntry = this.pickOwnRoom(payload)
    if (isObject(roomEntry)) {
      for (const [username, data] of Object.entries(roomEntry)) {
        if (!isObject(data)) continue
        const file = isObject(data.file)
          ? {
              name: typeof data.file.name === 'string' ? data.file.name : '',
              duration: typeof data.file.duration === 'number' ? data.file.duration : 0,
              size: typeof data.file.size === 'number' ? data.file.size : undefined
            }
          : null
        const isReady = typeof data.isReady === 'boolean' ? data.isReady : undefined
        const meta = isObject(data.file) ? this.extractAppMeta(data.file) : undefined
        // The reference server writes `file: {}` — never null, never absent —
        // for a watcher with nothing loaded, so `file` above is a hollow
        // {name:'', duration:0} for them and the view would render an empty
        // file line. The `Set` path can't reach this: it omits a falsy file.
        const hasFile = file !== null && file.name !== ''
        users.push({ username, file: hasFile ? file : null, isReady, animeDlAppMeta: meta })
      }
    }
    if (this.config) {
      const me = users.find((u) => u.username === this.config!.username)
      if (me) me.isReady = this.ownIsReady
      else users.push({ username: this.config.username, file: null, isReady: this.ownIsReady })
    }
    this.roomUsers = users
    this.emit('room-users', users.slice())
  }

  private handleState(payload: unknown): void {
    if (!isObject(payload)) return
    const ps = isObject(payload.playstate) ? payload.playstate : null
    const ping = isObject(payload.ping) ? payload.ping : null
    const iotf = isObject(payload.ignoringOnTheFly) ? payload.ignoringOnTheFly : {}

    if (ping) {
      const myTs =
        typeof ping.clientLatencyCalculation === 'number' ? ping.clientLatencyCalculation : null
      if (myTs !== null) {
        const rtt = Date.now() / 1000 - myTs
        if (rtt > 0 && rtt < 5) this.serverRtt = rtt
      }
    }

    const serverCounter = typeof iotf.server === 'number' ? iotf.server : null
    const clientEcho = typeof iotf.client === 'number' ? iotf.client : null

    if (serverCounter !== null) {
      this.pendingServerAck = serverCounter
    }
    if (clientEcho !== null) {
      if (clientEcho === this.pendingClientAck) this.pendingClientAck = 0
    }

    if (!ps) return

    const setBy = typeof ps.setBy === 'string' ? ps.setBy : null
    const position = typeof ps.position === 'number' ? ps.position : 0
    const paused = ps.paused === true
    const doSeek = ps.doSeek === true

    // Record the room's view before the echo guards below: a spectator mirrors
    // this back to the server, and the server's own periodic States (no setBy)
    // are exactly the ones that keep it fresh.
    this.lastRoomState = { position, paused, at: Date.now() }

    if (setBy === null) return
    if (this.config && setBy.toLowerCase() === this.config.username.toLowerCase()) return
    if (this.pendingClientAck !== 0) {
      log('drop remote state — local change unacked (counter=', this.pendingClientAck, ')')
      return
    }

    const compensated = position + this.serverRtt / 2
    this.lastAppliedRemotePosition = Math.max(0, compensated)
    log('remote-state', { paused, position: compensated, setBy, doSeek })
    this.emit('remote-state', {
      paused,
      position: compensated,
      setBy,
      doSeek
    })
  }

  private handleChat(payload: unknown): void {
    if (!isObject(payload)) return
    const user = typeof payload.username === 'string' ? payload.username : ''
    const text = typeof payload.message === 'string' ? payload.message : ''
    if (!text) return
    this.emit('room-event', { level: 'chat', text: user ? `${user}: ${text}` : text })
  }

  private handleError(payload: unknown): void {
    if (!isObject(payload)) return
    const text = typeof payload.message === 'string' ? payload.message : 'Server error'
    console.warn('[syncplay] server error:', text)
    this.emit('room-event', { level: 'error', text })
    if (/version|password|banned/i.test(text)) {
      if (this.config) {
        const prevConfig = this.config
        this.disconnectInternal(true)
        this.setStatus({
          state: 'disconnected',
          host: prevConfig.host,
          port: prevConfig.port,
          room: prevConfig.room,
          username: prevConfig.username,
          error: text
        })
      }
    } else if (this.status.state !== 'ready') {
      // Remember the server's own explanation so a FIN right after it does not
      // read "closed during login without a reply". Once ready the frame stays
      // a room-event only — otherwise a complaint from hours ago would outrank
      // "Connection to the server was lost" at the eventual drop. Note the same
      // text is deliberately shown twice on close (room-event + status.error),
      // matching how the escalated branch above already behaves.
      this.lastServerError = text
    }
  }

  private sendHello(): void {
    if (!this.config) return
    const features: JsonObject = {
      sharedPlaylists: false,
      chat: true,
      featureList: true,
      readiness: true,
      managedRooms: true,
      persistentRooms: false
    }
    const hello: JsonObject = {
      username: this.config.username,
      room: { name: this.config.room },
      version: CLIENT_VERSION,
      features
    }
    // Syncplay's wire format for the server password is an MD5 hex digest: the
    // server MD5s its own `--password` at startup and compares digests, so a
    // plaintext password is always rejected with "Wrong password supplied".
    // MD5 is the protocol's choice, not a security claim on our side — the
    // whole session already runs inside TLS. Matches the reference client,
    // which hashes unconditionally (a pre-hashed value would be hashed again).
    if (this.config.password) hello.password = md5Hex(this.config.password)
    this.sendJson({ Hello: hello })
  }

  private sendSetReady(isReady: boolean): void {
    this.sendJson({ Set: { ready: { isReady, manuallyInitiated: false } } })
  }

  private sendSetFile(file: SyncplayFileInfo): void {
    const set: JsonObject = {
      file: {
        name: file.canonicalName,
        duration: file.duration,
        size: 0,
        features: {
          animeDlAppMeta: {
            animeId: file.animeId,
            malId: file.malId,
            episodeInt: file.episodeInt,
            translationId: file.translationId
          }
        }
      }
    }
    this.sendJson({ Set: set })
  }

  // Whether a real player is driving us right now. The Watch Together view
  // joins a room *before* any player exists, and closing the player stops the
  // renderer's snapshot pushes while the connection lives on.
  private hasLivePlayback(): boolean {
    return this.lastSnapshotAt > 0 && Date.now() - this.lastSnapshotAt <= PLAYBACK_STALE_MS
  }

  // The playstate to assert, or null to assert none at all.
  //
  // Without a live player our `snapshot` is the initial {position: 0, paused:
  // true} (or a frozen leftover from a closed player), and the 1 s heartbeat
  // used to broadcast it unconditionally: joining a room from the Watch
  // Together view yanked everyone else back to 0 and paused them. A spectator
  // must never move the room, so it echoes the room's own last known state —
  // advanced by wall time while the room is playing, so we don't read as the
  // lagging user either — and sends no playstate at all until the server has
  // told us one (ping-only messages keep RTT calibration alive).
  private buildPlaystate(doSeek: boolean): JsonObject | null {
    // The snapshot now carries the renderer's *intent*, not the element's flag
    // (the readiness gate and the MSE buffer refill move the element on their
    // own), so it is safe to assert while buffering: a genuine user pause must
    // stick. Withholding it here instead — an earlier attempt at the same bug
    // — meant the next heartbeat mirrored the room's "playing" back and undid
    // the user's own pause a second after they pressed it.
    if (this.hasLivePlayback() && this.isAdopted()) {
      return {
        position: this.snapshot.position,
        paused: this.snapshot.paused,
        doSeek
      }
    }
    const room = this.lastRoomState
    if (!room) return null
    // Position only, no `paused`: the reference server reads a missing paused
    // as "no claim" (__hasPauseChanged(None) is False) while still applying the
    // position — so the mirror keeps our server-side watcher glued to the room
    // (a stale stored position would drag the min() room position back after a
    // room seek) but can never flip the room's pause. Mirroring `room.paused`
    // raced the room's own in-flight pause broadcasts: a heartbeat crossing a
    // peer's fresh pause on the wire unpaused the room, setBy us.
    //
    // Known consequence: the server reads a missing paused as not-paused in
    // _updatePositionByAge too, so it forward-delay-compensates the mirrored
    // position even while the room is paused. Invisible with peers present (we
    // land ahead, never the min()), but spectating *alone* in a paused room our
    // own crept value comes back as lastRoomState and compounds at ~one forward
    // delay per second. Nobody is watching in that state and adopting a player
    // resets it — documented rather than fixed, so it isn't rediscovered as
    // "the room moved while I was away".
    return {
      position: this.projectedRoomPosition(room),
      doSeek: false
    }
  }

  // Where the room is *now*: its last reported position, advanced by wall time
  // if it kept playing. Mirroring a stale position would read as lag.
  private projectedRoomPosition(room: { position: number; paused: boolean; at: number }): number {
    const elapsed = room.paused ? 0 : (Date.now() - room.at) / 1000
    return room.position + elapsed
  }

  // A player is driving us, but is it playing *this room's* content yet? With
  // no room state there is nothing to contradict — the first user in a room
  // establishes its position. Otherwise we wait until our position has
  // converged; the renderer's apply rule seeks us there within a heartbeat or
  // two. Latches, so ordinary drift later never demotes a live player.
  private isAdopted(): boolean {
    if (this.playbackAdopted) return true
    const room = this.lastRoomState
    if (!room) {
      // Alone in the room we establish its position. With peers present and no
      // State yet we are simply early — our heartbeat starts at
      // finishHandshake() and can beat the server's first State — so hold off
      // rather than guess: buildPlaystate() then falls through to the
      // ping-only frame, which is the right answer for "a player exists but we
      // don't know where the room is". The roster is the signal that we're not
      // first; it's why this PR requests it.
      const alone = this.roomUsers.filter((u) => u.username !== this.config?.username).length === 0
      if (alone) this.playbackAdopted = true
      return this.playbackAdopted
    }
    const drift = Math.abs(this.snapshot.position - this.projectedRoomPosition(room))
    if (drift <= ADOPT_TOLERANCE_S) this.playbackAdopted = true
    return this.playbackAdopted
  }

  private sendStateMessage(opts: { doSeek: boolean }): void {
    if (this.status.state !== 'ready') return
    const msg: JsonObject = {
      ping: {
        clientLatencyCalculation: Date.now() / 1000,
        ...(this.serverRtt > 0 ? { clientRtt: this.serverRtt } : {})
      }
    }
    const playstate = this.buildPlaystate(opts.doSeek)
    if (playstate) msg.playstate = playstate
    const iotf: JsonObject = {}
    if (this.pendingClientAck > 0) iotf.client = this.pendingClientAck
    if (this.pendingServerAck > 0) {
      iotf.server = this.pendingServerAck
      this.pendingServerAck = 0
    }
    if (Object.keys(iotf).length > 0) msg.ignoringOnTheFly = iotf
    this.sendJson({ State: msg })
  }

  private sendJson(obj: unknown): void {
    if (!this.socket) return
    const keys = Object.keys(obj as JsonObject).join(',')
    try {
      this.socket.write(JSON.stringify(obj) + '\r\n')
      log('>>', keys)
      if (DEBUG) this.emit('trace', { dir: 'out', keys, msg: obj })
    } catch (err) {
      console.warn('[syncplay] write error:', err)
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.sendStateMessage({ doSeek: false })
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private onSocketError(err: Error & { code?: string }): void {
    const code = err.code ? ` (${err.code})` : ''
    console.warn('[syncplay] socket error:', err.message + code)
    // Node's message usually embeds the code ("connect ECONNREFUSED 1.2.3.4:8999");
    // append it only when it doesn't, so the surfaced reason never duplicates.
    this.lastSocketError =
      err.code && !err.message.includes(err.code) ? err.message + code : err.message
    // Errors after a watchdog fire are manufactured by our own destroy() —
    // destroying a tls.TLSSocket before secureConnect emits ECONNRESET, the
    // exact signature the fatal-TLS classifier below treats as a hard abort,
    // and the fall-through room-event would report the app's own destroy as
    // the server's fault. Both are suppressed for this attempt; the recorded
    // lastSocketError is harmless because watchdogDetail outranks it in the
    // disconnect-reason composition.
    if (this.watchdogFired) return
    // TLS / certificate validation failures are not transient — don't burn
    // five reconnect attempts on a misconfigured server. Disconnect cleanly
    // with a clear error and stop. Detected by Node TLS error codes (all
    // cert-trust failures start with `CERT_*` or `*_CERT_*`, plus the
    // `ERR_TLS_*` family).
    const code2 = typeof err.code === 'string' ? err.code : ''
    const isFatalTls =
      code2.startsWith('ERR_TLS_') ||
      code2.includes('CERT_') ||
      code2 === 'EPROTO' ||
      (code2 === 'ECONNRESET' && this.status.state === 'tls-handshake')
    if (isFatalTls) {
      this.failHandshake(`TLS error${code}: ${err.message}`)
      return
    }
    this.emit('room-event', { level: 'warn', text: `Connection error${code}: ${err.message}` })
  }

  private onSocketClose(): void {
    console.warn(
      '[syncplay] socket closed (state=' +
        this.status.state +
        ', tls=' +
        this.tlsUpgraded +
        ', reconnectAttempts=' +
        this.reconnectAttempts +
        ')'
    )
    this.stopHeartbeat()
    if (this.status.state === 'idle') return
    const cfg = this.config
    this.socket = null
    this.resetTransportState()
    if (!cfg) {
      this.setStatus({ state: 'disconnected' })
      return
    }
    if (!cfg.autoReconnect || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      const maxedOut = this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS
      // status.error surfaces in the UI (test-connection button, player
      // popover). 'Auto-reconnect disabled' is *why we're not retrying*, not
      // *why we disconnected* — showing it as the error confuses users (#119).
      // The detail is composed from the *last attempt only*, in precedence
      // order: the server's own Error text, then the transport error (#213),
      // then the phase the attempt reached (#215) — an errorless close always
      // has a phase to name, never the bare "Connection closed".
      const phaseReason = PHASE_CLOSE_REASON[this.lastAttemptPhase]
      let errorReason: string
      if (maxedOut) {
        const detail =
          this.lastServerError ??
          this.watchdogDetail?.short ??
          this.lastSocketError ??
          phaseReason.short
        errorReason = `Max reconnect attempts reached — ${detail}`
      } else if (this.lastServerError) {
        errorReason = this.lastServerError
      } else if (this.watchdogDetail) {
        // Outranks lastSocketError: the destroy that follows a watchdog fire
        // manufactures its own transport error, which must not erase the
        // message the watchdog fired to produce. No "Connection closed"
        // prefix — we closed the socket.
        errorReason = this.watchdogDetail.long
      } else if (this.lastSocketError) {
        errorReason = `Connection closed — ${this.lastSocketError}`
      } else {
        errorReason = phaseReason.long
      }
      const eventReason = maxedOut ? 'Max reconnect attempts reached' : 'auto-reconnect disabled'
      this.setStatus({
        state: 'disconnected',
        host: cfg.host,
        port: cfg.port,
        room: cfg.room,
        username: cfg.username,
        error: errorReason
      })
      this.emit('room-event', {
        level: 'warn',
        text: `Disconnected from Syncplay room: ${eventReason}`
      })
      return
    }
    this.reconnectAttempts += 1
    const delay = RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1)
    console.warn(
      `[syncplay] reconnecting to ${cfg.host}:${cfg.port} in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
    )
    this.setStatus({
      state: 'reconnecting',
      host: cfg.host,
      port: cfg.port,
      room: cfg.room,
      username: cfg.username
    })
    this.emit('room-event', {
      level: 'warn',
      text: `Connection lost — retry ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay / 1000)}s`
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delay)
  }

  private setStatus(patch: Partial<SyncplayStatus>): void {
    // Single point of truth for phase tracking: any transition into one of the
    // five attempt phases advances lastAttemptPhase, so a future phase can't
    // be missed by forgetting a call site. openSocket() resets it per attempt.
    if (patch.state && (ATTEMPT_PHASES as readonly string[]).includes(patch.state)) {
      this.lastAttemptPhase = patch.state as AttemptPhase
    }
    this.status = { ...this.status, ...patch }
    this.emit('connection-status', { ...this.status })
  }
}

export const syncplay = new SyncplayClient()
