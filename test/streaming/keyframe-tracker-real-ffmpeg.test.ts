import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createStreamingService, type MseSession } from '../../src/main/streaming'
import { createKeyframeTracker } from '../../src/renderer/src/composables/fmp4-keyframe-tracker'

// Real-ffmpeg ground truth for the renderer's keyframe tracker (#653). The
// production live mux (`spawnFfmpegForSession`, copy and libx264 transcode) is
// run on a long-GOP file, its stdout batches are fed through the tracker with
// the `timestampOffset` main probes for the run, and the result is checked
// against ffprobe's keyframe list for the same output: one entry per keyframe,
// none extra, and every entry strictly below where the SourceBuffer labels that
// keyframe (output PTS + offset). An entry at or above it would let a removal
// ending there take the keyframe's whole GOP.
//
// The transcode case is the one that needs the subtracted frame: libx264
// `ultrafast` emits no composition offsets, so `tfdt` equals the PTS there.

const hasFfmpeg =
  (spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf-8' }).stdout ?? '').includes(
    'libx264'
  ) && spawnSync('ffprobe', ['-version']).status === 0

const FPS = 24
const ONE_FRAME = 1 / FPS
const DURATION_SECONDS = 200
// Every 10 s, except the 120 s gap from 30 to 150.
const SOURCE_KEYFRAMES = [0, 10, 20, 30, 150, 160, 170, 180, 190]

const channels = { streamChunk: 'sc', streamEnd: 'se', streamError: 'sx', streamProgress: 'sp' }

function keyframePts(file: string): number[] {
  return spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,flags',
      '-of',
      'csv=p=0',
      file
    ],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
  )
    .stdout.trim()
    .split('\n')
    .map((line) => line.split(','))
    .filter(([, flags]) => flags?.startsWith('K'))
    .map(([pts]) => Number(pts))
    .sort((a, b) => a - b)
}

describe.runIf(process.env.CI)('real-ffmpeg prerequisites (keyframe tracker)', () => {
  it('ffmpeg with libx264 and ffprobe are on PATH', () => {
    expect(hasFfmpeg).toBe(true)
  })
})

describe.skipIf(!hasFfmpeg)('keyframe tracker vs the live mux (real ffmpeg, long GOP)', () => {
  let dir: string
  let mkv: string

  const svc = createStreamingService({
    getFfmpegPath: () => 'ffmpeg',
    getFfprobePath: () => 'ffprobe',
    channels
  })

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyframe-tracker-real-'))
    mkv = path.join(dir, 'long-gop.mkv')
    const gen = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=192x108:rate=${FPS}:duration=${DURATION_SECONDS}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${DURATION_SECONDS}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-g',
        '100000',
        '-keyint_min',
        '100000',
        '-sc_threshold',
        '0',
        '-force_key_frames',
        SOURCE_KEYFRAMES.join(','),
        '-c:a',
        'aac',
        '-b:a',
        '32k',
        mkv
      ],
      { encoding: 'utf-8' }
    )
    if (gen.status !== 0) throw new Error(`fixture generation failed: ${gen.stderr}`)
    expect(keyframePts(mkv)).toEqual(SOURCE_KEYFRAMES)
  }, 60_000)

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  function mkSession(transcode: boolean): MseSession {
    return {
      proc: null as unknown as MseSession['proc'],
      pendingBytes: 0,
      stderrTail: [],
      done: false,
      error: null,
      senderId: 1,
      ready: false,
      prelude: [],
      endPending: false,
      mkvPath: mkv,
      generation: 1,
      videoCodec: 'h264',
      transcode,
      audioStrategy: 'copy',
      h264Encoder: transcode ? 'libx264' : null
    }
  }

  interface Run {
    offset: number
    /** What the tracker recorded from the run's stdout batches, in order. */
    recorded: readonly number[]
    /** Where the SourceBuffer labels each keyframe: output PTS + offset. */
    labelled: number[]
    batches: number
  }

  async function run(transcode: boolean, time: number): Promise<Run> {
    const session = mkSession(transcode)
    const event = { sender: { isDestroyed: () => false, send: (): void => {} } }
    session.proc = svc.spawnFfmpegForSession(session, event, 'sid', time)
    const offset = await svc.probeSeekAnchor(session, time)
    while (!session.done) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(session.error).toBeNull()
    const tracker = createKeyframeTracker()
    tracker.reset(offset)
    for (const batch of session.prelude) tracker.push(new Uint8Array(batch))
    const out = path.join(dir, `live-${transcode ? 'tx' : 'copy'}-${time}.mp4`)
    fs.writeFileSync(out, Buffer.concat(session.prelude))
    return {
      offset,
      recorded: tracker.keyframes(),
      labelled: keyframePts(out).map((pts) => pts + offset),
      batches: session.prelude.length
    }
  }

  // `looseFirst`: a transcode seek whose copied audio anchors the zero up to a
  // GOP early (here 30 s for a seek to 100) emits its first video sample at
  // decode time 0 with a composition offset across that gap, so its entry sits
  // far below it. Still below, which is all safety needs, and that entry is the
  // buffer's own start, never a removal end.
  function assertBelowEveryKeyframe({ recorded, labelled }: Run, looseFirst = false): void {
    expect(recorded).toHaveLength(labelled.length)
    recorded.forEach((k, i) => {
      const report = `keyframe ${i}: recorded ${k.toFixed(6)}, labelled ${labelled[i].toFixed(6)}`
      expect(k, report).toBeLessThanOrEqual(labelled[i])
      // Strictly below by at least half a frame, whatever the rounding.
      expect(labelled[i] - k, report).toBeGreaterThanOrEqual(ONE_FRAME / 2)
      // And close enough to be this keyframe, not some earlier point.
      if (!(looseFirst && i === 0)) expect(labelled[i] - k, report).toBeLessThan(4 * ONE_FRAME)
    })
  }

  it('stream copy from 0: one entry per source keyframe, each below it', async () => {
    const r = await run(false, 0)
    expect(r.batches).toBeGreaterThan(1)
    assertBelowEveryKeyframe(r)
    r.labelled.forEach((t, i) => expect(t).toBeCloseTo(SOURCE_KEYFRAMES[i], 2))
  }, 60_000)

  it('stream copy seeked into the gap lands on its opening keyframe, with the same guarantee', async () => {
    const r = await run(false, 100)
    // The run lands on the keyframe at 30, emitted at 0.083 (two B-frame delays).
    expect(r.offset).toBeCloseTo(30 - 2 * ONE_FRAME, 3)
    assertBelowEveryKeyframe(r)
    expect(r.labelled.map((t) => Math.round(t))).toEqual(SOURCE_KEYFRAMES.filter((k) => k >= 30))
    // The first entry is in the gap's own GOP: the eviction's only end before 150.
    expect(r.recorded[0]).toBeLessThan(30)
    expect(r.recorded[1]).toBeLessThan(150)
    expect(r.recorded[1]).toBeGreaterThan(149.8)
  }, 60_000)

  for (const time of [0, 100]) {
    it(`libx264 transcode at ${time}s: tfdt equals PTS there, and every entry is still below its keyframe`, async () => {
      const r = await run(true, time)
      // The transcode forces a keyframe every second.
      expect(r.labelled.length).toBeGreaterThan((DURATION_SECONDS - time) * 0.9)
      assertBelowEveryKeyframe(r, time > 0)
    }, 60_000)
  }
})
