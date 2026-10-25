import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createStreamingService, type MseSession } from '../../src/main/streaming'

// Real-ffmpeg ground truth for the uncached-seek buffer label. The fake-ffmpeg
// tests in streaming-service.test.ts pin argument shapes but cannot model what
// ffmpeg actually does with them — e.g. an output `-t` next to `-copyts` is
// measured against the *copied* (absolute) timestamps, so past ~60 s into the
// file the absolute-start probe emits zero packets, the offset silently falls
// back to the raw request, and the buffer is labeled up to one GOP late
// (subtitles run ahead of the video after every seek outside the cache).
//
// The fixture mirrors an app-merged file (H.264 with B-frames + AAC + ASS) at
// 64x36 so it builds in about a second. Ground truth is taken from the
// production live mux itself: each output packet is matched back to its
// source packet by content hash, and `source PTS - output PTS` is exactly the
// `timestampOffset` the renderer needs.

const hasFfmpeg =
  (spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf-8' }).stdout ?? '').includes(
    'libx264'
  ) && spawnSync('ffprobe', ['-version']).status === 0

const GOP_SECONDS = 4
const DURATION_SECONDS = 100

const channels = {
  streamChunk: 'sc',
  streamEnd: 'se',
  streamError: 'sx',
  streamProgress: 'sp'
}

interface Packet {
  stream: number
  pts: number
  hash: string
}

function readPackets(file: string): Packet[] {
  const out = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'packet=stream_index,pts_time,data_hash',
      '-show_data_hash',
      'MD5',
      '-of',
      'csv=p=0',
      file
    ],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
  ).stdout
  return out
    .trim()
    .split('\n')
    .map((line) => line.split(','))
    .filter((f) => f.length >= 3 && f[1] !== 'N/A')
    .map(([s, p, h]) => ({ stream: Number(s), pts: Number(p), hash: h }))
}

// CI installs ffmpeg for this file; a missing binary there must fail, not skip.
describe.runIf(process.env.CI)('real-ffmpeg prerequisites', () => {
  it('ffmpeg with libx264 and ffprobe are on PATH', () => {
    expect(hasFfmpeg).toBe(true)
  })
})

describe.skipIf(!hasFfmpeg)('probeSeekAnchor vs the live mux (real ffmpeg, synthetic MKV)', () => {
  let dir: string
  let mkv: string
  let source: Packet[]

  const svc = createStreamingService({
    getFfmpegPath: () => 'ffmpeg',
    getFfprobePath: () => 'ffprobe',
    channels
  })

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-anchor-real-'))
    mkv = path.join(dir, 'merged.mkv')
    const ass = path.join(dir, 'subs.ass')
    fs.writeFileSync(
      ass,
      [
        '[Script Info]',
        'ScriptType: v4.00+',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV',
        'Style: Default,Arial,20,&H00FFFFFF,0,0,2,10,10,10',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Text',
        'Dialogue: 0,0:01:20.00,0:01:25.00,Default,line',
        ''
      ].join('\n')
    )
    const gen = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=64x36:rate=24:duration=${DURATION_SECONDS}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${DURATION_SECONDS}`,
        '-i',
        ass,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '2:s',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-bf',
        '2',
        '-g',
        String(GOP_SECONDS * 24),
        '-keyint_min',
        String(GOP_SECONDS * 24),
        '-sc_threshold',
        '0',
        '-c:a',
        'aac',
        '-b:a',
        '32k',
        '-c:s',
        'ass',
        mkv
      ],
      { encoding: 'utf-8' }
    )
    if (gen.status !== 0) throw new Error(`fixture generation failed: ${gen.stderr}`)
    source = readPackets(mkv)
  }, 60_000)

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  // Runs the production live-mux spawn to completion and returns the buffer
  // offset it actually needs, measured on `stream` (0 = video, 1 = audio).
  async function liveRunOffset(session: MseSession, time: number, stream: number): Promise<number> {
    const event = { sender: { isDestroyed: () => false, send: (): void => {} } }
    const proc = svc.spawnFfmpegForSession(session, event, 'sid', time)
    await new Promise<void>((resolve) => proc.on('close', () => resolve()))
    expect(session.error).toBeNull()
    const out = path.join(dir, `live-${session.transcode ? 'tx' : 'copy'}-${time}.mp4`)
    fs.writeFileSync(out, Buffer.concat(session.prelude))
    // Only the run's first packet of the anchoring stream, and only when its
    // hash is unique in the source: inter-frame hashes repeat on a synthetic
    // pattern, keyframes and AAC packets don't.
    const first = readPackets(out).find((p) => p.stream === stream)
    expect(first).toBeDefined()
    const matches = source.filter((p) => p.stream === stream && p.hash === first!.hash)
    expect(matches).toHaveLength(1)
    return matches[0].pts - first!.pts
  }

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
      mkvPath: mkv,
      generation: 1,
      videoCodec: 'h264',
      transcode,
      audioStrategy: 'copy',
      h264Encoder: transcode ? 'libx264' : null
    }
  }

  // 30.5 s is the control (inside the 60 s window the regression leaves
  // working); 82.5 s is mid-GOP past it — keyframe at 80 s, so a fallback to
  // the raw request mislabels the buffer by ~2.5 s.
  for (const time of [30.5, 82.5]) {
    it(`stream copy: the probed offset matches the live run at ${time}s`, async () => {
      const session = mkSession(false)
      const [probed, truth] = await Promise.all([
        svc.probeSeekAnchor(session, time),
        liveRunOffset(session, time, 0)
      ])
      expect(truth).toBeLessThan(time - 1)
      expect(probed).toBeCloseTo(truth, 2)
    }, 60_000)

    it(`transcode with copied audio: the probed anchor matches the live run at ${time}s`, async () => {
      const session = mkSession(true)
      const [probed, truth] = await Promise.all([
        svc.probeSeekAnchor(session, time),
        liveRunOffset(session, time, 1)
      ])
      expect(truth).toBeLessThan(time - 1)
      expect(probed).toBeCloseTo(truth, 2)
    }, 60_000)
  }
})
