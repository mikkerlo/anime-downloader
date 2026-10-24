// Seek rows of the #489 catalog on the two-instance rig.
//
//   S1  Far seek by the non-`setBy` peer, load delay swept 100–3000 ms    #488 (fixed by #491)
//   S9  No false "<peer> seeked to …" toast during S1                      #488 (fixed by #491)
//   S6  Seek while paused: the peer moves, the room stays paused            —
//   S10 A scrub and a peer's pause ms apart: both paused, apart (drift)   #524 (fixed by #524)
//   S11 The same: the pause is lost                                 #535 (2a) / #544 (2b)
//   S10c / S11c  The same with a 2 s scrub: the control, no re-assert      #524
//   S12 S10's race with the scrubber's seek in flight 1–2 s: no drift      #524
//
// S1 / S9 were ✗ rows (`bad ≥ 1` at N) until #491 fixed #488; they now assert
// `bad == 0`, as S6 always has. The exact role × landing × phase pins are
// `test/services/syncplay-seek-revert.test.ts`. S10 and S10c's drift went the
// same way when #524 made a pause edge snap to the room (upstream parity). S11's
// dominant lost pause, the one the scrubber's #252 re-assert resumes, went when
// #535 armed the apply-in-flight marker above the re-assert; S11 now fails on
// that or a heartbeat resume. The residual the scrubber's own seek resumes is
// #544's.
//
// The seek goes through the seek bar (`Instance.seek`), so it takes
// `PlayerView.seek()` → `seekAsUser`, which since #491 announces at intent.
// Before #491 the seek bar, the ±5 s keys and skip OP/ED made a bare
// `currentTime` write, and the rig did the same. The fixture server's
// per-request delay is what keeps the seek in flight long enough for the next
// room frame to land on it. S1 also throttles each response, so on fixtures
// even the 100 ms cell lands in seconds; before #491 the first local runs saw
// every scoreable S1 run undone, well above the ~24% measured on real streams.

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
import {
  RowScorer,
  scrubPauseVerdict,
  pauseInFlight,
  lostPauseTally,
  type LostPauseTally
} from './helpers/score'
import { SEEK_REASSERT_TOLERANCE_S } from '../src/main/syncplay'

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

test('S1 / S9 — a far seek by the non-setBy peer sticks and is announced once (#488, fixed by #491)', async () => {
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
    // Flipped by #491.
    expect(r1.scoreable).toBeGreaterThanOrEqual(1)
    expect(r1.bad).toBe(0)
    expect(r9.bad).toBe(0)
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

// S10 / S11 — a seek-bar scrub on one peer and a Play/Pause press on the other
// a few ms apart (#524). Both actions are scheduled on the shared wall clock
// (`Instance.actAt`), the press `offsetMs` after the scrub (negative: before),
// in both role directions. The settle read decides the run:
//
//   S10 (drift)  both paused, more than ECHO_SEEK_EPSILON_S apart. The pause
//       reached a playing peer late, inside the renderer's 3 s apply rule, so
//       that peer paused where it was rather than where the room is. A ✗ row
//       (`bad ≥ 1`, 9 and 11 of 64 in #534's two runs) until #524 made the
//       pause edge snap past ECHO_SEEK_EPSILON_S; now `bad == 0`.
//   S11 (pause lost, #535)  either element still playing. The pause reached the
//       server first. Mostly the scrub, sent before the scrubber heard it,
//       crossed it and was dropped by the server's ignore gate, and the #252
//       re-assert behind the scrubber's ack resumed the room at the target.
//       Otherwise the scrubber heard the pause first and its seek, still
//       carrying the renderer's `paused: false`, resumed the room itself. A ✗
//       row (40 lost in #534's three sweeps) until #535 sent the re-assert
//       position-only while the pause is in flight; it now asserts that no lost
//       pause was resumed by a re-assert, and counts the seek-resumed ones
//       (#544) without failing on them.
//
// `scrubPauseVerdict` reads which scrubber frame the server resumed on, and
// `test/services/syncplay-ignoring-on-the-fly.test.ts` pins the server half of
// both shapes frame by frame. A transient yank the next heartbeat corrects is
// not counted: the read is taken after it.
//
// On localhost the window is a few ms wide and moves with the host, so the
// sweep runs either side of 0. The 10 / 20 / 50 / 200 ms grid of the P7f rows
// steps straight over it. `SYNCPLAY_E2E_N` is the per-bucket, per-direction N,
// 4 by default: over three local sweeps the lost pause showed in 23 of 26 runs
// at −1 ms and drift in 14 of 26 at 0 ms, so 64 runs see each ✗ row's
// `bad ≥ 1` with wide margin (9–14 bad per row per run here).
const SCRUB_PAUSE_OFFSETS_MS = [-3, -2, -1, 0, 1, 2, 3, 5] as const
/** The control's buckets: the ones where either shape showed. */
const SCRUB_PAUSE_CONTROL_OFFSETS_MS = [-3, -2, -1, 0, 1] as const
const SCRUB_PAUSE_N = Number(process.env.SYNCPLAY_E2E_N ?? 4)
/** Past SEEK_REASSERT_TOLERANCE_S, so the #252 re-assert hop exists. */
const FAR_SCRUB_S = 10 * SEEK_REASSERT_TOLERANCE_S
/** Inside it: the control, with no re-assert hop. */
const NEAR_SCRUB_S = SEEK_REASSERT_TOLERANCE_S - 1
/** Past every correction the runs showed: the heartbeat past #513's
 *  apply-in-flight window lands 1–2 s after the press. */
const SCRUB_PAUSE_SETTLE_MS = 3500

async function scrubPauseSweep(
  rows: { drift: RowScorer; lost: RowScorer },
  scrubS: number,
  offsets: readonly number[],
  opts: { loadDelayMs?: [number, number] } = {}
): Promise<void> {
  rig.fixtures.setRate(0)
  rig.fixtures.setDelay(0)
  const { A, B } = await seatDuo(rig)
  // S12's load delay keeps every seek in flight; it starts once both play, so
  // seating is not slowed by it.
  const [delayMin, delayMax] = opts.loadDelayMs ?? [0, 0]
  const settleMs = SCRUB_PAUSE_SETTLE_MS + delayMax
  try {
    expect(await bothPlaying(A, B), 'setup: both instances never played').toBe(true)
    rig.fixtures.setDelay(delayMin, delayMax)
    for (const [scrubber, pauser] of [
      [B, A],
      [A, B]
    ] as const) {
      for (const offsetMs of offsets) {
        for (let i = 0; i < SCRUB_PAUSE_N; i++) {
          const playing = await bothPlaying(A, B, 20_000)
          // A random heartbeat phase per run.
          await sleep(1000 + Math.random() * 1000)
          const [s0, p0] = await Promise.all([scrubber.state(), pauser.state()])
          // Measured from where the pauser will be at the press, not from the
          // scrubber: the 3 s rule leaves a drifted pair apart into the next
          // run, and the re-assert compares the scrubber with the room, which
          // the pause puts at the pauser. Back and forth around the middle of
          // the 24-minute fixture.
          const at = Date.now() + 300
          const from = p0.ct + 0.3
          const target = from < 600 ? from + scrubS : from - scrubS
          const [scrubAt, pressAt] = await Promise.all([
            scrubber.actAt(at, { seek: target }),
            pauser.actAt(at + offsetMs, 'toggle')
          ])
          await sleep(settleMs)
          const [ss, ps] = await Promise.all([scrubber.state(), pauser.state()])
          const [ds, dp] = await Promise.all([scrubber.collect(at - 50), pauser.collect(at - 50)])
          const v = scrubPauseVerdict({
            scrubber: { name: scrubber.name, wire: ds.wire, ct: ss.ct, paused: ss.paused },
            pauser: { name: pauser.name, wire: dp.wire, ct: ps.ct, paused: ps.paused }
          })
          const scrubbed = ds.wire.some((w) => w.dir === 'out' && w.ps?.doSeek === true)
          const pressed = dp.wire.some((w) => w.dir === 'out' && w.ps?.paused === true)
          // When the scrubber's own seek landed, and when the room's pause first
          // reached it, both relative to `at - 50`: S12's "in flight" is the
          // pause arriving first.
          const scrubIdx = ds.wire.findIndex((w) => w.dir === 'out' && w.ps?.doSeek === true)
          const scrubOutAt = scrubIdx < 0 ? null : ds.wire[scrubIdx].at
          const seekedAt =
            scrubOutAt === null
              ? null
              : (ds.ev.find((e) => e.t === 'seeked' && e.at >= scrubOutAt)?.at ?? null)
          const pauseInAt =
            scrubIdx < 0
              ? null
              : (ds.wire.slice(scrubIdx + 1).find((w) => w.dir === 'in' && w.ps?.paused === true)
                  ?.at ?? null)
          const log = (x: Instance): { at: number; line: string }[] =>
            x.mainLog
              .filter((l) => l.at >= at - 50 && l.at <= at + settleMs)
              .filter((l) => !/ (>>|<<) /.test(l.line))
              .map((l) => ({ at: l.at - at, line: l.line }))
          const rec = {
            setupOk: playing && scrubbed && pressed,
            offsetMs,
            realOffsetMs: pressAt - scrubAt,
            // Each action's in-page Date.now() minus its scheduled one.
            scrubLateMs: scrubAt - at,
            pressLateMs: pressAt - (at + offsetMs),
            scrubber: scrubber.name,
            // Scrubber minus pauser before the run: what an earlier run left.
            preSpread: +(s0.ct - p0.ct).toFixed(2),
            target: +target.toFixed(2),
            scrubberCt: +ss.ct.toFixed(2),
            pauserCt: +ps.ct.toFixed(2),
            seekedAt,
            pauseInAt,
            pauseInFlight: pauseInFlight({ wire: ds.wire, ev: ds.ev }),
            // `seeking` events on each element after the scrub: the scrubber's
            // own seek is one, a pause-edge snap another.
            scrubberSeeks: ds.ev.filter((e) => e.t === 'seeking').length,
            pauserSeeks: dp.ev.filter((e) => e.t === 'seeking').length,
            ...v,
            spread: +v.spread.toFixed(2)
          }
          const trace =
            v.lost || v.drift
              ? {
                  scrubber: { ...ds, log: log(scrubber) },
                  pauser: { ...dp, log: log(pauser) }
                }
              : undefined
          rows.drift.add({ ...rec, bad: v.drift }, v.drift ? trace : undefined)
          rows.lost.add({ ...rec, bad: v.lost }, v.lost ? trace : undefined)
          // Resume for the next run, from whichever element the run left paused.
          const [a, b] = await Promise.all([A.state(), B.state()])
          if (a.paused && b.paused) await pauser.togglePlayButton()
          else if (a.paused) await A.togglePlayButton()
          else if (b.paused) await B.togglePlayButton()
        }
      }
    }
  } finally {
    await closeDuo(A, B)
  }
}

function bucketLines(
  s: { row: string; records: { setupOk: boolean; bad: boolean; [k: string]: unknown }[] },
  offsets: readonly number[]
): void {
  for (const scrubber of ['rigB', 'rigA']) {
    for (const d of offsets) {
      const rs = s.records.filter((r) => r.setupOk && r.offsetMs === d && r.scrubber === scrubber)
      process.stdout.write(
        `[syncplay-e2e] ${s.row} ${scrubber} scrubs, ${d} ms: n=${rs.length} bad=${rs.filter((r) => r.bad).length}\n`
      )
      expect(rs.length, `${s.row} ${scrubber} ${d} ms: no scoreable runs`).toBeGreaterThanOrEqual(1)
    }
  }
}

/** Prints a lost-pause row's resumes by frame, and the seek-borne ones (2b,
 *  #544) on their own line; returns the tally the row asserts on. */
function resumedByLine(s: { row: string; records: Record<string, unknown>[] }): LostPauseTally {
  const t = lostPauseTally(s.records)
  process.stdout.write(
    `[syncplay-e2e] ${s.row} resumed by: reassert=${t.reassert} heartbeat=${t.heartbeat} seek=${t.seek} unread=${t.unread}\n`
  )
  process.stdout.write(
    `[syncplay-e2e] ${s.row} lost to the scrubber's own seek (2b, counted, not failed, #544): n=${t.seek}\n`
  )
  return t
}

/** How many settled-paused runs ended with a second `seeking` on either peer
 *  (#524): the scrubber's own seek and the pauser's following it are one each,
 *  so a second is the pause-edge snap, or a re-assert the pauser followed. */
function snapLine(s: { row: string; records: Record<string, unknown>[] }): void {
  const held = s.records.filter((r) => r.setupOk && !r.lost)
  const snapped = held.filter(
    (r) => (r.scrubberSeeks as number) >= 2 || (r.pauserSeeks as number) >= 2
  )
  process.stdout.write(
    `[syncplay-e2e] ${s.row} runs with a second seeking: ${snapped.length}/${held.length}\n`
  )
}

/** `actAt`'s accuracy over a sweep, so a CI log shows it without the traces:
 *  the real offset minus the asked one, and each action's own lateness. */
function offsetLine(rows: string, s: { records: Record<string, unknown>[] }): void {
  const runs = s.records.filter((r) => r.setupOk)
  const stat = (xs: number[]): string =>
    `min=${Math.min(...xs)} max=${Math.max(...xs)} nonzero=${xs.filter((x) => x !== 0).length}/${xs.length}`
  const num = (k: string): number[] => runs.map((r) => r[k] as number)
  process.stdout.write(
    `[syncplay-e2e] ${rows} offset: real−asked ${stat(runs.map((r) => (r.realOffsetMs as number) - (r.offsetMs as number)))}; scrub late ${stat(num('scrubLateMs'))}; press late ${stat(num('pressLateMs'))}\n`
  )
}

test('S10 / S11 — a far scrub and a peer’s pause 3 ms before to 5 ms after it (#524)', async () => {
  test.setTimeout(20 * 60_000)
  const drift = new RowScorer('S10')
  const lost = new RowScorer('S11')
  await scrubPauseSweep({ drift, lost }, FAR_SCRUB_S, SCRUB_PAUSE_OFFSETS_MS)
  const d = drift.score()
  const l = lost.score()
  bucketLines(d, SCRUB_PAUSE_OFFSETS_MS)
  bucketLines(l, SCRUB_PAUSE_OFFSETS_MS)
  const t = resumedByLine(l)
  offsetLine('S10 / S11', l)
  snapLine(d)
  // S10 was a ✗ row until #524's pause-edge snap. S11 fails on what #535
  // fixed, a pause the #252 re-assert behind the ack resumed (2a), and on a
  // heartbeat resume (#513's marker failing to withhold). A pause the
  // scrubber's own seek resumed (2b) is #544's; it is about 1 in 64 here, so a
  // plain `bad == 0` would flake, and it is counted on its own line instead.
  expect(d.bad, 'S10: both paused, more than ECHO_SEEK_EPSILON_S apart').toBe(0)
  expect(t.failed, 'S11: a lost pause the #252 re-assert or a heartbeat resumed').toBe(0)
})

test('S10c / S11c — the same race with a scrub inside SEEK_REASSERT_TOLERANCE_S: no #252 re-assert (#524 control)', async () => {
  test.setTimeout(15 * 60_000)
  const drift = new RowScorer('S10c')
  const lost = new RowScorer('S11c')
  await scrubPauseSweep({ drift, lost }, NEAR_SCRUB_S, SCRUB_PAUSE_CONTROL_OFFSETS_MS)
  const d = drift.score()
  const l = lost.score()
  bucketLines(d, SCRUB_PAUSE_CONTROL_OFFSETS_MS)
  bucketLines(l, SCRUB_PAUSE_CONTROL_OFFSETS_MS)
  const t = resumedByLine(l)
  offsetLine('S10c / S11c', l)
  snapLine(d)
  const runs = l.records.filter((r) => r.setupOk)
  // The control's claim: below the tolerance the hop S11 resumes on does not
  // exist, so no run sends a re-assert and no pause is lost to one.
  expect(runs.filter((r) => (r.reasserts as number) > 0).length, 'S11c: a re-assert was sent').toBe(
    0
  )
  // Its lost pauses are 2b, the scrubber's own seek (#534's one, and main's
  // one in #535's control run), so S11c is scored as S11 is: counted, failed
  // only on a re-assert (which this row's claim above already rules out) or a
  // heartbeat resume.
  expect(t.failed, 'S11c: a lost pause the #252 re-assert or a heartbeat resumed').toBe(0)
  // The drift showed here too (21 of 40 in #534's run). #524's snap closed it
  // but for #537's shape: a scrub this short that crossed the pause is dropped
  // and never re-asserted, and the pause met it still loading. Since #537 main
  // hands that pause over unrewritten and the #488 hold lets its snap through,
  // so the scrubber lands on the pauser's frame. The shape is still counted on
  // its own line, so a run shows whether it occurred; it is not carved out.
  const shape537 = d.records.filter(
    (r) => r.setupOk && r.seekCrossed === true && r.pauseInFlight === true && r.reasserts === 0
  )
  process.stdout.write(
    `[syncplay-e2e] S10c crossed, in flight, never re-asserted (#537): n=${shape537.length} bad=${shape537.filter((r) => r.bad).length}\n`
  )
  expect(d.bad, 'S10c: both paused, more than ECHO_SEEK_EPSILON_S apart').toBe(0)
})

// S12 — S10's race with the scrubber's seek kept in flight 1–2 s by the fixture
// server's per-request delay (#524). The pause-edge snap is a non-`doSeek` arm,
// so the #488 hold declines it while the scrubber's own seek is loading: the
// frame's position may be the pauser's pre-seek one, and snapping there would
// abort the user's seek. The element is not playing on while it loads, so the
// hold costs only what it plays between the landing and a pause that arrives
// after it, which the snap then takes. The row asserts no drift once the seek
// has landed and settled, and that the pause really did reach the scrubber
// inside the in-flight window in some runs, or the row says nothing about the
// hold.
const S12_OFFSETS_MS = [-1, 0, 1] as const

test('S12 — the scrub-vs-pause race with the scrubber’s seek in flight 1–2 s (#524)', async () => {
  test.setTimeout(15 * 60_000)
  const drift = new RowScorer('S12')
  const lost = new RowScorer('S12l')
  await scrubPauseSweep({ drift, lost }, FAR_SCRUB_S, S12_OFFSETS_MS, {
    loadDelayMs: [1000, 2000]
  })
  const d = drift.score()
  const l = lost.score()
  bucketLines(d, S12_OFFSETS_MS)
  const t = resumedByLine(l)
  snapLine(d)
  const runs = d.records.filter((r) => r.setupOk)
  const inFlight = runs.filter((r) => r.pauseInFlight === true)
  process.stdout.write(
    `[syncplay-e2e] S12 pause reached the scrubber in flight: ${inFlight.length}/${runs.length}, bad among them=${inFlight.filter((r) => r.bad).length}\n`
  )
  expect(inFlight.length, 'S12: no run put the pause inside the in-flight window').toBeGreaterThan(
    0
  )
  expect(d.bad, 'S12: both paused, more than ECHO_SEEK_EPSILON_S apart').toBe(0)
  // A far scrub, so S11's 2a hop exists here too: scored as S11 is (#535).
  expect(t.failed, 'S12l: a lost pause the #252 re-assert or a heartbeat resumed').toBe(0)
})
