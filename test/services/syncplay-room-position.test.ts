// `syncplay:get-room-position` (#262) — the value that seeds the MKV ffmpeg
// spawn, so the open doesn't pay a second spawn plus its buffer-ahead wait when
// the room is parked away from our local resume target.
//
// The discriminating property is the *gate*: a state we set ourselves — a user
// alone in a room, whose own position the server echoes back once a second —
// must answer `null`, even though `lastRoomState` is populated by it. An
// implementation built on `lastRoomState` (the spectator mirror's source,
// recorded deliberately *above* handleState()'s echo guards) passes every other
// test here and fails that one.

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

import { SyncplayClient } from '../../src/main/syncplay'

describe('SyncplayClient.getRoomPosition (#262)', () => {
  let client: SyncplayClient

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

  const serverState = (position: number, paused: boolean, setBy: string | null): void => {
    lastTlsSocket!.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          State: {
            ping: { latencyCalculation: 1_770_000_000.25 },
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
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  describe('the gate', () => {
    it('reports the room position after a state set by a peer', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      expect(client.getRoomPosition()).toBeCloseTo(600, 3)
    })

    // The solo-room case, and the whole reason this is a second field rather
    // than a read of `lastRoomState`: the server re-broadcasts our own reported
    // position with `setBy` naming us, so a client alone in a room *does* have a
    // `lastRoomState`. Answering with it would seed every MKV open from the
    // room instead of the saved position — the regression `roomOwnsPlayhead()`
    // exists to prevent, moved one layer earlier.
    it('returns null when the only states seen were set by us', () => {
      handshake()
      serverState(600, true, 'me')
      expect(client.getRoomPosition()).toBeNull()
    })

    it('returns null for a state carrying no setBy at all', () => {
      handshake()
      serverState(600, true, null)
      expect(client.getRoomPosition()).toBeNull()
    })

    it('returns null before any state has arrived', () => {
      handshake()
      expect(client.getRoomPosition()).toBeNull()
    })

    it('returns null with no session at all', () => {
      expect(client.getRoomPosition()).toBeNull()
    })

    // A peer's state seen while connected must not answer for a session that
    // has since ended: `disconnect()` runs tearDown(), which drops the field
    // beside `lastRoomState`.
    it('returns null after the session is torn down', () => {
      handshake()
      serverState(600, false, 'mikkerlo')
      expect(client.getRoomPosition()).not.toBeNull()
      client.disconnect()
      expect(client.getRoomPosition()).toBeNull()
    })
  })

  describe('the projection', () => {
    it('advances with wall time while the room is playing', () => {
      handshake()
      serverState(600, false, 'mikkerlo')
      vi.advanceTimersByTime(4000)
      expect(client.getRoomPosition()!).toBeCloseTo(604, 1)
    })

    // A paused position does not age, so advancing it is pure error — the same
    // rule `projectedRoomPosition()` applies for the spectator mirror.
    it('does not advance while the room is paused', () => {
      handshake()
      serverState(600, true, 'mikkerlo')
      vi.advanceTimersByTime(4000)
      expect(client.getRoomPosition()!).toBeCloseTo(600, 3)
    })

    it('never reports a negative position', () => {
      handshake()
      serverState(-5, true, 'mikkerlo')
      expect(client.getRoomPosition()).toBe(0)
    })
  })

  describe('file identity', () => {
    const file = (canonicalName: string, newPlayer = true): void => {
      client.setFile({
        animeId: 1,
        malId: 2,
        episodeInt: canonicalName.slice(-1),
        translationId: 3,
        canonicalName,
        duration: 1440,
        newPlayer
      })
    }

    // The room's position was reported for the file we were on. Handed to the
    // next episode's spawn it would be worse than the saved position it
    // replaces.
    it('drops the position when our canonical name changes', () => {
      handshake()
      file('Some Anime - 1')
      serverState(600, true, 'mikkerlo')
      expect(client.getRoomPosition()).toBeCloseTo(600, 3)

      file('Some Anime - 2')
      expect(client.getRoomPosition()).toBeNull()
    })

    // Keyed on identity, not on `newPlayer`: a same-episode reopen (close the
    // player, pick another translation) re-pushes a byte-identical name at a
    // fresh <video>, and the room's position is still the right seed for it.
    it('keeps the position across a same-episode reopen', () => {
      handshake()
      file('Some Anime - 1')
      serverState(600, true, 'mikkerlo')

      file('Some Anime - 1', true)
      expect(client.getRoomPosition()).toBeCloseTo(600, 3)
    })

    it('re-earns the position from the next state after a switch', () => {
      handshake()
      file('Some Anime - 1')
      serverState(600, true, 'mikkerlo')
      file('Some Anime - 2')
      serverState(12, true, 'mikkerlo')
      expect(client.getRoomPosition()).toBeCloseTo(12, 3)
    })
  })
})
