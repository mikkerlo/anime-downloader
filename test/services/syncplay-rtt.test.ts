// RTT compensation is a *forward delay* correction (#235): a state that left a
// peer while the room was playing has aged in flight, so it is shifted by
// serverRtt / 2 before applying. A paused position has not aged, so shifting it
// is pure error — and on the paused-seek path it is a silent, tolerance-free
// mis-seek, since `doSeek` bypasses the renderer's 3 s window
// (use-syncplay-client.ts:259). Upstream gates the same shift on the same flag
// (client.py:459-460, server.py:871-872).
//
// The compensated value must stay ONE expression read twice: it is emitted to
// the renderer *and* stored as `lastAppliedRemotePosition`, the reference the
// #220 echo guard (src/main/syncplay.ts:351-356) compares the element's echoed
// `seeked` against. Splitting them re-arms the self-seek loop.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  write = vi.fn()
  destroy = vi.fn(() => {
    this.emit('close')
  })
}

let lastSocket: FakeSocket | null = null
let lastTlsSocket: FakeSocket | null = null

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    lastSocket = new FakeSocket()
    return lastSocket
  })
}))

vi.mock('tls', () => ({
  connect: vi.fn(() => {
    lastTlsSocket = new FakeSocket()
    return lastTlsSocket
  })
}))

import { SyncplayClient, ECHO_SEEK_EPSILON_S, ADOPT_TOLERANCE_S } from '../../src/main/syncplay'

type Frame = Record<string, unknown>
type RemoteState = { paused: boolean; position: number; setBy: string; doSeek: boolean }

const frames = (sock: FakeSocket | null): Frame[] =>
  (sock?.write.mock.calls ?? []).map(([f]) => JSON.parse(String(f)) as Frame)

const statesOf = (
  sock: FakeSocket | null
): Array<{ playstate?: { position: number; paused?: boolean; doSeek: boolean } }> =>
  frames(sock)
    .filter((f) => 'State' in f)
    .map((f) => f.State as never)

describe('SyncplayClient inbound RTT compensation (#235)', () => {
  let client: SyncplayClient
  let remoteStates: RemoteState[]

  const handshake = (room = 'cinema'): void => {
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room,
      username: 'me',
      autoReconnect: false
    })
    lastSocket!.emit('connect')
    lastSocket!.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
    lastTlsSocket!.emit('secureConnect')
    lastTlsSocket!.emit(
      'data',
      Buffer.from(`{"Hello":{"username":"me","room":{"name":"${room}"},"version":"1.6.9"}}\r\n`)
    )
  }

  // Seeds serverRtt by echoing a *stale* clientLatencyCalculation: the client
  // computes `Date.now() / 1000 - myTs` and accepts it when 0 < rtt < 5
  // (src/main/syncplay.ts:833-837). `setBy` must be non-null and not our own
  // username, with pendingClientAck === 0, or the state is dropped at :862-867
  // before it ever reaches the compensation.
  const serverState = (opts: {
    position: number
    paused: boolean
    doSeek?: boolean
    setBy?: string
    rtt: number
  }): void => {
    lastTlsSocket!.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          State: {
            ping: { clientLatencyCalculation: Date.now() / 1000 - opts.rtt },
            playstate: {
              position: opts.position,
              paused: opts.paused,
              doSeek: opts.doSeek ?? false,
              setBy: opts.setBy ?? 'peer'
            }
          }
        }) + '\r\n'
      )
    )
  }

  const serverRttOf = (): number => (client as unknown as { serverRtt: number }).serverRtt
  const lastAppliedOf = (): number | null =>
    (client as unknown as { lastAppliedRemotePosition: number | null }).lastAppliedRemotePosition

  beforeEach(() => {
    vi.useFakeTimers()
    // A realistic epoch: the seed does not yield an exact rtt, because
    // `now / 1000` has already spent its mantissa. Assertions on compensated
    // values therefore use toBeCloseTo; the paused pass-through is exact.
    vi.setSystemTime(new Date('2026-08-07T12:00:00.123Z'))
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
    remoteStates = []
    client.on('remote-state', (s) => remoteStates.push(s as RemoteState))
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  // Case 1 — the defect. Fails on the old unconditional shift, which emitted
  // ~120.4 here.
  it('applies a paused remote position untouched, even with a live serverRtt', () => {
    handshake()
    serverState({ position: 120, paused: true, doSeek: true, rtt: 0.8 })

    expect(serverRttOf()).toBeGreaterThan(0.5)
    expect(remoteStates).toHaveLength(1)
    expect(remoteStates[0].position).toBe(120)
    expect(remoteStates[0].paused).toBe(true)
    expect(remoteStates[0].doSeek).toBe(true)
  })

  // Case 2 — the guard against over-correcting into "never compensate".
  it('still shifts a playing remote position forward by serverRtt / 2', () => {
    handshake()
    serverState({ position: 120, paused: false, rtt: 0.8 })

    expect(remoteStates).toHaveLength(1)
    expect(remoteStates[0].position).toBeCloseTo(120.4, 3)
  })

  // Case 3 — the echo-suppression coupling: one expression, two reads. Catches
  // a split between the emitted `compensated` and the stored
  // `lastAppliedRemotePosition` at any seed. Positions stay non-negative so the
  // Math.max(0, …) on the stored read remains the no-op it is in practice.
  it('stores exactly the position it emits, on both the paused and playing branches', () => {
    handshake()

    serverState({ position: 120, paused: true, rtt: 0.8 })
    expect(lastAppliedOf()).toBe(remoteStates[0].position)

    serverState({ position: 240, paused: false, rtt: 0.8 })
    expect(lastAppliedOf()).toBe(remoteStates[1].position)
  })

  // Case 4 — end-to-end on the paused path. Seeded at rtt ~= 2.0 deliberately:
  // at 0.8 a split between the emitted value and the stored echo reference
  // diverges by only 0.4, *inside* ECHO_SEEK_EPSILON_S, so the guard would
  // still suppress and this case would pass on the very implementation it
  // exists to reject. At 2.0 the divergence is 1.0 > 0.5.
  it('suppresses the element echo of an applied paused seek instead of re-asserting it', () => {
    handshake()
    serverState({ position: 120, paused: true, doSeek: true, rtt: 2.0 })

    expect(serverRttOf()).toBeGreaterThan(2 * ECHO_SEEK_EPSILON_S)
    const applied = remoteStates[0].position
    expect(applied).toBe(120)

    lastTlsSocket!.write.mockClear()
    // The <video> element reports back exactly what it was told to seek to.
    client.sendLocalState({ paused: true, position: applied, cause: 'seek' })

    expect(statesOf(lastTlsSocket).filter((s) => s.playstate?.doSeek === true)).toHaveLength(0)
  })

  // Case 6 in the issue — the control for case 4. Without it, "no doSeek frame"
  // could be true because of the pre-adoption gate (:337-339) or the hardcoded
  // doSeek: false in buildPlaystate()'s spectator fallback, rather than the
  // echo guard.
  // The offset sits inside ADOPT_TOLERANCE_S (so this call adopts on its own)
  // but outside ECHO_SEEK_EPSILON_S (so it is not an echo).
  it('does assert a genuine non-echo seek made from the same applied position', () => {
    handshake()
    serverState({ position: 120, paused: true, doSeek: true, rtt: 2.0 })
    const applied = remoteStates[0].position

    lastTlsSocket!.write.mockClear()
    const offset = 2.0
    expect(offset).toBeGreaterThan(ECHO_SEEK_EPSILON_S)
    expect(offset).toBeLessThanOrEqual(ADOPT_TOLERANCE_S)
    client.sendLocalState({ paused: true, position: applied + offset, cause: 'seek' })

    const seeks = statesOf(lastTlsSocket).filter((s) => s.playstate?.doSeek === true)
    expect(seeks).toHaveLength(1)
    expect(seeks[0].playstate!.position).toBe(applied + offset)
  })

  // Case 5 — lastRoomState is recorded raw, above the echo guards, because a
  // spectator mirrors it back on the wire via buildPlaystate().
  it('records lastRoomState from the raw wire position, not the applied one', () => {
    handshake()
    serverState({ position: 120, paused: false, rtt: 0.8 })

    const room = (
      client as unknown as { lastRoomState: { position: number; paused: boolean } | null }
    ).lastRoomState
    expect(room).not.toBeNull()
    expect(room!.position).toBe(120)
    expect(remoteStates[0].position).not.toBe(120)
  })
})
