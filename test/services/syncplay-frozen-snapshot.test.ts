// #284's *residual*, made executable — the half the fix does not buy.
//
// The renderer gate (`use-syncplay-client.ts`, `hasAnnounceablePosition`) stops
// an element at HAVE_NOTHING putting `position: 0` on the wire during an
// in-player translation or quality switch. Its own guard is
// `test/renderer/composables/use-syncplay-client.test.ts`; a renderer change
// cannot turn *this* file red, and it is not written as if it could.
//
// What this file pins is what main then does with a snapshot that has **stopped
// updating**, which is the shape the gate creates and which no fixture in the
// repo had. Adoption is deliberately retained across the switch — the
// canonical name carries no translation component and `newPlayer` is false —
// so `buildPlaystate()` keeps taking the `hasLivePlayback() && isAdopted()`
// branch (`syncplay.ts:2022-2027`) and the heartbeat re-asserts the *frozen*
// pre-switch position once a second. The modelled server re-seats
// `w.position` on every store and only ages it forward from `lastUpdatedOn`, so
// a value re-sent at 1 Hz never ages: we win `min()` for the whole switch.
//
// Hence the corrected acceptance criteria, and the three assertions below:
//
//   - no `position: 0` on the wire — the defect itself;
//   - the room never goes **below** our pre-switch position, so no peer is
//     seeked backwards past where we were when the switch began;
//   - the stall is bounded by `PLAYBACK_STALE_MS`, after which
//     `hasLivePlayback()` goes false, we fall through to the spectator mirror,
//     and the room is the peer's again.
//
// "The room does not move" is *not* one of them, and a switch over ~3 s costs
// the room real time. That is the trade the fix makes: a bounded 5 s stall in
// place of a yank to 0.

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

import { SyncplayClient } from '../../src/main/syncplay'
import { MinElectionServer } from '../helpers/syncplay-min-election-server'

const ROOM_START = 600
const DELAY_MS = 50
const OPEN = 'Some Anime - 7'
/** `syncplay.ts:58` — not exported; mirrored here so the bound is legible. */
const PLAYBACK_STALE_MS = 5000

describe('SyncplayClient — an adopted client whose snapshot froze (#284)', () => {
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

  /** Where the room genuinely is by wall time, ignoring every election. */
  const trueRoomPosition = (): number => ROOM_START + (Date.now() - t0) / 1000

  /**
   * Run the session forward at the composable's 1 Hz snapshot cadence.
   * `snapshotOf` returns a client's element position, or `null` for a client
   * pushing nothing at all — which is precisely what the renderer gate does to
   * a client whose element is reloading.
   */
  const run = (
    seconds: number,
    snapshotOf: (client: SyncplayClient) => number | null,
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
          client.updateSnapshot({ position: snap, paused: false })
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

  /**
   * Two clients, both with a player open on the episode and both adopted, run
   * to a push that lands on an exact second. `frozenAt` is the position the
   * switcher's last real snapshot claimed — the value main's heartbeat then
   * re-asserts for the whole switch — and `lastPushAt` is when it claimed it,
   * which is what `PLAYBACK_STALE_MS` is measured from.
   */
  const twoAdoptedWatchers = (): {
    switcher: SyncplayClient
    peer: SyncplayClient
    frozenAt: number
    lastPushAt: number
    sentBefore: number
  } => {
    const switcher = seat('switchuser')
    const peer = seat('peeruser')
    announceFile(switcher)
    announceFile(peer)
    run(4, () => trueRoomPosition())
    expect(switcher.getStatus().playbackAdopted).toBe(true)
    expect(peer.getStatus().playbackAdopted).toBe(true)
    return {
      switcher,
      peer,
      frozenAt: trueRoomPosition(),
      lastPushAt: Date.now(),
      sentBefore: server.wireOf('switchuser').length
    }
  }

  it('never announces 0 while its pushes are stopped, and holds its last real position', () => {
    const { switcher, frozenAt, sentBefore } = twoAdoptedWatchers()

    // The switch: `resetMseState()` drops the `src`, the element reloads to
    // HAVE_NOTHING at 0, and the renderer gate sends nothing for the whole
    // awaited round trip. The peer plays on.
    run(4, (c) => (c === switcher ? null : trueRoomPosition()))

    const during = server.wireOf('switchuser').slice(sentBefore)
    // Anti-vacuity: the heartbeat is still talking — this is a *frozen* claim,
    // not silence.
    expect(during.length).toBeGreaterThanOrEqual(4)
    // The defect itself. Ungated, every one of these reads 0 and the room
    // follows it there.
    expect(during.some((f) => f.position === 0)).toBe(false)
    // Every frame is the pre-switch position, held, and still making our pause
    // claim — so no peer applying one is dragged below where we were when the
    // switch began.
    expect(during.every((f) => f.position === frozenAt)).toBe(true)
    expect(during.every((f) => f.paused === false)).toBe(true)

    // The cost the corrected acceptance criteria name, asserted rather than
    // glossed: we win `min()` throughout, so the room is stalled on us and
    // every peer past its own 3 s apply tolerance is seeked *back* onto it.
    // "The room does not move" is not what this fix buys.
    expect(server.roomState().setBy).toBe('switchuser')
    expect(server.roomState().position).toBeLessThan(trueRoomPosition() - 2)
  })

  it('bounds the frozen claim at PLAYBACK_STALE_MS and falls through to the mirror', () => {
    const { switcher, frozenAt, lastPushAt, sentBefore } = twoAdoptedWatchers()

    run(PLAYBACK_STALE_MS / 1000 + 5, (c) => (c === switcher ? null : trueRoomPosition()))
    const during = server.wireOf('switchuser').slice(sentBefore)

    const live = during.filter((f) => f.at - lastPushAt <= PLAYBACK_STALE_MS)
    const stale = during.filter((f) => f.at - lastPushAt > PLAYBACK_STALE_MS)
    expect(live.length).toBeGreaterThanOrEqual(4)
    expect(stale.length).toBeGreaterThanOrEqual(4)

    // Inside the window `buildPlaystate()` takes the `hasLivePlayback() &&
    // isAdopted()` branch and re-asserts the frozen snapshot, pause claim and
    // all.
    expect(live.every((f) => f.position === frozenAt && f.paused === false)).toBe(true)

    // Past it `hasLivePlayback()` goes false and we announce the spectator
    // mirror instead: no `paused` key at all, and a position that tracks the
    // room forward again rather than standing still. That is the bound — the
    // stall cannot outlast PLAYBACK_STALE_MS however long the switch runs.
    expect(stale.every((f) => f.paused === undefined)).toBe(true)
    expect(stale.every((f) => f.position > frozenAt)).toBe(true)
    expect(stale[stale.length - 1].position).toBeGreaterThan(stale[0].position)

    // What the fall-through does *not* do, pinned so the next reader does not
    // assume it: `playbackAdopted` stays latched. Its only reset on this path
    // is inside `updateSnapshot()` (`syncplay.ts:770-776`), which a client that
    // has stopped pushing never calls — so what changes at the threshold is the
    // branch `buildPlaystate()` takes, not the flag. The issue body's "de-
    // adopting is the outcome we want" describes the announce side only.
    expect(switcher.getStatus().playbackAdopted).toBe(true)
    // Nor does the room become the peer's: our mirror is still the `min()`,
    // one one-way delay under the room it is mirroring. That deficit is #279's
    // ratchet, deliberately untouched here.
    expect(server.roomState().setBy).toBe('switchuser')
  })

  it('recovers the room on the first push after the load, with no 0 anywhere in between', () => {
    const { switcher } = twoAdoptedWatchers()

    // A switch comfortably inside the stale window — the ordinary case.
    run(3, (c) => (c === switcher ? null : trueRoomPosition()))
    expect(server.roomState().position).toBeLessThan(trueRoomPosition() - 1)

    // The restore writes `savedTime`, the element reaches HAVE_METADATA, and
    // the renderer gate opens again: pushes resume at the real position.
    run(3, () => trueRoomPosition())

    expect(switcher.getStatus().playbackAdopted).toBe(true)
    expect(server.wireOf('switchuser').some((f) => f.position === 0)).toBe(false)
    // The room is back on the true position — the stall was the switch's
    // length, and nothing outlives it.
    expect(Math.abs(server.roomState().position - trueRoomPosition())).toBeLessThanOrEqual(1)
  })
})
