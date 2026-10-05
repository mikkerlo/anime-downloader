// Episode-change rows of the #489 catalog on the two-instance rig.
//
//   E1  A presses next at ~30 s / ~10 min / ~20 min, B follows       #486 (fixed by #493)
//   E6  A presses prev — the mirror of E1, run on the way back       #486 (fixed by #493)
//   E2  Both press next, B 0–1.5 s after A                           #486 (fixed), #487 (fixed)
//   E5  Next pressed while the room is paused                        #486 (fixed), #496 ✗, #497 (recorded)
//
// The ✗ rule (#489 review): a ✗ row asserts only `bad ≥ 1` at its N on current
// main — proof this rig sees the bug — and the fix PR flips it to `bad == 0`.
// #493 fixed #486, so E1 / E6, E2's stale half and E5 are flipped; #492 fixed
// #487, so E2's skip half is flipped too and the whole row is `bad == 0`. A
// skip counts against #487 only when B pressed inside #487's window, before its
// followed N+1's first frame (`loadeddata`) plus `FOLLOW_GRACE_MS`. Until #500
// the window, like #492's token, closed at `loadedmetadata`: on the first local
// run after the rebase, 3 of 6 runs (gaps 900–1500 ms) reached N+2 from a press
// 190–490 ms after B's N+1 had loaded metadata, scored as a deliberate second
// Next. #500 moved both the token's clear and this carve-out to the first frame
// plus grace, so those presses are now `skipped` unless swallowed; a press past
// it is still recorded (`secondNext`, `swallowed`), and `past-metadata` counts
// the in-window presses #500 added. The exact
// pins live in Tier 1 (`test/services/syncplay-two-peer-next-episode.test.ts`,
// `test/services/syncplay-two-peer-double-next.test.ts`). Both instances must
// also agree on the episode in E1 / E6 (a follow is absolute and deduped) on
// every scoreable run.
//
// E5 is pinned against the documented rule rather than decided here:
// `docs/syncplay.md` says an episode switch ends the pending-pause hold and "a
// new episode deliberately auto-resumes the binge through the gate". So after
// next in a paused room both instances end playing, on the same episode, near
// 0. Before #493, #486 broke that rule: the paused room frame carrying the old
// position was parked on the new element and applied at `loadedmetadata`,
// which seeked it back *and paused it*, and the room never resumed. #493 fixed
// the position, so E5's #486 half is flipped: `bad == 0`, where bad is the
// wrong episode or a seek on the new element back to the old position (the
// room's, in a paused room). Two findings from the rebase are kept out of it:
//
//  - #496 ✗, the resume half. Across three local runs after the rebase, 7 of 9
//    scoreable runs ended with both instances paused on the new episode (6 at
//    ~0, one after the #497 seek below). Asserted as `not resumed ≥ 1` until
//    #496's fix flips it to "every run resumed".
//  - #497, a follower seeking its new element to its *saved watch progress*
//    at `loadedmetadata` (591 s against a room at ~324 s, back to 0 ~300 ms
//    later): a seek past 5 s whose target is neither 0 nor the old position.
//    Seen in 1 of those 9 runs, so it is recorded per run (`foreignSeek`) but
//    not asserted: at E5's 3 runs a night `≥ 1` would itself be red on most
//    nights. #497's fix asserts it `== 0`. Its saved position is wherever the
//    previous run left the episode it lands on (runs alternate next/prev), so
//    E5 positions even runs in 300–420 s and odd runs in 480–600 s
//    (`e5Position`). Consecutive positions are ≥ 60 s apart and a #497 seek
//    can never land within the ±15 s of the old position that `e5Split`
//    counts as #486 (#499). A timing rule (a snap-back to 0 means #497) would
//    not do: #486's stale seek can snap back too.
//
// Fixture loads are slowed to 300–800 ms per request: #486's stale position
// and #487's early lock release exist only while a load is in flight.

import { test, expect } from '@playwright/test'
import {
  startRig,
  seatDuo,
  closeDuo,
  bothPlaying,
  positionBoth,
  sleep,
  waitFor,
  epIntOf,
  type Rig,
  type Instance
} from './helpers/duo'
import { RowScorer, staleOutcome, e5Position, e5Split } from './helpers/score'
import { FOLLOW_GRACE_MS } from '../src/renderer/src/utils'

let rig: Rig
test.beforeAll(async () => {
  rig = await startRig({ readiness: true })
  rig.fixtures.setDelay(300, 800)
})
test.afterAll(async () => {
  await rig?.stop()
})

const N = Number(process.env.SYNCPLAY_E2E_N ?? 4)
// E1 / E6 alternate direction, so each press position takes two runs: 6 is the
// smallest N that reaches all three.
const N_E1 = Number(process.env.SYNCPLAY_E2E_N ?? 6)
const PRESS_POSITIONS = [30, 600, 1200]

async function waitBothSrcChanged(
  A: Instance,
  B: Instance,
  a0: string,
  b0: string,
  ms = 30_000
): Promise<boolean> {
  let ca = false
  let cb = false
  await waitFor(
    'both src changed',
    async () => {
      const [a, b] = await Promise.all([A.state(), B.state()])
      ca = ca || (!!a.src && a.src !== a0)
      cb = cb || (!!b.src && b.src !== b0)
      return ca && cb
    },
    ms,
    100
  )
  return ca && cb
}

/** Walk both to `ep` with Prev / Next: A's while A is off `ep` (B follows),
 *  then B's if a lost follow left only B off it. Setup; reports failure. */
async function resetTo(A: Instance, B: Instance, ep: string): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    const [a, b] = await Promise.all([A.state(), B.state()])
    if (epIntOf(a.label) === ep && epIntOf(b.label) === ep) return bothPlaying(A, B, 20_000)
    const at = Number(epIntOf(a.label))
    const bt = Number(epIntOf(b.label))
    if (at > Number(ep)) await A.pressPrev()
    else if (at < Number(ep)) await A.pressNext()
    else if (bt > Number(ep)) await B.pressPrev()
    else if (bt < Number(ep)) await B.pressNext()
    await sleep(4000)
  }
  return false
}

async function transition(
  A: Instance,
  B: Instance,
  press: () => Promise<void>
): Promise<{
  pressAt: number
  a: ReturnType<typeof staleOutcome>
  b: ReturnType<typeof staleOutcome>
  epA: string
  epB: string
  changed: boolean
}> {
  const [sa, sb] = await Promise.all([A.state(), B.state()])
  const pressAt = Date.now()
  await press()
  const changed = await waitBothSrcChanged(A, B, sa.src, sb.src)
  await sleep(12_500)
  const [da, db] = await Promise.all([A.collect(pressAt), B.collect(pressAt)])
  const [ea, eb] = await Promise.all([A.state(), B.state()])
  return {
    pressAt,
    a: staleOutcome(da, sa.src),
    b: staleOutcome(db, sb.src),
    epA: epIntOf(ea.label),
    epB: epIntOf(eb.label),
    changed
  }
}

test('E1 / E6 — A presses next (then prev), B follows: both land near 0 (#486, fixed by #493)', async () => {
  const { A, B } = await seatDuo(rig)
  const e1 = new RowScorer('E1')
  const e6 = new RowScorer('E6')
  try {
    expect(await bothPlaying(A, B), 'setup: both instances never played').toBe(true)
    for (let i = 0; i < N_E1; i++) {
      const forward = i % 2 === 0
      const row = forward ? e1 : e6
      const from = forward ? '1' : '2'
      const t = PRESS_POSITIONS[Math.floor(i / 2) % PRESS_POSITIONS.length] + Math.random() * 30
      // A run whose follow was lost leaves the room on the wrong side; walk it
      // back to `from` so one setup hiccup costs one run, not the row.
      const setupOk = (await resetTo(A, B, from)) && (await positionBoth(A, B, t))
      await sleep(2500 + Math.random() * 1500)
      const how = i % 4 === 0 ? 'key' : 'button'
      const r = await transition(A, B, () => (forward ? A.pressNext(how) : A.pressPrev()))
      const want = forward ? '2' : '1'
      const agree = r.epA === want && r.epB === want
      row.add(
        {
          setupOk: setupOk && r.changed,
          bad: r.a.stale || r.b.stale,
          stuck: r.a.stuck || r.b.stuck,
          agree,
          from,
          t: Math.round(t),
          how: forward ? how : 'button',
          A: r.a,
          B: r.b
        },
        r.a.stale || r.b.stale || !agree
          ? { A: await A.collect(r.pressAt - 3000), B: await B.collect(r.pressAt - 3000) }
          : undefined
      )
      if (setupOk && r.changed)
        expect(agree, `run ${i}: instances disagree on the episode (${r.epA} / ${r.epB})`).toBe(
          true
        )
    }
    const s1 = e1.score()
    const s6 = e6.score()
    // Flipped by #493: no stale start in either direction.
    expect(s1.scoreable).toBeGreaterThanOrEqual(1)
    expect(s1.bad).toBe(0)
    expect(s6.scoreable).toBeGreaterThanOrEqual(1)
    expect(s6.bad).toBe(0)
  } finally {
    await closeDuo(A, B)
  }
})

test("E2 — both press next 0–1.5 s apart: no N+2 from a press inside #487's window, both near 0 (#486 fixed, #487 fixed)", async () => {
  const { A, B } = await seatDuo(rig)
  const row = new RowScorer('E2')
  try {
    expect(await bothPlaying(A, B), 'setup: both instances never played').toBe(true)
    for (let i = 0; i < N; i++) {
      const reset = await resetTo(A, B, '1')
      const setupOk = reset && (await positionBoth(A, B, 300 + Math.random() * 300))
      await sleep(2500 + Math.random() * 1500)
      // A controlled spread over the gap, not single-run luck.
      const gap = Math.round((i / Math.max(1, N - 1)) * 1500)
      let bPressAt = 0
      const r = await transition(A, B, async () => {
        await A.pressNext()
        await sleep(gap)
        bPressAt = Date.now()
        await B.pressNext()
      })
      const traceB = await B.collect(r.pressAt - 3000)
      // #487's window is B's press landing after its follow released the lock
      // but before the followed episode's first frame (`loadeddata`) plus
      // `FOLLOW_GRACE_MS`, while B's user is still looking at N. A press after
      // that is the user's own second Next, and N+2 is what it asks for: the
      // token swallows only inside the window. Until #500 the window closed at
      // `loadedmetadata`, and presses 190–590 ms past it reached N+2 unscored.
      const bMetaAt = traceB.ev.find((e) => e.at >= 3000 && e.t === 'loadedmetadata')?.at
      const bDataAt = traceB.ev.find((e) => e.at >= 3000 && e.t === 'loadeddata')?.at
      const bClearAt = bDataAt === undefined ? undefined : bDataAt + FOLLOW_GRACE_MS
      const bPress = bPressAt - (r.pressAt - 3000)
      // The follow's lock release, proxied by B's first `loadstart` after A's
      // press: the release is queued right behind the source write.
      const bLoadAt = traceB.ev.find((e) => e.at >= 3000 && e.t === 'loadstart')?.at
      const inWindow =
        bLoadAt !== undefined && bClearAt !== undefined && bPress >= bLoadAt && bPress < bClearAt
      // The band #500 added: past metadata, still inside first frame + grace.
      const pastMeta = inWindow && bMetaAt !== undefined && bPress >= bMetaAt
      const n2 = r.epA === '3' || r.epB === '3'
      const skipped = n2 && (bClearAt === undefined || bPress < bClearAt)
      const diverged = r.epA !== r.epB
      row.add(
        {
          setupOk: setupOk && r.changed,
          bad: r.a.stale || r.b.stale || skipped || diverged,
          stale: r.a.stale || r.b.stale,
          skipped,
          secondNext: n2 && !skipped,
          swallowed: traceB.toasts.some((t) => t.txt.startsWith('Already switching')),
          diverged,
          inWindow,
          pastMeta,
          gap,
          bPress,
          bLoadAt,
          bMetaAt,
          bDataAt,
          epA: r.epA,
          epB: r.epB
        },
        { A: await A.collect(r.pressAt - 3000), B: traceB }
      )
    }
    const s = row.score()
    const scoreable = s.records.filter((r) => r.setupOk)
    // With no scoreable press inside #487's window, `skipped == 0` tests
    // nothing: print the count beside the score, before any assertion, so a
    // vacuous pass is visible and a red row still logs it.
    process.stdout.write(
      `[syncplay-e2e] E2: in-window=${scoreable.filter((r) => r.inWindow).length} (past-metadata=${scoreable.filter((r) => r.pastMeta).length}) of scoreable=${s.scoreable}\n`
    )
    expect(s.scoreable).toBeGreaterThanOrEqual(1)
    expect(s.bad).toBe(0)
    // The row guards two bugs, each asserted on its own so a regression names
    // its half. #493 flipped #486's, #492 flipped #487's, and #500 widened
    // #487's window from metadata to first frame + grace.
    expect(scoreable.filter((r) => r.stale).length, '#486 stale start after #493').toBe(0)
    expect(scoreable.filter((r) => r.skipped).length, '#487 skip to N+2 after #492/#500').toBe(0)
  } finally {
    await closeDuo(A, B)
  }
})

test('E5 — next in a paused room: both move to N+1 near 0 (#486 fixed); the binge auto-resume (docs/syncplay.md, #496 ✗); the saved-progress seek recorded (#497)', async () => {
  const { A, B } = await seatDuo(rig)
  const row = new RowScorer('E5')
  try {
    expect(await bothPlaying(A, B), 'setup: both instances never played').toBe(true)
    for (let i = 0; i < Math.min(N, 3); i++) {
      const forward = i % 2 === 0
      const setupOk =
        (await bothPlaying(A, B, 20_000)) &&
        (await positionBoth(A, B, e5Position(i, Math.random())))
      await sleep(2000)
      await A.togglePlayButton()
      const paused = await waitFor(
        'both paused',
        async () => {
          const [a, b] = await Promise.all([A.state(), B.state()])
          return a.paused && b.paused
        },
        5000
      )
      await sleep(2500)
      // Paused, so each element's position is the room's and the old one both.
      const [pa, pb] = await Promise.all([A.state(), B.state()])
      const r = await transition(A, B, () => (forward ? A.pressNext() : A.pressPrev()))
      const want = forward ? '2' : '1'
      const [a, b] = await Promise.all([A.state(), B.state()])
      const [da, db] = await Promise.all([A.collect(r.pressAt), B.collect(r.pressAt)])
      const resumed = !a.paused && !b.paused
      const sa = e5Split(da, pa, r.a)
      const sb = e5Split(db, pb, r.b)
      const stale = sa.old || sb.old
      const foreignSeek = sa.foreign || sb.foreign
      const wrongEp = r.epA !== want || r.epB !== want
      const bad = wrongEp || stale
      row.add(
        {
          setupOk: setupOk && paused && r.changed,
          bad,
          resumed,
          stale,
          foreignSeek,
          wrongEp,
          epA: r.epA,
          epB: r.epB
        },
        bad || !resumed || foreignSeek
          ? { A: await A.collect(r.pressAt - 3000), B: await B.collect(r.pressAt - 3000) }
          : undefined
      )
      // Leave the room playing for the next run's setup, whatever this one did.
      if ((await A.state()).paused) await A.togglePlayButton()
    }
    const s = row.score()
    // #486 half, flipped by #493: every scoreable run on the right episode, and
    // no seek back to the old position.
    expect(s.scoreable).toBeGreaterThanOrEqual(1)
    expect(s.bad).toBe(0)
    const scoreable = s.records.filter((r) => r.setupOk)
    // #497: recorded in the JSONL (`foreignSeek`), not asserted — see the header.
    // ✗ half (#496): the rig must see the room stay paused at least once.
    expect(
      scoreable.filter((r) => !r.resumed).length,
      'paused room never stayed paused'
    ).toBeGreaterThanOrEqual(1)
  } finally {
    await closeDuo(A, B)
  }
})
