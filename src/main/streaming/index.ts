import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile, spawn, type ChildProcess } from 'child_process'
import Ffmpeg from 'fluent-ffmpeg'
import { avcCodecString, hevcCodecString, aacCodecString } from './codec-strings'

export interface MseOpenResult {
  sessionId: string
  generation: number
  duration: number
  mimeType: string
  hasSubtitlesPending: boolean
  initialSeek: number
}

export interface MseSession {
  proc: ChildProcess
  pendingBytes: number
  stderrTail: string[]
  done: boolean
  error: string | null
  senderId: number
  ready: boolean
  prelude: Buffer[]
  mkvPath: string
  generation: number
  videoCodec: 'h264' | 'hevc'
  transcode: boolean
  audioStrategy: 'copy' | 'transcode'
  h264Encoder: string | null
}

export interface MkvProbeResult {
  duration: number
  videoCodec: 'h264' | 'hevc'
  audioCodecName: string
  audioStrategy: 'copy' | 'transcode'
  streamCopyMimeType: string | null
  /**
   * Set when the source audio is AAC — carries the precise AAC object-type
   * codec string (e.g. mp4a.40.2, mp4a.40.5) for HE-AAC/HE-AACv2 variants.
   */
  audioCodecString: string | null
}

export interface H264EncoderChoice {
  name: string
  videoArgs: string[]
  extraInputArgs?: string[]
}

/**
 * Structural boundary for the `event.sender` channel of an
 * `Electron.IpcMainInvokeEvent`. Keeping it ambient avoids importing
 * `electron` into this module so it stays unit-testable without the
 * electron-mock plumbing.
 */
export interface StreamingIpcSender {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}
export interface StreamingIpcEvent {
  sender: StreamingIpcSender
}

export interface StreamingServiceDeps {
  /**
   * Live getter for the ffmpeg binary path. `ffmpegPath` in `index.ts` mutates
   * at runtime (post-bootstrap), so a closure-cached value would race the
   * auto-download on first launch.
   */
  getFfmpegPath: () => string
  /** Live getter; same reasoning as `getFfmpegPath`. */
  getFfprobePath: () => string
  /**
   * Live check for verbose player diagnostics. Main wires this to the
   * `playerDiagLogging` setting (Settings → Debug) so the toggle applies
   * without a restart. Falls back to the `ANIME_DL_PLAYER_DIAG=1` env
   * override when absent.
   */
  isPlayerDiagEnabled?: () => boolean
  /**
   * Extra sink for diag lines (they always go to the console too). Main wires
   * a `player-diag.log` appender under `userData` so packaged builds — where
   * the main-process console is invisible — can still retrieve the log.
   */
  playerDiagSink?: (line: string) => void
  channels: {
    streamChunk: string
    streamEnd: string
    streamError: string
    streamProgress: string
  }
}

/** Backpressure watermarks — exported so cancel/seek paths in `index.ts` can use them. */
export const STREAM_BACKPRESSURE_HIGH_WATERMARK = 64 * 1024 * 1024
export const STREAM_BACKPRESSURE_LOW_WATERMARK = 16 * 1024 * 1024

/**
 * Env override for verbose player diagnostics (set `ANIME_DL_PLAYER_DIAG=1`).
 * The runtime toggle lives in Settings → Debug (`playerDiagLogging`, checked
 * live via `StreamingServiceDeps.isPlayerDiagEnabled`); this constant is the
 * fallback when no dep is wired. Logs the exact ffmpeg spawn args and the
 * probed input-seek landing vs the requested timestamp, so a desync can be
 * traced to the ffmpeg layer without a rebuild. Off by default.
 */
export const PLAYER_DIAG = process.env.ANIME_DL_PLAYER_DIAG === '1'

/** Filename of the diag log under `userData`; shared with the Debug-tab IPC. */
export const PLAYER_DIAG_LOG_FILENAME = 'player-diag.log'

export interface StreamingService {
  /** Shared tmpdir for transient remux/transcode output. */
  readonly tmpDir: string
  readonly highWatermark: number
  readonly lowWatermark: number

  /** Probe a `.mkv` and return the MSE-compatible MIME + strategy info, or `null` if unsupported. */
  probeMkvForMse(mkvPath: string): Promise<MkvProbeResult | null>
  /**
   * Ground-truth `sourceBuffer.timestampOffset` for a stream-copy `-ss time` run:
   * the absolute file time that the run's MSE timeline zero corresponds to.
   * Measured, not modeled — two concurrent piped ffmpeg|ffprobe probes replicate
   * (a) the input seek with `-copyts` (absolute PTS of the landing keyframe) and
   * (b) the exact live fMP4 mux (the output PTS that keyframe is emitted at,
   * i.e. what the renderer's buffered range will show). Offset = (a) − (b).
   * A keyframe-PTS-only probe is off by the mux's zeroing shift (B-frame
   * reorder + `-avoid_negative_ts make_zero` anchoring on the earliest DTS
   * across streams) — a sub-second subtitle drift.
   */
  probeCopyTimestampOffset(
    filePath: string,
    time: number,
    videoCodec: 'h264' | 'hevc'
  ): Promise<number>
  /** Cached H.264 encoder pick (vaapi → nvenc → qsv → libx264, dry-run-gated). */
  pickH264Encoder(): Promise<H264EncoderChoice>
  /** The full candidate list `pickH264Encoder` walks; exposed for tests + transcode arg assembly. */
  h264EncoderCandidates(): H264EncoderChoice[]
  /**
   * Spawn ffmpeg for one stream session and wire stdout/stderr to the renderer
   * via the four configured event channels. Behavior is verbatim from the
   * pre-extraction `index.ts` implementation.
   */
  spawnFfmpegForSession(
    session: MseSession,
    event: StreamingIpcEvent,
    sessionId: string,
    seekSeconds: number
  ): ChildProcess

  registerSession(sessionId: string, session: MseSession): void
  getSession(sessionId: string): MseSession | undefined
  allSessionIds(): string[]
  /** Kill ffmpeg, mark done, and drop the session from the map. */
  cleanupSession(sessionId: string): void
  cleanupAllSessions(): void
}

export function createStreamingService(deps: StreamingServiceDeps): StreamingService {
  const { getFfmpegPath, getFfprobePath, channels } = deps

  const tmpDir = path.join(os.tmpdir(), 'anime-dl-remux')
  const sessions = new Map<string, MseSession>()
  let cachedH264Encoder: string | null | undefined = undefined

  function diagEnabled(): boolean {
    return deps.isPlayerDiagEnabled ? deps.isPlayerDiagEnabled() : PLAYER_DIAG
  }

  function diag(line: string): void {
    const msg = `[player][diag] ${line}`
    console.log(msg)
    try {
      deps.playerDiagSink?.(msg)
    } catch {
      /* a broken sink must never take down the stream path */
    }
  }

  function listVaapiRenderNodes(): string[] {
    // Common default is /dev/dri/renderD128, but multi-GPU systems expose
    // renderD129, renderD130, ... The right one for hardware H.264 encode isn't
    // knowable without probing, so enumerate all of them and let pickH264Encoder
    // dry-run each in order.
    try {
      const entries = fs.readdirSync('/dev/dri')
      return entries
        .filter((n) => /^renderD\d+$/.test(n))
        .sort()
        .map((n) => `/dev/dri/${n}`)
    } catch {
      return []
    }
  }

  function h264EncoderCandidates(): H264EncoderChoice[] {
    // Force a keyframe every second via a time-based expression so fragments
    // emitted with `+frag_keyframe` land every ~1 s instead of waiting for the
    // encoder's default ~10 s GOP. Without this, the first post-seek fragment
    // takes many seconds to appear and the MSE buffer stays empty.
    const keyframeEverySecond = ['-force_key_frames', 'expr:gte(t,n_forced*1)']
    const candidates: H264EncoderChoice[] = []
    if (process.platform === 'linux') {
      for (const node of listVaapiRenderNodes()) {
        candidates.push({
          name: `h264_vaapi(${node})`,
          extraInputArgs: ['-init_hw_device', `vaapi=va:${node}`, '-filter_hw_device', 'va'],
          videoArgs: [
            '-vf',
            'format=nv12,hwupload',
            '-c:v',
            'h264_vaapi',
            '-profile:v',
            'high',
            '-level',
            '40',
            ...keyframeEverySecond
          ]
        })
      }
    }
    candidates.push({
      name: 'h264_nvenc',
      videoArgs: [
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p1',
        '-tune',
        'll',
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'high',
        '-level',
        '4.0',
        ...keyframeEverySecond
      ]
    })
    if (process.platform === 'win32' || process.platform === 'linux') {
      candidates.push({
        name: 'h264_qsv',
        videoArgs: [
          '-c:v',
          'h264_qsv',
          '-preset',
          'veryfast',
          '-pix_fmt',
          'nv12',
          '-profile:v',
          'high',
          '-level',
          '4.0',
          ...keyframeEverySecond
        ]
      })
    }
    candidates.push({
      // No `-tune zerolatency`: it forces slice-threads only and disables frame-threading,
      // which roughly halves libx264's throughput. `-threads 0` lets x264 auto-pick.
      name: 'libx264',
      videoArgs: [
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-threads',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'high',
        '-level',
        '4.0',
        ...keyframeEverySecond
      ]
    })
    return candidates
  }

  function dryRunEncoder(choice: H264EncoderChoice): Promise<boolean> {
    return new Promise((resolve) => {
      const ffmpegPath = getFfmpegPath()
      if (!ffmpegPath) return resolve(false)
      const args: string[] = []
      if (choice.extraInputArgs) args.push(...choice.extraInputArgs)
      args.push('-f', 'lavfi', '-i', 'testsrc=duration=0.1:size=320x240:rate=30', '-frames:v', '1')
      args.push(...choice.videoArgs)
      args.push('-an', '-f', 'null', '-')
      try {
        execFile(ffmpegPath, args, { timeout: 5000 }, (err) => resolve(!err))
      } catch {
        resolve(false)
      }
    })
  }

  async function pickH264Encoder(): Promise<H264EncoderChoice> {
    const candidates = h264EncoderCandidates()
    if (cachedH264Encoder !== undefined) {
      const hit = candidates.find((c) => c.name === cachedH264Encoder)
      if (hit) return hit
    }
    for (const c of candidates) {
      const ok = await dryRunEncoder(c)
      if (ok) {
        cachedH264Encoder = c.name
        console.log(`[remux-stream] picked H.264 encoder: ${c.name}`)
        return c
      }
    }
    // libx264 should always work but if even that fails, still return it so the spawn surfaces a real error later.
    cachedH264Encoder = 'libx264'
    return candidates[candidates.length - 1]
  }

  // Spawn `ffmpeg <ffmpegArgs> pipe:1 | ffprobe <ffprobeArgs> pipe:0` and resolve
  // with the first line ffprobe prints (or '' on failure). Both processes are
  // SIGKILLed as soon as that line arrives, so a probe never runs past the
  // first packet and nothing touches disk.
  function readFirstProbeLine(ffmpegArgs: string[], ffprobeArgs: string[]): Promise<string> {
    const ffmpegPath = getFfmpegPath()
    const ffprobePath = getFfprobePath()
    return new Promise<string>((resolve) => {
      let settled = false
      let enc: ChildProcess | null = null
      let probe: ChildProcess | null = null
      const done = (v: string): void => {
        if (settled) return
        settled = true
        try {
          enc?.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        try {
          probe?.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve(v)
      }
      enc = spawn(ffmpegPath, ffmpegArgs, { stdio: ['ignore', 'pipe', 'ignore'] })
      probe = spawn(ffprobePath, ffprobeArgs, { stdio: ['pipe', 'pipe', 'ignore'] })
      enc.on('error', () => done(''))
      probe.on('error', () => done(''))
      // EPIPE is expected when ffprobe exits after the first packet while
      // ffmpeg is still writing — swallow it instead of crashing the process.
      enc.stdout?.on('error', () => {})
      probe.stdin?.on('error', () => {})
      if (enc.stdout && probe.stdin) enc.stdout.pipe(probe.stdin)
      let buf = ''
      probe.stdout?.on('data', (d: Buffer) => {
        buf += d.toString()
        const nl = buf.indexOf('\n')
        if (nl !== -1) done(buf.slice(0, nl).trim())
      })
      // 'close' (not 'exit') — exit can fire before stdout's last data event
      // is delivered for a fast process, resolving with an empty buffer.
      probe.on('close', () => done(buf.trim().split('\n')[0] ?? ''))
    })
  }

  // Absolute content start of a seeked copy run: replicate the exact input seek
  // with BOTH streams mapped (the demuxer positions differently when only one
  // stream is selected) and `-copyts` into NUT — the only common container that
  // preserves absolute timestamps through a pipe — and read the first packet's
  // PTS of `stream`. For video that is the landing keyframe's absolute PTS; for
  // audio it is the first copied audio packet (the `make_zero` anchor of a
  // transcode-with-copied-audio run).
  function probeAbsoluteStart(
    filePath: string,
    time: number,
    stream: 'video' | 'audio'
  ): Promise<number> {
    const sel = stream === 'audio' ? 'a' : 'v'
    return readFirstProbeLine(
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(time),
        '-i',
        filePath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-copyts',
        '-frames:v',
        '1',
        '-frames:a',
        '1',
        '-f',
        'nut',
        'pipe:1'
      ],
      [
        '-v',
        'error',
        '-f',
        'nut',
        '-i',
        'pipe:0',
        '-select_streams',
        `${sel}:0`,
        '-show_entries',
        'packet=pts_time',
        '-of',
        'csv=p=0'
      ]
    ).then((line) => parseFloat(line))
  }

  // The output PTS the landing keyframe is emitted at by the LIVE mux — i.e.
  // where the renderer's buffered range will actually start relative to its
  // timestampOffset. Replicates spawnFfmpegForSession's copy args verbatim
  // (same `make_zero` zeroing, same fMP4 per-track normalization), so the value
  // is exact by construction rather than modeled from DTS heuristics.
  function probeEmittedStart(
    filePath: string,
    time: number,
    videoCodec: 'h264' | 'hevc'
  ): Promise<number> {
    return readFirstProbeLine(
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-fflags',
        '+genpts',
        '-ss',
        String(time),
        '-i',
        filePath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-avoid_negative_ts',
        'make_zero',
        '-muxpreload',
        '0',
        '-muxdelay',
        '0',
        ...(videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
        '-movflags',
        '+frag_keyframe+empty_moov+default_base_moof+separate_moof',
        '-frag_duration',
        '1000000',
        '-frames:v',
        '1',
        '-frames:a',
        '1',
        '-f',
        'mp4',
        'pipe:1'
      ],
      [
        '-v',
        'error',
        '-f',
        'mp4',
        '-i',
        'pipe:0',
        '-select_streams',
        'v:0',
        '-show_entries',
        'packet=pts_time',
        '-of',
        'csv=p=0'
      ]
    ).then((line) => parseFloat(line))
  }

  // Ground-truth timestampOffset for a stream-copy seek (see the interface doc).
  // ffmpeg's Matroska `-ss` input seek lands on the keyframe strictly before the
  // request (a ~0.5–1s deadzone after each keyframe still snaps to the previous
  // one), and the fmp4 muxer then emits that keyframe at a small non-zero output
  // PTS (B-frame reorder over the `make_zero` anchor). Both quantities are
  // probed concurrently (~one probe of wall time) and the offset is their
  // difference, so buffered content maps onto the absolute file timeline
  // exactly as the live run will emit it.
  async function probeCopyTimestampOffset(
    filePath: string,
    time: number,
    videoCodec: 'h264' | 'hevc'
  ): Promise<number> {
    const ffmpegPath = getFfmpegPath()
    const ffprobePath = getFfprobePath()
    if (!ffmpegPath || !ffprobePath || !isFinite(time) || time <= 0) {
      return Math.max(0, time || 0)
    }
    const [absStart, emittedStart] = await Promise.all([
      probeAbsoluteStart(filePath, time, 'video'),
      probeEmittedStart(filePath, time, videoCodec)
    ])
    if (diagEnabled()) {
      diag(
        `probeCopyTimestampOffset requested=${time.toFixed(3)} absStart=${
          isFinite(absStart) ? absStart.toFixed(3) : 'n/a'
        } emittedStart=${isFinite(emittedStart) ? emittedStart.toFixed(3) : 'n/a'}`
      )
    }
    // A copy seek only ever starts at-or-before the request; a sane emitted
    // start is a sub-minute mux offset. Anything else means a probe failed —
    // fall back to the request itself (worst case: the pre-#198 drift).
    if (!isFinite(absStart) || absStart < 0 || absStart > time + 0.001) {
      return Math.max(0, time)
    }
    const emitted =
      isFinite(emittedStart) && emittedStart >= 0 && emittedStart < 60 ? emittedStart : 0
    return Math.max(0, absStart - emitted)
  }

  async function probeMkvForMse(mkvPath: string): Promise<MkvProbeResult | null> {
    const ffprobePath = getFfprobePath()
    if (!ffprobePath) return null
    try {
      Ffmpeg.setFfprobePath(ffprobePath)
      const metadata = await new Promise<Ffmpeg.FfprobeData>((res, rej) => {
        Ffmpeg.ffprobe(mkvPath, (err, m) => (err ? rej(err) : res(m)))
      })
      const durationStr = metadata.format?.duration
      const duration =
        typeof durationStr === 'number' ? durationStr : parseFloat(String(durationStr))
      if (!isFinite(duration) || duration <= 0) return null
      const video = metadata.streams?.find((s) => s.codec_type === 'video')
      const audio = metadata.streams?.find((s) => s.codec_type === 'audio')
      if (!video || !audio) return null
      let videoCodec: 'h264' | 'hevc'
      let videoCodecStr: string | null = null
      const avc = avcCodecString(video)
      if (avc) {
        videoCodec = 'h264'
        videoCodecStr = avc
      } else {
        const hevc = hevcCodecString(video)
        if (hevc) {
          videoCodec = 'hevc'
          videoCodecStr = hevc
        } else return null
      }
      const audioCodecName = (audio.codec_name || '').toString()
      const aStr = aacCodecString(audio)
      const audioStrategy: 'copy' | 'transcode' = aStr ? 'copy' : 'transcode'
      const streamCopyMimeType =
        aStr && videoCodecStr ? `video/mp4; codecs="${videoCodecStr}, ${aStr}"` : null
      return {
        duration,
        videoCodec,
        audioCodecName,
        audioStrategy,
        streamCopyMimeType,
        audioCodecString: aStr
      }
    } catch {
      return null
    }
  }

  function spawnFfmpegForSession(
    session: MseSession,
    event: StreamingIpcEvent,
    sessionId: string,
    seekSeconds: number
  ): ChildProcess {
    const ffmpegPath = getFfmpegPath()
    const args: string[] = ['-fflags', '+genpts']
    if (session.transcode) {
      const choice =
        h264EncoderCandidates().find((c) => c.name === session.h264Encoder) ||
        h264EncoderCandidates().slice(-1)[0]
      if (choice.extraInputArgs) args.push(...choice.extraInputArgs)
      if (seekSeconds > 0) args.push('-ss', String(seekSeconds))
      args.push('-i', session.mkvPath, '-map', '0:v:0', '-map', '0:a:0?')
      args.push(...choice.videoArgs)
      if (session.audioStrategy === 'copy') args.push('-c:a', 'copy')
      else args.push('-c:a', 'aac', '-b:a', '192k')
      args.push('-avoid_negative_ts', 'make_zero', '-muxpreload', '0', '-muxdelay', '0')
    } else {
      if (seekSeconds > 0) args.push('-ss', String(seekSeconds))
      args.push(
        '-i',
        session.mkvPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c',
        'copy',
        '-avoid_negative_ts',
        'make_zero',
        '-muxpreload',
        '0',
        '-muxdelay',
        '0'
      )
      // HEVC tracks in fMP4 must be tagged `hvc1` (parameter sets in sample entry)
      // so Chromium's MSE decoder accepts them. ffmpeg defaults to `hev1`
      // (parameter sets in-band), which many browsers reject for MSE.
      if (session.videoCodec === 'hevc') args.push('-tag:v', 'hvc1')
    }
    args.push(
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof+separate_moof',
      '-frag_duration',
      '1000000',
      '-f',
      'mp4',
      'pipe:1'
    )
    if (diagEnabled()) {
      diag(
        `ffmpeg spawn transcode=${session.transcode} seek=${seekSeconds} args: ${args.join(' ')}`
      )
    }
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const procGen = session.generation

    // Throttle transcode progress IPC: ffmpeg emits progress lines ~4x/sec which
    // is too noisy for a UI label, so we coalesce to at most one send per 500 ms.
    let lastProgressSentAt = 0
    proc.stderr?.on('data', (data: Buffer) => {
      if (procGen !== session.generation) return
      const line = data.toString()
      session.stderrTail.push(line)
      if (session.stderrTail.length > 40) session.stderrTail.shift()
      if (!session.transcode) return
      // Lines look like:
      //   frame= 1234 fps= 60 q=-1.0 size=... time=00:01:23.45 bitrate=... speed=2.5x
      const speedMatch = /speed=\s*([\d.]+)x/.exec(line)
      const timeMatch = /time=\s*(\d+):(\d+):([\d.]+)/.exec(line)
      if (!speedMatch && !timeMatch) return
      const now = Date.now()
      if (now - lastProgressSentAt < 500) return
      lastProgressSentAt = now
      const sender = event.sender
      if (!sender || sender.isDestroyed()) return
      const speed = speedMatch ? parseFloat(speedMatch[1]) : null
      const time = timeMatch
        ? parseInt(timeMatch[1], 10) * 3600 +
          parseInt(timeMatch[2], 10) * 60 +
          parseFloat(timeMatch[3])
        : null
      sender.send(channels.streamProgress, { sessionId, gen: procGen, speed, time })
    })

    // Coalesce small ffmpeg stdout chunks into ~256 KB IPC messages. ffmpeg
    // emits 50–60 KB writes; at transcode speed that floods the renderer main
    // thread with hundreds of IPC events per second and starves the video
    // compositor, showing up as playback stutter.
    const BATCH_FLUSH_BYTES = 256 * 1024
    let batchBuf: Buffer[] = []
    let batchLen = 0
    const flushBatch = (): void => {
      if (batchLen === 0) return
      const out = batchBuf.length === 1 ? batchBuf[0] : Buffer.concat(batchBuf, batchLen)
      batchBuf = []
      batchLen = 0
      if (session.ready) {
        const sender = event.sender
        if (sender && !sender.isDestroyed()) {
          sender.send(channels.streamChunk, { sessionId, gen: procGen, data: out })
        }
      } else {
        session.prelude.push(out)
      }
    }
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (procGen !== session.generation) return
      session.pendingBytes += chunk.length
      batchBuf.push(chunk)
      batchLen += chunk.length
      if (batchLen >= BATCH_FLUSH_BYTES) flushBatch()
      if (session.pendingBytes > STREAM_BACKPRESSURE_HIGH_WATERMARK) {
        proc.stdout?.pause()
      }
    })

    proc.stdout?.on('pause', flushBatch)

    proc.stdout?.on('end', () => {
      if (procGen !== session.generation) return
      if (session.done) return
      flushBatch()
      session.done = true
      const sender = event.sender
      if (sender && !sender.isDestroyed()) {
        sender.send(channels.streamEnd, { sessionId })
      }
    })

    proc.on('error', (err) => {
      if (procGen !== session.generation) return
      if (session.done) return
      session.done = true
      session.error = err.message
      console.error('[remux-stream] spawn error:', err.message)
      const sender = event.sender
      if (sender && !sender.isDestroyed()) {
        sender.send(channels.streamError, { sessionId, error: err.message })
      }
    })

    proc.on('exit', (code, signal) => {
      if (procGen !== session.generation) return
      if (signal === 'SIGKILL') return
      if (code !== 0 && !session.done) {
        const msg = `ffmpeg exited with code ${code}: ${session.stderrTail.slice(-3).join('').trim()}`
        session.error = msg
        session.done = true
        console.error('[remux-stream]', msg)
        const sender = event.sender
        if (sender && !sender.isDestroyed()) {
          sender.send(channels.streamError, { sessionId, error: msg })
        }
      }
    })

    return proc
  }

  function registerSession(sessionId: string, session: MseSession): void {
    sessions.set(sessionId, session)
  }

  function getSession(sessionId: string): MseSession | undefined {
    return sessions.get(sessionId)
  }

  function allSessionIds(): string[] {
    return Array.from(sessions.keys())
  }

  function cleanupSession(sessionId: string): void {
    const session = sessions.get(sessionId)
    if (!session) return
    session.done = true
    try {
      session.proc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    sessions.delete(sessionId)
  }

  function cleanupAllSessions(): void {
    for (const id of Array.from(sessions.keys())) cleanupSession(id)
  }

  return {
    tmpDir,
    highWatermark: STREAM_BACKPRESSURE_HIGH_WATERMARK,
    lowWatermark: STREAM_BACKPRESSURE_LOW_WATERMARK,
    probeMkvForMse,
    probeCopyTimestampOffset,
    pickH264Encoder,
    h264EncoderCandidates,
    spawnFfmpegForSession,
    registerSession,
    getSession,
    allSessionIds,
    cleanupSession,
    cleanupAllSessions
  }
}
