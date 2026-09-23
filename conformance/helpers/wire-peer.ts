// One peer, at the level the comparison is made: bytes on a socket.
//
// #367 compares the two backends **on the wire** rather than on internal state,
// because reaching into `MinElectionServer`'s fields would be asking the model
// what it thinks it does — which is the thing under test. Everything this file
// records is a frame that actually arrived.
//
// The framing, the parse and the observable extraction are shared between the
// two backends because they are genuinely identical: `\r\n`-delimited JSON. What
// is deliberately **not** shared is anything that reinterprets time. The issue's
// case against a shared driver is that `advance(seconds)` means a fake-timer
// slice loop on one backend and a real sleep on the other; here there is one
// meaning, because `MinElectionServer` runs on real timers (`setInterval`, and
// `Date.now()` throughout) exactly as the reference's `LoopingCall` does. A
// `wait(ms)` in a conformance scenario is the same wall-clock wait on both sides.

import { EventEmitter } from 'node:events'
import net from 'node:net'
import type {
  MinElectionServer,
  ModelSocket
} from '../../test/helpers/syncplay-min-election-server'

export interface Playstate {
  position: number
  paused: boolean
  doSeek: boolean
  setBy: string | null
}

/** A `Set: {user: {<name>: {room, file}}}` announcement, as it arrived. */
export interface Announcement {
  user: string
  /** The file's `name`, or `null` for a render the reference writes as `{}`. */
  file: string | null
}

export interface Transport {
  connect(): Promise<void>
  send(raw: string): void
  onLine(cb: (raw: string) => void): void
  close(): void
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A file object as the two backends render it, reduced to the one thing both can
 * express. `protocols.py:695` writes `watcher.getFile() if watcher.getFile()
 * else {}`, so a cleared file and a `{}` file are the *same* render there while
 * they are different watchers in the election — a divergence the suite reports
 * rather than papers over, see `conformance/README.md`.
 */
export function fileName(file: unknown): string | null {
  if (!isRecord(file)) return null
  const name = file.name
  return typeof name === 'string' && name.length > 0 ? name : null
}

export class RealTransport implements Transport {
  private sock: net.Socket | null = null
  private buf = ''
  private cb: ((raw: string) => void) | null = null

  constructor(private readonly port: number) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port }, () => resolve())
      sock.setEncoding('utf8')
      sock.setNoDelay(true)
      sock.once('error', reject)
      sock.on('data', (chunk: string) => this.absorb(chunk))
      this.sock = sock
    })
    // TLS-only clients probe first (`src/main/syncplay.ts:1130`). The suite runs
    // plaintext on loopback — the server answers `startTLS: "false"` with no
    // `--tls-dir` — but the probe is still sent, because a server that never saw
    // one is in a different state than one that did.
    const answered = new Promise<void>((resolve) => {
      const prev = this.cb
      this.cb = (raw) => {
        prev?.(raw)
        if (raw.includes('"TLS"')) resolve()
      }
    })
    this.send(JSON.stringify({ TLS: { startTLS: 'send' } }))
    await answered
  }

  private absorb(chunk: string): void {
    this.buf += chunk
    for (;;) {
      const i = this.buf.indexOf('\r\n')
      if (i < 0) break
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 2)
      if (line.trim()) this.cb?.(line)
    }
  }

  send(raw: string): void {
    this.sock?.write(raw + '\r\n')
  }

  onLine(cb: (raw: string) => void): void {
    const prev = this.cb
    this.cb = (raw) => {
      prev?.(raw)
      cb(raw)
    }
  }

  close(): void {
    this.sock?.destroy()
    this.sock = null
  }
}

/**
 * The model side of the same socket. `MinElectionServer.seat()` takes ownership
 * of `write` and pushes inbound bytes back with `emit('data', …)`, so a pair of
 * bare `EventEmitter`s is the whole transport — no `vi.mock('net')` and no
 * `SyncplayClient` anywhere in this suite.
 */
export class ModelTransport implements Transport {
  private readonly plain = new EventEmitter() as ModelSocket
  private readonly tls = new EventEmitter() as ModelSocket
  private buf = ''
  private cb: ((raw: string) => void) | null = null

  constructor(
    private readonly server: MinElectionServer,
    private readonly username: string
  ) {}

  async connect(): Promise<void> {
    this.tls.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString()
      for (;;) {
        const i = this.buf.indexOf('\r\n')
        if (i < 0) break
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 2)
        if (line.trim()) this.cb?.(line)
      }
    })
    this.server.seat({ username: this.username, plain: this.plain, takeTls: () => this.tls })
  }

  send(raw: string): void {
    this.tls.write(raw)
  }

  onLine(cb: (raw: string) => void): void {
    const prev = this.cb
    this.cb = (raw) => {
      prev?.(raw)
      cb(raw)
    }
  }

  close(): void {
    this.tls.removeAllListeners('data')
    this.cb = null
  }
}

export class Peer {
  /** Everything that arrived, verbatim, for the failure report. */
  readonly inbound: Array<{ at: number; raw: string }> = []
  /** Everything we sent, verbatim, for the failure report. */
  readonly outbound: Array<{ at: number; raw: string }> = []

  lastPlaystate: Playstate | null = null
  /** `Set: {user}` frames carrying a `file`, since the last `takeAnnouncements()`. */
  private announcements: Announcement[] = []
  lastRoster: Record<string, string | null> | null = null
  /**
   * Set by `requestList()`, cleared by the reply it is waiting for. Only a
   * solicited `List` becomes the roster observable.
   *
   * The two backends differ on `List` *cadence* and the difference is declared:
   * `MinElectionServer.applySet` pushes a fresh `List` to the whole room on any
   * roster change, standing in for the reference's `Set: {user}` broadcast
   * ("same effect on `roomUsers`, one code path", its own comment says), where
   * the reference sends a `List` only when a client asks — `sendList(toGUIOnly)`
   * needs both a rooms DB and a `uiMode` key, and this client's feature block
   * deliberately omits it (`src/main/syncplay.ts:2267-2274`). Reading the roster
   * off whatever `List` happened to arrive would compare that cadence and report
   * it as a divergence on every scenario. Reading it off a `List` the scenario
   * asked for compares the render, which is the observable `#307` turns on.
   */
  private awaitingList = false
  /**
   * Whether this peer answers a forced update with an immediate acknowledgement.
   * On by default because a peer that does not ack is not a conforming client,
   * and the difference is not cosmetic in either direction:
   *
   *  - inbound, `protocols.py:788-789` gates `updateState` on
   *    `serverIgnoringOnTheFly == 0`, so the reference **discards** every
   *    playstate a client sends between a forced update and its ack;
   *  - outbound, `protocols.py:761` is `if self.serverIgnoringOnTheFly == 0 or
   *    forced`, so the reference also stops sending that watcher its periodic
   *    `State` until the ack arrives — it goes silent, and the peer's last
   *    playstate freezes at the moment of the seek.
   *
   * Measured: without the ack, the pause-change scenario reported
   * `real=700.0017 model=701.802` and `real setBy="bravo" model="alpha"` — both
   * of them the reference's silence rather than a model disagreement, because
   * the model's `setInterval` kept broadcasting into the same window. The ack
   * closes it on both sides so the comparison is about the election.
   *
   * A real Syncplay client sends `State` about once a second and carries the
   * echo on the next one (`protocols.py:318-322`); ours does the same
   * (`src/main/syncplay.ts`). Acking with the server's own broadcast position
   * is what a client that *accepted* the forced update reports, so it claims
   * nothing new and perturbs no election. The counters themselves are still not
   * compared — see `IGNORED_FIELDS` in `trace-diff.ts`.
   *
   * Per-peer rather than a constant, because one scenario needs a peer that
   * does **not** ack: `conf-forced-ping-stamps` drives the acknowledgement by
   * hand, and an automatic one would both stamp `_lastUpdatedOn` the instant
   * the forced update arrived — collapsing the wait that scenario is built on
   * — and carry a full playstate, which is the opposite of the frame under
   * test. The default stays on, so every other scenario is unaffected.
   */
  private readonly ackForcedUpdates: boolean

  /**
   * The newest `ignoringOnTheFly.server` counter the server has sent us, or
   * `null` if none has arrived. Captured **outside** the `ackForcedUpdates`
   * gate below, and the two are easy to fuse by accident: a peer with acking
   * off still has to be able to carry the counter on a hand-driven frame,
   * because `protocols.py:788-789` runs `updateState` only while
   * `serverIgnoringOnTheFly == 0` and only an echo whose counter matches
   * exactly (`protocols.py:775-777`) clears it. A counter-less frame sent
   * inside that window is discarded by the reference and inert in the model,
   * which is agreement that measures nothing.
   *
   * Newest wins, deliberately: a second forced update increments past the
   * first, so a peer that kept the first counter it ever saw would echo one
   * that no longer matches and be dropped exactly as if it had carried none.
   */
  private lastServerCounter: number | null = null

  constructor(
    readonly name: string,
    private readonly transport: Transport,
    options: { ackForcedUpdates?: boolean } = {}
  ) {
    this.ackForcedUpdates = options.ackForcedUpdates ?? true
  }

  async seat(room: string): Promise<void> {
    await this.transport.connect()
    this.transport.onLine((raw) => this.absorb(raw))
    this.write({
      Hello: {
        username: this.name,
        room: { name: room },
        version: '1.7.6',
        features: {
          sharedPlaylists: false,
          chat: true,
          featureList: false,
          readiness: true,
          managedRooms: false,
          persistentRooms: false
        }
      }
    })
  }

  private absorb(raw: string): void {
    this.inbound.push({ at: Date.now(), raw })
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(msg)) return
    if (isRecord(msg.State) && isRecord(msg.State.playstate)) {
      const ps = msg.State.playstate
      this.lastPlaystate = {
        position: typeof ps.position === 'number' ? ps.position : 0,
        paused: ps.paused === true,
        doSeek: ps.doSeek === true,
        setBy: typeof ps.setBy === 'string' ? ps.setBy : null
      }
      // Latent gap: this capture sits inside the `playstate` guard above, so a
      // genuinely playstate-free inbound counter would not be captured. The
      // reference only ever raises the flag on a `forced` broadcast, which
      // always carries a playstate (`protocols.py:748-757`), so no scenario has
      // reached it — it is a shape this helper does not handle, not a bug it
      // has hit.
      if (isRecord(msg.State.ignoringOnTheFly)) {
        const counter = msg.State.ignoringOnTheFly.server
        if (typeof counter === 'number' && counter > 0) {
          this.lastServerCounter = counter
          if (this.ackForcedUpdates) this.ack(counter, this.lastPlaystate)
        }
      }
    }
    if (isRecord(msg.Set) && isRecord(msg.Set.user)) {
      for (const [user, body] of Object.entries(msg.Set.user)) {
        // A join notice (`sendJoinMessage`, `server.py:168-173`) carries `event`
        // and no `file`; only the `sendFileUpdate` relay is an announcement.
        if (!isRecord(body) || !('file' in body)) continue
        this.announcements.push({ user, file: fileName(body.file) })
      }
    }
    if (isRecord(msg.List) && this.awaitingList) {
      this.awaitingList = false
      const roster: Record<string, string | null> = {}
      for (const entry of Object.values(msg.List)) {
        if (!isRecord(entry)) continue
        for (const [user, body] of Object.entries(entry)) {
          roster[user] = isRecord(body) ? fileName(body.file) : null
        }
      }
      this.lastRoster = roster
    }
  }

  /** Asks for a roster. The next `List` reply becomes `lastRoster`. */
  requestList(): void {
    this.awaitingList = true
    this.write({ List: {} })
  }

  /**
   * Accepts a forced update and says so: the counter back, and the server's own
   * position reported as ours. `doSeek` is false because acking a seek is not
   * requesting one.
   */
  private ack(counter: number, applied: Playstate): void {
    this.write({
      State: {
        playstate: { position: applied.position, paused: applied.paused, doSeek: false },
        ping: {
          clientLatencyCalculation: Date.now() / 1000,
          latencyCalculation: Date.now() / 1000
        },
        ignoringOnTheFly: { server: counter }
      }
    })
  }

  /** One playstate, as the scenario asked for it. */
  sendState(playstate: { position: number; paused?: boolean; doSeek?: boolean }): void {
    this.write({
      State: {
        playstate: {
          position: playstate.position,
          ...(playstate.paused === undefined ? {} : { paused: playstate.paused }),
          doSeek: playstate.doSeek === true
        },
        ping: {
          clientLatencyCalculation: Date.now() / 1000,
          latencyCalculation: Date.now() / 1000
        }
      }
    })
  }

  /**
   * A `State` carrying `ping` and the retained counter and **no `playstate`
   * key at all** — the production sender's frame, copied rather than invented:
   * `sendAck()`'s literal is `src/main/syncplay.ts:2729-2737`, and that object
   * holds the ping, the counter, and nothing else. The absence of a playstate
   * is the thing under test, so an emitter that added one would be testing a
   * different frame.
   *
   * Throws when no counter has been retained rather than sending the frame
   * without one, because a counter-less frame is not merely weaker: inside the
   * ignore window the reference discards it and the model has no ignore window
   * to begin with, so both backends go inert together and `trace-diff` reports
   * agreement — the one failure mode here that reads as evidence.
   *
   * Does **not** clear `lastServerCounter`, where production `sendAck()` zeroes
   * `pendingServerAck` on the way out (`src/main/syncplay.ts:2746`), so a second
   * `pingOnly` step would re-echo a counter the first one already spent. Benign
   * today rather than harmless in general: with no forced update in between the
   * server's flag is already 0, `protocols.py:775-777` simply does not match,
   * and the frame reaches `updateState` anyway — a redundant key, not a dropped
   * frame. With one in between the capture above has already advanced the
   * counter, because `protocols.py:761` lets `forced` broadcasts through a
   * raised flag. What the missing clear costs is the property production has by
   * construction: that a retained counter is echoed exactly once. A scenario
   * that leans on that ordering should clear it here first.
   */
  sendPingOnly(): void {
    if (this.lastServerCounter === null) {
      throw new Error(`peer ${this.name} was asked to echo a counter it never received`)
    }
    this.write({
      State: {
        ping: {
          clientLatencyCalculation: Date.now() / 1000,
          latencyCalculation: Date.now() / 1000
        },
        ignoringOnTheFly: { server: this.lastServerCounter }
      }
    })
  }

  takeAnnouncements(): Announcement[] {
    const taken = this.announcements
    this.announcements = []
    return taken
  }

  write(obj: unknown): void {
    const raw = JSON.stringify(obj)
    this.outbound.push({ at: Date.now(), raw })
    this.transport.send(raw)
  }

  close(): void {
    this.transport.close()
  }
}
