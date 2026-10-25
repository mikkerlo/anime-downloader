// The file-change seek (#486), one client at a time.
//
// A Syncplay room state carries no file identity, so after an in-player episode
// change every position the room holds is still the previous episode's number.
// `setFile()` answers an `episodeSwitch: 'local'` (or, since #512,
// `'auto-advance'`) push the way the reference
// client answers a playlist change: it sends one forced seek to 0, and the
// server's `forcePositionUpdate` overwrites every watcher's stored position with
// it. These cases pin the frame itself and every path that must *not* send it.
// The two-peer outcome is `syncplay-two-peer-episode-change.test.ts`.

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
import type { SyncplayRemoteState } from '../../src/main/syncplay'

type Playstate = { position: number; paused?: boolean; doSeek: boolean }
type StateFrame = { playstate?: Playstate; ignoringOnTheFly?: { client?: number } }

const EP7 = 'Some Anime - 7'
const EP8 = 'Some Anime - 8'

describe('SyncplayClient — the file-change seek (#486)', () => {
  let client: SyncplayClient

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
  }

  const emit = (msg: unknown): void => {
    lastTlsSocket!.emit('data', Buffer.from(JSON.stringify(msg) + '\r\n'))
  }

  // A peer is listed, so adoption has to be earned by drift rather than handed
  // out by `rosterSaysAlone()`.
  const withPeer = (): void => {
    emit({
      List: {
        cinema: {
          me: { position: 0, file: {} },
          peer: { position: 0, file: { name: EP7, duration: 1440 } }
        }
      }
    })
  }

  const roomState = (position: number, paused: boolean, setBy = 'peer'): void => {
    emit({ State: { playstate: { position, paused, doSeek: false, setBy } } })
  }

  const file = (
    canonicalName: string,
    extra: { newPlayer?: boolean; episodeSwitch?: SyncplayEpisodeSwitch } = {}
  ): void => {
    client.setFile({
      animeId: 1,
      malId: 2,
      episodeInt: canonicalName.slice(canonicalName.lastIndexOf(' ') + 1),
      translationId: 3,
      canonicalName,
      duration: 1440,
      playerSessionId: 'p-1',
      ...extra
    })
  }

  const states = (): StateFrame[] =>
    (lastTlsSocket?.write.mock.calls ?? [])
      .map(([f]) => JSON.parse(String(f)) as { State?: StateFrame })
      .filter((m) => m.State)
      .map((m) => m.State!)

  const seeks = (): Playstate[] =>
    states()
      .map((s) => s.playstate)
      .filter((p): p is Playstate => p?.doSeek === true)

  /** Seated on episode 7 in a room playing at 600, adopted, heartbeats flowing. */
  const seatAdopted = (paused = false): void => {
    handshake()
    withPeer()
    roomState(600, paused)
    file(EP7, { newPlayer: true })
    client.updateSnapshot({ position: 600, paused })
    vi.advanceTimersByTime(1000)
    expect(client['playbackAdopted']).toBe(true)
    lastTlsSocket!.write.mockClear()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T00:00:00Z'))
    lastSocket = null
    lastTlsSocket = null
    client = new SyncplayClient()
  })

  afterEach(() => {
    client.disconnect()
    vi.useRealTimers()
  })

  it('sends exactly one forced seek to 0 after a local switch, built from the override and not the mirror', () => {
    seatAdopted()

    file(EP8, { episodeSwitch: 'local' })

    // One frame, and it is the explicit one: position 0, the room's `paused`,
    // `doSeek`. Routed through the plain `sendStateMessage({doSeek: true})` it
    // would be the mirror — de-adopted and with the snapshot just dropped —
    // i.e. `{position: ~600, doSeek: false}` with no `paused` key, which is the
    // old episode's number forced into every watcher.
    expect(seeks()).toHaveLength(1)
    expect(seeks()[0]).toEqual({ position: 0, paused: false, doSeek: true })
    expect(states()).toHaveLength(1)

    // Bumped like any local seek, so frames already in flight for the old
    // episode are dropped until the server answers.
    expect(client['clientIgnoreCounter']).toBe(1)
    expect(client['pendingClientAck']).toBe(1)
    expect(states()[0].ignoringOnTheFly).toEqual({ client: 1 })
  })

  it('carries the room’s paused flag, so a paused room stays paused', () => {
    seatAdopted(true)

    file(EP8, { episodeSwitch: 'local' })

    expect(seeks()).toEqual([{ position: 0, paused: true, doSeek: true }])
  })

  it('drops the outgoing snapshot, so the next heartbeat cannot re-adopt on the old position', () => {
    seatAdopted()

    file(EP8, { episodeSwitch: 'local' })
    lastTlsSocket!.write.mockClear()
    // The heartbeat before the server's forced update comes back. The room
    // state we hold is still the old episode's 600, so a snapshot left at 600
    // would read as drift 0, re-latch adoption and assert 600 under the new file.
    vi.advanceTimersByTime(1000)

    expect(client['lastSnapshotAt']).toBe(0)
    expect(client['playbackAdopted']).toBe(false)
    const asserted = states()
      .map((s) => s.playstate)
      .filter((p) => p?.paused !== undefined)
    expect(asserted).toEqual([])
  })

  // #512. The end-of-episode countdown is the one origin that knows why the
  // room is paused: every peer's `ended` reported paused, and the seek resumes
  // it. A `'local'` press in the same paused room keeps it paused (above).
  it('an auto-advance forces the room to 0 playing, even when the room is paused', () => {
    seatAdopted(true)

    file(EP8, { episodeSwitch: 'auto-advance' })

    expect(seeks()).toEqual([{ position: 0, paused: false, doSeek: true }])
    expect(states()).toHaveLength(1)
    expect(client['clientIgnoreCounter']).toBe(1)
    expect(client['pendingClientAck']).toBe(1)
    expect(client['lastSnapshotAt']).toBe(0)
  })

  it('an auto-advance in a playing room forces it to 0 playing too', () => {
    seatAdopted(false)

    file(EP8, { episodeSwitch: 'auto-advance' })

    expect(seeks()).toEqual([{ position: 0, paused: false, doSeek: true }])
  })

  it('a follow sends no seek in a paused room either', () => {
    // The origin test that #512 widened: a follow must stay seek-free whatever
    // the room's state, or it rewinds the presser.
    seatAdopted(true)

    file(EP8, { episodeSwitch: 'follow' })
    vi.advanceTimersByTime(1000)

    expect(seeks()).toEqual([])
    expect(client['clientIgnoreCounter']).toBe(0)
  })

  // #512's Critical item: the "stray `paused:false` then `paused:true`" pair
  // the manual matrix saw around an auto-advance. The first frame is not a
  // `paused: false` at all: it is the mirror arm of `buildPlaystate()`, a
  // position with no `paused` key, sent by any heartbeat that ticks between the
  // switch (which drops the snapshot) and the new element's first push. The
  // second is just the next heartbeat asserting what that push said. So the
  // pair belongs to every origin, and only the push decides the second frame.
  it.each<SyncplayEpisodeSwitch>(['local', 'auto-advance', 'follow'])(
    'a heartbeat between a %s switch and the first push claims no pause; the next asserts the push (#512)',
    (origin) => {
      seatAdopted(true)
      const resumes = origin === 'auto-advance'

      file(EP8, { episodeSwitch: origin })
      if (origin !== 'follow') {
        // The server's answer to our forced seek.
        emit({
          State: {
            playstate: { position: 0, paused: !resumes, doSeek: true, setBy: 'me' },
            ignoringOnTheFly: { client: 1 }
          }
        })
      } else {
        roomState(0, true)
      }
      lastTlsSocket!.write.mockClear()
      vi.advanceTimersByTime(1000)

      const gap = states().flatMap((s) => (s.playstate ? [s.playstate] : []))
      expect(gap).toHaveLength(1)
      expect(gap[0]).not.toHaveProperty('paused')
      // The room's 0, advanced by wall time once the room plays.
      expect(gap[0].position).toBeCloseTo(resumes ? 1 : 0, 1)

      lastTlsSocket!.write.mockClear()
      client.updateSnapshot({ position: 0, paused: !resumes })
      vi.advanceTimersByTime(1000)

      const next = states().flatMap((s) => (s.playstate ? [s.playstate] : []))
      expect(next.map((p) => p.paused)).toEqual([!resumes])
    }
  )

  it('a follow drops the snapshot and sends no seek', () => {
    seatAdopted()

    file(EP8, { episodeSwitch: 'follow' })
    vi.advanceTimersByTime(1000)

    expect(seeks()).toEqual([])
    expect(client['clientIgnoreCounter']).toBe(0)
    expect(client['lastSnapshotAt']).toBe(0)
    expect(client['playbackAdopted']).toBe(false)
  })

  it('sends no seek while the room has told us nothing', () => {
    handshake()
    withPeer()
    file(EP7, { newPlayer: true })
    lastTlsSocket!.write.mockClear()

    file(EP8, { episodeSwitch: 'local' })

    expect(seeks()).toEqual([])
    expect(client['clientIgnoreCounter']).toBe(0)
  })

  it('sends no seek on a first open into a mid-episode room', () => {
    handshake()
    withPeer()
    roomState(600, false)
    lastTlsSocket!.write.mockClear()

    file(EP8, { newPlayer: true })
    vi.advanceTimersByTime(3000)

    expect(seeks()).toEqual([])
    expect(client['clientIgnoreCounter']).toBe(0)
  })

  it('sends no seek on a reopen after playerClosed()', () => {
    seatAdopted()

    client.playerClosed('p-1')
    file(EP8, { newPlayer: true })
    vi.advanceTimersByTime(3000)

    expect(seeks()).toEqual([])
    expect(client['clientIgnoreCounter']).toBe(0)
  })

  it('sends no seek on a translation or quality switch, and keeps adoption', () => {
    seatAdopted()

    // Same canonicalName: a translation switch re-pushes with no field, and
    // even a stray `episodeSwitch` on an unchanged file is ignored.
    file(EP7)
    file(EP7, { episodeSwitch: 'local' })

    expect(seeks()).toEqual([])
    expect(client['clientIgnoreCounter']).toBe(0)
    expect(client['playbackAdopted']).toBe(true)
  })

  it('a duration re-push after a local switch sends no second seek', () => {
    seatAdopted()

    file(EP8, { episodeSwitch: 'local' })
    // `onDurationChange`'s re-push: same file, no field.
    file(EP8)
    vi.advanceTimersByTime(3000)

    expect(seeks()).toHaveLength(1)
    expect(client['clientIgnoreCounter']).toBe(1)
  })

  it('never stores the field, so a reconnect re-announce cannot replay it', () => {
    seatAdopted()

    file(EP8, { episodeSwitch: 'local' })

    expect(client['currentFile']).not.toHaveProperty('episodeSwitch')
  })

  // #502. A peer that pauses (or seeks, or plays) in the slice we switch sent
  // that frame before its own `Set{file}`, so our roster still lists it on the
  // old episode when the frame arrives, and its position belongs to that
  // episode. The two-peer outcomes are in
  // `syncplay-two-peer-ignore-counters.test.ts`; these pin the marker and the
  // gate one frame at a time.
  describe('an old-file frame crossing the file-change seek (#502)', () => {
    /** `Set{user}` relaying `username`'s file, with app meta unless `vanilla`. */
    const peerOn = (
      username: string,
      episodeInt: string,
      extra: {
        followShortOf?: string
        translationId?: number
        vanilla?: boolean
        animeId?: number
      } = {}
    ): void => {
      const meta = {
        animeId: extra.animeId ?? 1,
        malId: 2,
        episodeInt,
        translationId: extra.translationId ?? 3,
        ...(extra.followShortOf ? { followShortOf: extra.followShortOf } : {})
      }
      emit({
        Set: {
          user: {
            [username]: {
              room: { name: 'cinema' },
              file: {
                name: `Some Anime - ${episodeInt}`,
                duration: 1440,
                ...(extra.vanilla ? {} : { features: { animeDlAppMeta: meta } })
              }
            }
          }
        }
      })
    }

    /** A forced update, as the server broadcasts a pause change or a seek. */
    const forced = (
      position: number,
      paused: boolean,
      setBy: string,
      server: number,
      doSeek = false
    ): void => {
      emit({
        State: { playstate: { position, paused, doSeek, setBy }, ignoringOnTheFly: { server } }
      })
    }

    const remote: SyncplayRemoteState[] = []
    const marker = (): unknown => client['fileChangeInFlight']

    /** Adopted on episode 7 with `peer` listed there too, then a switch to 8. */
    const seatAndSwitch = (
      origin: SyncplayEpisodeSwitch = 'local',
      paused = false,
      peers: string[] = ['peer']
    ): void => {
      handshake()
      withPeer()
      for (const p of peers) peerOn(p, '7')
      roomState(600, paused)
      file(EP7, { newPlayer: true })
      client.updateSnapshot({ position: 600, paused })
      vi.advanceTimersByTime(1000)
      expect(client['playbackAdopted']).toBe(true)
      remote.length = 0
      client.on('remote-state', (s: SyncplayRemoteState) => remote.push(s))
      file(EP8, { episodeSwitch: origin })
      lastTlsSocket!.write.mockClear()
    }

    /** Our own file-change seek, reflected back (closes the window). */
    const ownEcho = (paused = false, server = 1): void => {
      forced(0, paused, 'me', server, true)
    }

    it.each<SyncplayEpisodeSwitch>(['local', 'auto-advance'])(
      'arms on a %s switch while an app peer is listed on the old episode',
      (origin) => {
        seatAndSwitch(origin)
        expect(marker()).toEqual({ animeId: 1, episodeInt: '8' })
      }
    )

    it('never arms on a follow, which sends no seek', () => {
      seatAndSwitch('follow')
      expect(marker()).toBeNull()
    })

    it('is not left armed when no app peer is off the pick', () => {
      // A vanilla peer only: unknown, not contradicted.
      seatAndSwitch('local', false, [])
      expect(marker()).toBeNull()
    })

    it('ordering A: keeps the pause, hands the renderer 0, records 0 and sends one corrective seek', () => {
      seatAndSwitch('local')
      ownEcho()
      // Our own echo does not clear it: in ordering A the old-file frame
      // arrives after it.
      expect(marker()).not.toBeNull()
      expect(client['pendingClientAck']).toBe(0)
      remote.length = 0
      lastTlsSocket!.write.mockClear()

      forced(304, true, 'peer', 2)

      expect(remote).toEqual([{ paused: true, position: 0, setBy: 'peer', doSeek: false }])
      expect(client['lastRoomState']!.position).toBe(0)
      expect(client['lastRemoteRoomState']!.position).toBe(0)
      // Built from the override, like the file-change seek, never the mirror.
      expect(seeks()).toEqual([{ position: 0, paused: true, doSeek: true }])
      expect(client['clientIgnoreCounter']).toBe(2)
      expect(client['pendingClientAck']).toBe(2)
      expect(client['crossedByForeign']).toBeNull()
      // Its own bump does not go through `sendLocalState()` and leaves the
      // marker armed.
      expect(marker()).toEqual({ animeId: 1, episodeInt: '8' })
    })

    it('ordering A: an old-file seek goes out as a seek to 0, and its echo target survives the corrective seek', () => {
      seatAndSwitch('local')
      ownEcho()
      lastTlsSocket!.write.mockClear()

      forced(304, false, 'peer', 2, true)

      expect(remote.at(-1)).toMatchObject({ paused: false, setBy: 'peer', doSeek: true })
      expect(remote.at(-1)!.position).toBeLessThan(1)
      expect(seeks()).toEqual([{ position: 0, paused: false, doSeek: true }])
      // Armed for the new element's `seeked` at ~0, and left armed: unlike the
      // file-change seek, the corrective one does not null it.
      expect(client['lastAppliedRemotePosition']).not.toBeNull()
      expect(client['lastAppliedRemotePosition']!).toBeLessThan(1)
    })

    it('ordering A: an old-file play keeps its `paused: false`', () => {
      seatAndSwitch('local', true)
      ownEcho(true)
      lastTlsSocket!.write.mockClear()

      forced(300, false, 'peer', 2)

      expect(remote.at(-1)).toMatchObject({ paused: false, setBy: 'peer' })
      expect(remote.at(-1)!.position).toBeLessThan(1)
      expect(seeks()).toEqual([{ position: 0, paused: false, doSeek: true }])
    })

    it.each<SyncplayEpisodeSwitch>(['local', 'auto-advance'])(
      'ordering B (%s): drops the frame whole and leaves the echo as on an uncrossed switch',
      (origin) => {
        const run = (crossed: boolean): SyncplayRemoteState[] => {
          seatAndSwitch(origin)
          expect(client['pendingClientAck']).toBe(1)
          if (crossed) {
            const before = client['lastRoomState']
            forced(304, true, 'peer', 1)
            // No emit, no corrective seek, no #494 latch, and the raw frame
            // never reached `lastRoomState`.
            expect(remote).toEqual([])
            expect(seeks()).toEqual([])
            expect(client['clientIgnoreCounter']).toBe(1)
            expect(client['crossedByForeign']).toBeNull()
            expect(client['lastRoomState']).toBe(before)
          }
          // A playing room: both origins' seeks carry `paused: false`.
          ownEcho(false, 2)
          const out = remote.slice()
          client.disconnect()
          client = new SyncplayClient()
          remote.length = 0
          return out
        }
        const control = run(false)
        const episode = run(true)
        expect(episode).toEqual(control)
        expect(episode.at(-1)).toMatchObject({ paused: false, doSeek: true })
      }
    )

    it('leaves a frame already at the new episode’s start alone', () => {
      seatAndSwitch('local')
      ownEcho()
      lastTlsSocket!.write.mockClear()

      forced(0.5, true, 'peer', 2)

      expect(remote.at(-1)).toEqual({ paused: true, position: 0.5, setBy: 'peer', doSeek: false })
      expect(seeks()).toEqual([])
      expect(client['clientIgnoreCounter']).toBe(1)
    })

    it('leaves a vanilla setter alone', () => {
      seatAndSwitch('local')
      peerOn('stranger', '7', { vanilla: true })
      ownEcho()
      lastTlsSocket!.write.mockClear()

      forced(304, true, 'stranger', 2)

      expect(remote.at(-1)).toEqual({
        paused: true,
        position: 304,
        setBy: 'stranger',
        doSeek: false
      })
      expect(seeks()).toEqual([])
    })

    it('passes a settled peer’s seek unstripped while another app peer is still behind', () => {
      seatAndSwitch('local', false, ['peer', 'third'])
      ownEcho()
      peerOn('peer', '8')
      // `third` is still on 7, so the marker stays armed.
      expect(marker()).not.toBeNull()
      lastTlsSocket!.write.mockClear()

      forced(304, false, 'peer', 2, true)
      expect(remote.at(-1)).toMatchObject({ setBy: 'peer', doSeek: true })
      expect(remote.at(-1)!.position).toBeGreaterThan(300)
      expect(seeks()).toEqual([])

      forced(305, true, 'third', 3)
      expect(remote.at(-1)).toEqual({ paused: true, position: 0, setBy: 'third', doSeek: false })
      expect(seeks()).toEqual([{ position: 0, paused: true, doSeek: true }])
    })

    it('clears once the setter’s `Set{file}` matches ours, translation aside', () => {
      seatAndSwitch('local')
      ownEcho()
      peerOn('peer', '8', { translationId: 9 })
      expect(marker()).toBeNull()

      forced(304, false, 'peer', 2, true)
      expect(remote.at(-1)!.position).toBeGreaterThan(300)
      expect(seeks()).toEqual([])
    })

    // #506: a follower whose walk could not reach the pick announces the
    // episode it reached, marked `followShortOf: <pick>`. It will never
    // announce the pick, so it counts as settled; otherwise every legitimate
    // seek it makes on its own episode would be stripped to 0 and the
    // corrective seek would pull the room, that follower included, back to it.
    it('clears on a stopped-short follower’s marked announce, and its seeks then pass', () => {
      seatAndSwitch('local')
      ownEcho()
      peerOn('peer', '7', { followShortOf: '8' })
      expect(marker()).toBeNull()
      lastTlsSocket!.write.mockClear()

      forced(200, false, 'peer', 2, true)
      expect(remote.at(-1)).toMatchObject({ setBy: 'peer', doSeek: true })
      expect(remote.at(-1)!.position).toBeGreaterThan(199)
      expect(seeks()).toEqual([])
    })

    it('a stopped-short follower does not hold the gate for another peer either', () => {
      seatAndSwitch('local', false, ['peer', 'third'])
      ownEcho()
      peerOn('peer', '7', { followShortOf: '8' })
      expect(marker()).not.toBeNull()
      lastTlsSocket!.write.mockClear()

      forced(200, false, 'peer', 2, true)
      expect(remote.at(-1)!.position).toBeGreaterThan(199)
      expect(seeks()).toEqual([])
    })

    // #502 review, the residual left in scope: a peer whose player is on
    // another anime never follows, so its meta never settles on our pick, and
    // until our next asserted change every seek it makes is stripped. Pinned so
    // that is a decision, not an accident: a second seek is stripped too.
    it('an unmarked peer on another anime still has its second seek stripped', () => {
      seatAndSwitch('local')
      ownEcho()
      peerOn('peer', '7', { animeId: 9 })
      expect(marker()).toEqual({ animeId: 1, episodeInt: '8' })

      forced(200, false, 'peer', 2, true)
      expect(remote.at(-1)!.position).toBeLessThan(1)
      ownEcho(false, 3)
      lastTlsSocket!.write.mockClear()

      forced(300, false, 'peer', 4, true)
      expect(remote.at(-1)).toMatchObject({ setBy: 'peer', doSeek: true })
      expect(remote.at(-1)!.position).toBeLessThan(1)
      expect(seeks()).toEqual([{ position: 0, paused: false, doSeek: true }])
      expect(marker()).toEqual({ animeId: 1, episodeInt: '8' })
    })

    it('a stale `followShortOf` for another episode does not count as settled', () => {
      seatAndSwitch('local')
      ownEcho()
      peerOn('peer', '7', { followShortOf: '9' })
      expect(marker()).not.toBeNull()
    })

    it('a `List` does not clear it, but the gate reads the rebuilt roster', () => {
      seatAndSwitch('local')
      ownEcho()
      emit({
        List: {
          cinema: {
            me: { position: 0, file: {} },
            peer: {
              position: 0,
              file: {
                name: EP8,
                duration: 1440,
                features: { animeDlAppMeta: { animeId: 1, episodeInt: '8' } }
              }
            }
          }
        }
      })
      expect(marker()).not.toBeNull()
      lastTlsSocket!.write.mockClear()

      forced(304, true, 'peer', 2)
      expect(remote.at(-1)!.position).toBe(304)
      expect(seeks()).toEqual([])
    })

    it('clears on the next asserted local change, with the counter bump', () => {
      seatAndSwitch('local')
      ownEcho()
      client.updateSnapshot({ position: 0, paused: false })
      vi.advanceTimersByTime(1000)
      expect(client['playbackAdopted']).toBe(true)
      expect(marker()).not.toBeNull()

      client.sendLocalState({ paused: true, position: 0.5, cause: 'pause' })

      expect(client['clientIgnoreCounter']).toBe(2)
      expect(marker()).toBeNull()
    })

    it('stays armed through a de-adopted local push, which returns before the bump', () => {
      seatAndSwitch('local')
      expect(client['playbackAdopted']).toBe(false)

      client.sendLocalState({ paused: true, position: 0, cause: 'pause' })

      expect(client['clientIgnoreCounter']).toBe(1)
      expect(marker()).not.toBeNull()
    })

    it('clears in resetTransportState()', () => {
      seatAndSwitch('local')
      client['resetTransportState']()
      expect(marker()).toBeNull()
    })

    it('goes inert once our own file moves off the pick', () => {
      seatAndSwitch('local')
      ownEcho()
      file('Some Anime - 9', { episodeSwitch: 'follow' })
      lastTlsSocket!.write.mockClear()

      forced(304, true, 'peer', 2)
      expect(remote.at(-1)!.position).toBe(304)
      expect(seeks()).toEqual([])
      expect(marker()).toBeNull()
    })
  })
})
