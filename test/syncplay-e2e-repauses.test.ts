// `rePausesAfterSeek` (`e2e-syncplay/helpers/score.ts`), the re-pause term of
// E7 / E7s / E7b / E7c (#549). Before it, each row counted every outbound
// `paused: true` from either peer after the earliest `{0, doSeek}` either sent,
// so a peer's 1 Hz heartbeat that left before that peer received the other's
// seek scored a correct auto-advance as bad. The two recorded shapes are wire
// slices of the bad run's trace, ping-only frames dropped: #546's CI (run
// 40147417184, shard 1, E7c i=3) and #502's local E7s i=3, both on the real
// Syncplay 1.7.6 server. Each frame is
// `[at, dir, playstate | null, ignoringOnTheFly | null]`, relative to the
// trace's start; `null` playstate is an ack.

import { describe, expect, it } from 'vitest'
import { rePausesAfterSeek } from '../e2e-syncplay/helpers/score'

type Ps = { position: number; paused?: boolean; doSeek: boolean; setBy?: string }
type Io = { server?: number; client?: number }
type Tuple = [number, 'in' | 'out', Ps | null, Io | null]
type Frame = { at: number; dir: string; ps?: Ps; iotf?: Io }
const wire = (frames: Tuple[]): Frame[] =>
  frames.map(([at, dir, ps, iotf]) => ({
    at,
    dir,
    ...(ps ? { ps } : {}),
    ...(iotf ? { iotf } : {})
  }))

/** The rule every row used before #549, kept here as the characterization. */
const oldRule = (wa: Frame[], wb: Frame[]): number => {
  const own = (w: Frame[]): Frame[] =>
    w.filter((f) => f.dir === 'out' && !!f.ps?.doSeek && f.ps.position < 1)
  const firstSeekAt = Math.min(...[...own(wa), ...own(wb)].map((f) => f.at))
  return [wa, wb].flatMap((w) =>
    w.filter((f) => f.dir === 'out' && f.at > firstSeekAt && f.ps?.paused === true)
  ).length
}

const heartbeat = (at: number, position = 1420): Tuple => [
  at,
  'out',
  { position, paused: true, doSeek: false },
  null
]

// #546's CI, E7c i=3. B's seek left at 16833, A's heartbeat at 16834, and A
// received the seek at 16835. Nothing re-paused the room.
const e7cA: Tuple[] = [
  [15832, 'out', { position: 1420, paused: true, doSeek: false }, null],
  [15855, 'in', { position: 1420, paused: true, doSeek: false, setBy: 'rigA' }, null],
  [16834, 'out', { position: 1420, paused: true, doSeek: false }, null],
  [
    16835,
    'in',
    { position: 0.0005770797521117697, paused: false, doSeek: true, setBy: 'rigB' },
    { server: 1 }
  ],
  [16835, 'out', null, { server: 1 }],
  [
    16856,
    'in',
    { position: 0.018729555109167434, paused: false, doSeek: false, setBy: 'rigA' },
    null
  ]
]
const e7cB: Tuple[] = [
  [15810, 'out', { position: 1420.042737, paused: true, doSeek: false }, null],
  [15869, 'in', { position: 1420, paused: true, doSeek: false, setBy: 'rigA' }, null],
  [16811, 'out', { position: 1420.042737, paused: true, doSeek: false }, null],
  [16833, 'out', { position: 0, paused: false, doSeek: true }, { client: 4 }],
  [
    16834,
    'in',
    { position: 0.0005770797521117697, paused: false, doSeek: true, setBy: 'rigB' },
    { server: 1, client: 4 }
  ],
  [16834, 'out', null, { server: 1 }],
  [
    16869,
    'in',
    { position: 0.03209005544486079, paused: false, doSeek: false, setBy: 'rigA' },
    null
  ]
]

// #502's E7s i=3. B's seek left at 16856; A's heartbeat and A's receipt of the
// seek are both at 16871, the heartbeat first in A's wire.
const e7sA: Tuple[] = [
  [15870, 'in', { position: 1419.999, paused: true, doSeek: false, setBy: 'rigB' }, null],
  [15870, 'out', { position: 1420, paused: true, doSeek: false }, null],
  [16871, 'out', { position: 1420, paused: true, doSeek: false }, null],
  [
    16871,
    'in',
    { position: 0.001528779589191221, paused: false, doSeek: true, setBy: 'rigB' },
    { server: 1 }
  ],
  [16872, 'out', null, { server: 1 }]
]
const e7sB: Tuple[] = [
  [16101, 'out', { position: 1419.999, paused: true, doSeek: false }, null],
  [16131, 'in', { position: 1419.999, paused: true, doSeek: false, setBy: 'rigB' }, null],
  [16856, 'out', { position: 0, paused: false, doSeek: true }, { client: 4 }],
  [
    16858,
    'in',
    { position: 0.001528779589191221, paused: false, doSeek: true, setBy: 'rigB' },
    { server: 1, client: 4 }
  ],
  [16858, 'out', null, { server: 1 }],
  [17101, 'out', { position: 0.24400363310481624, doSeek: false }, null],
  [17131, 'in', { position: 1.0014098087182195, paused: false, doSeek: false, setBy: 'rigB' }, null]
]

/** `frames` with `extra` inserted before index `at`. */
const insert = (frames: Tuple[], at: number, ...extra: Tuple[]): Tuple[] => [
  ...frames.slice(0, at),
  ...extra,
  ...frames.slice(at)
]

describe('rePausesAfterSeek on the recorded shapes (#549)', () => {
  it("#546's E7c i=3: A's heartbeat 1 ms after B's seek, before A received it, does not count", () => {
    expect(oldRule(wire(e7cA), wire(e7cB))).toBe(1)
    expect(rePausesAfterSeek(wire(e7cA), wire(e7cB))).toEqual({
      a: 0,
      b: 0,
      roomRePaused: false
    })
  })

  it("#502's E7s i=3: A's heartbeat in the ms A received the seek, ahead of it in A's wire, does not count", () => {
    expect(oldRule(wire(e7sA), wire(e7sB))).toBe(1)
    expect(rePausesAfterSeek(wire(e7sA), wire(e7sB))).toEqual({
      a: 0,
      b: 0,
      roomRePaused: false
    })
  })
})

describe('a re-pause sent after the seek still counts (#549)', () => {
  it('A sends `paused: true` 5 ms after it received the seek', () => {
    const a = insert(e7cA, 5, heartbeat(16840, 0.005))
    expect(rePausesAfterSeek(wire(a), wire(e7cB))).toEqual({ a: 1, b: 0, roomRePaused: false })
  })

  it('the seeker sends `paused: true` in the ms of its own seek, after it in its wire', () => {
    const b = insert(e7cB, 4, heartbeat(16833, 0.001))
    // `at > firstSeekAt` hid it.
    expect(oldRule([], wire(b))).toBe(0)
    expect(rePausesAfterSeek(wire(e7cA), wire(b))).toEqual({ a: 0, b: 1, roomRePaused: false })
  })

  it('counts are per peer', () => {
    const a = insert(e7cA, 5, heartbeat(16840, 0.005))
    const b = [...e7cB, heartbeat(16900, 0.07), heartbeat(17900, 1.07)]
    expect(rePausesAfterSeek(wire(a), wire(b))).toEqual({ a: 1, b: 2, roomRePaused: false })
  })

  it('a re-pause the server forwards sets roomRePaused, and one it drops still counts', () => {
    const a = insert(e7cA, 5, heartbeat(16840, 0.005))
    const b: Tuple[] = [
      ...e7cB,
      [16860, 'in', { position: 0.005, paused: true, doSeek: false, setBy: 'rigA' }, null]
    ]
    expect(rePausesAfterSeek(wire(a), wire(b))).toEqual({ a: 1, b: 0, roomRePaused: true })
    expect(rePausesAfterSeek(wire(a), wire(e7cB)).a).toBe(1)
  })
})

describe('the threshold is the wire index, not `at` (#549)', () => {
  // A's heartbeat and A's seek receipt share 16871 in #502's trace. The order
  // in A's wire decides, both ways.
  it('a same-ms heartbeat before the seek-in frame does not count', () => {
    expect(rePausesAfterSeek(wire(e7sA), wire(e7sB)).a).toBe(0)
  })

  it('a same-ms heartbeat after the seek-in frame counts', () => {
    const swapped: Tuple[] = [e7sA[0], e7sA[1], e7sA[3], e7sA[2], e7sA[4]]
    expect(rePausesAfterSeek(wire(swapped), wire(e7sB))).toEqual({
      a: 1,
      b: 0,
      roomRePaused: false
    })
  })
})

describe('only the advance seek moves the threshold (#549)', () => {
  it('an inbound `doSeek` past 1 s before the advance seek does not move it', () => {
    const a = insert(e7cA, 2, [
      16834,
      'in',
      { position: 1411, paused: false, doSeek: true, setBy: 'rigB' },
      null
    ])
    expect(rePausesAfterSeek(wire(a), wire(e7cB)).a).toBe(0)
  })

  it('an advance-shaped inbound seek from before the first seek out is not the threshold', () => {
    const a = insert(e7cA, 0, [
      15820,
      'in',
      { position: 0.2, paused: true, doSeek: true, setBy: 'rigA' },
      null
    ])
    expect(rePausesAfterSeek(wire(a), wire(e7cB)).a).toBe(0)
  })
})

describe('a peer the seek never reached (#549)', () => {
  // B seeks at 100; A has no seek out and none in, so it keeps the old rule.
  const b = wire([[100, 'out', { position: 0, paused: false, doSeek: true }, null]])

  it('falls back to the first seek: a pause after it counts, one before it does not', () => {
    const a = wire([heartbeat(90), heartbeat(150), heartbeat(1150)])
    expect(rePausesAfterSeek(a, b)).toEqual({ a: 2, b: 0, roomRePaused: false })
  })

  it('with no seek from anyone, nothing counts', () => {
    expect(rePausesAfterSeek(wire([heartbeat(90)]), wire([heartbeat(95)]))).toEqual({
      a: 0,
      b: 0,
      roomRePaused: false
    })
  })
})
