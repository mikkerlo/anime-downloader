// Joining a room must be a passive act (#220): the joiner has no player yet,
// so it must not assert a playstate (which used to yank everyone back to 0 and
// pause them), and it must actively ask for the roster (the server only
// broadcasts membership *changes*, so people already in the room were
// invisible — "Room is empty — you're the first one here" with two people in).

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

import { SyncplayClient, type SyncplayRoomUser } from '../../src/main/syncplay'

// Mirrors PLAYBACK_STALE_MS in the client: how long without a renderer push
// before main decides no player is driving playback.
const PLAYBACK_STALE_MS = 5000

type Frame = Record<string, unknown>

const frames = (sock: FakeSocket | null): Frame[] =>
  (sock?.write.mock.calls ?? []).map(([f]) => JSON.parse(String(f)) as Frame)

const statesOf = (
  sock: FakeSocket | null
): Array<{
  playstate?: { position: number; paused?: boolean; doSeek: boolean }
}> =>
  frames(sock)
    .filter((f) => 'State' in f)
    .map((f) => f.State as never)

describe('SyncplayClient room presence on join (#220)', () => {
  let client: SyncplayClient
  let roomUsers: SyncplayRoomUser[][]

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

  const serverState = (position: number, paused: boolean, setBy: string | null = null): void => {
    lastTlsSocket!.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          State: {
            ping: { latencyCalculation: 1 },
            playstate: { position, paused, doSeek: false, setBy }
          }
        }) + '\r\n'
      )
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
    roomUsers = []
    client.on('room-users', (u) => roomUsers.push(u as SyncplayRoomUser[]))
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  describe('the roster is requested, not waited for', () => {
    it('asks the server for the user list once the handshake completes', () => {
      handshake()
      expect(frames(lastTlsSocket)).toContainEqual({ List: null })
    })

    // The bug: people already sitting in the room generate no Set broadcasts,
    // so without a List request the joiner sees an empty room.
    it('populates the roster from the List reply for users who were already there', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              cinema: {
                mikkerlo: {
                  isReady: true,
                  file: {
                    name: 'Ore dake Level Up na Ken Season 2 - 2',
                    duration: 1440,
                    features: {
                      animeDlAppMeta: {
                        animeId: 42,
                        malId: 7,
                        episodeInt: '2',
                        translationId: 601
                      }
                    }
                  }
                },
                me: { isReady: true, file: {} }
              }
            }
          }) + '\r\n'
        )
      )

      const latest = roomUsers.at(-1)!
      expect(latest.map((u) => u.username).sort()).toEqual(['me', 'mikkerlo'])
      const peer = latest.find((u) => u.username === 'mikkerlo')!
      expect(peer.file?.name).toBe('Ore dake Level Up na Ken Season 2 - 2')
      // Without the metadata the view lists the peer but offers no "Join & watch".
      expect(peer.animeDlAppMeta).toEqual({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601
      })
    })

    // The server writes `file: {}` for a watcher with nothing loaded, which
    // would otherwise parse into a hollow {name:'', duration:0} and render as
    // an empty file line under their name.
    it('reports a watcher with nothing loaded as having no file', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )

      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.file).toBeNull()
    })

    // A room named like an Object.prototype member resolves to the prototype's
    // function through a bare index — non-undefined, so the single-room
    // fallback is skipped, and isObject() then rejects it: empty roster.
    it('reads a roster when the room is named like an Object prototype member', () => {
      handshake('toString')
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: { Renamed: { mikkerlo: { isReady: true, file: {} } } }
          }) + '\r\n'
        )
      )

      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])
    })

    it('ignores users sitting in other rooms on the same server', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              cinema: { mikkerlo: { isReady: true, file: {} } },
              'someone-elses-room': { stranger: { isReady: true, file: {} } }
            }
          }) + '\r\n'
        )
      )

      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])
    })

    it('keys the roster by the room name the server seated us in', () => {
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
      // Server canonicalizes the room name.
      lastTlsSocket!.emit(
        'data',
        Buffer.from('{"Hello":{"username":"me","room":{"name":"Cinema"},"version":"1.6.9"}}\r\n')
      )
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { Cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )

      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'mikkerlo'])
    })
  })

  describe('a joiner without a player never moves the room', () => {
    // The bug: snapshot defaults to {position: 0, paused: true} and the 1 s
    // heartbeat asserted it, so joining pulled everyone back to 0 and paused.
    it('sends no playstate at all before the server has reported one', () => {
      handshake()
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(3000)

      const states = statesOf(lastTlsSocket)
      expect(states.length).toBeGreaterThan(0)
      for (const s of states) expect(s.playstate).toBeUndefined()
    })

    it('mirrors the room position instead of asserting 0', () => {
      handshake()
      serverState(742.5, true)
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      // Position mirrored; no `paused` field at all — a spectator must never be
      // able to flip the room's pause state.
      expect(state.playstate).toEqual({ position: 742.5, doSeek: false })
    })

    it('advances the mirrored position while the room is playing, so we never read as lagging', () => {
      handshake()
      serverState(100, false)
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(3000)

      const states = statesOf(lastTlsSocket)
      expect(states.at(-1)!.playstate!.position).toBeCloseTo(103, 1)
      expect(states.at(-1)!.playstate!.paused).toBeUndefined()
    })

    // The race: a peer pauses, the room flips server-side, and our next
    // heartbeat is still carrying `paused: false` from the stale lastRoomState
    // — its arrival unpauses the room, setBy us. The server reads a *missing*
    // paused as "no claim", so a mirror that omits it cannot flip anything.
    // Distinct from the case below by actually crossing that boundary.
    it('carries no pause claim across a peer’s pause landing mid-stream', () => {
      handshake()
      serverState(100, false, 'mikkerlo')
      lastTlsSocket!.write.mockClear()
      vi.advanceTimersByTime(2000)
      const beforeCount = statesOf(lastTlsSocket).length

      // The peer's pause reaches us only now; heartbeats straddle it.
      serverState(100, true, 'mikkerlo')
      vi.advanceTimersByTime(2000)

      const states = statesOf(lastTlsSocket)
      expect(beforeCount).toBeGreaterThan(0)
      expect(states.length).toBeGreaterThan(beforeCount)
      for (const s of states) {
        expect(s.playstate).toBeDefined()
        expect('paused' in s.playstate!).toBe(false)
      }
    })

    it('never claims paused while the room is playing', () => {
      handshake()
      serverState(50, false)
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(5000)

      // Stronger than "never claims paused": a mirror makes no pause claim at
      // all, so it cannot race the room's own in-flight pause broadcast.
      for (const s of statesOf(lastTlsSocket)) expect(s.playstate!.paused).toBeUndefined()
    })
  })

  describe('a freshly opened player converges before it asserts', () => {
    // "Join & watch" mounts a <video> that reports {0, paused} for a beat
    // before the first remote State seeks it, and the renderer pushes that
    // snapshot on its 1 s timer — the same room-resetting assertion as the
    // no-player case, just arriving through a live player.
    it('does not assert a fresh player position 0 while the room plays on', () => {
      handshake()
      serverState(742.5, false)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })
      client.updateSnapshot({ position: 0, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate!.paused).toBeUndefined()
      expect(state.playstate!.position).toBeGreaterThan(742)
    })

    it('asserts its own state once the player has caught up to the room', () => {
      handshake()
      serverState(742.5, true)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })
      client.updateSnapshot({ position: 0, paused: true })
      vi.advanceTimersByTime(1000)
      lastTlsSocket!.write.mockClear()

      // The renderer's apply rule seeked us to the room position.
      client.updateSnapshot({ position: 742.5, paused: false })
      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate).toEqual({ position: 742.5, paused: false, doSeek: false })
    })

    // Latches: once converged, ordinary drift must not demote a live player
    // back to mirroring (that would silently stop propagating its position).
    it('keeps asserting after convergence even when drift exceeds the tolerance', () => {
      handshake()
      serverState(100, true)
      client.updateSnapshot({ position: 100, paused: true })
      vi.advanceTimersByTime(1000)
      lastTlsSocket!.write.mockClear()

      client.updateSnapshot({ position: 400, paused: true })
      vi.advanceTimersByTime(1000)

      expect(statesOf(lastTlsSocket)[0].playstate!.position).toBe(400)
    })

    // With peers listed we know we are not the first user, so an empty
    // lastRoomState means we are early (our heartbeat can beat the server's
    // first State), not alone — asserting the fresh {0, paused} there is the
    // same yank the gate exists to prevent.
    it('holds off when peers are present but no room state has arrived yet', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )
      client.updateSnapshot({ position: 0, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      for (const s of statesOf(lastTlsSocket)) expect(s.playstate).toBeUndefined()
    })

    // Reopening the *same* episode gets a fresh <video> at 0 with an identical
    // canonicalName, so setFile()'s identity check can't see the transition.
    it('re-converges when a new player reopens the same episode', () => {
      handshake()
      serverState(600, false)
      const file = {
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      }
      client.setFile(file)
      client.updateSnapshot({ position: 600, paused: false })
      vi.advanceTimersByTime(1000)

      // Player closed: pushes stop long enough to go stale, then the same
      // episode is reopened and its fresh element reports 0.
      vi.advanceTimersByTime(PLAYBACK_STALE_MS + 1000)
      client.setFile(file)
      client.updateSnapshot({ position: 0, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate!.position).toBeGreaterThan(600)
      expect(state.playstate!.paused).toBeUndefined()
    })

    // Main's readiness outlives the player; the renderer's is per-player and
    // only pushes on a change, so a player closed mid-buffer left main stuck
    // at false — pinning us as "Buffering" in every peer's roster.
    it('clears a stale buffering flag when a new player announces its file', () => {
      handshake()
      client.setReady(false)
      lastTlsSocket!.write.mockClear()

      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })

      expect(frames(lastTlsSocket)).toContainEqual({
        Set: { ready: { isReady: true, manuallyInitiated: false } }
      })
    })

    // One applied seek yields one `seeked`, so the echo target must retire —
    // otherwise a later genuine seek onto a peer's old position is dropped.
    it('retires the echo target so a later seek to the same spot still sends', () => {
      handshake()
      serverState(309.229, false, 'mikkerlo')
      client.updateSnapshot({ position: 309.229, paused: false })
      vi.advanceTimersByTime(1000)
      client.sendLocalState({ position: 309.228948, paused: false, cause: 'seek' })
      lastTlsSocket!.write.mockClear()

      // Much later the user deliberately seeks back to the same spot.
      client.sendLocalState({ position: 309.229, paused: false, cause: 'seek' })

      expect(statesOf(lastTlsSocket)[0].playstate!.doSeek).toBe(true)
    })

    it('asserts immediately when no room state exists yet — the first user sets it', () => {
      handshake()
      client.updateSnapshot({ position: 12.5, paused: false })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      expect(statesOf(lastTlsSocket)[0].playstate).toEqual({
        position: 12.5,
        paused: false,
        doSeek: false
      })
    })

    // The failure the unit tests missed and a live session found: opening the
    // player on "Join & watch" reset the host to 0. A fresh <video> fires
    // play/pause/seeked at ~0 *before* any remote state has been applied, so
    // the renderer's suppression window isn't up and those events reach main
    // (use-syncplay-client.ts onLocalPlay/onLocalPause/onVideoSeeked).
    it('sends nothing when a fresh player fires its startup events at 0', () => {
      handshake()
      serverState(742.5, false)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })
      lastTlsSocket!.write.mockClear()

      // Exactly what the renderer emits while the element loads.
      client.sendLocalState({ position: 0, paused: false, cause: 'play' })
      client.sendLocalState({ position: 0, paused: true, cause: 'pause' })
      client.sendLocalState({ position: 0, paused: false, cause: 'seek' })

      for (const s of statesOf(lastTlsSocket)) {
        expect(s.playstate?.position ?? Infinity).toBeGreaterThan(700)
      }
    })

    // Each pre-adoption local state used to bump clientIgnoreCounter, and
    // handleState drops every inbound remote state while that ack is pending —
    // so the player never got seeked to the room and the session desynced.
    it('keeps applying remote states while a fresh player is still converging', () => {
      handshake()
      serverState(742.5, false)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })
      const remote: Array<{ position: number }> = []
      client.on('remote-state', (s) => remote.push(s as { position: number }))

      client.sendLocalState({ position: 0, paused: false, cause: 'play' })
      client.sendLocalState({ position: 0, paused: true, cause: 'pause' })
      serverState(800, false, 'mikkerlo')

      expect(remote.map((r) => Math.round(r.position))).toContain(800)
    })

    // The readiness gate pauses the local element while we buffer; buffering
    // has its own channel (`Set: {ready}`) precisely so a slow client doesn't
    // ping-pong pause/play at the room. Caught live: a joiner whose stream
    // stalled paused everyone, over and over.
    // A user pause has to survive buffering. An earlier attempt withheld every
    // assertion while !ownIsReady, so the next heartbeat mirrored the room's
    // "playing" straight back and undid the pause a second after it was
    // pressed — reported live as "I paused and it didn't pause".
    it('keeps asserting a user pause while we are buffering', () => {
      handshake()
      serverState(742.5, false)
      client.updateSnapshot({ position: 742.5, paused: false })
      vi.advanceTimersByTime(1000)

      client.setReady(false)
      client.sendLocalState({ position: 742.5, paused: true, cause: 'pause' })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(2000)

      const states = statesOf(lastTlsSocket)
      expect(states.length).toBeGreaterThan(0)
      for (const s of states) expect(s.playstate!.paused).toBe(true)
    })

    // Caught in a live session: applying a peer's seek makes our element fire
    // `seeked` once it finishes — often past the renderer's 1500 ms window on a
    // network stream — and we handed the peer their own position back with
    // doSeek, dragging the room to a stale point and bumping the ignore
    // counter so inbound states got dropped. "Sync breaks after a few seeks".
    it('does not echo a seek that merely lands on the room position', () => {
      handshake()
      serverState(309.229, false, 'mikkerlo')
      client.updateSnapshot({ position: 309.229, paused: false })
      vi.advanceTimersByTime(1000)
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 309.228948, paused: false, cause: 'seek' })

      for (const s of statesOf(lastTlsSocket)) expect(s.playstate?.doSeek).not.toBe(true)
    })

    it('keeps applying remote states after an echoed seek (no ignore-counter stall)', () => {
      handshake()
      serverState(309.229, false, 'mikkerlo')
      client.updateSnapshot({ position: 309.229, paused: false })
      vi.advanceTimersByTime(1000)
      const remote: Array<{ position: number }> = []
      client.on('remote-state', (s) => remote.push(s as { position: number }))

      client.sendLocalState({ position: 309.228948, paused: false, cause: 'seek' })
      serverState(400, false, 'mikkerlo')

      expect(remote.map((r) => Math.round(r.position))).toContain(400)
    })

    it('still propagates a real user seek away from the room', () => {
      handshake()
      serverState(309.229, false, 'mikkerlo')
      client.updateSnapshot({ position: 309.229, paused: false })
      vi.advanceTimersByTime(1000)
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 90, paused: false, cause: 'seek' })

      expect(statesOf(lastTlsSocket)[0].playstate).toEqual({
        position: 90,
        paused: false,
        doSeek: true
      })
    })

    it('propagates an explicit local pause once converged', () => {
      handshake()
      serverState(742.5, false)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '2',
        translationId: 601,
        canonicalName: 'Show - 2',
        duration: 1440
      })
      // The apply rule has seeked us onto the room, so we speak for ourselves.
      client.updateSnapshot({ position: 742.5, paused: false })
      vi.advanceTimersByTime(1000)
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 742.5, paused: true, cause: 'pause' })

      expect(statesOf(lastTlsSocket)[0].playstate).toEqual({
        position: 742.5,
        paused: true,
        doSeek: false
      })
    })

    it('re-converges on the next episode instead of asserting its 0', () => {
      handshake()
      serverState(10, false)
      client.updateSnapshot({ position: 10, paused: false })
      vi.advanceTimersByTime(1000)

      // Peer advances; we follow onto a fresh element that starts at 0.
      serverState(30, false)
      client.setFile({
        animeId: 42,
        malId: 7,
        episodeInt: '3',
        translationId: 601,
        canonicalName: 'Show - 3',
        duration: 1440
      })
      client.updateSnapshot({ position: 0, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate!.position).toBeGreaterThan(30)
      expect(state.playstate!.paused).toBeUndefined()
    })
  })

  describe('a joiner with a player asserts its own state', () => {
    it('asserts the local snapshot once the renderer starts pushing', () => {
      handshake()
      // Converged with the room (see the adoption rule below), so this player
      // speaks for itself rather than mirroring.
      serverState(12, true)
      client.updateSnapshot({ position: 12.5, paused: false })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(1000)

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate).toEqual({ position: 12.5, paused: false, doSeek: false })
    })

    it('still propagates a local seek', () => {
      handshake()
      client.updateSnapshot({ position: 12.5, paused: false })
      lastTlsSocket!.write.mockClear()

      client.sendLocalState({ position: 300, paused: false, cause: 'seek' })

      const [state] = statesOf(lastTlsSocket)
      expect(state.playstate).toEqual({ position: 300, paused: false, doSeek: true })
    })

    // Closing the player stops the snapshot pushes but leaves the connection
    // up; the stale snapshot must not keep asserting a frozen position.
    it('reverts to mirroring when the player stops pushing snapshots', () => {
      handshake()
      serverState(600, false)
      // Converge first: at a drift of ~590 the client mirrors because it never
      // adopted, so this would pass with the staleness rule deleted. The frozen
      // snapshot has to be one it would otherwise be asserting.
      client.updateSnapshot({ position: 600, paused: false })
      vi.advanceTimersByTime(1000)
      client.updateSnapshot({ position: 601, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(10_000)

      const last = statesOf(lastTlsSocket).at(-1)!
      expect(last.playstate!.paused).toBeUndefined()
      expect(last.playstate!.position).toBeGreaterThan(600)
    })
  })

  // Every roster test above drives membership through `List`. `handleSet` is
  // the other half — the only path that carries live membership changes — and
  // no test fed it a raw frame, so its branches were reachable only in
  // production.
  describe('handleSet seats membership from live Set broadcasts', () => {
    const serverSet = (user: Record<string, unknown>): void => {
      lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ Set: { user } }) + '\r\n'))
    }

    it('seats a peer on a joined event and drops it on left', () => {
      handshake()

      serverSet({ peer: { event: { joined: true } } })
      expect(roomUsers.at(-1)!.map((u) => u.username)).toContain('peer')

      serverSet({ peer: { event: { left: true } } })
      expect(roomUsers.at(-1)!.map((u) => u.username)).not.toContain('peer')
    })

    it('does not seat the same peer twice on a repeated join', () => {
      handshake()

      serverSet({ peer: { event: { joined: true } } })
      const afterFirst = roomUsers.at(-1)!.filter((u) => u.username === 'peer').length
      serverSet({ peer: { event: { joined: true } } })

      expect(afterFirst).toBe(1)
      expect(roomUsers.at(-1)!.filter((u) => u.username === 'peer')).toHaveLength(1)
    })

    it('absorbs a peer file pushed without any event key', () => {
      handshake()

      serverSet({
        peer: {
          file: {
            name: 'COTE - 7',
            duration: 1440,
            features: { animeDlAppMeta: { animeId: 42, episodeInt: '7', translationId: 1 } }
          }
        }
      })

      const peer = roomUsers.at(-1)!.find((u) => u.username === 'peer')
      expect(peer?.file?.name).toBe('COTE - 7')
    })

    // The branch accepts two shapes for `data.isReady` — a nested object and a
    // bare boolean — and this pins both arms.
    //
    // DELETE WITH THE BRANCH. This characterizes handleSet's `data.isReady`
    // branch, which the reference server never emits — readiness travels as a
    // top-level Set:{ready}. #229 deletes that branch and removes this test,
    // replaced by a case feeding the real sendUserSetting shape ({room, file,
    // event} with no isReady). (#225's item A1 specified the same deletion and
    // was folded into #229 on 2026-08-06, so #229 is the sole owner.)
    it('records peer readiness from both the object and boolean shapes', () => {
      handshake()

      serverSet({ peer: { isReady: { isReady: false } } })
      expect(roomUsers.at(-1)!.find((u) => u.username === 'peer')?.isReady).toBe(false)

      serverSet({ other: { isReady: true } })
      expect(roomUsers.at(-1)!.find((u) => u.username === 'other')?.isReady).toBe(true)
    })

    it('ignores a malformed per-user payload without disturbing the roster', () => {
      handshake()
      serverSet({ peer: { event: { joined: true } } })
      const before = roomUsers.length

      serverSet({ peer: 'not-an-object' })

      expect(roomUsers).toHaveLength(before)
      expect(roomUsers.at(-1)!.map((u) => u.username)).toContain('peer')
    })

    // A top-level `Set: {room}` is a client→server command — the reference
    // server consumes it and no server-side `sendSet` emits it. Since the room
    // filter (#230) keys off `this.config.room`, honouring an unsolicited one
    // would rewrite the filter's reference name mid-session and re-expose
    // every stranger, so the branch is gone: the roster stays keyed to the
    // name `handleHello` seated us under.
    it('ignores a top-level Set:{room}, so the filter’s reference name cannot be rewritten', () => {
      handshake('cinema')

      lastTlsSocket!.emit(
        'data',
        Buffer.from(JSON.stringify({ Set: { room: { name: 'Cinema' } } }) + '\r\n')
      )
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              cinema: { me: { isReady: true, file: {} }, peer: { isReady: true, file: {} } },
              Cinema: { stranger: { isReady: true, file: {} } }
            }
          }) + '\r\n'
        )
      )

      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'peer'])

      // …and the per-user filter still reads "cinema" as ours, so the renamed
      // room's occupant stays out of the roster.
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            Set: { user: { stranger: { room: { name: 'Cinema' }, file: { name: 'X - 1' } } } }
          }) + '\r\n'
        )
      )

      expect(
        roomUsers
          .at(-1)!
          .map((u) => u.username)
          .sort()
      ).toEqual(['me', 'peer'])
    })
  })

  // With `isolateRooms` off — the reference server's default — `RoomManager.
  // broadcast` fans `Set: {user}` out to *every* room on the server, and
  // `handleSet` never read `data.room.name`. Strangers were seated, their
  // episode changes logged, and their file frames could navigate our player.
  // The filter has to be ordered rather than flat: a peer switching *out* of
  // our room arrives as a lone entry naming their **destination**
  // (`sendRoomSwitchMessage` broadcasts after `moveWatcher` has already
  // reassigned the room), so "ignore off-room entries" would discard the only
  // frame that tells us they left.
  describe('handleSet scopes Set:{user} to our own room (#230)', () => {
    let roomEvents: string[]
    let episodeChanges: unknown[]

    const serverSet = (user: Record<string, unknown>): void => {
      lastTlsSocket!.emit('data', Buffer.from(JSON.stringify({ Set: { user } }) + '\r\n'))
    }

    const fileFrame = (name: string, withMeta = false): Record<string, unknown> => ({
      name,
      duration: 1440,
      ...(withMeta
        ? { features: { animeDlAppMeta: { animeId: 42, malId: 7, episodeInt: '7' } } }
        : {})
    })

    const usernames = (): string[] => (roomUsers.at(-1) ?? []).map((u) => u.username).sort()

    beforeEach(() => {
      roomEvents = []
      episodeChanges = []
      client.on('room-event', (e) => roomEvents.push((e as { text: string }).text))
      client.on('remote-episode-change', (e) => episodeChanges.push(e))
    })

    // Written first, and it is not a regression guard: it passes on `main`
    // (where no room name is read at all) and fails only on a correct-looking
    // filter that keeps `pickOwnRoom`'s stale name. That hole is the one way
    // this change can make a working server worse — the roster would fill from
    // `List` and then empty itself peer by peer as each pushes a file.
    it('adopts the fallback room name, so later Set frames from that room are not filtered', () => {
      const statuses: Array<{ room?: string }> = []
      client.on('connection-status', (s) => statuses.push(s as { room?: string }))
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
      // No `room` key in Hello, so `handleHello` cannot adopt a canonical name.
      lastTlsSocket!.emit('data', Buffer.from('{"Hello":{"username":"me","version":"1.6.9"}}\r\n'))
      // Single room, keyed under a name we never learned → pickOwnRoom's
      // fallback arm resolves the roster but must also adopt "Cinema".
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ List: { Cinema: { mikkerlo: { isReady: true, file: {} } } } }) + '\r\n'
        )
      )
      expect(usernames()).toEqual(['me', 'mikkerlo'])

      serverSet({ mikkerlo: { room: { name: 'Cinema' }, file: fileFrame('COTE - 7') } })

      expect(usernames()).toEqual(['me', 'mikkerlo'])
      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.file?.name).toBe('COTE - 7')

      // The name the view renders is a third copy: `finishHandshake` emitted
      // "cinema" before the `List` arrived, and every later status that carries
      // a room reads it back off the config — so the adoption has to push it
      // through, or the displayed room flips on the next reconnect.
      expect(statuses.at(-1)!.room).toBe('Cinema')
    })

    // Case 1: the frame that separates an ordered filter from a flat one. It
    // names the peer's *new* room and carries no `left` event, because plain
    // `RoomManager.moveWatcher` emits none.
    it('drops a seated peer named by an off-room entry — that is the switch-out frame', () => {
      handshake()
      serverSet({ mikkerlo: { event: { joined: true } } })
      roomEvents.length = 0

      serverSet({ mikkerlo: { room: { name: 'elsewhere' } } })

      expect(usernames()).toEqual(['me'])
      expect(roomEvents).toEqual(['mikkerlo left the room'])
    })

    // Case 10: `sendFileUpdate` also emits `{room, file}` with no `event`, on
    // the hot path, so "no event means switch-in, announce a join" would put a
    // spurious join line in front of every switched-to line.
    it('seats an unseated in-room peer from a file frame without announcing a join', () => {
      handshake()

      serverSet({ mikkerlo: { room: { name: 'cinema' }, file: fileFrame('COTE - 7') } })

      expect(usernames()).toEqual(['me', 'mikkerlo'])
      expect(roomEvents).toEqual(['mikkerlo switched to "COTE - 7"'])
    })

    it('seats a peer switching into our room from a room-only frame', () => {
      handshake()

      serverSet({ mikkerlo: { room: { name: 'cinema' } } })

      expect(usernames()).toEqual(['me', 'mikkerlo'])
      expect(roomEvents).toEqual(['mikkerlo joined the room'])
      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.file).toBeNull()
    })

    it('ignores a stranger’s file frame entirely — no seat, no log line, no auto-nav', () => {
      handshake()

      serverSet({
        stranger: { room: { name: 'elsewhere' }, file: fileFrame('Some Other Show - 1', true) }
      })

      expect(usernames()).toEqual(['me'])
      expect(roomEvents).toEqual([])
      expect(episodeChanges).toEqual([])
    })

    it('ignores join and leave events from another room', () => {
      handshake()
      const emitsBefore = roomUsers.length

      serverSet({ stranger: { room: { name: 'elsewhere' }, event: { joined: true } } })
      serverSet({ stranger: { room: { name: 'elsewhere' }, event: { left: true } } })

      expect(roomUsers).toHaveLength(emitsBefore)
      expect(usernames()).toEqual(['me'])
      expect(roomEvents).toEqual([])
    })

    // Rule 0: self is exempt from the room filter. A flat rule 2 would delete
    // us from our own roster, and we would only reappear on the next readiness
    // toggle or reconnect.
    it('never evicts us on a self entry naming another room, and keeps our room name', () => {
      handshake()

      serverSet({ me: { room: { name: 'elsewhere' } } })

      expect(usernames()).toEqual(['me'])
      expect(roomEvents).toEqual([])

      // The filter still keys off "cinema", so an in-room peer is accepted.
      serverSet({ mikkerlo: { room: { name: 'cinema' } } })
      expect(usernames()).toEqual(['me', 'mikkerlo'])
    })

    // Rule 0 is "exempt from the room filter", not "skip the entry".
    // `sendFileUpdate` broadcasts without excluding the sender, so our own push
    // comes back to us and `absorbRemoteFile` is what keeps our roster row's
    // file current between `List` replies.
    it('still absorbs our own echoed file, silently', () => {
      handshake()

      serverSet({ me: { room: { name: 'cinema' }, file: fileFrame('COTE - 7', true) } })

      expect(roomUsers.at(-1)!.find((u) => u.username === 'me')!.file?.name).toBe('COTE - 7')
      expect(roomEvents).toEqual([])
      expect(episodeChanges).toEqual([])
    })

    // …and the branch where the exemption actually earns its keep: the case
    // above names our own room, so it takes the ordinary in-room path and would
    // pass with rule 0 deleted. Only an off-room *self* entry reaches rule 2's
    // `continue`, which would drop our own file instead of absorbing it.
    // Unreachable against a reference server — belt and braces for rule 0.
    it('absorbs our own echoed file even when the entry names another room', () => {
      handshake()

      serverSet({ me: { room: { name: 'elsewhere' }, file: fileFrame('COTE - 7', true) } })

      expect(usernames()).toEqual(['me'])
      expect(roomUsers.at(-1)!.find((u) => u.username === 'me')!.file?.name).toBe('COTE - 7')
      expect(roomEvents).toEqual([])
      expect(episodeChanges).toEqual([])
    })

    // Rule 1 announces a switch-in only for frames that carry nothing but a
    // room. `isReady` speaks for itself: the branch at the bottom of the loop
    // seats the user, so announcing here would put a spurious join line in
    // front of it. Dead against a reference server (live readiness is a
    // top-level `Set: {ready}`), live again the moment #229 revives the path.
    it('seats a peer from a {room, isReady} entry without announcing a join', () => {
      handshake()

      serverSet({ mikkerlo: { room: { name: 'cinema' }, isReady: false } })

      expect(usernames()).toEqual(['me', 'mikkerlo'])
      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.isReady).toBe(false)
      expect(roomEvents).toEqual([])
    })

    // Pins the invariant that makes `handleSet` safe to write against a
    // non-null `config`: the two sites that null it (`failHandshake`,
    // `disconnectInternal(true)`) both go through `tearDown` →
    // `resetTransportState`, which sets `rxBuffer = ''` — so the rest of the
    // chunk is discarded mid-drain rather than dispatched without a config.
    // (`tearDown` also strips the socket's listeners, and `upgradeToTls`
    // reassigns `this.socket` to the TLS socket, so no *later* chunk arrives
    // either.) Without this the filter's own-room comparison would need a
    // fail-closed reading of `undefined` to mean anything.
    it('discards the rest of the chunk once an escalating Error tears the session down', () => {
      handshake()
      const emitsBefore = roomUsers.length

      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({ Error: { message: 'You are banned from this server' } }) +
            '\r\n' +
            JSON.stringify({
              Set: { user: { stranger: { room: { name: 'elsewhere' } } } }
            }) +
            '\r\n'
        )
      )

      // `tearDown` already emptied the roster without broadcasting, so the
      // proof is that the stranger produced neither a fresh `room-users` emit
      // nor a join line.
      expect(roomUsers).toHaveLength(emitsBefore)
      expect(roomEvents).toEqual(['You are banned from this server'])
    })

    // Characterization, not a regression guard: `sendUserSetting` always writes
    // `room`, so a roomless entry only arrives from a proxy or a non-reference
    // server. Treating it as ours preserves today's behavior exactly.
    it('treats an entry with no room key as ours', () => {
      handshake()

      serverSet({ mikkerlo: { file: fileFrame('COTE - 7') } })

      expect(roomUsers.at(-1)!.find((u) => u.username === 'mikkerlo')!.file?.name).toBe('COTE - 7')
    })

    // `PublicRoomManager.moveWatcher` (isolateRooms=True) does broadcast a
    // `left`, but with the **old** room and room-scoped — so it names our own
    // room and takes today's exact path.
    it('keeps the isolateRooms leave frame working, since it names our own room', () => {
      handshake()
      serverSet({ mikkerlo: { event: { joined: true } } })
      roomEvents.length = 0

      serverSet({ mikkerlo: { room: { name: 'cinema' }, event: { left: true } } })

      expect(usernames()).toEqual(['me'])
      expect(roomEvents).toEqual(['mikkerlo left the room'])
    })

    // …and on that server the switch-in's file frame arrives *before* the
    // switch frame (`moveWatcher` ends with `setFile`, inside `setWatcherRoom`,
    // ahead of `sendRoomSwitchMessage`). So the peer is seated silently by the
    // file frame and the room-only frame that follows must do nothing at all.
    it('seats an isolated switch-in once, and the trailing room-only frame is a no-op', () => {
      handshake()
      serverSet({ mikkerlo: { room: { name: 'cinema' }, file: fileFrame('COTE - 7') } })
      const emitsAfterFile = roomUsers.length

      serverSet({ mikkerlo: { room: { name: 'cinema' } } })

      expect(roomUsers.at(-1)!.filter((u) => u.username === 'mikkerlo')).toHaveLength(1)
      expect(roomEvents).toEqual(['mikkerlo switched to "COTE - 7"'])
      expect(roomUsers).toHaveLength(emitsAfterFile)
    })
  })
})
