import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createStreamingService } from '../../src/main/streaming'

// Real-ffmpeg check that every H.264 transcode candidate this machine can run
// gives MSE a random-access point at least once a second (#639). The transcode
// forces a keyframe every second, but h264_nvenc and h264_qsv write a forced
// keyframe as a non-IDR intra frame unless told otherwise, and the fMP4 then
// flags only the run's first sample as sync. Chromium drops every video frame
// after a dropped first one, and `SourceBuffer.remove()` extends a removal to
// the next random-access point, so the property is the largest stretch of the
// stream not preceded by a key packet within 1 s + 1 frame.
//
// Each candidate runs only when its own 1-frame dry run (the one
// `pickH264Encoder` gates on, with its `extraInputArgs`) succeeds here. CI's
// pinned ffmpeg has no hardware encoders, so there only libx264 runs.

const hasFfmpeg =
  (spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf-8' }).stdout ?? '').includes(
    'libx264'
  ) && spawnSync('ffprobe', ['-version']).status === 0

const FPS = 30
const DURATION_SECONDS = 3
const MAX_KEY_GAP = 1 + 1 / FPS
const EPSILON = 1e-6

const channels = {
  streamChunk: 'sc',
  streamEnd: 'se',
  streamError: 'sx',
  streamProgress: 'sp'
}

interface VideoPacket {
  pts: number
  key: boolean
}

function readVideoPackets(file: string): VideoPacket[] {
  const out = spawnSync(
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
    { encoding: 'utf-8' }
  ).stdout
  return out
    .trim()
    .split('\n')
    .map((line) => line.split(','))
    .filter((f) => f.length >= 2 && f[0] !== 'N/A')
    .map(([p, flags]) => ({ pts: Number(p), key: flags.includes('K') }))
    .sort((a, b) => a.pts - b.pts)
}

// CI installs ffmpeg for this file; a missing binary there must fail, not skip.
describe.runIf(process.env.CI)('real-ffmpeg prerequisites (#639)', () => {
  it('ffmpeg with libx264 and ffprobe are on PATH', () => {
    expect(hasFfmpeg).toBe(true)
  })
})

describe.skipIf(!hasFfmpeg)('H.264 transcode candidates: a key packet every second (#639)', () => {
  let dir: string

  const svc = createStreamingService({
    getFfmpegPath: () => 'ffmpeg',
    getFfprobePath: () => 'ffprobe',
    channels
  })

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h264-encoder-idr-'))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  for (const choice of svc.h264EncoderCandidates()) {
    it(`${choice.name}: key packets at most 1 s + 1 frame apart through the live fMP4 mux`, async ({
      skip
    }) => {
      if (!(await svc.dryRunEncoder(choice))) {
        // Every build ships libx264, the last-resort fallback; its dry run failing is a failure.
        expect(choice.name).not.toBe('libx264')
        skip()
      }
      const out = path.join(dir, `${choice.name.replace(/[^A-Za-z0-9_]/g, '_')}.mp4`)
      const r = spawnSync(
        'ffmpeg',
        [
          ...['-hide_banner', '-loglevel', 'error', '-y'],
          ...(choice.extraInputArgs ?? []),
          ...['-f', 'lavfi', '-i', `testsrc=duration=${DURATION_SECONDS}:size=320x240:rate=${FPS}`],
          ...choice.videoArgs,
          '-an',
          ...['-avoid_negative_ts', 'make_zero', '-muxpreload', '0', '-muxdelay', '0'],
          ...['-movflags', '+frag_keyframe+empty_moov+default_base_moof+separate_moof'],
          ...['-frag_duration', '1000000', '-f', 'mp4', out]
        ],
        { encoding: 'utf-8' }
      )
      expect(r.status, r.stderr).toBe(0)

      const packets = readVideoPackets(out)
      expect(packets).toHaveLength(DURATION_SECONDS * FPS)
      expect(packets[0].key).toBe(true)
      const keys = packets.filter((p) => p.key).map((p) => p.pts)
      // The stream's last packet closes the final stretch, so a run with one
      // key packet fails here instead of having no gaps to measure.
      const bounds = [...keys, packets[packets.length - 1].pts]
      const gaps = bounds.slice(1).map((t, i) => t - bounds[i])
      expect(
        gaps.filter((g) => g > MAX_KEY_GAP + EPSILON),
        `key packets at ${keys.join(', ')}; last packet at ${bounds[bounds.length - 1]}`
      ).toEqual([])
    }, 30_000)
  }
})
