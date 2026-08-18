// The boundary of #278's read-side rule, made executable.
//
// #278 fixes symptom 1 — "two quick arrow presses revert to the first" — by
// having `handleState()` hand the renderer *our* position instead of the room's
// while a local seek intent is live. That rule reaches exactly the shape where
// **the room never took our seek**, so the intent is still live when the
// contradicting periodic lands.
//
// This file pins the other shape, and it is a test that the bug **survives**:
// the host's big forward seek is *accepted*, the room agrees for one tick, and
// then `Room.getPosition()`'s `min()` over watchers (`server.py:597-604`)
// re-elects the room onto a joiner whose element has not landed yet and is
// still reporting its stalled `currentTime`. By the time that frame arrives the
// host's `seekIntent` has already been retired by the server's own reflected
// forced update — "the recovery fired" and "the intent exists" go false on the
// *same* tick — so no intent-keyed rule can reach it, whatever its lifetime.
//
// This is deliberately a characterisation, not a regression test. It is
// expected to start failing, and to be rewritten rather than deleted, when
// either of its two real causes lands:
//
//  - **#284** — pushing the snapshot from the element's `seeking` *target*
//    rather than its stalled `currentTime`, which is what keeps a mid-seek
//    laggard out of the `min()` election in the first place. Symptom 2's
//    primary fix.
//  - **#279** — the room's position ratcheting backwards under a mirror
//    `min()`; a `doSeek: false` frame should not be allowed to move the room
//    backwards by minutes at all.
//
// Driven by `test/helpers/syncplay-min-election-server.ts` (landed on #282 for
// #277), because "who the server says set the room" is the *result* here rather
// than an input — of the election, of the link delay, and of what each client
// last asserted.

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

import { SyncplayClient, ADOPT_TOLERANCE_S } from '../../src/main/syncplay'
import { MinElectionServer } from '../helpers/syncplay-min-election-server'
import type { SyncplayRemoteState } from '../../src/main/syncplay'

const ROOM_START = 100
const SEEK_TO = 645
const DELAY_MS = 50
const OPEN = 'Some Anime - 7'
/** How long the joiner's unbuffered seek takes to land — an MKV/MSE respawn. */
const LAND_MS = 6000

const seekIntentOf = (client: SyncplayClient): { at: number; attempts: number } | null =>
  (client as unknown as { seekIntent: { at: number; attempts: number } | null }).seekIntent

/**
 * A `<video>` whose seeks do not land instantly. While one is in flight the
 * element reports its **stalled** `currentTime` — the pre-seek value — which is
 * exactly what the renderer's 1 Hz snapshot push reports to main, and exactly
 * what wins the server's `min()` election. That is #284's subject; here it is
 * the fixture.
 */
class LaggyElement {
  private position: number
  private at: number
  private landing: { target: number; startedAt: number } | null = null

  constructor(
    position: number,
    private readonly landMs: number
  ) {
    this.position = position
    this.at = Date.now()
  }

  /** What `v.currentTime` reads right now. */
  currentTime(): number {
    if (this.landing !== null) return this.position
    return this.position + (Date.now() - this.at) / 1000
  }

  /** The renderer's apply rule, verbatim (use-syncplay-client.ts:585-586). */
  apply(state: SyncplayRemoteState): boolean {
    if (!state.doSeek && Math.abs(this.currentTime() - state.position) <= 3) return false
    this.seekTo(state.position)
    return true
  }

  seekTo(target: number): void {
    if (this.landMs <= 0) {
      this.position = target
      this.at = Date.now()
      return
    }
    this.position = this.currentTime()
    this.at = Date.now()
    this.landing = { target, startedAt: Date.now() }
  }

  /** Called on every fixture step; completes a seek once its wait is up. */
  tick(): void {
    if (this.landing === null) return
    if (Date.now() - this.landing.startedAt < this.landMs) return
    this.position = this.landing.target
    this.at = Date.now()
    this.landing = null
  }

  get isSeeking(): boolean {
    return this.landing !== null
  }
}

describe('SyncplayClient — the post-agreement re-election #278 does not reach', () => {
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

  const announceFile = (client: SyncplayClient): void =>
    client.setFile({
      animeId: 1,
      malId: 2,
      episodeInt: '7',
      translationId: 3,
      canonicalName: OPEN,
      duration: 1440,
      newPlayer: true
    })

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

  it('yanks a host whose seek the room accepted, with no seekIntent left to key on', () => {
    /** One frame the renderer was handed, with the state main held at the time. */
    type Observed = {
      at: number
      state: SyncplayRemoteState
      intent: { at: number; attempts: number } | null
      element: number
    }

    // Both elements start converged on the room and both clients adopt: this is
    // an ordinary two-watcher session, not #277's unadopted mirror.
    const hostEl = new LaggyElement(ROOM_START, 0)
    const joinerEl = new LaggyElement(ROOM_START, LAND_MS)

    const host = seat('hostuser')
    const hostFrames: Observed[] = []
    host.on('remote-state', (s: SyncplayRemoteState) =>
      hostFrames.push({
        at: Date.now() - t0,
        state: s,
        intent: seekIntentOf(host),
        element: hostEl.currentTime()
      })
    )
    announceFile(host)

    const joiner = seat('joinuser')
    const joinerFrames: Observed[] = []
    joiner.on('remote-state', (s: SyncplayRemoteState) =>
      joinerFrames.push({
        at: Date.now() - t0,
        state: s,
        intent: seekIntentOf(joiner),
        element: joinerEl.currentTime()
      })
    )
    announceFile(joiner)

    // Each element applies what it is handed, and each renderer pushes its
    // element's live `currentTime` at 1 Hz — the stalled one included.
    host.on('remote-state', (s: SyncplayRemoteState) => hostEl.apply(s))
    joiner.on('remote-state', (s: SyncplayRemoteState) => joinerEl.apply(s))

    const run = (seconds: number): void => {
      const steps = Math.round((seconds * 1000) / 50)
      let sinceSnapshot = 0
      for (let i = 0; i < steps; i += 1) {
        vi.advanceTimersByTime(50)
        hostEl.tick()
        joinerEl.tick()
        sinceSnapshot += 50
        if (sinceSnapshot >= 1000) {
          sinceSnapshot = 0
          host.updateSnapshot({ position: hostEl.currentTime(), paused: false })
          joiner.updateSnapshot({ position: joinerEl.currentTime(), paused: false })
        }
      }
    }

    run(4)
    expect(host.getStatus().playbackAdopted).toBe(true)
    expect(joiner.getStatus().playbackAdopted).toBe(true)

    // t=4000: the host seeks 545 s forward. Its own element lands instantly
    // (buffered); the joiner's takes LAND_MS and reports its stalled position
    // the whole time.
    hostEl.seekTo(SEEK_TO)
    host.sendLocalState({ paused: false, position: SEEK_TO, cause: 'seek' })
    expect(seekIntentOf(host)).not.toBeNull()
    const seekedAt = Date.now()
    hostFrames.length = 0

    run(16)

    // The frame that is the whole point: the host's element is at ~645 and it is
    // handed the room's collapsed ~105 on a `doSeek: false` periodic. Measured
    // on this fixture, and it reproduces the trace in #278's Motivation to two
    // decimal places — `t=6050 host <- 105.52 setBy=joinuser doSeek=false
    // el=647.05`, and the room never returning above ~114 by t=20000.
    const yank = hostFrames.find((f) => f.element > SEEK_TO - 5 && f.state.position < SEEK_TO - 100)
    expect(yank, 'the host was never yanked — the fixture stopped reproducing').toBeDefined()

    // 1. The room genuinely moved. This is not a read-side timing artefact:
    //    the server's own `_position` is down there too.
    expect(server.roomState().position).toBeLessThan(SEEK_TO - 100)

    // 2. **The intent is already null when it lands.** It was retired by the
    //    server's own reflected forced update (`syncplay.ts:2143-2148`, drift ≈
    //    0) one round trip after the seek — i.e. "the recovery fired" and "the
    //    intent exists" go false on the same tick. #278's rewrite is keyed on
    //    exactly this value, so it cannot fire here however long the window is
    //    held open.
    expect(yank!.intent).toBeNull()
    expect(yank!.at).toBeGreaterThan(seekedAt - t0)

    // 3. And so the frame goes to the renderer unrewritten, at the room's
    //    position rather than ours, far enough out that the renderer applies it.
    expect(Math.abs(yank!.element - yank!.state.position)).toBeGreaterThan(ADOPT_TOLERANCE_S)
    expect(yank!.state.doSeek).toBe(false)

    // 4. The joiner is yanked too — at t≈14050, once the room's `setBy` swings
    //    back to the host and its self-guard stops eating the periodics — and it
    //    **never seeked at all**. It holds no intent at any point in the run, so
    //    there is no lifetime on its side for any rule of this shape to key to.
    //    That is the fact that closes the question rather than merely bounding
    //    it: even an unbounded window would protect the host and leave the
    //    joiner exactly as it is today.
    const joinerYank = joinerFrames.find(
      (f) => f.at > seekedAt - t0 && f.state.position < SEEK_TO - 100 && f.element > SEEK_TO - 5
    )
    expect(
      joinerYank,
      'the joiner was never yanked — the fixture stopped reproducing'
    ).toBeDefined()
    expect(joinerYank!.intent).toBeNull()
    expect(joinerFrames.every((f) => f.intent === null)).toBe(true)
  })
})
