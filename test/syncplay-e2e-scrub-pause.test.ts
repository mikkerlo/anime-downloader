// `scrubPauseVerdict` (`e2e-syncplay/helpers/score.ts`), the S10 / S11 scorer
// of #524, replayed on wire slices captured from the local sweep on the real
// Syncplay 1.7.6 server (one slice per outcome the sweep produced). Each frame
// is `[at, dir, playstate | null, ignoringOnTheFly | null]`, relative to the
// scheduled scrub; `null` playstate is a ping-only ack.

import { describe, expect, it } from 'vitest'
import {
  SCRUB_PAUSE_SPREAD_S,
  lostPauseTally,
  pauseInFlight,
  scrubPauseVerdict
} from '../e2e-syncplay/helpers/score'
import { ECHO_SEEK_EPSILON_S } from '../src/main/syncplay'

type Ps = { position: number; paused?: boolean; doSeek: boolean; setBy?: string }
type Io = { server?: number; client?: number }
const wire = (
  frames: [number, 'in' | 'out', Ps | null, Io | null][]
): { at: number; dir: string; ps?: Ps; iotf?: Io }[] =>
  frames.map(([at, dir, ps, iotf]) => ({
    at,
    dir,
    ...(ps ? { ps } : {}),
    ...(iotf ? { iotf } : {})
  }))

describe('scrubPauseVerdict (#524)', () => {
  it('the spread threshold is ECHO_SEEK_EPSILON_S, the predicate the drift fix snaps at', () => {
    expect(SCRUB_PAUSE_SPREAD_S).toBe(ECHO_SEEK_EPSILON_S)
  })

  // B scrubs, A pauses 1 ms earlier. A's pause reaches the server first; B's
  // seek left before B heard it, so the forced pause carries no `client` echo
  // and the seek no `server` ack. B acks and re-asserts in the same ms; the
  // room resumes on the re-assert, and both peers play on from the target.
  it('a crossed scrub: the pause is lost, resumed by the #252 re-assert', () => {
    const v = scrubPauseVerdict({
      scrubber: {
        name: 'rigB',
        ct: 399.71,
        paused: false,
        wire: wire([
          [51, 'out', { position: 394.8, paused: false, doSeek: true }, { client: 12 }],
          [
            51,
            'in',
            { position: 363.169, paused: true, doSeek: false, setBy: 'rigA' },
            { server: 1 }
          ],
          [51, 'out', null, { server: 1 }],
          [52, 'out', { position: 394.8, paused: false, doSeek: true }, null],
          [
            94,
            'in',
            { position: 394.801, paused: false, doSeek: true, setBy: 'rigB' },
            { server: 1, client: 12 }
          ],
          [94, 'out', null, { server: 1 }]
        ])
      },
      pauser: {
        name: 'rigA',
        ct: 399.71,
        paused: false,
        wire: wire([
          [50, 'out', { position: 363.169, paused: true, doSeek: false }, { client: 22 }],
          [
            52,
            'in',
            { position: 363.169, paused: true, doSeek: false, setBy: 'rigA' },
            { server: 1, client: 22 }
          ],
          [53, 'out', null, { server: 1 }],
          [
            94,
            'in',
            { position: 394.801, paused: false, doSeek: true, setBy: 'rigB' },
            { server: 1 }
          ],
          [94, 'out', null, { server: 1 }]
        ])
      }
    })
    expect(v).toMatchObject({
      lost: true,
      drift: false,
      seekCrossed: true,
      reasserts: 1,
      resumedBy: 'reassert'
    })
  })

  // The crossed wire, but the forced pause echoes the seek's `client: 12`: the
  // server had the seek before it sent the pause, so this is a seek dropped
  // behind an older forced update, not a crossing. The room still resumes on
  // the re-assert, and that must not read as the seek.
  it('a seek the server had but dropped: not crossed, still resumed by the re-assert', () => {
    const v = scrubPauseVerdict({
      scrubber: {
        name: 'rigB',
        ct: 399.71,
        paused: false,
        wire: wire([
          [51, 'out', { position: 394.8, paused: false, doSeek: true }, { client: 12 }],
          [
            51,
            'in',
            { position: 363.169, paused: true, doSeek: false, setBy: 'rigA' },
            { server: 1, client: 12 }
          ],
          [51, 'out', null, { server: 1 }],
          [52, 'out', { position: 394.8, paused: false, doSeek: true }, null],
          [
            94,
            'in',
            { position: 394.801, paused: false, doSeek: true, setBy: 'rigB' },
            { server: 1, client: 12 }
          ],
          [94, 'out', null, { server: 1 }]
        ])
      },
      pauser: {
        name: 'rigA',
        ct: 399.71,
        paused: false,
        wire: wire([
          [50, 'out', { position: 363.169, paused: true, doSeek: false }, { client: 22 }],
          [
            52,
            'in',
            { position: 363.169, paused: true, doSeek: false, setBy: 'rigA' },
            { server: 1, client: 22 }
          ],
          [53, 'out', null, { server: 1 }],
          [
            94,
            'in',
            { position: 394.801, paused: false, doSeek: true, setBy: 'rigB' },
            { server: 1 }
          ],
          [94, 'out', null, { server: 1 }]
        ])
      }
    })
    expect(v).toMatchObject({
      lost: true,
      seekCrossed: false,
      reasserts: 1,
      resumedBy: 'reassert'
    })
  })

  // The crossed wire again, with a `server` ack on the seek. The server clears
  // its counter only when an ack equals it (protocols.py's handleState), and
  // the forced pause carries the counter as it stood when the seek arrived.
  const crossedWithSeekAck = (seekAck: number, pauseServer: number): boolean => {
    const prior: [number, 'in', Ps, Io][] =
      pauseServer > seekAck
        ? [
            [
              40,
              'in',
              { position: 390, paused: false, doSeek: false, setBy: 'rigA' },
              { server: seekAck }
            ]
          ]
        : []
    return scrubPauseVerdict({
      scrubber: {
        name: 'rigB',
        ct: 399.71,
        paused: false,
        wire: wire([
          ...prior,
          [
            51,
            'out',
            { position: 394.8, paused: false, doSeek: true },
            { server: seekAck, client: 12 }
          ],
          [
            51,
            'in',
            { position: 363.169, paused: true, doSeek: false, setBy: 'rigA' },
            { server: pauseServer }
          ],
          [51, 'out', null, { server: pauseServer }]
        ])
      },
      pauser: {
        name: 'rigA',
        ct: 399.71,
        paused: false,
        wire: wire([
          [50, 'out', { position: 363.169, paused: true, doSeek: false }, { client: 22 }]
        ])
      }
    }).seekCrossed
  }

  // An ack equal to the counter the pause carries clears the gate, so the
  // seek applies behind the pause: not crossed.
  it('a seek acking the counter the pause carries: not crossed', () => {
    expect(crossedWithSeekAck(1, 1)).toBe(false)
  })

  // The scrubber acks the forced update it heard before seeking (counter 1),
  // but the pause's forced send has bumped the counter to 2: the ack does not
  // clear it, the gate drops the seek, and this is still a crossing.
  it('a seek acking an older forced update: still crossed', () => {
    expect(crossedWithSeekAck(1, 2)).toBe(true)
  })

  // A scrubs, B pauses 2 ms earlier, and A hears (and acks) the pause before
  // its seek leaves. No crossing, so the gate is down: the seek itself, still
  // carrying the renderer's `paused: false`, resumes the room.
  it('an uncrossed scrub: the pause is lost, resumed by the seek itself', () => {
    const v = scrubPauseVerdict({
      scrubber: {
        name: 'rigA',
        ct: 583.36,
        paused: false,
        wire: wire([
          [
            51,
            'in',
            { position: 609.962, paused: true, doSeek: false, setBy: 'rigB' },
            { server: 1 }
          ],
          [52, 'out', null, { server: 1 }],
          [52, 'out', { position: 579.3, paused: false, doSeek: true }, { client: 82 }],
          [
            52,
            'in',
            { position: 579.301, paused: false, doSeek: true, setBy: 'rigA' },
            { server: 1, client: 82 }
          ],
          [52, 'out', null, { server: 1 }]
        ])
      },
      pauser: {
        name: 'rigB',
        ct: 584.25,
        paused: false,
        wire: wire([
          [49, 'out', { position: 609.962, paused: true, doSeek: false }, { client: 52 }],
          [
            50,
            'in',
            { position: 609.962, paused: true, doSeek: false, setBy: 'rigB' },
            { server: 1, client: 52 }
          ],
          [50, 'out', null, { server: 1 }],
          [
            52,
            'in',
            { position: 579.301, paused: false, doSeek: true, setBy: 'rigA' },
            { server: 1 }
          ],
          [52, 'out', null, { server: 1 }]
        ])
      }
    })
    expect(v).toMatchObject({
      lost: true,
      seekCrossed: false,
      pauseCrossed: false,
      reasserts: 0,
      resumedBy: 'seek'
    })
  })

  // A scrubs, B pauses in the same ms, and the scrub reaches the server first:
  // the forced seek is the first forced update B hears after its press, with no
  // `client` echo of the press. The gate drops B's press, so the room never
  // pauses; B's first heartbeat is position-only (#513's marker), and by the
  // second B's renderer has let its pending pause go, so it claims playing. The
  // full-suite S11 run for #544, run 47: a lost pause that `resumedBy` reads as
  // the seek, which is the scrubber's honest `paused: false` (it never heard the
  // pause), so `pauseCrossed` takes it out of the 2b bucket.
  it('the pauser’s press crossed by the scrub and dropped: lost, `pauseCrossed`, not 2b', () => {
    const v = scrubPauseVerdict({
      scrubber: {
        name: 'rigA',
        ct: 629.15,
        paused: false,
        wire: wire([
          [51, 'out', { position: 625.7, paused: false, doSeek: true }, { client: 81 }],
          [
            52,
            'in',
            { position: 625.701, paused: false, doSeek: true, setBy: 'rigA' },
            { server: 1, client: 81 }
          ],
          [52, 'out', null, { server: 1 }],
          [344, 'in', { position: 626.7, paused: false, doSeek: false, setBy: 'rigA' }, null],
          [347, 'out', { position: 625.71, paused: false, doSeek: false }, null]
        ])
      },
      pauser: {
        name: 'rigB',
        ct: 627.6,
        paused: false,
        wire: wire([
          [52, 'out', { position: 595.671, paused: true, doSeek: false }, { client: 63 }],
          [
            52,
            'in',
            { position: 625.701, paused: false, doSeek: true, setBy: 'rigA' },
            { server: 1 }
          ],
          [52, 'out', null, { server: 1 }],
          [
            607,
            'in',
            { position: 625.971, paused: false, doSeek: false, setBy: 'rigA' },
            { client: 63 }
          ],
          [613, 'out', { position: 625.701, doSeek: false }, null],
          [1607, 'in', { position: 626.971, paused: false, doSeek: false, setBy: 'rigA' }, null],
          [1613, 'out', { position: 625.701, paused: false, doSeek: false }, null]
        ])
      }
    })
    expect(v).toMatchObject({
      lost: true,
      seekCrossed: false,
      pauseCrossed: true,
      reasserts: 0,
      resumedBy: 'seek'
    })
    expect(lostPauseTally([{ setupOk: true, ...v }])).toMatchObject({ seek: 0, dropped: 1 })
  })

  // The uncrossed wire plus a `doSeek: true` the scrubber sends at 60 ms, after
  // the room had already resumed on the seek at 52: a later re-assert does not
  // make it the frame the room resumed on.
  it('a re-assert sent after the resume: still resumed by the seek', () => {
    const v = scrubPauseVerdict({
      scrubber: {
        name: 'rigA',
        ct: 583.36,
        paused: false,
        wire: wire([
          [
            51,
            'in',
            { position: 609.962, paused: true, doSeek: false, setBy: 'rigB' },
            { server: 1 }
          ],
          [52, 'out', null, { server: 1 }],
          [52, 'out', { position: 579.3, paused: false, doSeek: true }, { client: 82 }],
          [
            52,
            'in',
            { position: 579.301, paused: false, doSeek: true, setBy: 'rigA' },
            { server: 1, client: 82 }
          ],
          [52, 'out', null, { server: 1 }],
          [60, 'out', { position: 579.3, paused: false, doSeek: true }, null]
        ])
      },
      pauser: {
        name: 'rigB',
        ct: 584.25,
        paused: false,
        wire: wire([
          [49, 'out', { position: 609.962, paused: true, doSeek: false }, { client: 52 }],
          [
            50,
            'in',
            { position: 609.962, paused: true, doSeek: false, setBy: 'rigB' },
            { server: 1, client: 52 }
          ],
          [50, 'out', null, { server: 1 }],
          [
            52,
            'in',
            { position: 579.301, paused: false, doSeek: true, setBy: 'rigA' },
            { server: 1 }
          ],
          [52, 'out', null, { server: 1 }]
        ])
      }
    })
    expect(v).toMatchObject({ lost: true, seekCrossed: false, reasserts: 1, resumedBy: 'seek' })
  })

  // B scrubs, A pauses in the same ms. The scrub reaches the server first and
  // A's pause, sent at the pre-seek position, crosses it and is dropped. A's
  // first heartbeat is position-only (#513's marker), the next one re-pauses
  // the room at the target, and B has played on 1.25 s by then.
  it('the pauser’s pause crossed by the scrub: drift, the scrubber ahead', () => {
    const v = scrubPauseVerdict({
      scrubber: {
        name: 'rigB',
        ct: 543.05,
        paused: true,
        wire: wire([
          [51, 'out', { position: 541.8, paused: false, doSeek: true }, { client: 16 }],
          [
            52,
            'in',
            { position: 541.801, paused: false, doSeek: true, setBy: 'rigB' },
            { server: 1, client: 16 }
          ],
          [52, 'out', null, { server: 1 }]
        ])
      },
      pauser: {
        name: 'rigA',
        ct: 541.8,
        paused: true,
        wire: wire([
          [52, 'out', { position: 512.145, paused: true, doSeek: false }, { client: 26 }],
          [
            52,
            'in',
            { position: 541.801, paused: false, doSeek: true, setBy: 'rigB' },
            { server: 1 }
          ],
          [52, 'out', null, { server: 1 }],
          [354, 'out', { position: 541.802, doSeek: false }, null]
        ])
      }
    })
    expect(v).toMatchObject({
      lost: false,
      drift: true,
      seekCrossed: false,
      pauseCrossed: true,
      resumedBy: null
    })
    expect(v.spread).toBeCloseTo(1.25, 2)
  })

  // B scrubs, A pauses 3 ms later: the scrub lands, A acks it, then pauses at
  // the target. Both end paused together.
  it('a clean run: neither', () => {
    const v = scrubPauseVerdict({
      scrubber: {
        name: 'rigB',
        ct: 605.3,
        paused: true,
        wire: wire([
          [51, 'out', { position: 605.3, paused: false, doSeek: true }, { client: 31 }],
          [
            51,
            'in',
            { position: 605.301, paused: false, doSeek: true, setBy: 'rigB' },
            { server: 1, client: 31 }
          ],
          [52, 'out', null, { server: 1 }],
          [
            56,
            'in',
            { position: 605.301, paused: true, doSeek: false, setBy: 'rigA' },
            { server: 1 }
          ],
          [56, 'out', null, { server: 1 }]
        ])
      },
      pauser: {
        name: 'rigA',
        ct: 605.3,
        paused: true,
        wire: wire([
          [
            53,
            'in',
            { position: 605.301, paused: false, doSeek: true, setBy: 'rigB' },
            { server: 1 }
          ],
          [54, 'out', null, { server: 1 }],
          [55, 'out', { position: 605.301, paused: true, doSeek: false }, { client: 56 }]
        ])
      }
    })
    expect(v).toEqual({
      lost: false,
      drift: false,
      spread: 0,
      seekCrossed: false,
      pauseCrossed: false,
      reasserts: 0,
      resumedBy: null
    })
  })

  it('reads a heartbeat resume as one, and a pause with no recorded resume as unread', () => {
    const scrubber = {
      name: 'rigB',
      ct: 10,
      paused: false,
      wire: wire([
        [1, 'out', { position: 40, paused: false, doSeek: true }, { client: 1 }],
        [2, 'in', { position: 5, paused: true, doSeek: false, setBy: 'rigA' }, { server: 1 }],
        [2, 'out', null, { server: 1 }]
      ])
    }
    const press: [number, 'out', Ps, Io][] = [
      [0, 'out', { position: 5, paused: true, doSeek: false }, { client: 1 }]
    ]
    const heartbeat = scrubPauseVerdict({
      scrubber,
      pauser: {
        name: 'rigA',
        ct: 10,
        paused: false,
        wire: wire([
          ...press,
          [900, 'in', { position: 41, paused: false, doSeek: false, setBy: 'rigB' }, { server: 2 }]
        ])
      }
    })
    expect(heartbeat.resumedBy).toBe('heartbeat')
    // A periodic (no `server` counter) is not a forced resume.
    const unread = scrubPauseVerdict({
      scrubber,
      pauser: {
        name: 'rigA',
        ct: 10,
        paused: false,
        wire: wire([
          ...press,
          [900, 'in', { position: 41, paused: false, doSeek: false, setBy: 'rigB' }, null]
        ])
      }
    })
    expect(unread).toMatchObject({ lost: true, seekCrossed: true, resumedBy: null })
  })
})

// The #537 shape, replayed on the run that showed it: S10c run 8 on #524's
// tip, rigB scrubbing 2 s while rigA pauses 1 ms before. The scrub crossed the
// forced pause (no server ack, the pause carries no client echo), the pause
// reached rigB 5 ms before its own seek landed, and no re-assert followed. Both
// settled paused 2.01 s apart. #524 carved exactly this shape out of S10c's
// `bad == 0`; #537 lands the scrubber on the pauser's frame and removes the
// carve-out, so S10c fails on any run scored like the recorded one.
describe('the #537 shape is scored as drift, with no carve-out (S10c)', () => {
  const scrubberWire = wire([
    [51, 'out', { position: 36.4, paused: false, doSeek: true }, { client: 9 }],
    [51, 'in', { position: 34.390382, paused: true, doSeek: false, setBy: 'rigA' }, { server: 1 }],
    [51, 'out', null, { server: 1 }],
    [882, 'out', { position: 36.4, paused: true, doSeek: false }, null],
    [950, 'in', { position: 34.390382, paused: true, doSeek: false, setBy: 'rigA' }, { client: 9 }]
  ])
  const pauserWire = wire([
    [50, 'out', { position: 34.390382, paused: true, doSeek: false }, { client: 4 }]
  ])
  const ev = (seekedAt: number): { at: number; t: string; ct: number; src: string }[] => [
    { at: 51, t: 'seeking', ct: 36.4, src: 'ep1' },
    { at: 52, t: 'pause', ct: 36.4, src: 'ep1' },
    { at: seekedAt, t: 'seeked', ct: 36.4, src: 'ep1' }
  ]
  const outcome = (s: { wire: typeof scrubberWire; seekedAt: number; ct?: number }) => {
    const v = scrubPauseVerdict({
      scrubber: { name: 'rigB', wire: s.wire, ct: s.ct ?? 36.4, paused: true },
      pauser: { name: 'rigA', wire: pauserWire, ct: 34.39, paused: true }
    })
    return {
      bad: v.drift,
      seekCrossed: v.seekCrossed,
      reasserts: v.reasserts,
      pauseInFlight: pauseInFlight({ wire: s.wire, ev: ev(s.seekedAt) })
    }
  }

  it('scores the recorded run bad: drifted, crossed, in flight, never re-asserted', () => {
    const r = outcome({ wire: scrubberWire, seekedAt: 56 })
    expect(r).toEqual({ bad: true, seekCrossed: true, reasserts: 0, pauseInFlight: true })
  })

  it('scores the same crossing with the scrubber on the pauser’s frame as no drift', () => {
    // The #537 outcome: the scrub is still lost, and the scrubber snapped to the
    // pause, so its heartbeat carries the pauser's position.
    const landed = scrubberWire.map((f) =>
      f.at === 882 ? { ...f, ps: { position: 34.390382, paused: true, doSeek: false } } : f
    )
    const r = outcome({ wire: landed, seekedAt: 56, ct: 34.39 })
    expect(r).toEqual({ bad: false, seekCrossed: true, reasserts: 0, pauseInFlight: true })
  })
})

// S11 / S11c / S12l since #544: a lost pause fails the row when the #252
// re-assert (2a, #535), a heartbeat (#513's marker failing to withhold) or the
// scrubber's own seek (2b, #544's kept marker failing) resumed the room. An
// unread resume, which can't be attributed, and a press the server dropped
// (`pauseCrossed`: the room never paused) that reads as the seek are counted
// without failing, until #547.
describe('lostPauseTally: what S11 fails on (#535, #544)', () => {
  type Rec = { setupOk: boolean; lost: boolean; resumedBy: string | null; pauseCrossed?: boolean }
  const run = (resumedBy: Rec['resumedBy'], over: Partial<Rec> = {}): Rec => ({
    setupOk: true,
    lost: true,
    resumedBy,
    ...over
  })

  it('a lost pause the re-assert resumed fails the row', () => {
    const t = lostPauseTally([run('reassert'), run(null, { lost: false })])
    expect(t).toEqual({ reassert: 1, seek: 0, heartbeat: 0, unread: 0, dropped: 0, failed: 1 })
  })

  it('a lost pause the scrubber’s own seek resumed fails the row (#544)', () => {
    const t = lostPauseTally([run('seek'), run(null, { lost: false })])
    expect(t).toEqual({ reassert: 0, seek: 1, heartbeat: 0, unread: 0, dropped: 0, failed: 1 })
  })

  it('a lost pause a heartbeat resumed fails the row (#513’s marker did not withhold)', () => {
    const t = lostPauseTally([run('heartbeat'), run(null, { lost: false })])
    expect(t).toEqual({ reassert: 0, seek: 0, heartbeat: 1, unread: 0, dropped: 0, failed: 1 })
  })

  it('counts an unread resume without failing, and skips unscoreable runs', () => {
    const t = lostPauseTally([
      run(null),
      run(null),
      run('reassert', { setupOk: false }),
      run('heartbeat', { setupOk: false }),
      run('seek', { setupOk: false })
    ])
    expect(t).toEqual({ reassert: 0, seek: 0, heartbeat: 0, unread: 2, dropped: 0, failed: 0 })
  })

  // A press the server dropped (`pauseCrossed`) left the room unpaused, and the
  // crossing seek is the first forced `paused: false` the pauser sees, so
  // `resumedBy` reads it as the seek: it is in `dropped` and no other bucket.
  // Red if the seek bucket took it, the misreading that put every seek-resumed
  // lost pause #535 and #544 saw into 2b.
  it('counts a dropped press without failing, and keeps it out of the seek bucket', () => {
    const t = lostPauseTally([
      run('seek', { pauseCrossed: true }),
      run('seek', { pauseCrossed: true, setupOk: false }),
      run('seek')
    ])
    expect(t).toEqual({ reassert: 0, seek: 1, heartbeat: 0, unread: 0, dropped: 1, failed: 1 })
  })

  // The exemption covers only that `seek` misread: a dropped press explains no
  // re-assert or heartbeat resume, so a crossed run read as either still fails.
  // Red if every `pauseCrossed` run were exempted.
  it('fails a dropped press a heartbeat resumed', () => {
    const t = lostPauseTally([run('heartbeat', { pauseCrossed: true })])
    expect(t).toEqual({ reassert: 0, seek: 0, heartbeat: 1, unread: 0, dropped: 0, failed: 1 })
  })

  it('fails a dropped press the re-assert resumed', () => {
    const t = lostPauseTally([run('reassert', { pauseCrossed: true })])
    expect(t).toEqual({ reassert: 1, seek: 0, heartbeat: 0, unread: 0, dropped: 0, failed: 1 })
  })

  it('counts in `dropped` exactly the crossed runs read as the seek', () => {
    const t = lostPauseTally([
      run('seek', { pauseCrossed: true }),
      run('seek', { pauseCrossed: true }),
      run('reassert', { pauseCrossed: true }),
      run('heartbeat', { pauseCrossed: true }),
      run(null, { pauseCrossed: true }),
      run('seek', { pauseCrossed: true, lost: false })
    ])
    expect(t).toEqual({ reassert: 1, seek: 0, heartbeat: 1, unread: 1, dropped: 2, failed: 2 })
  })

  it('fails on every attributed resume, whatever the mix', () => {
    const t = lostPauseTally([
      run('reassert'),
      run('seek'),
      run('seek'),
      run('heartbeat'),
      run(null)
    ])
    expect(t).toEqual({ reassert: 1, seek: 2, heartbeat: 1, unread: 1, dropped: 0, failed: 4 })
  })

  it('reads a record shaped as the sweep writes it: `setupOk` plus the verdict', () => {
    // Shaped exactly as `scrubPauseSweep` writes a record: `setupOk` plus the
    // verdict spread in.
    const rec = (resumedBy: 'reassert' | 'seek'): Record<string, unknown> => ({
      setupOk: true,
      ...({
        lost: true,
        drift: false,
        spread: 0,
        seekCrossed: resumedBy === 'reassert',
        pauseCrossed: false,
        reasserts: resumedBy === 'reassert' ? 1 : 0,
        resumedBy
      } satisfies ReturnType<typeof scrubPauseVerdict>)
    })
    expect(lostPauseTally([rec('reassert')]).failed).toBe(1)
    expect(lostPauseTally([rec('seek')]).failed).toBe(1)
    expect(lostPauseTally([{ ...rec('seek'), lost: false }]).failed).toBe(0)
    expect(lostPauseTally([{ ...rec('seek'), pauseCrossed: true }])).toMatchObject({
      dropped: 1,
      failed: 0
    })
  })
})
