// @vitest-environment happy-dom
//
// Where the *new* episode starts after "next" in a two-peer room (#489 Tier 1,
// rows E1 / E2 / E3 — the #486 half).
//
// **This file pins a known-broken behaviour (#486 ✗).** The tables below are
// what current `main` does; the fix for #486 ("force the room to 0 on file
// change") is expected to turn them red, and the fix PR rewrites them —
// every `stale` count to 0, every end position near the read-out time — rather
// than deleting the file.
//
// Why not `syncplay-two-peer-episode-change.test.ts`: that file is #360's, and
// its header declares every assertion in it a characterisation of what happens
// to the **non-switching** peer's element. #486 is about the elements that *do*
// switch — the old episode's position written onto the new source — and
// sharing a file would make each header's "every assertion here is about X"
// false.
//
// The mechanism, from #486: after the switch, nothing tells the room the new
// file starts at 0. The switcher's outgoing snapshot keeps asserting the old
// position until it goes stale, the server's `min()` keeps a room position from
// the old episode, and both the parked-frame path (an inbound frame parked on
// a `readyState 0` element and applied at `loadedmetadata`) and the plain
// `diff > 3.0` apply (`src/renderer/src/composables/use-syncplay-client.ts:1411`)
// write it onto the new element.
//
// ── What a cell is ───────────────────────────────────────────────────────────
//
// Two peers on episode 7 of a room at 300 s, 50 ms each way, seated through
// `seat()` at the shipped 500 ms bind gap. After four seconds plus `phaseMs` A
// switches to episode 8; `postBind` then does what `PlayerView.goToEpisode`'s
// `nextTick` block does on the fresh element (`seekProgrammatically(v, 0)` and
// `playProgrammatically(v, 'episode-start')`). B either follows (waits for the
// composable to hand it A's change, then does the same) or presses on its own
// 100 ms later. The cell is read twelve seconds after the last switch.
//
// `stale` is any `currentTime` write past 5 s on a peer from the switch on —
// the old position landing on the new source, whether or not it later snaps
// back. The end tuple `A/B` is each element's rounded position, with `p` for a
// paused element; a correct cell reads ~12 on both, playing. Most cells below
// are worse than stale: one peer plays on at the old position while the other
// sits paused at 0, which is #486's "stuck" outcome plus a divergence the room
// never repairs inside the read-out window.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { Peer, TwoPeerRoom } from '../helpers/syncplay-two-peer'

const ROOM_AT = 300
const DELAY_MS = 50
const PHASES_MS = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]
const READ_AFTER_S = 12
const STALE_S = 5

/** `PlayerView.goToEpisode`'s post-bind writes on the new element. */
function postBind(p: Peer): void {
  const sop = p.ui.beginProgrammaticSeek(0)
  try {
    p.el.currentTime = 0
  } catch {
    sop.retract()
  }
  const op = p.ui.beginProgrammaticPlayback('play', 'episode-start')
  void Promise.resolve(p.el.play()).catch(() => op.retract())
}

type Kind = 'follow' | 'both' | 'chain'

interface Grid {
  staleA: number
  staleB: number
  /** Cells where either element ends more than 100 s in: the stale position
   *  stuck rather than self-correcting. */
  stuck: number
  ends: string[]
}

describe('SyncplayClient — the next episode starts at the old timestamp (#486 ✗)', () => {
  let room: TwoPeerRoom | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    room?.dispose()
    room = undefined
    vi.useRealTimers()
  })

  const waitRemote = async (p: Peer, n: number): Promise<void> => {
    for (let guard = 0; p.remoteEpisodes.length < n && guard < 100; guard++) {
      await room!.advance(0.05)
    }
    expect(p.remoteEpisodes.length).toBeGreaterThanOrEqual(n)
  }

  const nav = async (p: Peer, ep: string): Promise<void> => {
    await p.goToEpisode(ep)
    postBind(p)
  }

  async function grid(kind: Kind, paused: boolean): Promise<Grid> {
    const g: Grid = { staleA: 0, staleB: 0, stuck: 0, ends: [] }
    for (const phase of PHASES_MS) {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      room = await createTwoPeerRoom({ position: ROOM_AT, paused })
      const a = await room.seat({
        username: 'hostuser',
        position: ROOM_AT,
        paused,
        delayMs: DELAY_MS,
        episodeInt: '7'
      })
      const b = await room.seat({
        username: 'joinuser',
        position: ROOM_AT,
        paused,
        delayMs: DELAY_MS,
        episodeInt: '7'
      })
      await room.advance(4 + phase / 1000)
      const aW = a.el.seekWrites.length
      const bW = b.el.seekWrites.length
      if (kind === 'follow') {
        await nav(a, '8')
        await waitRemote(b, 1)
        await room.advance(0.1)
        await nav(b, '8')
      } else if (kind === 'both') {
        await nav(a, '8')
        await room.advance(0.1)
        await nav(b, '8')
      } else {
        for (const ep of ['8', '9', '10']) {
          await nav(a, ep)
          await waitRemote(b, Number(ep) - 7)
          await room.advance(0.1)
          await nav(b, ep)
          await room.advance(3)
        }
      }
      await room.advance(READ_AFTER_S)
      if (a.el.seekWrites.slice(aW).some((x) => x > STALE_S)) g.staleA++
      if (b.el.seekWrites.slice(bW).some((x) => x > STALE_S)) g.staleB++
      if (a.el.currentTime > 100 || b.el.currentTime > 100) g.stuck++
      const end = (p: Peer): string => `${Math.round(p.el.currentTime)}${p.el.paused ? 'p' : ''}`
      g.ends.push(`${end(a)}/${end(b)}`)
      room.dispose()
      room = undefined
    }
    return g
  }

  it('writes the old position onto both new elements when B follows A (E1)', async () => {
    const g = await grid('follow', false)
    expect(g.staleA).toBe(10)
    expect(g.staleB).toBe(10)
    expect(g.stuck).toBe(9)
    expect(g.ends).toEqual([
      '315/315',
      '309/0p',
      '309/0p',
      '309/0p',
      '309/0p',
      '0p/310',
      '0p/310',
      '0p/310',
      '0p/310',
      '0p/0p'
    ])
  }, 60_000)

  it('does the same when both press, B 100 ms after A (E2)', async () => {
    const g = await grid('both', false)
    expect(g.staleA).toBe(10)
    expect(g.staleB).toBe(10)
    expect(g.stuck).toBe(10)
    expect(g.ends).toEqual([
      '315/315',
      '309/0p',
      '309/0p',
      '309/0p',
      '309/0p',
      '0p/310',
      '0p/310',
      '0p/310',
      '0p/310',
      '0p/310'
    ])
  }, 60_000)

  it('writes it on every chain of three, but mostly self-corrects by the end (E3)', async () => {
    const g = await grid('chain', false)
    expect(g.staleA).toBe(10)
    expect(g.staleB).toBe(10)
    expect(g.stuck).toBe(2)
    expect(g.ends).toEqual([
      '8/7p',
      '0p/2p',
      '8p/7',
      '8p/7',
      '8p/7',
      '315/0p',
      '313/313',
      '0p/0p',
      '8/7p',
      '14/15'
    ])
  }, 60_000)

  // E5's paused-state half is not decided here: `docs/syncplay.md` already says an
  // episode switch ends the pending-pause hold and "a new episode deliberately
  // auto-resumes the binge through the gate", and `e2e-syncplay/episode.spec.ts`
  // pins that on the real `PlayerView`. The `p` ends below are #486's stale
  // position parking an element, not a reading of that rule.
  it('carries the old position in a paused room too, where nothing can walk it off (E5 position half)', async () => {
    const g = await grid('follow', true)
    expect(g.staleA).toBe(10)
    expect(g.staleB).toBe(10)
    expect(g.stuck).toBe(9)
    expect(g.ends).toEqual([
      '300p/300p',
      '300p/6',
      '300p/6',
      '300p/6',
      '300p/6',
      '6/300p',
      '6/300p',
      '6/300p',
      '6/300p',
      '6/6'
    ])
  }, 60_000)
})
