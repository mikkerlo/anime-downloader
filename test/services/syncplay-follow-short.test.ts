// `followShortOf` through main, one client at a time (#506).
//
// A follower whose room walk stopped short of the leader's pick marks every push
// from the episode it reached. Main only passes the marker through: `setFile()`
// stores it (its rest spread strips `episodeSwitch` alone), `sendSetFile()`
// writes it into `animeDlAppMeta`, the reconnect re-announce carries it, and
// `absorbRemoteFile()` hands it to the renderer on `remote-episode-change`,
// keyed exactly as before. The opposite of `episodeSwitch`, which is never
// stored and never on the wire. The renderer's decision is pinned in
// `test/services/syncplay-two-peer-episode-change.test.ts`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'

class FakeSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  write = vi.fn()
  destroy = vi.fn(() => {
    this.emit('close')
  })
}

const tlsSockets: FakeSocket[] = []
let lastSocket: FakeSocket | null = null

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    lastSocket = new FakeSocket()
    return lastSocket
  })
}))

vi.mock('tls', () => ({
  connect: vi.fn(() => {
    const s = new FakeSocket()
    tlsSockets.push(s)
    return s
  })
}))

import { SyncplayClient, type SyncplayRemoteEpisode } from '../../src/main/syncplay'

// Comfortably past the first reconnect backoff (RECONNECT_BASE_MS = 1000).
const RECONNECT_MS = 1500

type Meta = Record<string, unknown>

describe('SyncplayClient — followShortOf is stored and on the wire (#506)', () => {
  let client: SyncplayClient
  let episodes: SyncplayRemoteEpisode[]

  const tls = (): FakeSocket => tlsSockets[tlsSockets.length - 1]

  const completeHandshake = (): void => {
    lastSocket!.emit('connect')
    lastSocket!.emit('data', Buffer.from('{"TLS":{"startTLS":"true"}}\r\n'))
    tls().emit('secureConnect')
    tls().emit(
      'data',
      Buffer.from('{"Hello":{"username":"me","room":{"name":"cinema"},"version":"1.6.9"}}\r\n')
    )
  }

  const handshake = (autoReconnect = false): void => {
    client.connect({
      host: 'syncplay.test',
      port: 8999,
      room: 'cinema',
      username: 'me',
      autoReconnect
    })
    completeHandshake()
  }

  const file = (episodeInt: string, extra: Partial<SyncplayFilePayload> = {}): void => {
    client.setFile({
      animeId: 1,
      malId: 2,
      episodeInt,
      translationId: 3,
      canonicalName: `Some Anime - ${episodeInt}`,
      duration: 1440,
      playerSessionId: 'p-1',
      ...extra
    })
  }

  /** `animeDlAppMeta` of every outbound `Set: {file}` on `sock`. */
  const sentMetas = (sock: FakeSocket = tls()): Meta[] =>
    sock.write.mock.calls
      .map(([f]) => JSON.parse(String(f)) as { Set?: { file?: { features?: Meta } } })
      .filter((m) => m.Set?.file)
      .map((m) => m.Set!.file!.features!.animeDlAppMeta as Meta)

  const peerFile = (episodeInt: string, extra: Meta = {}): void => {
    const animeDlAppMeta = { animeId: 1, malId: 2, episodeInt, translationId: 3, ...extra }
    tls().emit(
      'data',
      Buffer.from(
        JSON.stringify({
          Set: {
            user: {
              rigB: {
                room: { name: 'cinema' },
                file: {
                  name: `Some Anime - ${episodeInt}`,
                  duration: 1440,
                  features: { animeDlAppMeta }
                }
              }
            }
          }
        }) + '\r\n'
      )
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'))
    tlsSockets.length = 0
    lastSocket = null
    client = new SyncplayClient()
    episodes = []
    client.on('remote-episode-change', (e) => episodes.push(e as SyncplayRemoteEpisode))
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  it('stores the marker and writes it into animeDlAppMeta, beside an unmarked file', () => {
    handshake()

    file('7', { episodeSwitch: 'follow', followShortOf: '8' })
    file('7')

    expect(sentMetas()).toEqual([
      { animeId: 1, malId: 2, episodeInt: '7', translationId: 3, followShortOf: '8' },
      { animeId: 1, malId: 2, episodeInt: '7', translationId: 3 }
    ])
    expect(sentMetas()[1]).not.toHaveProperty('followShortOf')
  })

  it('keeps the marker in currentFile while dropping episodeSwitch', () => {
    handshake()

    file('7', { episodeSwitch: 'follow', followShortOf: '8' })

    expect(client['currentFile']).toHaveProperty('followShortOf', '8')
    expect(client['currentFile']).not.toHaveProperty('episodeSwitch')
  })

  it('the reconnect re-announce carries it', async () => {
    handshake(true)
    file('7', { episodeSwitch: 'follow', followShortOf: '8' })
    const first = tls()

    first.emit('close')
    await vi.advanceTimersByTimeAsync(RECONNECT_MS)
    completeHandshake()

    expect(tls()).not.toBe(first)
    expect(sentMetas(tls())).toEqual([
      { animeId: 1, malId: 2, episodeInt: '7', translationId: 3, followShortOf: '8' }
    ])
  })

  it('passes a peer’s marker through on remote-episode-change, keyed as before', () => {
    handshake()

    peerFile('7', { followShortOf: '8' })
    // The same key again, the marker unchanged: no second emit.
    peerFile('7', { followShortOf: '8' })
    peerFile('6')

    expect(episodes.map((e) => [e.episodeInt, e.followShortOf])).toEqual([
      ['7', '8'],
      ['6', undefined]
    ])
    expect(episodes[1]).not.toHaveProperty('followShortOf')
    expect(client.getRoomUsers().find((u) => u.username === 'rigB')?.animeDlAppMeta).toEqual({
      animeId: 1,
      malId: 2,
      episodeInt: '6',
      translationId: 3
    })
  })

  it('reads a non-string marker as absent', () => {
    handshake()

    peerFile('7', { followShortOf: 8 })

    expect(episodes).toHaveLength(1)
    expect(episodes[0]).not.toHaveProperty('followShortOf')
  })
})
