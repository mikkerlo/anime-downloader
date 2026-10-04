// Episode-change rows of the #489 catalog on the two-instance rig.
//
//   E1  A presses next at ~30 s / ~10 min / ~20 min, B follows       #486 ✗
//   E6  A presses prev — the mirror of E1, run on the way back       #486 ✗
//   E2  Both press next, B 0–1.5 s after A                           #486 ✗, #487 ✗
//   E5  Next pressed while the room is paused                        docs/syncplay.md, #486 ✗
//
// The ✗ rule (#489 review): a ✗ row asserts only `bad ≥ 1` at its N on current
// main — proof this rig sees the bug — and the fix PR flips it to `bad == 0`.
// The exact pins live in Tier 1 (`test/services/syncplay-two-peer-next-episode.test.ts`,
// `test/services/syncplay-two-peer-double-next.test.ts`). What is *not* ✗ is
// asserted as a pass on every scoreable run: both instances agree on the
// episode in E1 / E6 (a follow is absolute and deduped), and E5's paused state.
//
// E5 is pinned against the documented rule rather than decided here:
// `docs/syncplay.md` says an episode switch ends the pending-pause hold and "a
// new episode deliberately auto-resumes the binge through the gate". So after
// next in a paused room both instances end playing, on the same episode.
// On current main #486 breaks that rule in a measurable way: the paused room
// frame carrying the old position is parked on the new element and applied at
// `loadedmetadata`, which seeks it back *and pauses it*, and the room never
// resumes (the first local run: 1 of 2 scoreable runs, both stuck paused at
// the old timestamp; Tier 1's paused grid in
// `syncplay-two-peer-next-episode.test.ts` shows the same `p` ends). So E5
// asserts two things: the documented rule holds on every run #486 did not
// touch (`bad == 0`, where a not-resumed run counts as bad only if it was not
// stale), and the rig sees #486 at all (`stale ≥ 1`). The fix PR for #486
// flips it to "every run resumed".
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
import { RowScorer, staleOutcome } from './helpers/score'

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

/** Walk both to `ep` with A's Prev / Next (B follows). Setup; reports failure. */
async function resetTo(A: Instance, B: Instance, ep: string): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    const [a, b] = await Promise.all([A.state(), B.state()])
    if (epIntOf(a.label) === ep && epIntOf(b.label) === ep) return bothPlaying(A, B, 20_000)
    const at = Number(epIntOf(a.label))
    if (at > Number(ep)) await A.pressPrev()
    else if (at < Number(ep)) await A.pressNext()
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

test('E1 / E6 — A presses next (then prev), B follows: both land near 0 (#486 ✗)', async () => {
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
    // ✗ rows: the rig must see #486 at least once in each direction.
    expect(s1.scoreable).toBeGreaterThanOrEqual(1)
    expect(s1.bad).toBeGreaterThanOrEqual(1)
    expect(s6.scoreable).toBeGreaterThanOrEqual(1)
    expect(s6.bad).toBeGreaterThanOrEqual(1)
  } finally {
    await closeDuo(A, B)
  }
})

test('E2 — both press next 0–1.5 s apart: never N+2, both near 0 (#486 ✗, #487 ✗)', async () => {
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
      const r = await transition(A, B, async () => {
        await A.pressNext()
        await sleep(gap)
        await B.pressNext()
      })
      const skipped = r.epA === '3' || r.epB === '3'
      const diverged = r.epA !== r.epB
      row.add(
        {
          setupOk: setupOk && r.changed,
          bad: r.a.stale || r.b.stale || skipped || diverged,
          stale: r.a.stale || r.b.stale,
          skipped,
          diverged,
          gap,
          epA: r.epA,
          epB: r.epB
        },
        { A: await A.collect(r.pressAt - 3000), B: await B.collect(r.pressAt - 3000) }
      )
    }
    const s = row.score()
    expect(s.scoreable).toBeGreaterThanOrEqual(1)
    expect(s.bad).toBeGreaterThanOrEqual(1)
    // The row guards two bugs; each must be visible on its own, so the fix PR
    // for either one flips only its half.
    const scoreable = s.records.filter((r) => r.setupOk)
    expect(scoreable.filter((r) => r.stale).length, '#486 never seen').toBeGreaterThanOrEqual(1)
    expect(scoreable.filter((r) => r.skipped).length, '#487 never seen').toBeGreaterThanOrEqual(1)
  } finally {
    await closeDuo(A, B)
  }
})

test('E5 — next in a paused room: both move to N+1 and the binge auto-resumes (docs/syncplay.md)', async () => {
  const { A, B } = await seatDuo(rig)
  const row = new RowScorer('E5')
  try {
    expect(await bothPlaying(A, B), 'setup: both instances never played').toBe(true)
    for (let i = 0; i < Math.min(N, 3); i++) {
      const forward = i % 2 === 0
      const setupOk =
        (await bothPlaying(A, B, 20_000)) && (await positionBoth(A, B, 300 + Math.random() * 300))
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
      const r = await transition(A, B, () => (forward ? A.pressNext() : A.pressPrev()))
      const want = forward ? '2' : '1'
      const [a, b] = await Promise.all([A.state(), B.state()])
      const resumed = !a.paused && !b.paused
      const stale = r.a.stale || r.b.stale
      const wrongEp = r.epA !== want || r.epB !== want
      const bad = wrongEp || (!resumed && !stale)
      row.add(
        {
          setupOk: setupOk && paused && r.changed,
          bad,
          resumed,
          stale,
          wrongEp,
          epA: r.epA,
          epB: r.epB
        },
        bad || !resumed
          ? { A: await A.collect(r.pressAt - 3000), B: await B.collect(r.pressAt - 3000) }
          : undefined
      )
      // Leave the room playing for the next run's setup, whatever this one did.
      if ((await A.state()).paused) await A.togglePlayButton()
    }
    const s = row.score()
    const scoreable = s.records.filter((r) => r.setupOk)
    expect(s.scoreable).toBeGreaterThanOrEqual(1)
    expect(s.bad).toBe(0)
    // ✗ half (#486): the rig must see the stale position at least once.
    expect(scoreable.filter((r) => r.stale).length, '#486 never seen').toBeGreaterThanOrEqual(1)
  } finally {
    await closeDuo(A, B)
  }
})
