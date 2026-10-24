// Main's half of the pause-edge snap (#524).
//
// Since #524 the renderer seeks to the room's position when a pause reaches a
// playing element more than ECHO_SEEK_EPSILON_S away (`wouldSeekOnApply()` in
// src/shared/syncplay-apply-rule.ts). The `seeked` that snap fires has two
// guards against the #220 self-seek loop: the renderer's value-keyed seek
// operation, and main's echo target (`lastAppliedRemotePosition`), which
// `sendLocalState()` swallows a seek within ECHO_SEEK_EPSILON_S of. Main arms
// that target only for a state it predicts the renderer will move on, so the
// belt covers the snap only if main predicts with the renderer's own rule on the
// renderer's own quantity. The renderer measures from `currentTime`; main has
// only our last snapshot, up to one push old, and walks it forward by its age
// (`projectedSnapshotPosition()`).
//
// The renderer side of each cell below is the shared predicate evaluated at
// where the element really is. The composable's own call of it, on
// `currentTime`, is pinned in the composable's "a pause edge snaps to the room"
// block (test/renderer/composables/use-syncplay-client.test.ts).

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

import { SyncplayClient, ECHO_SEEK_EPSILON_S } from '../../src/main/syncplay'
import { wouldSeekOnApply } from '../../src/shared/syncplay-apply-rule'

type StateFrame = {
  playstate?: { position: number; paused?: boolean; doSeek?: boolean }
}

const outboundStates = (sock: FakeSocket | null): StateFrame[] =>
  (sock?.write.mock.calls ?? [])
    .map(([f]) => JSON.parse(String(f)) as Record<string, unknown>)
    .filter((f) => 'State' in f)
    .map((f) => f.State as StateFrame)

type EmittedState = { position: number; setBy: string | null; paused: boolean; doSeek: boolean }

describe('SyncplayClient — the echo target arms in lockstep with the pause-edge snap (#524)', () => {
  let client: SyncplayClient
  let remoteStates: EmittedState[]
  let serverCounter = 0

  const armed = (): number | null =>
    (client as unknown as { lastAppliedRemotePosition: number | null }).lastAppliedRemotePosition

  const handshake = (): void => {
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room: 'cinema',
      username: 'me',
      autoReconnect: false
    })
    lastSocket!.emit('connect')
    lastSocket!.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
    lastTlsSocket!.emit('secureConnect')
    lastTlsSocket!.emit(
      'data',
      Buffer.from('{"Hello":{"username":"me","room":{"name":"cinema"},"version":"1.6.9"}}\r\n')
    )
    lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ List: { cinema: {} } }) + '\r\n'))
  }

  // A peer's change, forced to us by the server: the frame a pause edge rides.
  const forced = (position: number, paused: boolean, doSeek = false): void => {
    serverCounter += 1
    const state = {
      ping: { latencyCalculation: 1_770_000_000.25 },
      ignoringOnTheFly: { server: serverCounter },
      playstate: { position, paused, doSeek, setBy: 'peer' }
    }
    lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ State: state }) + '\r\n'))
  }

  const doSeekFrames = (): StateFrame[] =>
    outboundStates(lastTlsSocket).filter((s) => s.playstate?.doSeek === true)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    lastSocket = null
    lastTlsSocket = null
    serverCounter = 0
    client = new SyncplayClient()
    remoteStates = []
    client.on('remote-state', (s) => remoteStates.push(s as EmittedState))
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  const SNAP = 100

  // Our last push at SNAP, `ageS` ago, saying playing. The element has played on
  // from it ever since unless `stalled`, in which case it stands at SNAP. The
  // peer's pause lands `offset` from the element.
  const pauseEdge = (o: {
    ageS: number
    offset: number
    stalled?: boolean
  }): { renderer: boolean; main: boolean; room: number } => {
    handshake()
    client.updateSnapshot({ position: SNAP, paused: false })
    vi.advanceTimersByTime(Math.round(o.ageS * 1000))
    const element = o.stalled ? SNAP : SNAP + o.ageS
    const room = element + o.offset
    forced(room, true)
    expect(remoteStates.at(-1)?.position, 'the pause was not handed over').toBe(room)
    const renderer = wouldSeekOnApply({
      doSeek: false,
      diff: Math.abs(element - room),
      pauseEdge: true
    })
    return { renderer, main: armed() !== null, room }
  }

  describe('the agreement table, on a playing element', () => {
    const AGES = [0, 0.5, 1.1]
    const OFFSETS = [-2, -0.8, -0.3, 0, 0.3, 0.8, 2]

    for (const ageS of AGES) {
      it(`main arms exactly when the renderer snaps, snapshot ${ageS} s old`, () => {
        const cells = OFFSETS.map((offset) => {
          client.disconnect()
          client = new SyncplayClient()
          remoteStates = []
          client.on('remote-state', (s) => remoteStates.push(s as EmittedState))
          return { offset, ...pauseEdge({ ageS, offset }) }
        })
        for (const c of cells) expect(c.main, JSON.stringify(c)).toBe(c.renderer)
        // Not vacuous: each row holds snaps and non-snaps, and the non-snap
        // band is exactly the |offset| ≤ 0.5 cells.
        expect(cells.filter((c) => c.renderer).map((c) => c.offset)).toEqual([-2, -0.8, 0.8, 2])
      })
    }

    it('arms at the position the renderer is handed, the room’s pause', () => {
      const c = pauseEdge({ ageS: 1.1, offset: -1.5 })
      expect(c.renderer).toBe(true)
      expect(armed()).toBe(c.room)
    })
  })

  // The plan review's second point. The projection is ahead of a stalled
  // element (buffering, before the readiness gate pauses it), so the two sides
  // can disagree, and which way depends on where the room is. Pinned both ways,
  // so the direction that loses main's belt is visible rather than assumed.
  describe('a stalled element', () => {
    it('room behind it: main arms for a snap the renderer does not make (harmless)', () => {
      const c = pauseEdge({ ageS: 0.5, offset: -0.3, stalled: true })
      expect(c.renderer).toBe(false)
      expect(c.main).toBe(true)
    })

    it('room ahead of it: the renderer snaps where main does not arm (the belt is lost)', () => {
      const c = pauseEdge({ ageS: 0.5, offset: 0.8, stalled: true })
      expect(c.renderer).toBe(true)
      expect(c.main).toBe(false)
      // What is left is the renderer's value-keyed operation. If that let go,
      // the snap's `seeked` would go out as a seek of ours:
      client.sendLocalState({ paused: true, position: c.room, cause: 'seek' })
      expect(doSeekFrames()).toHaveLength(1)
    })
  })

  it('does not arm off the edge inside 3 s: a paused snapshot keeps the old rule', () => {
    handshake()
    client.updateSnapshot({ position: SNAP, paused: true })
    vi.advanceTimersByTime(500)
    forced(SNAP + 1.5, true)
    expect(armed()).toBeNull()
    forced(SNAP + 3.5, true)
    expect(armed()).toBe(SNAP + 3.5)
  })

  // #220, keyed on the widened target: the snap's own `seeked`, reaching main
  // as a seek because the renderer's operation had already let go of it, is
  // swallowed rather than asserted back into the room.
  it('swallows the snap’s own seeked as an echo', () => {
    const c = pauseEdge({ ageS: 0.5, offset: -1.5 })
    expect(c.main).toBe(true)
    const before = outboundStates(lastTlsSocket).length

    client.sendLocalState({ paused: true, position: c.room, cause: 'seek' })

    expect(doSeekFrames()).toHaveLength(0)
    expect(outboundStates(lastTlsSocket)).toHaveLength(before)
    expect(armed()).toBeNull()
  })

  // #515's crossing substitution reads the same target. With the wider arm it
  // also fires on a local pause pressed between main's arming and the renderer's
  // apply: the pause goes out at the room's own pause position instead of the
  // element's, which moves nobody.
  it('a local pause crossing a pause-edge arm asserts the room’s pause position', () => {
    const c = pauseEdge({ ageS: 0, offset: -1.5 })
    expect(c.main).toBe(true)

    client.sendLocalState({ paused: true, position: SNAP, cause: 'pause' })

    const last = outboundStates(lastTlsSocket).at(-1)!
    expect(last.playstate).toMatchObject({ position: c.room, paused: true, doSeek: false })
    expect(armed()).toBe(c.room)
  })

  // The plan review's third point. A main-only edge — a room pause reaching an
  // element the readiness gate has paused, while our snapshot still reports
  // the intent "playing" — arms a target the renderer, applying its 3 s rule to
  // a paused element, never seeks to. `updateSnapshot()` does not retire it;
  // our next assertion does, and after a room pause that is the user's Play.
  describe('a target armed for a snap the renderer did not make', () => {
    const mainOnlyArm = (): number => {
      handshake()
      client.updateSnapshot({ position: SNAP, paused: false })
      forced(SNAP + 1.5, true)
      expect(armed()).toBe(SNAP + 1.5)
      // The renderer's pushes since: the element still at SNAP, paused by the gate.
      client.updateSnapshot({ position: SNAP, paused: true })
      vi.advanceTimersByTime(3000)
      client.updateSnapshot({ position: SNAP, paused: true })
      expect(armed()).toBe(SNAP + 1.5)
      return SNAP + 1.5
    }

    it('is retired by the next Play, so a later seek near it reaches the room', () => {
      const room = mainOnlyArm()
      client.sendLocalState({ paused: false, position: SNAP, cause: 'play' })
      expect(armed()).toBeNull()

      client.sendLocalState({ paused: false, position: room + 0.2, cause: 'seek' })
      const seeks = doSeekFrames()
      expect(seeks).toHaveLength(1)
      expect(seeks[0].playstate?.position).toBe(room + 0.2)
    })

    it('until then swallows a seek to within ECHO_SEEK_EPSILON_S of the room’s pause', () => {
      const room = mainOnlyArm()
      client.sendLocalState({
        paused: true,
        position: room + ECHO_SEEK_EPSILON_S / 2,
        cause: 'seek'
      })
      expect(doSeekFrames()).toHaveLength(0)
    })
  })

  // The plan review's first point, main's half. `seekAsUser` announces at
  // intent, so `sendLocalState()` stamps the snapshot at the click, and the
  // projection walks on while the element stands loading. Under a live seek
  // intent (the crossed shape: the room is still elsewhere, so the intent
  // survives the frame and is re-asserted) `handleState()` hands the renderer
  // that projection as the room's position (#278). The renderer re-anchors it
  // with a push on the landing (the composable's half of the pair).
  describe('a pause edge 200 ms after a 1 s user seek lands', () => {
    const TARGET = 700

    const seekThenPause = (o: { reanchor: boolean }): EmittedState => {
      handshake()
      client.updateSnapshot({ position: SNAP, paused: false })
      client.sendLocalState({ paused: false, position: TARGET, cause: 'seek' })
      vi.advanceTimersByTime(1000)
      if (o.reanchor) client.updateSnapshot({ position: TARGET, paused: false })
      vi.advanceTimersByTime(200)
      forced(SNAP + 1, true)
      expect(
        (client as unknown as { seekIntent: unknown }).seekIntent,
        'the intent must still be live for this to be the #278 path'
      ).not.toBeNull()
      return remoteStates.at(-1)!
    }

    it('hands the renderer where the element is, so nothing moves but paused', () => {
      const element = TARGET + 0.2
      const s = seekThenPause({ reanchor: true })
      expect(s.paused).toBe(true)
      expect(Math.abs(s.position - element)).toBeLessThan(1e-9)
      expect(wouldSeekOnApply({ doSeek: s.doSeek, diff: 0, pauseEdge: true })).toBe(false)
      expect(armed()).toBeNull()
    })

    it('without the re-anchor it would run a second ahead, past the pause edge’s tolerance', () => {
      const element = TARGET + 0.2
      const s = seekThenPause({ reanchor: false })
      expect(s.position).toBeCloseTo(TARGET + 1.2, 9)
      expect(
        wouldSeekOnApply({ doSeek: false, diff: Math.abs(s.position - element), pauseEdge: true })
      ).toBe(true)
    })
  })
})
