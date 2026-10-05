// Pause / unpause rows of the #489 catalog on the two-instance rig.
//
//   P1  A pauses, B follows; A unpauses, B follows.
//   P6  Pause, then a translation switch: the room stays paused (#347).
//   P7  Pause, then a quality switch: the room stays paused (#306).
//   P8  Readiness: B drops not-ready (`syncplaySetReady(false)`, the app's own
//       send path); the gate pauses both, and both resume when B is ready
//       again (#355). Readiness is ON in this rig's server, which is why the
//       shared bootstrap takes it as a flag.
//   P7f Pause, then a quality switch 0 / 20 / 50 / 200 ms later (#498) — ✗.
//   P6f The same for a translation switch.
//
// All but P7f are non-✗ rows: `bad == 0` over the scoreable runs.

import { test, expect } from '@playwright/test'
import {
  startRig,
  seatDuo,
  closeDuo,
  bothPlaying,
  positionBoth,
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
test.afterAll(async () => {
  await rig?.stop()
})

const N = Number(process.env.SYNCPLAY_E2E_N ?? 3)

async function bothPaused(A: Instance, B: Instance, ms = 5000): Promise<boolean> {
  return waitFor(
    'both paused',
    async () => {
      const [a, b] = await Promise.all([A.state(), B.state()])
      return a.paused && b.paused
    },
    ms
  )
}

test('P1 — a pause and an unpause on A reach B within a tick, positions within 1 s', async () => {
  const { A, B } = await seatDuo(rig)
  const row = new RowScorer('P1')
  try {
    expect(await bothPlaying(A, B), 'setup: both instances never played').toBe(true)
    for (let i = 0; i < N; i++) {
      await sleep(1500 + Math.random() * 1000)
      const at = Date.now()
      await A.togglePlayButton()
      const paused = await bothPaused(A, B, 3000)
      await sleep(1000)
      const [ap, bp] = await Promise.all([A.state(), B.state()])
      await A.togglePlayButton()
      const resumed = await bothPlaying(A, B, 4000)
      const [ar, br] = await Promise.all([A.state(), B.state()])
      // Every failing clause, so a red row says which half broke in the job log
      // itself rather than only in the uploaded JSONL.
      const reasons = [
        !paused && `not both paused within 3 s (1 s later: A ${ap.paused}, B ${bp.paused})`,
        Math.abs(ap.ct - bp.ct) > 1 && `paused spread ${(ap.ct - bp.ct).toFixed(2)} s > 1`,
        !resumed && `not both playing within 4 s (A ${!ar.paused}, B ${!br.paused})`,
        Math.abs(ar.ct - br.ct) > 1.5 && `playing spread ${(ar.ct - br.ct).toFixed(2)} s > 1.5`
      ].filter((r): r is string => typeof r === 'string')
      const bad = reasons.length > 0
      if (bad) process.stdout.write(`[syncplay-e2e] P1 run ${i} bad: ${reasons.join('; ')}\n`)
      row.add(
        {
          setupOk: true,
          bad,
          reasons,
          paused,
          resumed,
          pausedSpread: ap.ct - bp.ct,
          playingSpread: ar.ct - br.ct
        },
        bad ? { A: await A.collect(at), B: await B.collect(at) } : undefined
      )
    }
    const s = row.score()
    expect(s.scoreable).toBe(N)
    expect(s.bad).toBe(0)
  } finally {
    await closeDuo(A, B)
  }
})

for (const [rowId, what] of [
  ['P6', 'translation'],
  ['P7', 'quality']
] as const) {
  test(`${rowId} — pause, then a ${what} switch: the room stays paused`, async () => {
    const { A, B } = await seatDuo(rig)
    const row = new RowScorer(rowId)
    try {
      expect(await bothPlaying(A, B), 'setup: both instances never played').toBe(true)
      for (let i = 0; i < N; i++) {
        const setupOk =
          (await bothPlaying(A, B, 20_000)) && (await positionBoth(A, B, 120 + i * 60))
        await sleep(1500)
        const at = Date.now()
        await A.togglePlayButton()
        const paused = await bothPaused(A, B, 4000)
        // "Pause, then switch": the pause has settled (both elements paused and
        // a couple of room ticks gone by) before the switch starts. A switch
        // tens of ms after the press is a different scenario, #498's, and it is
        // the P7f / P6f rows below rather than folded into this one.
        await sleep(2000)
        const before = await A.state()
        if (what === 'translation') await A.switchTranslation()
        else await A.switchQuality()
        // The swap reloads A's element; give it the load plus a few ticks.
        const swapped = await waitFor(
          'src changed',
          async () => (await A.state()).src !== before.src,
          15_000
        )
        await sleep(6000)
        const [a, b] = await Promise.all([A.state(), B.state()])
        const bad = !paused || !swapped || !a.paused || !b.paused || Math.abs(a.ct - before.ct) > 5
        row.add(
          {
            setupOk: setupOk && paused && swapped,
            bad,
            aPaused: a.paused,
            bPaused: b.paused,
            drift: a.ct - before.ct
          },
          bad ? { A: await A.collect(at), B: await B.collect(at) } : undefined
        )
        // Resume for the next run (a bad run may have left it playing already).
        if ((await A.state()).paused) await A.togglePlayButton()
        await bothPlaying(A, B, 15_000)
      }
      const s = row.score()
      expect(s.scoreable).toBeGreaterThanOrEqual(1)
      expect(s.bad).toBe(0)
    } finally {
      await closeDuo(A, B)
    }
  })
}

// P7f / P6f — pause, then a switch tens of ms later (#498). No `bothPaused`
// before the switch: the press and both clicks run in one `page.evaluate`, and
// each run records its real gaps. The quality switch rebinds the element with
// nothing on its path to disarm the re-armed `autoplay`, so a fast fixture
// reload autostarts it and `onLocalPlay` tells the room `paused: false`. The
// translation switch resolves its stream first (the rig's 300 ms), and the
// episode/translation watcher disarms in that window, so P6f is a non-✗ guard.
const BUCKETS_MS = [0, 20, 50, 200] as const
const N_PER_BUCKET = Number(process.env.SYNCPLAY_E2E_N ?? 10)

for (const [rowId, what] of [
  ['P7f', 'quality'],
  ['P6f', 'translation']
] as const) {
  test(`${rowId} — pause, then a ${what} switch within tens of ms`, async () => {
    const { A, B } = await seatDuo(rig)
    const row = new RowScorer(rowId)
    try {
      expect(await bothPlaying(A, B), 'setup: both instances never played').toBe(true)
      let k = 0
      for (const delayMs of BUCKETS_MS) {
        for (let i = 0; i < N_PER_BUCKET; i++, k++) {
          const setupOk =
            (await bothPlaying(A, B, 20_000)) && (await positionBoth(A, B, 120 + (k % 20) * 60))
          await sleep(1500)
          const before = await A.state()
          const at = Date.now()
          const clicks = await A.pauseThenSwitch(what, delayMs)
          const swapped = await waitFor(
            'src changed',
            async () => (await A.state()).src !== before.src,
            15_000
          )
          await sleep(4000)
          const [a, b] = await Promise.all([A.state(), B.state()])
          const dA = await A.collect(at)
          // From A's own `paused: true` on, any outbound `paused: false` is a
          // resume nobody pressed — counted, so one a later frame undid shows.
          const out = dA.wire.filter((w) => w.dir === 'out' && w.ps)
          const press = out.findIndex((w) => w.ps!.paused === true)
          const resumesSent =
            press < 0 ? 0 : out.slice(press).filter((w) => w.ps!.paused === false).length
          const bad = !a.paused || !b.paused || resumesSent > 0
          row.add(
            {
              setupOk: setupOk && swapped && press >= 0,
              bad,
              delayMs,
              gapToFirstClick: clicks.firstClickAt - clicks.pressAt,
              gapToSecondClick: clicks.secondClickAt - clicks.pressAt,
              aPaused: a.paused,
              bPaused: b.paused,
              resumesSent
            },
            bad ? { A: dA, B: await B.collect(at) } : undefined
          )
          if ((await A.state()).paused) await A.togglePlayButton()
          await bothPlaying(A, B, 15_000)
        }
      }
      const s = row.score()
      const bucket = (d: number): { n: number; bad: number } => {
        const rs = s.records.filter((r) => r.setupOk && r.delayMs === d)
        return { n: rs.length, bad: rs.filter((r) => r.bad).length }
      }
      for (const d of BUCKETS_MS) {
        const b = bucket(d)
        process.stdout.write(`[syncplay-e2e] ${rowId} ${d} ms: n=${b.n} bad=${b.bad}\n`)
        expect(b.n, `${rowId} ${d} ms: no scoreable runs`).toBeGreaterThanOrEqual(1)
      }
      if (rowId === 'P7f') {
        // ✗ (#498): the rig sees the bug in the 0 ms bucket.
        expect(bucket(0).bad).toBeGreaterThanOrEqual(1)
      } else {
        expect(s.bad).toBe(0)
      }
    } finally {
      await closeDuo(A, B)
    }
  })
}

test('P8 — B goes not-ready: the gate pauses both, and both resume when it is ready', async () => {
  const { A, B } = await seatDuo(rig)
  const row = new RowScorer('P8')
  try {
    expect(await bothPlaying(A, B), 'setup: both instances never played').toBe(true)
    for (let i = 0; i < N; i++) {
      await sleep(2000)
      const at = Date.now()
      await B.page.evaluate(() => window.api.syncplaySetReady(false))
      const gated = await bothPaused(A, B, 5000)
      await sleep(1500)
      await B.page.evaluate(() => window.api.syncplaySetReady(true))
      const resumed = await bothPlaying(A, B, 10_000)
      const bad = !gated || !resumed
      row.add(
        { setupOk: true, bad, gated, resumed },
        bad ? { A: await A.collect(at), B: await B.collect(at) } : undefined
      )
    }
    const s = row.score()
    expect(s.scoreable).toBe(N)
    expect(s.bad).toBe(0)
  } finally {
    await closeDuo(A, B)
  }
})
