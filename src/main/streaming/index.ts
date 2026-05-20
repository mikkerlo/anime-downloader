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

export interface StreamingService {
  /** Shared tmpdir for transient remux/transcode output. */
  readonly tmpDir: string
  readonly highWatermark: number
  readonly lowWatermark: number

  /** Probe a `.mkv` and return the MSE-compatible MIME + strategy info, or `null` if unsupported. */
  probeMkvForMse(mkvPath: string): Promise<MkvProbeResult | null>
  /** Find the last keyframe at-or-before `time` (seconds), for accurate seek alignment. */
  findKeyframeBefore(filePath: string, time: number): Promise<number>
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

  // Find the latest video keyframe at-or-before `time` (in seconds) by scanning a
  // short window of frames with ffprobe. The fmp4 muxer normalizes per-output
  // `tfdt` to start at 0 regardless of `-copyts`, so we cannot ask ffmpeg to emit
  // absolute timestamps in its fragmented MP4 output. Instead we tell ffmpeg to
  // `-ss <keyframeTime>` exactly, then let the renderer set
  // `sourceBuffer.timestampOffset = keyframeTime` so the video element's timeline
  // aligns with the original file. Without this, seeking lands on the keyframe
  // PTS rather than the user's target (off by up to one GOP).
  async function findKeyframeBefore(filePath: string, time: number): Promise<number> {
    const ffprobePath = getFfprobePath()
    if (!ffprobePath || time <= 0) return Math.max(0, time)
    const start = Math.max(0, time - 15)
    return new Promise<number>((resolve) => {
      const proc = spawn(
        ffprobePath,
        [
          '-v',
          'error',
          '-skip_frame',
          'nokey',
          '-read_intervals',
          `${start.toFixed(3)}%${time.toFixed(3)}`,
          '-select_streams',
          'v:0',
          '-show_entries',
          'frame=pts_time,key_frame',
          '-of',
          'csv=print_section=0',
          filePath
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      )
      let buf = ''
      proc.stdout.on('data', (data: Buffer) => {
        buf += data.toString()
      })
      proc.on('error', () => resolve(Math.max(0, time)))
      proc.on('exit', () => {
        let latest = 0
        for (const line of buf.split('\n')) {
          const parts = line.trim().split(',')
          if (parts.length < 2) continue
          const isKey = parts[0] === '1'
          const pts = parseFloat(parts[1])
          if (!isKey || !isFinite(pts)) continue
          if (pts <= time && pts > latest) latest = pts
        }
        resolve(latest > 0 ? latest : Math.max(0, time))
      })
    })
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
    findKeyframeBefore,
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
