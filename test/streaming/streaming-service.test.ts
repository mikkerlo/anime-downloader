import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  createStreamingService,
  seekAnchorStreamFor,
  type MseSession
} from '../../src/main/streaming'

function mkSession(over: Partial<MseSession> = {}): MseSession {
  const kills: string[] = []
  const proc = {
    kill: (sig: string): boolean => {
      kills.push(sig)
      return true
    }
  } as unknown as ChildProcess
  return {
    proc,
    pendingBytes: 0,
    stderrTail: [],
    done: false,
    error: null,
    senderId: 1,
    ready: false,
    prelude: [],
    mkvPath: '/tmp/show.mkv',
    generation: 1,
    videoCodec: 'h264',
    transcode: false,
    audioStrategy: 'copy',
    h264Encoder: null,
    ...over
  }
}

describe('StreamingService session management', () => {
  const channels = {
    streamChunk: 'sc',
    streamEnd: 'se',
    streamError: 'sx',
    streamProgress: 'sp'
  }

  let svc: ReturnType<typeof createStreamingService>

  beforeEach(() => {
    svc = createStreamingService({
      getFfmpegPath: () => '/bin/ffmpeg',
      getFfprobePath: () => '/bin/ffprobe',
      channels
    })
  })

  it('exposes the backpressure watermarks + tmpDir constants', () => {
    expect(svc.highWatermark).toBe(64 * 1024 * 1024)
    expect(svc.lowWatermark).toBe(16 * 1024 * 1024)
    expect(svc.tmpDir).toMatch(/anime-dl-remux$/)
  })

  it('registerSession + getSession round-trip; getSession returns undefined for unknown ids', () => {
    const s = mkSession()
    svc.registerSession('abc', s)
    expect(svc.getSession('abc')).toBe(s)
    expect(svc.getSession('missing')).toBeUndefined()
  })

  it('allSessionIds reflects current registrations', () => {
    expect(svc.allSessionIds()).toEqual([])
    svc.registerSession('a', mkSession())
    svc.registerSession('b', mkSession())
    expect(svc.allSessionIds().sort()).toEqual(['a', 'b'])
  })

  it('cleanupSession kills the proc with SIGKILL, marks done, and drops the entry', () => {
    const s = mkSession()
    svc.registerSession('a', s)
    svc.cleanupSession('a')
    expect(s.done).toBe(true)
    expect(svc.getSession('a')).toBeUndefined()
    expect((s.proc as unknown as { kill: (sig: string) => boolean }).kill).toBeTruthy()
  })

  it('cleanupSession on unknown id is a no-op', () => {
    expect(() => svc.cleanupSession('missing')).not.toThrow()
  })

  it('cleanupAllSessions drops every registered session', () => {
    svc.registerSession('a', mkSession())
    svc.registerSession('b', mkSession())
    svc.cleanupAllSessions()
    expect(svc.allSessionIds()).toEqual([])
  })
})

describe('StreamingService h264EncoderCandidates', () => {
  const svc = createStreamingService({
    getFfmpegPath: () => '/bin/ffmpeg',
    getFfprobePath: () => '/bin/ffprobe',
    channels: {
      streamChunk: 'sc',
      streamEnd: 'se',
      streamError: 'sx',
      streamProgress: 'sp'
    }
  })

  it('always includes libx264 as the final fallback', () => {
    const candidates = svc.h264EncoderCandidates()
    expect(candidates[candidates.length - 1].name).toBe('libx264')
  })

  it('libx264 args contain the per-second keyframe expression', () => {
    const lx = svc.h264EncoderCandidates().find((c) => c.name === 'libx264')!
    const idx = lx.videoArgs.indexOf('-force_key_frames')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(lx.videoArgs[idx + 1]).toBe('expr:gte(t,n_forced*1)')
  })

  it('candidate list is platform-aware (linux: nvenc + qsv reachable; mac: nvenc-only after vaapi)', () => {
    const names = svc.h264EncoderCandidates().map((c) => c.name)
    expect(names).toContain('h264_nvenc')
    expect(names).toContain('libx264')
    if (process.platform === 'win32' || process.platform === 'linux') {
      expect(names).toContain('h264_qsv')
    } else {
      expect(names).not.toContain('h264_qsv')
    }
  })
})

describe('StreamingService player diagnostics', () => {
  const channels = {
    streamChunk: 'sc',
    streamEnd: 'se',
    streamError: 'sx',
    streamProgress: 'sp'
  }
  const event = {
    sender: { isDestroyed: (): boolean => false, send: (): void => {} }
  }

  function mkSvc(opts: {
    enabled: () => boolean
    sink?: (line: string) => void
  }): ReturnType<typeof createStreamingService> {
    return createStreamingService({
      // `echo` stands in for ffmpeg — spawn succeeds and exits harmlessly, and
      // the diag line is emitted synchronously before the spawn either way.
      getFfmpegPath: () => '/bin/echo',
      getFfprobePath: () => '/bin/ffprobe',
      isPlayerDiagEnabled: opts.enabled,
      playerDiagSink: opts.sink,
      channels
    })
  }

  it('spawnFfmpegForSession sends the spawn args to the diag sink when enabled', () => {
    const lines: string[] = []
    const svc = mkSvc({ enabled: () => true, sink: (l) => lines.push(l) })
    const session = mkSession()
    const proc = svc.spawnFfmpegForSession(session, event, 'sid', 42)
    proc.kill('SIGKILL')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[player\]\[diag\] ffmpeg spawn transcode=false seek=42/)
    expect(lines[0]).toContain('-ss 42')
  })

  it('stays silent when diagnostics are disabled', () => {
    const lines: string[] = []
    const svc = mkSvc({ enabled: () => false, sink: (l) => lines.push(l) })
    const proc = svc.spawnFfmpegForSession(mkSession(), event, 'sid', 42)
    proc.kill('SIGKILL')
    expect(lines).toHaveLength(0)
  })

  it('the enabled check is live — toggling on mid-session logs the next spawn without a rebuild', () => {
    let enabled = false
    const lines: string[] = []
    const svc = mkSvc({ enabled: () => enabled, sink: (l) => lines.push(l) })
    svc.spawnFfmpegForSession(mkSession(), event, 'sid', 10).kill('SIGKILL')
    expect(lines).toHaveLength(0)
    enabled = true
    svc.spawnFfmpegForSession(mkSession(), event, 'sid', 20).kill('SIGKILL')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('seek=20')
  })

  it('a throwing sink never breaks the spawn path', () => {
    const svc = mkSvc({
      enabled: () => true,
      sink: () => {
        throw new Error('disk full')
      }
    })
    expect(() =>
      svc.spawnFfmpegForSession(mkSession(), event, 'sid', 5).kill('SIGKILL')
    ).not.toThrow()
  })
})

describe('StreamingService probeCopyTimestampOffset', () => {
  const channels = {
    streamChunk: 'sc',
    streamEnd: 'se',
    streamError: 'sx',
    streamProgress: 'sp'
  }

  let dir: string
  let argsFile: string
  let ffmpeg: string
  let ffprobe: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'))
    argsFile = path.join(dir, 'ffmpeg-args')
    ffmpeg = path.join(dir, 'ffmpeg')
    ffprobe = path.join(dir, 'ffprobe')
    // Fake ffmpeg records its args; fake ffprobe answers the NUT (absolute
    // start) probe with 198.115 and the fMP4-replica (emitted start) probe
    // with 0.083 — the values measured on the real repro file.
    fs.writeFileSync(ffmpeg, `#!/bin/sh\necho "$@" >> "${argsFile}"\n`, { mode: 0o755 })
    fs.writeFileSync(
      ffprobe,
      '#!/bin/sh\ncase "$*" in\n  *" nut "*) echo 198.115 ;;\n  *" mp4 "*) echo 0.083 ;;\nesac\n',
      { mode: 0o755 }
    )
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function mkSvc(): ReturnType<typeof createStreamingService> {
    return createStreamingService({
      getFfmpegPath: () => ffmpeg,
      getFfprobePath: () => ffprobe,
      channels
    })
  }

  it('returns absolute landing minus emitted start (not the keyframe PTS alone)', async () => {
    const offset = await mkSvc().probeCopyTimestampOffset('/x.mkv', 207, 'hevc')
    // 198.115 (absolute keyframe PTS) - 0.083 (output PTS the live mux emits
    // it at) = 198.032. The pre-fix behavior returned 198.115 — a ~83 ms
    // subtitle-ahead drift.
    expect(offset).toBeCloseTo(198.032, 3)
  })

  it('runs both probes through pipes with the live-mux args (no temp files)', async () => {
    await mkSvc().probeCopyTimestampOffset('/x.mkv', 207, 'hevc')
    const args = fs.readFileSync(argsFile, 'utf-8')
    // Absolute-start probe: raw -ss, both streams mapped, -copyts, NUT to stdout.
    expect(args).toContain('-ss 207')
    expect(args).toContain('-copyts')
    expect(args).toContain('-f nut pipe:1')
    // Emitted-start probe: replicates the live fMP4 mux verbatim.
    expect(args).toContain('-avoid_negative_ts make_zero')
    expect(args).toContain('-movflags +frag_keyframe+empty_moov+default_base_moof+separate_moof')
    expect(args).toContain('-tag:v hvc1')
    expect(args).toContain('-f mp4 pipe:1')
    // Nothing was asked to write to disk.
    expect(args).not.toContain('.nut ')
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.nut'))).toEqual([])
  })

  it('omits the hvc1 tag for H.264 sources', async () => {
    await mkSvc().probeCopyTimestampOffset('/x.mkv', 207, 'h264')
    expect(fs.readFileSync(argsFile, 'utf-8')).not.toContain('-tag:v hvc1')
  })

  it('falls back to the requested time when the probes fail', async () => {
    fs.writeFileSync(ffprobe, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const offset = await mkSvc().probeCopyTimestampOffset('/x.mkv', 207, 'h264')
    expect(offset).toBe(207)
  })

  it('returns 0 for non-positive seek times without spawning anything', async () => {
    const offset = await mkSvc().probeCopyTimestampOffset('/x.mkv', 0, 'h264')
    expect(offset).toBe(0)
    expect(fs.existsSync(argsFile)).toBe(false)
  })
})

describe('StreamingService probeSeekAnchor (transcode audio-copy desync)', () => {
  const channels = {
    streamChunk: 'sc',
    streamEnd: 'se',
    streamError: 'sx',
    streamProgress: 'sp'
  }

  let dir: string
  let argsFile: string
  let ffmpeg: string
  let ffprobe: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-test-'))
    argsFile = path.join(dir, 'ffmpeg-args')
    ffmpeg = path.join(dir, 'ffmpeg')
    ffprobe = path.join(dir, 'ffprobe')
    fs.writeFileSync(ffmpeg, `#!/bin/sh\necho "$@" >> "${argsFile}"\n`, { mode: 0o755 })
    // Values measured on the real repro file for a 207 s seek: the muxed-seek
    // audio landing (198.043) differs from a lone audio-only seek (198.136) —
    // the demuxer positions differently when the video stream is mapped too.
    fs.writeFileSync(
      ffprobe,
      '#!/bin/sh\ncase "$*" in\n  *"a:0"*) echo 198.043 ;;\n  *" nut "*) echo 198.115 ;;\n  *" mp4 "*) echo 0.083 ;;\nesac\n',
      { mode: 0o755 }
    )
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function mkSvc(): ReturnType<typeof createStreamingService> {
    return createStreamingService({
      getFfmpegPath: () => ffmpeg,
      getFfprobePath: () => ffprobe,
      channels
    })
  }

  it('seekAnchorStreamFor maps run type to the anchoring stream', () => {
    expect(seekAnchorStreamFor({ transcode: false, audioStrategy: 'copy' })).toBe('video')
    expect(seekAnchorStreamFor({ transcode: false, audioStrategy: 'transcode' })).toBe('video')
    // Transcode with copied AAC: the untrimmable audio anchors make_zero.
    expect(seekAnchorStreamFor({ transcode: true, audioStrategy: 'copy' })).toBe('audio')
    // Full transcode trims every stream to the exact -ss — no early anchor.
    expect(seekAnchorStreamFor({ transcode: true, audioStrategy: 'transcode' })).toBeNull()
  })

  it('full transcode returns the raw request without spawning probes', async () => {
    const anchor = await mkSvc().probeSeekAnchor(
      { mkvPath: '/x.mkv', transcode: true, audioStrategy: 'transcode', videoCodec: 'hevc' },
      207
    )
    expect(anchor).toBe(207)
    expect(fs.existsSync(argsFile)).toBe(false)
  })

  it('stream copy delegates to the full offset measurement', async () => {
    const anchor = await mkSvc().probeSeekAnchor(
      { mkvPath: '/x.mkv', transcode: false, audioStrategy: 'copy', videoCodec: 'hevc' },
      207
    )
    expect(anchor).toBeCloseTo(198.032, 3) // 198.115 - 0.083
  })

  it('transcode-with-copied-audio probes the audio landing in the muxed demux context (old behavior returned the raw request)', async () => {
    const anchor = await mkSvc().probeSeekAnchor(
      { mkvPath: '/x.mkv', transcode: true, audioStrategy: 'copy', videoCodec: 'hevc' },
      207
    )
    expect(anchor).toBeCloseTo(198.043, 3)
    const args = fs.readFileSync(argsFile, 'utf-8')
    // Muxed context: BOTH streams mapped (a lone audio map seeks differently),
    // absolute timestamps preserved, one packet per stream, piped.
    expect(args).toContain('-map 0:v:0')
    expect(args).toContain('-map 0:a:0?')
    expect(args).toContain('-copyts')
    expect(args).toContain('-frames:a 1')
    expect(args).toContain('-f nut pipe:1')
  })

  it('non-positive times return 0 without probing', async () => {
    const anchor = await mkSvc().probeSeekAnchor(
      { mkvPath: '/x.mkv', transcode: true, audioStrategy: 'copy', videoCodec: 'h264' },
      0
    )
    expect(anchor).toBe(0)
    expect(fs.existsSync(argsFile)).toBe(false)
  })
})
