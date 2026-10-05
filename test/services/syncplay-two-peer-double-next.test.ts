// @vitest-environment happy-dom
//
// Both peers press "next episode" d ms apart (#489 Tier 1, row E2's #487 half).
//
// **#487 is fixed; this file pins the fix.** Until the fix PR it pinned the
// double advance (12 of 21 presses landing both peers on N+2); the fix turned
// that sweep red, and `SWEEP_50_400` is now re-derived, every cell `7/7`.
//
// The mechanism, from #487: B follows A's change with an absolute index lookup
// and a relative walk (`handleRemoteEpisodeChange`,
// `src/renderer/src/components/views/PlayerView.vue:508`), and B's `navigating`
// lock — which is what disables its Next button
// (`PlayerView.vue:3273`) — is released in the `nextTick` after
// `playerGetStreamUrl` resolves (`PlayerView.vue:2564`), not when the followed
// episode has loaded. B's user is still looking at episode N; a Next pressed
// after that release reads its target relative to the already-committed N+1
// (`PlayerView.vue:2315`), and before the fix both peers landed on N+2. The
// fix leaves the early release alone and adds a pending-follow token: a room
// follow's Next step arms it at its commit, the step's `loadedmetadata` clears
// it, and the user's Next (`onUserNext`) swallows one press while it still
// names the active episode (`shouldSwallowLocalNext`,
// `src/renderer/src/utils.ts:274`).
//
// ── What is real and what is modelled ────────────────────────────────────────
//
// Real: both main `SyncplayClient`s and their IPC routers, both mounted
// `use-syncplay-client` composables, `MinElectionServer`,
// `walkEpisodeSteps` (`src/renderer/src/utils.ts:251`), the loop B's follow
// runs through, and `shouldSwallowLocalNext`. Modelled: `PlayerView`'s
// `goToEpisode` / `handleRemoteEpisodeChange` / `onUserNext`, because there is
// no `PlayerView` mount harness. The model is four properties, and the
// source-scan block at the end of this file pins each of them against
// `PlayerView.vue` so the model cannot drift from the component without a red
// here:
//
//  1. the target is read relative to `activeEpisodeIndex` at entry, *before*
//     the `navigating` guard;
//  2. `navigating` is released in the `nextTick` after the stream URL
//     resolves, not on `loadedmetadata`;
//  3. a remote change is followed as a relative walk gated on `!navigating`;
//  4. a follow's Next step arms the token at its commit, its `loadedmetadata`
//     clears it, and the user's Next consumes it instead of stepping.
//
// `RESOLVE_MS` is the time `playerGetStreamUrl` takes; `METADATA_MS` is the
// source swap to `loadedmetadata`. The boundary between a press the button
// turns away and one the token swallows sits at `DELAY_MS + RESOLVE_MS` (one
// hop for A's `Set{file}` to reach B, then B's own stream resolve), which is the
// relation #487 measured on real streams at 352–598 ms; before the fix the same
// boundary separated a converging press from a double advance.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createTwoPeerRoom } from '../helpers/syncplay-two-peer'
import type { Peer, TwoPeerRoom } from '../helpers/syncplay-two-peer'
import { walkEpisodeSteps, shouldSwallowLocalNext } from '../../src/renderer/src/utils'
import type { EpisodeStepOutcome } from '../../src/renderer/src/utils'

const EPISODES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
/** Both peers start on episode 6 (index 5). */
const START_IDX = 5
/** Source swap to `loadedmetadata` — where the token is cleared. */
const METADATA_MS = 1500

type Press = 'dispatched' | 'button-disabled' | 'swallowed'

interface Nav {
  idx(): number
  pressNext(): Press
}

/** The four-property model of `PlayerView`'s navigation; see the header. */
function attachNavigator(peer: Peer, resolveMs: number): Nav {
  let idx = START_IDX
  let navigating = false
  let epoch = 0
  // (4) the pending-follow token, stamped with the run that armed it.
  let pendingFollow: { index: number; nav: number } | null = null

  // `viewGoToEpisode`, not `goToEpisode`: this is the model of `PlayerView`'s
  // function, and the harness's `peer.goToEpisode(` call-site census in
  // `syncplay-two-peer-loop.test.ts` would otherwise count it, and its
  // deliberately unawaited button press, as harness calls.
  async function viewGoToEpisode(
    dir: 'prev' | 'next',
    origin: 'local' | 'follow'
  ): Promise<EpisodeStepOutcome> {
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
    // (4) armed at the commit by a follow's Next step, cleared by any other.
    pendingFollow = origin === 'follow' && dir === 'next' ? { index: target, nav: my } : null
    await peer.goToEpisode(EPISODES[target])
    await new Promise((r) => setTimeout(r, resolveMs))
    if (epoch !== my) return 'moved'
    // (2) released in the nextTick after the stream URL resolved.
    await Promise.resolve()
    // (4) the step's own `loadedmetadata` clears its own token.
    setTimeout(() => {
      if (pendingFollow?.nav === my) pendingFollow = null
    }, METADATA_MS)
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
      () => viewGoToEpisode(dir, 'follow')
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
    // (4) `onUserNext`: the button's guard, then the token, then the step.
    pressNext: () => {
      if (navigating) return 'button-disabled'
      if (shouldSwallowLocalNext(pendingFollow?.index ?? null, idx)) {
        pendingFollow = null
        return 'swallowed'
      }
      void viewGoToEpisode('next', 'local')
      return 'dispatched'
    }
  }
}

interface Run {
  a: string
  b: string
  bPress: Press
}

describe('SyncplayClient — both peers press next d ms apart (#487, fixed)', () => {
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
    `${r.a}/${r.b}${r.bPress === 'dispatched' ? '' : ` ${r.bPress === 'button-disabled' ? 'disabled' : 'swallowed'}`}`

  /** d = 0..1000 ms in 50 ms steps at 50 ms each way and a 400 ms stream
   *  resolve — the probe's grid, and #487's in-process evidence. Before the
   *  fix, d = 450..1000 read `8/8`. */
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
    450: '7/7 swallowed',
    500: '7/7 swallowed',
    550: '7/7 swallowed',
    600: '7/7 swallowed',
    650: '7/7 swallowed',
    700: '7/7 swallowed',
    750: '7/7 swallowed',
    800: '7/7 swallowed',
    850: '7/7 swallowed',
    900: '7/7 swallowed',
    950: '7/7 swallowed',
    1000: '7/7 swallowed'
  }

  it('swallows every press that lands after the follower’s lock released, so neither peer skips (E2)', async () => {
    const got: Record<number, string> = {}
    for (let d = 0; d <= 1000; d += 50) got[d] = fmt(await run(d, 50, 400))
    expect(got).toEqual(SWEEP_50_400)
    // As a count, the way Tier 2 scores the row: none of 21 presses skips, and
    // the 12 that skipped before the fix are the 12 the token swallows.
    expect(Object.values(got).filter((v) => v.startsWith('8'))).toHaveLength(0)
    expect(Object.values(got).filter((v) => v.endsWith('swallowed'))).toHaveLength(12)
  }, 60_000)

  it('moves the swallow boundary with link delay + stream resolve, and never skips', async () => {
    // The first press gap (50 ms grid) the token swallows, per (delay,
    // resolve) — the gaps that double-advanced before the fix. Measured:
    // 50+400 → 450, 100+250 → 350, 100+400 → 500, and at a 1000 ms resolve
    // the button is still disabled for every press inside the first second.
    const firstSwallow = async (delayMs: number, resolveMs: number): Promise<number | null> => {
      let first: number | null = null
      for (let d = 0; d <= 1000; d += 50) {
        const r = await run(d, delayMs, resolveMs)
        expect([r.a, r.b], `skip at d=${d}, ${delayMs}+${resolveMs}`).toEqual(['7', '7'])
        if (first === null && r.bPress === 'swallowed') first = d
      }
      return first
    }
    expect(await firstSwallow(50, 400)).toBe(450)
    expect(await firstSwallow(100, 250)).toBe(350)
    expect(await firstSwallow(100, 400)).toBe(500)
    expect(await firstSwallow(50, 1000)).toBeNull()
  }, 60_000)

  it('converges when B presses before A’s change has reached it (d = 0)', async () => {
    const r = await run(0, 50, 400)
    expect([r.a, r.b, r.bPress]).toEqual(['7', '7', 'dispatched'])
  })
})

// The four properties of the real code the navigator model relies on. A
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
  it('arms the token at a follow Next commit and clears it on that run’s own loadedmetadata', () => {
    const flat = body.replace(/\s+/g, ' ')
    expect(flat).toContain(
      "pendingFollow = origin === 'follow' && direction === 'next' ? { index: targetIndex, nav: myNav } : null;"
    )
    expect(flat).toContain(
      'const onTargetMetadata = (): void => { if (pendingFollow?.nav === myNav) pendingFollow = null;'
    )
    // Both source arms, the local file and the stream, clear through it.
    expect(
      body.split("v.addEventListener('loadedmetadata', onTargetMetadata, { once: true });")
    ).toHaveLength(3)
  })

  it('routes the user’s Next through onUserNext, which consumes the token instead of stepping', () => {
    const user = SRC.slice(SRC.indexOf('function onUserNext('))
    const flat = user.slice(0, user.indexOf('\n}\n')).replace(/\s+/g, ' ')
    expect(flat).toContain(
      'if (!canNext.value || navigating.value) return; if (shouldSwallowLocalNext(pendingFollow?.index ?? null, activeEpisodeIndex.value)) { pendingFollow = null;'
    )
    expect(flat.indexOf('shouldSwallowLocalNext(')).toBeLessThan(
      flat.indexOf("goToEpisode('next', 'local')")
    )
    expect(SRC).toContain('@nav="onUserNext"')
    expect(SRC.replace(/\s+/g, ' ')).toContain("case 'next-episode': onUserNext(); break;")
  })
})
