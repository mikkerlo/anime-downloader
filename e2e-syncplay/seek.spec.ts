// Seek rows of the #489 catalog on the two-instance rig.
//
//   S1  Far seek by the non-`setBy` peer, load delay swept 100–3000 ms    #488 ✗
//   S9  No false "<peer> seeked to …" toast during S1                      #488 ✗
//   S6  Seek while paused: the peer moves, the room stays paused            —
//
// S1 / S9 follow the ✗ rule (`bad ≥ 1` at N on current main; the exact
// role × landing × phase pins are `test/services/syncplay-seek-revert.test.ts`).
// S6 is a non-✗ row and asserts `bad == 0`.
//
// The seek is a bare `currentTime` write, which is exactly what the seek bar,
// the ±5 s keys and skip OP/ED do on current main. The fixture server's
// per-request delay is what keeps the seek in flight long enough for the next
// room frame to land on it. S1 also throttles each response, so on fixtures
// even the 100 ms cell lands in seconds; the first local runs saw every
// scoreable S1 run undone, well above the ~24% measured on real streams,
// which is why the row asserts `bad ≥ 1` and nothing about the rate.

import { test, expect } from '@playwright/test'
import {
  startRig,
  seatDuo,
  closeDuo,
  bothPlaying,
  sleep,
  waitFor,
  type Rig,
  type Instance
} from './helpers/duo'
import { RowScorer } from './helpers/score'

let rig: Rig
test.beforeAll(async () => {
  rig = await startRig({ readiness: true })
})

/** Far targets, each ≥ 200 s from every other and from the opening minute,
 *  so no run's target sits in a range an earlier run left buffered. */
const TARGETS = [700, 300, 1100, 500, 900, 1300, 400, 1000]
test.afterAll(async () => {
  await rig?.stop()
})

const N = Number(process.env.SYNCPLAY_E2E_N ?? 6)

/** The instance the room is *not* currently set by: its inbound frames name
 *  the other peer. `null` when neither has seen a recent attributed frame. */
async function nonSetBy(A: Instance, B: Instance): Promise<Instance | null> {
  const since = Date.now() - 2500
  const [wa, wb] = await Promise.all([A.collect(since), B.collect(since)])
  const lastIn = (w: { dir: string; ps?: { setBy?: string | null } }[]): string | null =>
    [...w].reverse().find((f) => f.dir === 'in' && f.ps?.setBy)?.ps?.setBy ?? null
  if (lastIn(wa.wire) === B.name) return A
  if (lastIn(wb.wire) === A.name) return B
  return null
}

test('S1 / S9 — a far seek by the non-setBy peer is undone and never announced (#488 ✗)', async () => {
  // ~3x the fixtures' bitrate: playback never starves, but the buffer stays
  // seconds ahead rather than the whole file, so a far seek needs a fresh
  // ranged request and waits out the per-request delay.
  rig.fixtures.setRate(3 * 1024)
  const { A, B } = await seatDuo(rig)
  const s1 = new RowScorer('S1')
  const s9 = new RowScorer('S9')
  try {
    expect(await bothPlaying(A, B), 'setup: both instances never played').toBe(true)
    for (let i = 0; i < N; i++) {
      rig.fixtures.setDelay(0)
      const playing = await bothPlaying(A, B, 20_000)
      await sleep(2000 + Math.random() * 1000)
      const seeker = await nonSetBy(A, B)
      const other = seeker === A ? B : A
      // Load delay swept 100–3000 ms across the runs.
      const delay = Math.round(100 + (i / Math.max(1, N - 1)) * 2900)
      rig.fixtures.setDelay(delay)
      const target = TARGETS[i % TARGETS.length]
      const at = Date.now()
      if (seeker) await seeker.seek(target)
      await sleep(8000)
      rig.fixtures.setDelay(0)
      await sleep(4000)
      if (!seeker) {
        s1.add({ setupOk: false, bad: false, reason: 'no attributed frame to pick a role from' })
        s9.add({ setupOk: false, bad: false })
        continue
      }
      const [ds, se, oe] = await Promise.all([seeker.collect(at), seeker.state(), other.state()])
      const doSeeksOut = ds.wire.filter((w) => w.dir === 'out' && w.ps?.doSeek === true).length
      const undone = Math.abs(se.ct - target) > 30
      const notFollowed = Math.abs(oe.ct - se.ct) > 20
      const falseToast = ds.toasts.some((t) => t.txt.includes(other.name) && /seek/i.test(t.txt))
      const bad = undone || doSeeksOut !== 1 || notFollowed
      const trace = bad || falseToast ? { seeker: ds, other: await other.collect(at) } : undefined
      s1.add(
        {
          setupOk: playing,
          bad,
          undone,
          doSeeksOut,
          notFollowed,
          delay,
          seeker: seeker.name,
          target: Math.round(target)
        },
        trace
      )
      s9.add({ setupOk: playing, bad: falseToast, delay })
    }
    const r1 = s1.score()
    const r9 = s9.score()
    expect(r1.scoreable).toBeGreaterThanOrEqual(1)
    expect(r1.bad).toBeGreaterThanOrEqual(1)
    expect(r9.bad).toBeGreaterThanOrEqual(1)
  } finally {
    rig.fixtures.setDelay(0)
    await closeDuo(A, B)
  }
})

test('S6 — a seek while paused moves the peer and leaves the room paused', async () => {
  // Unthrottled and undelayed: S6 is about the paused path, not about a seek
  // in flight. With S1's throttle every far seek takes seconds to land, and
  // the paused room's 1 Hz frames undo it exactly as they undo S1's (#488),
  // which made this row a second copy of S1 (4 of 4 undone in the first run).
  rig.fixtures.setRate(0)
  rig.fixtures.setDelay(0)
  const { A, B } = await seatDuo(rig)
  const row = new RowScorer('S6')
  try {
    expect(await bothPlaying(A, B), 'setup: both instances never played').toBe(true)
    for (let i = 0; i < Math.min(N, 4); i++) {
      const playing = await bothPlaying(A, B, 20_000)
      await sleep(1500)
      const seeker = i % 2 === 0 ? A : B
      const other = seeker === A ? B : A
      await seeker.togglePlayButton()
      const paused = await waitFor(
        'both paused',
        async () => {
          const [a, b] = await Promise.all([A.state(), B.state()])
          return a.paused && b.paused
        },
        5000
      )
      const target = 200 + i * 150
      const at = Date.now()
      await seeker.seek(target)
      await sleep(5000)
      const [se, oe] = await Promise.all([seeker.state(), other.state()])
      const bad =
        Math.abs(se.ct - target) > 3 || Math.abs(oe.ct - target) > 3 || !se.paused || !oe.paused
      row.add(
        { setupOk: playing && paused, bad, seekerCt: se.ct, otherCt: oe.ct, target },
        bad ? { seeker: await seeker.collect(at), other: await other.collect(at) } : undefined
      )
      if ((await seeker.state()).paused) await seeker.togglePlayButton()
    }
    const s = row.score()
    expect(s.scoreable).toBeGreaterThanOrEqual(1)
    expect(s.bad).toBe(0)
  } finally {
    await closeDuo(A, B)
  }
})
