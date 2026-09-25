// The fixture's playing/`setBy` pairing rule (#384).
//
// Upstream cannot put `paused: false` on the wire beside a null `setBy`.
// `Room.setPaused` writes `_playState` and `_setBy` in the same two statements
// (`server.py:611-612`), it is reached only from `Watcher.updateState`
// (`server.py:879`), a fresh room is `STATE_PAUSED` with `_setBy = None`
// (`server.py:543-544`), and `protocols.py:739` renders whatever is stored by
// name. `MinElectionServer` nevertheless opened playing **and** nameless, so
// every fixture reading `setBy` in the sliver before the first election was
// reading a frame no reference server can send. That was an infidelity, not a
// degree of freedom, and this file is the rule made executable: the first case
// fails on the old constructor, which seeded `null` whatever the pause flag
// said.
//
// The sentinel carries a second constraint that no amount of constructing can
// check — the name has to be one **no seated watcher holds**, or a fixture
// asserting "the room is not ours" passes for the wrong reason. The last case
// censuses the fixture corpus for it instead, which is the only place that
// constraint can be enforced.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { readdirSync, readFileSync, statSync } from 'fs'
import { resolve, join } from 'path'
import { MinElectionServer, DEFAULT_PLAYING_SET_BY } from '../helpers/syncplay-min-election-server'
import type { ModelSocket } from '../helpers/syncplay-min-election-server'

const ROOM_START = 600

// Two names already in the corpus, so seating them here adds nothing to the
// census the last case runs.
const SEATED = ['hostuser', 'joinuser']

describe('MinElectionServer — the playing/`setBy` pairing', () => {
  let server: MinElectionServer | null = null

  afterEach(() => {
    server?.stop()
    server = null
    vi.useRealTimers()
  })

  /**
   * A watcher with no client behind it. `seat()` takes ownership of `write` and
   * pushes inbound frames back with `emit('data', …)`; nothing here listens, so
   * the seat is exactly a row in the election and nothing else — which is all
   * these cases need, and keeps the clock the only other moving part.
   */
  const seat = (host: MinElectionServer, username: string): void => {
    const plain = new EventEmitter() as ModelSocket
    const tls = new EventEmitter() as ModelSocket
    host.seat({ username, plain, takeTls: () => tls })
  }

  it('seeds a playing room with a setter, and not one of its own watchers', () => {
    // Frozen before the constructor, because the periodic `State` starts in it:
    // no tick can fire, so what `roomState()` reports is the seed rather than
    // the first election's winner.
    vi.useFakeTimers()
    server = new MinElectionServer({ position: ROOM_START, paused: false })
    for (const username of SEATED) seat(server, username)

    const { paused, setBy } = server.roomState()

    expect(paused).toBe(false)
    expect(setBy).not.toBeNull()
    expect(setBy).toBe(DEFAULT_PLAYING_SET_BY)
    // The half that makes the seed usable rather than merely non-null: a room
    // set by a watcher who has since left is the only history that reaches this
    // state, so the name must not be one still in the room.
    expect(SEATED).not.toContain(setBy)
  })

  it('seeds a paused room with null, as `Room.__init__` does', () => {
    // `server.py:543-544` — the pause flag and the nameless setter arrive
    // together, so the pairing is symmetric and this arm is unchanged.
    vi.useFakeTimers()
    server = new MinElectionServer({ position: ROOM_START, paused: true })
    for (const username of SEATED) seat(server, username)

    expect(server.roomState()).toMatchObject({ paused: true, setBy: null })
  })

  it('lets an explicit `setBy` override either default', () => {
    vi.useFakeTimers()
    server = new MinElectionServer({ position: ROOM_START, paused: false, setBy: 'zoe' })
    expect(server.roomState().setBy).toBe('zoe')
    server.stop()

    server = new MinElectionServer({ position: ROOM_START, paused: true, setBy: 'zoe' })
    expect(server.roomState().setBy).toBe('zoe')
  })

  it('holds the seed only until the first election', () => {
    // `Room.getPosition()` overwrites `_setBy` with `min(watchers)`
    // (`server.py:601`) once the room state is older than the election age, so
    // the seed is reachable for one tick and the fixtures that run for whole
    // seconds never see it. That is the reason the old infidelity went
    // unnoticed, and the reason fixing it cannot move their assertions.
    vi.useFakeTimers()
    server = new MinElectionServer({ position: ROOM_START, paused: false })
    seat(server, SEATED[0])

    expect(server.roomState().setBy).toBe(DEFAULT_PLAYING_SET_BY)

    vi.advanceTimersByTime(1000)

    expect(server.roomState().setBy).toBe(SEATED[0])
    expect(server.elections).toHaveLength(1)
  })

  it('names nobody the fixture corpus seats', () => {
    const root = resolve(__dirname, '..', '..')
    const definition = resolve(root, 'test/helpers/syncplay-min-election-server.ts')

    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full, out)
        else if (full.endsWith('.ts')) out.push(full)
      }
      return out
    }
    const files = ['test', 'e2e', 'conformance'].flatMap((d) => walk(resolve(root, d)))

    // Every name the corpus seats by literal: the `username:` option form the
    // helper and the two-peer harness take, and the `peers:` roster the
    // conformance scenarios declare.
    const seated = new Set<string>()
    // The other way a seat gets its name is a bare string argument —
    // `seat(server, 'alpha')` — which no cheap pattern separates from any other
    // short literal. So that form is covered from the other side, by the
    // hand-written scan below: a seat can only collide by spelling the sentinel
    // out, and nothing but the definition is allowed to.
    const handWritten: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/username: *'([^']*)'/g)) seated.add(m[1])
      for (const m of text.matchAll(/peers: *\[([^\]]*)\]/g)) {
        for (const p of m[1].matchAll(/'([^']*)'/g)) seated.add(p[1])
      }
      for (const [i, line] of text.split('\n').entries()) {
        if (!line.includes(`'${DEFAULT_PLAYING_SET_BY}'`)) continue
        if (file === definition && line.includes('DEFAULT_PLAYING_SET_BY =')) continue
        handWritten.push(`${file}:${i + 1}`)
      }
    }

    // A tripwire on the census itself: a pattern that stopped matching would
    // make the assertion below vacuously true.
    expect(seated.size).toBeGreaterThan(10)
    expect(seated).not.toContain(DEFAULT_PLAYING_SET_BY)
    expect(handWritten).toEqual([])
  })
})
