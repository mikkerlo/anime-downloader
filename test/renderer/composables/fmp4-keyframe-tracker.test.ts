import { describe, it, expect } from 'vitest'
import { createKeyframeTracker } from '../../../src/renderer/src/composables/fmp4-keyframe-tracker'
import {
  NON_SYNC,
  SYNC,
  concat,
  fragment,
  initSegment,
  topLevelBoxes,
  type TrackSpec,
  type TrafSpec
} from '../../helpers/fmp4-boxes'

// #653. The flag layout is the one measured on ffmpeg 6.1.1's copy and
// transcode mux: a keyframe fragment carries `trun` `first_sample_flags` =
// 0x02000000, every other fragment falls back to `tfhd` `default_sample_flags`
// = 0x01010000, and `trex` `default_sample_flags` is 0.

const TS = 16000
const FRAME = 667
const VIDEO: TrackSpec = { id: 1, handler: 'vide', timescale: TS }
const AUDIO: TrackSpec = { id: 2, handler: 'soun', timescale: 48000 }
const INIT = initSegment([VIDEO, AUDIO])

const frames = (n: number): { duration: number; size: number }[] =>
  Array.from({ length: n }, () => ({ duration: FRAME, size: 10 }))

function videoTraf(seconds: number, keyframe: boolean, extra: Partial<TrafSpec> = {}): TrafSpec {
  return {
    trackId: 1,
    tfdt: seconds * TS,
    tfhdFlags: NON_SYNC,
    ...(keyframe ? { firstSampleFlags: SYNC } : {}),
    samples: frames(24),
    ...extra
  }
}

const audioTraf = (seconds: number): TrafSpec => ({
  trackId: 2,
  tfdt: seconds * 48000,
  firstSampleFlags: SYNC,
  samples: [{ duration: 1024, size: 6 }]
})

// The recorded value for a keyframe fragment at `seconds` of decode time.
const k = (seconds: number, offset = 0, duration = FRAME): number =>
  (seconds * TS - duration) / TS + offset

function track(...chunks: Uint8Array[]): readonly number[] {
  const t = createKeyframeTracker()
  t.reset(0)
  for (const c of chunks) t.push(c)
  return t.keyframes()
}

function expectTimes(actual: readonly number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((e, i) => expect(actual[i]).toBeCloseTo(e, 9))
}

describe('fmp4 keyframe tracker — which fragments are keyframes', () => {
  it('records a fragment whose trun first_sample_flags is a sync sample', () => {
    const t = createKeyframeTracker()
    t.reset(5)
    t.push(INIT)
    t.push(fragment([videoTraf(10, true)]))
    expectTimes(t.keyframes(), [k(10, 5)])
  })

  it('does not record a fragment only tfhd default_sample_flags marks non-sync, with trex flags 0', () => {
    // The trap: a parser that skipped tfhd and fell back to trex would read
    // every one of these as a keyframe.
    expectTimes(track(INIT, fragment([videoTraf(1, false)]), fragment([videoTraf(2, false)])), [])
  })

  it('falls back to trex default_sample_flags only when tfhd has none', () => {
    const noTfhdFlags = videoTraf(3, false, { tfhdFlags: undefined })
    expectTimes(track(INIT, fragment([noTfhdFlags])), [k(3)])
    const nonSyncTrex = initSegment([{ ...VIDEO, trexFlags: NON_SYNC }, AUDIO])
    expectTimes(track(nonSyncTrex, fragment([noTfhdFlags])), [])
  })

  it('reads the first sample per-sample sample_flags when the trun has no first_sample_flags', () => {
    const synced = videoTraf(4, false, {
      samples: [
        { duration: FRAME, flags: SYNC },
        ...frames(3).map((f) => ({ ...f, flags: NON_SYNC }))
      ]
    })
    const notFirst = videoTraf(5, false, {
      samples: [
        { duration: FRAME, flags: NON_SYNC },
        { duration: FRAME, flags: SYNC }
      ]
    })
    expectTimes(track(INIT, fragment([synced]), fragment([notFirst])), [k(4)])
  })

  it('prefers first_sample_flags over the per-sample flags of sample 0', () => {
    const traf = videoTraf(6, true, {
      samples: [{ duration: FRAME, flags: NON_SYNC }]
    })
    expectTimes(track(INIT, fragment([traf])), [k(6)])
  })

  it('ignores an audio traf by track_ID, in its own moof and beside the video', () => {
    expectTimes(
      track(
        INIT,
        fragment([audioTraf(7)]),
        fragment([audioTraf(8), videoTraf(8, false)]),
        fragment([audioTraf(9), videoTraf(9, true)])
      ),
      [k(9)]
    )
  })

  it('takes the video track from the trak whose hdlr is vide, whatever its track_ID', () => {
    const init = initSegment([
      { id: 1, handler: 'soun', timescale: 44100 },
      { id: 2, handler: 'vide', timescale: 90000 }
    ])
    const video: TrafSpec = {
      trackId: 2,
      tfdt: 10 * 90000,
      tfhdFlags: NON_SYNC,
      firstSampleFlags: SYNC,
      samples: [{ duration: 3750 }]
    }
    const audio: TrafSpec = { ...video, trackId: 1, tfdt: 20 * 44100 }
    expectTimes(track(init, fragment([audio]), fragment([video])), [(10 * 90000 - 3750) / 90000])
  })

  it('reads tkhd and mdhd version 1 headers', () => {
    const init = initSegment([
      { ...VIDEO, version: 1 },
      { ...AUDIO, version: 1 }
    ])
    expectTimes(track(init, fragment([videoTraf(11, true)])), [k(11)])
  })
})

describe('fmp4 keyframe tracker — times', () => {
  it('reads tfdt version 0 and version 1 (64-bit)', () => {
    const big = 2 ** 32 + 5 * TS
    expectTimes(
      track(
        INIT,
        fragment([videoTraf(12, true, { tfdtVersion: 0 })]),
        fragment([videoTraf(0, true, { tfdtVersion: 1, tfdt: big })])
      ),
      [k(12), (big - FRAME) / TS]
    )
  })

  it('subtracts the frame duration from the trun sample_duration', () => {
    const traf = videoTraf(13, true, { samples: [{ duration: 1000, size: 5 }] })
    expectTimes(track(INIT, fragment([traf])), [k(13, 0, 1000)])
  })

  it('subtracts the frame duration from tfhd default_sample_duration when the trun has none', () => {
    const traf = videoTraf(14, true, { tfhdDuration: 800, samples: [{ size: 5 }, { size: 5 }] })
    expectTimes(track(INIT, fragment([traf])), [k(14, 0, 800)])
  })

  it('records every keyframe below its decode time, and adds the run offset', () => {
    const t = createKeyframeTracker()
    t.reset(329.917)
    t.push(INIT)
    t.push(fragment([videoTraf(0, true)]))
    expect(t.keyframes()[0]).toBeLessThan(329.917)
    expect(t.keyframes()[0]).toBeCloseTo(329.917 - FRAME / TS, 9)
  })
})

describe('fmp4 keyframe tracker — framing across chunks', () => {
  const stream = concat([
    INIT,
    fragment([videoTraf(20, true)], { mdatBytes: 300 }),
    fragment([audioTraf(20)], { mdatBytes: 50 }),
    fragment([videoTraf(21, false)], { mdatBytes: 300 }),
    fragment([videoTraf(22, true)], { mdatBytes: 200, largeMdat: true }),
    fragment([videoTraf(23, true)], { mdatBytes: 10 })
  ])
  const expected = [k(20), k(22), k(23)]
  const boxes = topLevelBoxes(stream)
  const moofs = boxes.filter((b) => b.type === 'moof')

  it('skips a 64-bit largesize mdat and keeps parsing after it', () => {
    expect(boxes.some((b) => b.type === 'mdat' && stream[b.start + 3] === 1)).toBe(true)
    expectTimes(track(stream), expected)
  })

  it('carries a box header split inside its 8 bytes', () => {
    for (const { start } of moofs) {
      for (const cut of [1, 3, 4, 7]) {
        expectTimes(track(stream.subarray(0, start + cut), stream.subarray(start + cut)), expected)
      }
    }
  })

  it('carries a largesize header split between its 8th and 16th byte', () => {
    const large = boxes.find((b) => b.type === 'mdat' && stream[b.start + 3] === 1)!
    for (const cut of [8, 11, 15]) {
      const at = large.start + cut
      expectTimes(track(stream.subarray(0, at), stream.subarray(at)), expected)
    }
  })

  it('carries a moof split mid-trun', () => {
    // The trun is the moof's last box, so the moof's last 20 bytes are inside it.
    for (const { end } of moofs) {
      const at = end - 20
      expectTimes(track(stream.subarray(0, at), stream.subarray(at)), expected)
    }
  })

  it('skips an mdat spanning several chunks', () => {
    const pieces: Uint8Array[] = []
    for (let at = 0; at < stream.byteLength; at += 37) pieces.push(stream.subarray(at, at + 37))
    expectTimes(track(...pieces), expected)
  })

  it('gives the same list for every single split point and for one byte at a time', () => {
    for (let at = 0; at <= stream.byteLength; at++) {
      expectTimes(track(stream.subarray(0, at), stream.subarray(at)), expected)
    }
    const bytes = Array.from({ length: stream.byteLength }, (_, i) => stream.subarray(i, i + 1))
    expectTimes(track(...bytes), expected)
  })
})

describe('fmp4 keyframe tracker — reset and prune', () => {
  it('reset empties the list and drops the carry-over', () => {
    const t = createKeyframeTracker()
    t.reset(0)
    t.push(INIT)
    t.push(fragment([videoTraf(30, true)]))
    const half = fragment([videoTraf(31, true)])
    t.push(half.subarray(0, 40))
    expect(t.keyframes()).toHaveLength(1)

    t.reset(100)
    expect(t.keyframes()).toEqual([])
    t.push(INIT)
    t.push(fragment([videoTraf(0, true)]))
    expectTimes(t.keyframes(), [k(0, 100)])
  })

  it('reset forgets the previous run init segment', () => {
    const t = createKeyframeTracker()
    t.reset(0)
    t.push(INIT)
    t.reset(0)
    t.push(fragment([videoTraf(1, true)]))
    expect(t.keyframes()).toEqual([])
  })

  it('prune drops entries at or below the bound', () => {
    const t = createKeyframeTracker()
    t.reset(0)
    t.push(INIT)
    for (const s of [10, 20, 30]) t.push(fragment([videoTraf(s, true)]))
    t.prune(k(20))
    expectTimes(t.keyframes(), [k(30)])
  })

  it('keeps the list ascending and free of duplicates', () => {
    expectTimes(
      track(
        INIT,
        fragment([videoTraf(40, true)]),
        fragment([videoTraf(30, true)]),
        fragment([videoTraf(40, true)])
      ),
      [k(30), k(40)]
    )
  })
})
