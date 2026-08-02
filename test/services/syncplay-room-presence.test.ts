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

type Frame = Record<string, unknown>

const frames = (sock: FakeSocket | null): Frame[] =>
  (sock?.write.mock.calls ?? []).map(([f]) => JSON.parse(String(f)) as Frame)

const statesOf = (
  sock: FakeSocket | null
): Array<{
  playstate?: { position: number; paused: boolean; doSeek: boolean }
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
                me: { isReady: true, file: null }
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

    it('ignores users sitting in other rooms on the same server', () => {
      handshake()
      lastTlsSocket!.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            List: {
              cinema: { mikkerlo: { isReady: true, file: null } },
              'someone-elses-room': { stranger: { isReady: true, file: null } }
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
          JSON.stringify({ List: { Cinema: { mikkerlo: { isReady: true, file: null } } } }) + '\r\n'
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
      expect(state.playstate).toEqual({ position: 742.5, paused: true, doSeek: false })
    })

    it('advances the mirrored position while the room is playing, so we never read as lagging', () => {
      handshake()
      serverState(100, false)
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(3000)

      const states = statesOf(lastTlsSocket)
      expect(states.at(-1)!.playstate!.position).toBeCloseTo(103, 1)
      expect(states.at(-1)!.playstate!.paused).toBe(false)
    })

    it('never claims paused while the room is playing', () => {
      handshake()
      serverState(50, false)
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(5000)

      for (const s of statesOf(lastTlsSocket)) expect(s.playstate!.paused).toBe(false)
    })
  })

  describe('a joiner with a player asserts its own state', () => {
    it('asserts the local snapshot once the renderer starts pushing', () => {
      handshake()
      serverState(742.5, true)
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
      client.updateSnapshot({ position: 12.5, paused: true })
      lastTlsSocket!.write.mockClear()

      vi.advanceTimersByTime(10_000)

      const last = statesOf(lastTlsSocket).at(-1)!
      expect(last.playstate!.paused).toBe(false)
      expect(last.playstate!.position).toBeGreaterThan(600)
    })
  })
})
