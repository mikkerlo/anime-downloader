// `scrubPauseVerdict` (`e2e-syncplay/helpers/score.ts`), the S10 / S11 scorer
// of #524, replayed on wire slices captured from the local sweep on the real
// Syncplay 1.7.6 server (one slice per outcome the sweep produced). Each frame
// is `[at, dir, playstate | null, ignoringOnTheFly | null]`, relative to the
// scheduled scrub; `null` playstate is a ping-only ack.

import { describe, expect, it } from 'vitest'
import {
  SCRUB_PAUSE_SPREAD_S,
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
    expect(v).toMatchObject({ lost: true, seekCrossed: false, reasserts: 0, resumedBy: 'seek' })
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
    expect(v).toMatchObject({ lost: false, drift: true, seekCrossed: false, resumedBy: null })
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
