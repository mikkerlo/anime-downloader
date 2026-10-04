// @vitest-environment happy-dom
//
// Both peers press "next episode" d ms apart (#489 Tier 1, row E2's #487 half).
//
// **This file pins a known-broken behaviour (#487 ✗).** The double advance
// below is what current `main` does; the fix for #487 is expected to turn the
// sweep red, and the fix PR rewrites `SWEEP_50_400` (every cell `7/7`) rather
// than deleting the file.
//
// The mechanism, from #487: B follows A's change with an absolute index lookup
// and a relative walk (`handleRemoteEpisodeChange`,
// `src/renderer/src/components/views/PlayerView.vue:508`), and B's `navigating`
// lock — which is what disables its Next button
// (`PlayerView.vue:3164`) — is released in the `nextTick` after
// `playerGetStreamUrl` resolves (`PlayerView.vue:2484`), not when the followed
// episode has loaded. B's user is still looking at episode N; if they press
// Next after that release, `goToEpisode` reads its target relative to the
// already-committed N+1 (`PlayerView.vue:2261`) and both peers land on N+2.
//
// ── What is real and what is modelled ────────────────────────────────────────
//
// Real: both main `SyncplayClient`s and their IPC routers, both mounted
// `use-syncplay-client` composables, `MinElectionServer`, and
// `walkEpisodeSteps` (`src/renderer/src/utils.ts:255`), the loop B's follow
// runs through. Modelled: `PlayerView`'s `goToEpisode` /
// `handleRemoteEpisodeChange`, because there is no `PlayerView` mount harness.
// The model is three properties, and the source-scan block at the end of this
// file pins each of them against `PlayerView.vue` so the model cannot drift from
// the component without a red here:
//
//  1. the target is read relative to `activeEpisodeIndex` at entry, *before*
//     the `navigating` guard;
//  2. `navigating` is released in the `nextTick` after the stream URL
//     resolves, not on `loadedmetadata`;
//  3. a remote change is followed as a relative walk gated on `!navigating`.
//
// `RESOLVE_MS` is the time `playerGetStreamUrl` takes. The boundary between a
// converging press and a double advance sits at `DELAY_MS + RESOLVE_MS` (one
// hop for A's `Set{file}` to reach B, then B's own stream resolve), which is the
// relation #487 measured on real streams at 352–598 ms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { Peer, TwoPeerRoom } from '../helpers/syncplay-two-peer'
import { walkEpisodeSteps } from '../../src/renderer/src/utils'
import type { EpisodeStepOutcome } from '../../src/renderer/src/utils'

const EPISODES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
/** Both peers start on episode 6 (index 5). */
const START_IDX = 5

interface Nav {
  idx(): number
  pressNext(): 'dispatched' | 'button-disabled'
}

/** The three-property model of `PlayerView`'s navigation; see the header. */
function attachNavigator(peer: Peer, resolveMs: number): Nav {
  let idx = START_IDX
  let navigating = false
  let epoch = 0

  // `viewGoToEpisode`, not `goToEpisode`: this is the model of `PlayerView`'s
  // function, and the harness's `peer.goToEpisode(` call-site census in
  // `syncplay-two-peer-loop.test.ts` would otherwise count it, and its
  // deliberately unawaited button press, as harness calls.
  async function viewGoToEpisode(dir: 'prev' | 'next'): Promise<EpisodeStepOutcome> {
    // (1) target from the index at entry, ahead of the guard.
    const target = dir === 'prev' ? idx - 1 : idx + 1
    if (target < 0 || target >= EPISODES.length) return 'unreachable'
    if (navigating) return 'superseded'
    await Promise.resolve()
    navigating = true
    const my = ++epoch
    await Promise.resolve()
    if (epoch !== my) return 'superseded'
    idx = target
    await peer.goToEpisode(EPISODES[target])
    await new Promise((r) => setTimeout(r, resolveMs))
    if (epoch !== my) return 'moved'
    // (2) released in the nextTick after the stream URL resolved.
    await Promise.resolve()
    navigating = false
    return 'moved'
  }

  // (3) absolute lookup, relative walk gated on !navigating.
  const handleRemote = (episodeInt: string): void => {
    const i = EPISODES.indexOf(episodeInt)
    if (i < 0 || i === idx) return
    const dir = i > idx ? 'next' : 'prev'
    void walkEpisodeSteps(
      () => idx !== i && !navigating,
      () => viewGoToEpisode(dir)
    )
  }
  // `remoteEpisodes` is the harness's record of what the composable handed its
  // consumer; intercepting the push is what makes the model the consumer.
  const arr = peer.remoteEpisodes as unknown as { push: (...x: unknown[]) => number }
  const origPush = Array.prototype.push
  arr.push = function (...eps: unknown[]) {
    const n = origPush.apply(this, eps)
    for (const e of eps as { episodeInt: string }[]) handleRemote(e.episodeInt)
    return n
  }

  return {
    idx: () => idx,
    pressNext: () => {
      if (navigating) return 'button-disabled'
      void viewGoToEpisode('next')
      return 'dispatched'
    }
  }
}

interface Run {
  a: string
  b: string
  bPress: 'dispatched' | 'button-disabled'
}

describe('SyncplayClient — both peers press next d ms apart (#487 ✗)', () => {
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

  async function run(dMs: number, delayMs: number, resolveMs: number): Promise<Run> {
    room = await createTwoPeerRoom({ position: 100, paused: false })
    const A = await room.seat({
      username: 'rigA',
      position: 100,
      paused: false,
      delayMs,
      episodeInt: EPISODES[START_IDX]
    })
    const B = await room.seat({
      username: 'rigB',
      position: 100,
      paused: false,
      delayMs,
      episodeInt: EPISODES[START_IDX]
    })
    await room.advance(4)
    const na = attachNavigator(A, resolveMs)
    const nb = attachNavigator(B, resolveMs)
    na.pressNext()
    if (dMs > 0) await room.advance(dMs / 1000)
    const bPress = nb.pressNext()
    await room.advance(6)
    const r: Run = { a: EPISODES[na.idx()], b: EPISODES[nb.idx()], bPress }
    room.dispose()
    room = undefined
    return r
  }

  const fmt = (r: Run): string =>
    `${r.a}/${r.b}${r.bPress === 'button-disabled' ? ' disabled' : ''}`

  /** d = 0..1000 ms in 50 ms steps at 50 ms each way and a 400 ms stream
   *  resolve — the probe's grid, and #487's in-process evidence. */
  const SWEEP_50_400: Record<number, string> = {
    0: '7/7',
    50: '7/7 disabled',
    100: '7/7 disabled',
    150: '7/7 disabled',
    200: '7/7 disabled',
    250: '7/7 disabled',
    300: '7/7 disabled',
    350: '7/7 disabled',
    400: '7/7 disabled',
    450: '8/8',
    500: '8/8',
    550: '8/8',
    600: '8/8',
    650: '8/8',
    700: '8/8',
    750: '8/8',
    800: '8/8',
    850: '8/8',
    900: '8/8',
    950: '8/8',
    1000: '8/8'
  }

  it('double-advances every press that lands after the follower’s lock released (E2)', async () => {
    const got: Record<number, string> = {}
    for (let d = 0; d <= 1000; d += 50) got[d] = fmt(await run(d, 50, 400))
    expect(got).toEqual(SWEEP_50_400)
    // Both peers always agree — this is a skip, not a divergence.
    expect(Object.values(got).every((v) => v.slice(0, 1) === v.slice(2, 3))).toBe(true)
    // As a count, the way Tier 2 scores the row: 12 of 21 presses skip.
    expect(Object.values(got).filter((v) => v.startsWith('8/8'))).toHaveLength(12)
  }, 60_000)

  it('moves the boundary with link delay + stream resolve, not with anything else', async () => {
    // The first press gap (50 ms grid) that double-advances, per (delay,
    // resolve). Measured: 50+400 → 450, 100+250 → 350, 100+400 → 500, and at a
    // 1000 ms resolve no press inside the first second skips at all.
    const firstSkip = async (delayMs: number, resolveMs: number): Promise<number | null> => {
      for (let d = 0; d <= 1000; d += 50) {
        const r = await run(d, delayMs, resolveMs)
        if (r.a === '8') return d
      }
      return null
    }
    expect(await firstSkip(50, 400)).toBe(450)
    expect(await firstSkip(100, 250)).toBe(350)
    expect(await firstSkip(100, 400)).toBe(500)
    expect(await firstSkip(50, 1000)).toBeNull()
  }, 60_000)

  it('converges when B presses before A’s change has reached it (d = 0)', async () => {
    const r = await run(0, 50, 400)
    expect([r.a, r.b, r.bPress]).toEqual(['7', '7', 'dispatched'])
  })
})

// The three properties of the real code the navigator model relies on. A
// PlayerView change that breaks one of them reds here, which is the signal that
// the model above (and its pinned table) needs re-deriving.
describe('PlayerView anchors for the #487 navigation model', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../../src/renderer/src/components/views/PlayerView.vue'),
    'utf8'
  )
  const body = SRC.slice(
    SRC.indexOf('async function goToEpisode('),
    SRC.indexOf('function cancelAutoAdvance(')
  )

  it('reads the target relative to activeEpisodeIndex at entry, before the navigating guard', () => {
    const tgt = body.indexOf(
      "direction === 'prev' ? activeEpisodeIndex.value - 1 : activeEpisodeIndex.value + 1"
    )
    expect(tgt).toBeGreaterThan(-1)
    expect(tgt).toBeLessThan(body.indexOf("if (navigating.value) return 'superseded';"))
  })

  it('releases navigating in the nextTick after the stream URL resolves, not on loadedmetadata', () => {
    const url = body.indexOf(
      'await window.api.playerGetStreamUrl(resolvedTr.id, resolvedTr.height)'
    )
    const rel = body.indexOf("navigating.value = false;\n    });\n    return 'moved';", url)
    expect(url).toBeGreaterThan(-1)
    expect(rel).toBeGreaterThan(url)
  })

  it('follows a remote change as a relative walk gated on !navigating', () => {
    expect(SRC.replace(/\s+/g, ' ')).toContain(
      "() => activeEpisodeIndex.value !== idx && !navigating.value && translationEpoch === walkTranslation, () => goToEpisode(dir, 'follow')"
    )
  })
})
