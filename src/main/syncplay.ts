import * as net from 'net'
import * as tls from 'tls'
import { EventEmitter } from 'events'

const CLIENT_VERSION = '1.6.9'
const HEARTBEAT_MS = 1000
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_BASE_MS = 1000
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

export class SyncplayClient extends EventEmitter {
  private config: SyncplayConfig | null = null
  private socket: net.Socket | tls.TLSSocket | null = null
  private rxBuffer = ''
  private status: SyncplayStatus = { state: 'idle' }

  private heartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0

  private snapshot: SyncplaySnapshot = { position: 0, paused: true }
  private currentFile: SyncplayFileInfo | null = null
  private serverMotd = ''
  private tlsUpgraded = false
  private roomUsers: SyncplayRoomUser[] = []
  private ownIsReady = true

  private clientIgnoreCounter = 0
  private pendingClientAck = 0
  private pendingServerAck = 0
  private lastAppliedRoomEpisode: string | null = null

  private serverRtt = 0

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

  setFile(file: SyncplayFileInfo): void {
    this.currentFile = file
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
    this.clientIgnoreCounter += 1
    this.pendingClientAck = this.clientIgnoreCounter
    log('local-state', payload.cause, 'counter=', this.clientIgnoreCounter, 'pos=', payload.position)
    this.sendStateMessage({ doSeek: payload.cause === 'seek' })
  }

  updateSnapshot(snap: SyncplaySnapshot): void {
    this.snapshot = snap
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
    this.rxBuffer = ''
    this.tlsUpgraded = false
    this.clientIgnoreCounter = 0
    this.pendingClientAck = 0
    this.pendingServerAck = 0
    this.serverRtt = 0
    this.roomUsers = []
    this.ownIsReady = true
  }

  private disconnectInternal(userInitiated: boolean): void {
    this.tearDown()
    if (userInitiated) {
      this.config = null
      this.setStatus({ state: 'idle' })
    }
  }

  private openSocket(): void {
    if (!this.config) return
    const { host, port } = this.config
    this.setStatus({
      state: this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting',
      host,
      port,
      room: this.config.room,
      username: this.config.username,
      tls: false
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
      // wire in plaintext. The server replies with {TLS:{startTLS:'true'|'false'}};
      // anything other than 'true' aborts the connection.
      this.sendJson({ TLS: { option: 'send' } })
    })
    sock.on('data', (chunk) => this.onData(chunk))
    sock.on('error', (err) => this.onSocketError(err))
    sock.on('close', () => this.onSocketClose())
  }

  private onData(chunk: Buffer | string): void {
    this.rxBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
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
        continue
      }
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

    const advertisedUsername = typeof payload.username === 'string' ? payload.username : this.config.username
    if (advertisedUsername !== this.config.username) {
      this.emit('room-event', {
        level: 'info',
        text: `Joined as "${advertisedUsername}" (server rewrote username)`
      })
      this.config = { ...this.config, username: advertisedUsername }
    }

    if (motd) this.emit('room-event', { level: 'info', text: motd })

    this.finishHandshake()
  }

  private finishHandshake(): void {
    if (!this.config) return
    this.setStatus({
      state: 'ready',
      host: this.config.host,
      port: this.config.port,
      room: this.config.room,
      username: this.config.username,
      tls: this.tlsUpgraded
    })
    this.reconnectAttempts = 0
    if (this.currentFile) this.sendSetFile(this.currentFile)
    this.sendSetReady(this.ownIsReady)
    this.updateOwnReadinessInRoom()
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
      this.failHandshake('Server does not support TLS — TLS-only mode requires a TLS-capable Syncplay server (1.6.3+).')
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
      for (const [username, data] of Object.entries(payload.user)) {
        if (!isObject(data)) continue
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
          const isReady = typeof data.isReady === 'boolean'
            ? data.isReady
            : data.isReady.isReady === true
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
    if (isObject(payload.room)) {
      const name = typeof payload.room.name === 'string' ? payload.room.name : undefined
      if (name && this.config) this.config.room = name
    }
    if (usersDirty) this.emit('room-users', this.roomUsers.slice())
  }

  private absorbRemoteFile(username: string, file: JsonObject): void {
    const name = typeof file.name === 'string' ? file.name : ''
    const duration = typeof file.duration === 'number' ? file.duration : 0
    const size = typeof file.size === 'number' ? file.size : undefined
    let meta: SyncplayRoomUser['animeDlAppMeta']
    if (isObject(file.features) && isObject(file.features.animeDlAppMeta)) {
      const m = file.features.animeDlAppMeta
      if (typeof m.animeId === 'number' && typeof m.episodeInt === 'string') {
        meta = {
          animeId: m.animeId,
          malId: typeof m.malId === 'number' ? m.malId : null,
          episodeInt: m.episodeInt,
          translationId: typeof m.translationId === 'number' ? m.translationId : null
        }
      }
    }
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
    if (!isObject(payload)) return
    const users: SyncplayRoomUser[] = []
    for (const [_roomName, roomEntry] of Object.entries(payload)) {
      if (!isObject(roomEntry)) continue
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
        users.push({ username, file, isReady })
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
      const myTs = typeof ping.clientLatencyCalculation === 'number' ? ping.clientLatencyCalculation : null
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

    if (setBy === null) return
    if (this.config && setBy.toLowerCase() === this.config.username.toLowerCase()) return
    if (this.pendingClientAck !== 0) {
      log('drop remote state — local change unacked (counter=', this.pendingClientAck, ')')
      return
    }

    const compensated = position + this.serverRtt / 2
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
    if (this.config.password) hello.password = this.config.password
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

  private sendStateMessage(opts: { doSeek: boolean }): void {
    if (this.status.state !== 'ready') return
    const msg: JsonObject = {
      playstate: {
        position: this.snapshot.position,
        paused: this.snapshot.paused,
        doSeek: opts.doSeek
      },
      ping: {
        clientLatencyCalculation: Date.now() / 1000,
        ...(this.serverRtt > 0 ? { clientRtt: this.serverRtt } : {})
      }
    }
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
      '[syncplay] socket closed (state=' + this.status.state +
      ', tls=' + this.tlsUpgraded +
      ', reconnectAttempts=' + this.reconnectAttempts + ')'
    )
    this.stopHeartbeat()
    if (this.status.state === 'idle') return
    const cfg = this.config
    this.socket = null
    this.rxBuffer = ''
    if (!cfg) {
      this.setStatus({ state: 'disconnected' })
      return
    }
    if (!cfg.autoReconnect || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      const reason = this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS
        ? 'Max reconnect attempts reached'
        : 'Auto-reconnect disabled'
      this.setStatus({
        state: 'disconnected',
        host: cfg.host,
        port: cfg.port,
        room: cfg.room,
        username: cfg.username,
        error: reason
      })
      this.emit('room-event', { level: 'warn', text: `Disconnected from Syncplay room: ${reason}` })
      return
    }
    this.reconnectAttempts += 1
    const delay = RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1)
    console.warn(`[syncplay] reconnecting to ${cfg.host}:${cfg.port} in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
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
    this.status = { ...this.status, ...patch }
    this.emit('connection-status', { ...this.status })
  }
}

export const syncplay = new SyncplayClient()
