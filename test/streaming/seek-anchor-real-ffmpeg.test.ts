import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { ipcMain } from 'electron'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createStreamingService, type MseSession } from '../../src/main/streaming'
import { register } from '../../src/main/ipc/player.ipc'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import type { AppDeps } from '../../src/main/ipc'

// Real-ffmpeg ground truth for the uncached-seek buffer label. The fake-ffmpeg
// tests in streaming-service.test.ts pin argument shapes but cannot model what
// ffmpeg actually does with them — e.g. an output `-t` next to `-copyts` is
// measured against the *copied* (absolute) timestamps, so past ~60 s into the
// file the absolute-start probe emits zero packets, the offset silently falls
// back to the raw request, and the buffer is labeled up to one GOP late
// (subtitles run ahead of the video after every seek outside the cache).
//
// The fixture mirrors an app-merged file (H.264 with B-frames + AAC + ASS) at
// 192x48 so it builds in about a second. Its top band is the frame number in
// binary, so a transcoded frame can be traced back to its source frame. The
// second fixture is the same file with every video DTS moved 0.3 s earlier,
// which makes the copied audio land before each keyframe (#560).
//
// Ground truth is taken from the production live mux itself: `source PTS -
// output PTS` is exactly the `timestampOffset` the renderer needs. It is read
// over packets 2..81 of each track, never the first: the mux stores the gap
// between the tracks' starts in the first sample of whichever track starts
// later, so that sample alone reads differently. Copied packets are matched by
// MD5 (unique hashes only); transcoded video by the frame number it shows.

const hasFfmpeg =
  (spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf-8' }).stdout ?? '').includes(
    'libx264'
  ) && spawnSync('ffprobe', ['-version']).status === 0

const FPS = 24
const ONE_FRAME = 1 / FPS
const GOP_SECONDS = 4
const DURATION_SECONDS = 100
const CODE_BITS = 12
const BLOCK = 16
const WIDTH = CODE_BITS * BLOCK
// Height of the code band; the picture is three bands tall.
const HEIGHT = 16
const LATER_SAMPLES = 80

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

// The frame number each decoded frame shows, with its PTS, in presentation
// order. `-fps_mode passthrough` keeps one output frame per decoded frame: by
// default ffmpeg duplicates the stretched first frame, and frames 2–6 would all
// read as frame 1.
function readFrameCodes(file: string): { pts: number; code: number }[] {
  const times = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'frame=pts_time',
      '-of',
      'csv=p=0',
      file
    ],
    { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }
  )
    .stdout.trim()
    .split('\n')
    .map((line) => Number(line.split(',')[0]))
  const raw = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-fps_mode',
      'passthrough',
      '-vf',
      `crop=${WIDTH}:${HEIGHT}:0:0`,
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { maxBuffer: 256 * 1024 * 1024 }
  ).stdout
  const size = WIDTH * HEIGHT
  const frames: { pts: number; code: number }[] = []
  for (let f = 0; f * size + size <= raw.length && f < times.length; f++) {
    let code = 0
    for (let bit = 0; bit < CODE_BITS; bit++) {
      let sum = 0
      for (let y = 4; y < 12; y++) {
        for (let x = bit * BLOCK + 4; x < bit * BLOCK + 12; x++)
          sum += raw[f * size + y * WIDTH + x]
      }
      code = (code << 1) | (sum / 64 >= 128 ? 1 : 0)
    }
    frames.push({ pts: times[f], code })
  }
  return frames
}

interface Fixture {
  mkv: string
  packets: Packet[]
  framePts: Map<number, number>
}

function loadFixture(mkv: string): Fixture {
  const framePts = new Map<number, number>()
  for (const { pts, code } of readFrameCodes(mkv)) framePts.set(code, pts)
  return { mkv, packets: readPackets(mkv), framePts }
}

// CI installs ffmpeg for this file; a missing binary there must fail, not skip.
describe.runIf(process.env.CI)('real-ffmpeg prerequisites', () => {
  it('ffmpeg with libx264 and ffprobe are on PATH', () => {
    expect(hasFfmpeg).toBe(true)
  })
})

describe.skipIf(!hasFfmpeg)('probeSeekAnchor vs the live mux (real ffmpeg, synthetic MKV)', () => {
  let dir: string
  let base: Fixture
  let shifted: Fixture

  const svc = createStreamingService({
    getFfmpegPath: () => 'ffmpeg',
    getFfprobePath: () => 'ffprobe',
    channels
  })

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-anchor-real-'))
    const baseMkv = path.join(dir, 'merged.mkv')
    const shiftedMkv = path.join(dir, 'audio-earliest.mkv')
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
    // The code band: block x of the CODE_BITS x 1 source is bit
    // (CODE_BITS - 1 - x) of the frame number N, upscaled without filtering.
    // The moving testsrc2 below it keeps the copied inter frames' MD5s unique.
    const bit = `mod(floor(N/pow(2,${CODE_BITS - 1}-X)),2)`
    const gen = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${WIDTH}x${HEIGHT * 3}:rate=${FPS}:duration=${DURATION_SECONDS}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${DURATION_SECONDS}`,
        '-i',
        ass,
        '-filter_complex',
        `color=c=black:s=${CODE_BITS}x1:r=${FPS}:d=${DURATION_SECONDS},format=yuv444p,` +
          `geq=lum='16+219*${bit}':cb=128:cr=128,` +
          `scale=${WIDTH}:${HEIGHT}:flags=neighbor,format=yuv420p[code];` +
          `[0:v][code]overlay=0:0:shortest=1[v]`,
        '-map',
        '[v]',
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
        String(GOP_SECONDS * FPS),
        '-keyint_min',
        String(GOP_SECONDS * FPS),
        '-sc_threshold',
        '0',
        '-c:a',
        'aac',
        '-b:a',
        '32k',
        '-c:s',
        'ass',
        baseMkv
      ],
      { encoding: 'utf-8' }
    )
    if (gen.status !== 0) throw new Error(`fixture generation failed: ${gen.stderr}`)
    // Moving every video DTS 0.3 s earlier makes the remux interleave the
    // audio ~0.37 s ahead of each keyframe: the audio-earliest layout real
    // merged files show on some seeks (#560). `pts=PTS` is spelled out because
    // ffmpeg 6.1's setts otherwise rewrites PTS to decode order, and the
    // B-frames would show out of order. The audio moves 0.1 s later so that it
    // starts after the first keyframe: the NUT probe then reads it shifted in
    // the first GOP (0.162 for 0.100), which only the file's own first packets
    // get right.
    const remux = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-i',
        baseMkv,
        '-map',
        '0',
        '-c',
        'copy',
        '-bsf:v',
        'setts=dts=DTS-0.3/TB:pts=PTS',
        '-bsf:a',
        'setts=pts=PTS+0.1/TB:dts=DTS+0.1/TB',
        shiftedMkv
      ],
      { encoding: 'utf-8' }
    )
    if (remux.status !== 0) throw new Error(`setts remux failed: ${remux.stderr}`)
    base = loadFixture(baseMkv)
    shifted = loadFixture(shiftedMkv)
  }, 60_000)

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  function spread(values: number[]): number {
    return Math.max(...values) - Math.min(...values)
  }

  function mean(values: number[]): number {
    return values.reduce((a, b) => a + b, 0) / values.length
  }

  // `source PTS - output PTS` over packets 2..81 of `stream`, unique MD5s only.
  function copiedTruth(fixture: Fixture, out: Packet[], stream: number): number[] {
    const byHash = new Map<string, number[]>()
    for (const p of fixture.packets) {
      if (p.stream !== stream) continue
      byHash.set(p.hash, [...(byHash.get(p.hash) ?? []), p.pts])
    }
    const offsets: number[] = []
    for (const p of out.filter((q) => q.stream === stream).slice(1, LATER_SAMPLES + 1)) {
      const src = byHash.get(p.hash)
      if (src?.length === 1) offsets.push(src[0] - p.pts)
    }
    return offsets
  }

  // The same over decoded frames 2..81, traced back by the frame number shown.
  function decodedVideoTruth(fixture: Fixture, outFile: string): number[] {
    const offsets: number[] = []
    for (const { pts, code } of readFrameCodes(outFile).slice(1, LATER_SAMPLES + 1)) {
      const src = fixture.framePts.get(code)
      if (src !== undefined) offsets.push(src - pts)
    }
    return offsets
  }

  interface LiveTruth {
    video: number[]
    audio: number[]
  }

  // Waits for the production live mux of `session` to finish (`done` is set
  // once its stdout has ended and the last batch is in the prelude) and returns
  // the per-sample offsets of both tracks (0 = video, 1 = audio in the output).
  async function liveTruth(
    fixture: Fixture,
    session: MseSession,
    label: string
  ): Promise<LiveTruth> {
    while (!session.done) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(session.error).toBeNull()
    const out = path.join(dir, `live-${label}.mp4`)
    fs.writeFileSync(out, Buffer.concat(session.prelude))
    const packets = readPackets(out)
    return {
      video: session.transcode ? decodedVideoTruth(fixture, out) : copiedTruth(fixture, packets, 0),
      audio: copiedTruth(fixture, packets, 1)
    }
  }

  // Both tracks of the live run share one timeline from sample 2 on. Copy
  // asserts that by MD5 on both (spread < 2 ms); transcode by MD5 on the audio
  // and by frame number on the video, which is only good to a frame.
  function assertMatches(probed: number, truth: LiveTruth, transcode: boolean): number {
    expect(truth.audio.length).toBeGreaterThanOrEqual(20)
    expect(truth.video.length).toBeGreaterThanOrEqual(20)
    expect(spread(transcode ? truth.audio : [...truth.video, ...truth.audio])).toBeLessThan(0.002)
    const zero = mean(truth.audio)
    const report = `probed ${probed.toFixed(3)}, live ${zero.toFixed(3)}`
    expect(Math.abs(probed - zero), report).toBeLessThanOrEqual(ONE_FRAME)
    if (transcode) {
      for (const video of truth.video) {
        expect(Math.abs(probed - video), report).toBeLessThanOrEqual(ONE_FRAME)
      }
    }
    return zero
  }

  function mkSession(mkv: string, transcode: boolean): MseSession {
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

  async function measure(
    fixture: Fixture,
    transcode: boolean,
    time: number
  ): Promise<{ probed: number; truth: LiveTruth }> {
    const session = mkSession(fixture.mkv, transcode)
    const event = { sender: { isDestroyed: () => false, send: (): void => {} } }
    session.proc = svc.spawnFfmpegForSession(session, event, 'sid', time)
    const label = `${path.basename(fixture.mkv, '.mkv')}-${transcode ? 'tx' : 'copy'}-${time}`
    const [probed, truth] = await Promise.all([
      svc.probeSeekAnchor(session, time),
      liveTruth(fixture, session, label)
    ])
    return { probed, truth }
  }

  const fixtures = (): Record<'base' | 'shifted', Fixture> => ({ base, shifted })

  // base: 30.5 s is the control (inside the 60 s window #556 left working) and
  // 82.5 s is mid-GOP past it — keyframe at 80 s, so a fallback to the raw
  // request mislabels the buffer by ~2.5 s. 2.0 s is inside the first GOP,
  // where the B-frame delay puts the copy zero below 0. Transcode at 20.2 s
  // lands its audio after the request: the video is earliest and the anchor
  // must stay the request (the copied-audio guard).
  //
  // shifted: the audio lands ~0.38 s before every keyframe, so the copy zero is
  // the audio landing (the video's own zero is ~0.3 s late). At 0 and 2.0 s
  // the run lands on the first keyframe, where only the file's own first
  // packets give both starts (the NUT probe reads them shifted).
  const cases: { fixture: 'base' | 'shifted'; transcode: boolean; time: number }[] = [
    ...[2.0, 30.5, 82.5].map((time) => ({ fixture: 'base' as const, transcode: false, time })),
    ...[20.2, 30.5, 82.5].map((time) => ({ fixture: 'base' as const, transcode: true, time })),
    ...[0, 2.0, 20.2, 30.5, 70.5, 82.5].flatMap((time) => [
      { fixture: 'shifted' as const, transcode: false, time },
      { fixture: 'shifted' as const, transcode: true, time }
    ])
  ]

  for (const { fixture, transcode, time } of cases) {
    const mode = transcode ? 'transcode with copied audio' : 'stream copy'
    it(`${fixture}, ${mode}: the probed anchor matches the live run at ${time}s`, async () => {
      const { probed, truth } = await measure(fixtures()[fixture], transcode, time)
      const zero = assertMatches(probed, truth, transcode)
      // A run starts at or before the request, except an open at 0 whose first
      // frame is a little after it.
      expect(zero).toBeLessThanOrEqual(time + ONE_FRAME)
    }, 60_000)
  }

  // The open at T = 0 goes through the copy handler, which used to skip the
  // probe there and reply 0; the B-frame delay makes the true zero -0.083.
  describe('the copy open at T = 0 (player:remux-mkv-stream)', () => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown
    let handlers: Map<string, Handler>

    beforeAll(() => {
      const deps = {
        store: new InMemoryStorage({ hevcTranscodeOnPlay: 'ask' }),
        streamingService: svc,
        smotretApi: {},
        coldStorageService: {},
        mp4StatsService: {},
        // An empty ffprobe path skips the embedded-subtitle extraction, so
        // nothing is written to the shared remux tmpdir.
        getFfmpegPath: () => 'ffmpeg',
        getFfprobePath: () => ''
      } as unknown as AppDeps
      ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
      register(deps)
      handlers = new Map(
        (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
      )
    })

    for (const fixture of ['base', 'shifted'] as const) {
      it(`${fixture}: contentStart matches the live run`, async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const event = { sender: { id: 1, isDestroyed: () => false, send: (): void => {} } }
        const res = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(
          event,
          fixtures()[fixture].mkv,
          0
        )) as { sessionId: string; contentStart: number }
        vi.restoreAllMocks()
        const session = svc.getSession(res.sessionId)!
        expect(session).toBeDefined()
        try {
          const truth = await liveTruth(fixtures()[fixture], session, `${fixture}-open`)
          // The B-frame delay puts the zero below 0, which main's old reply of 0
          // missed by more than a frame.
          expect(assertMatches(res.contentStart, truth, false)).toBeLessThan(-ONE_FRAME)
        } finally {
          svc.cleanupSession(res.sessionId)
        }
      }, 60_000)
    }
  })
})
