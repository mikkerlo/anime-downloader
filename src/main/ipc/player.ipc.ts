import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { type ChildProcess } from 'child_process'
import Ffmpeg from 'fluent-ffmpeg'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import { sanitizeFilename } from '../download-manager'
import type { MseSession, MseOpenResult } from '../streaming'
import type { AppDeps } from './index'

/**
 * Extracts the first embedded subtitle track of `mkvPath` to `assPath` and
 * returns its content. Returns `undefined` when ffmpeg is unavailable, the
 * file has no subtitle stream, or extraction fails. Lifted verbatim out of
 * `index.ts` (Phase 3 slice 3g) — only player remux handlers use it.
 */
async function extractFirstSubtitle(
  ffmpegPath: string,
  ffprobePath: string,
  mkvPath: string,
  assPath: string
): Promise<string | undefined> {
  try {
    if (!ffmpegPath || !ffprobePath) return undefined
    // fluent-ffmpeg resolves the ffmpeg binary from PATH unless setFfmpegPath
    // was called. On Windows the ffbinaries-downloaded ffmpeg is not on PATH,
    // so this must be set explicitly here even if setFfprobePath was called.
    Ffmpeg.setFfmpegPath(ffmpegPath)
    Ffmpeg.setFfprobePath(ffprobePath)
    const hasSubStream = await new Promise<boolean>((res) => {
      Ffmpeg.ffprobe(mkvPath, (err, metadata) => {
        res(err ? false : !!metadata.streams?.find((s) => s.codec_type === 'subtitle'))
      })
    })
    if (!hasSubStream) return undefined
    await new Promise<void>((res, rej) => {
      Ffmpeg(mkvPath)
        .outputOptions(['-map', '0:s:0', '-c:s', 'ass'])
        .output(assPath)
        .on('error', (err) => {
          console.error('[remux] Subtitle extraction error:', err.message)
          rej(err)
        })
        .on('end', () => res())
        .run()
    })
    const content = fs.readFileSync(assPath, 'utf-8')
    console.log('[remux] Subtitle extracted:', assPath)
    return content
  } catch {
    return undefined
  }
}

export function register({
  store,
  smotretApi,
  coldStorageService,
  streamingService,
  mp4StatsService,
  getFfmpegPath,
  getFfprobePath
}: AppDeps): void {
  ipcMain.handle(
    CHANNELS.PLAYER_GET_STREAM_URL,
    async (_event, translationId: number, maxHeight: number) => {
      try {
        const embed = await smotretApi.getEmbed(translationId)
        const streams = embed.stream || []
        if (streams.length === 0) return null
        const sorted = [...streams].sort((a, b) => b.height - a.height)
        const best = sorted.find((s) => s.height <= maxHeight) || sorted[0]
        const streamUrl = best && best.urls.length > 0 ? best.urls[0] : null
        if (!streamUrl) return null

        // Build list of all available streams for quality selector
        const availableStreams = sorted
          .filter((s) => s.urls.length > 0)
          .map((s) => ({ height: s.height, url: s.urls[0] }))

        // Fetch raw ASS subtitle content if available (rendered natively by JASSUB in the player)
        let subtitleContent: string | null = null
        if (embed.subtitlesUrl) {
          subtitleContent = await smotretApi.fetchSubtitleContent(translationId)
        }

        return { streamUrl, subtitleContent, availableStreams }
      } catch {
        return null
      }
    }
  )

  ipcMain.handle(CHANNELS.PLAYER_GET_LOCAL_SUBTITLES, async (_event, filePath: string) => {
    const assPath = filePath.replace(/\.(mp4|mkv)$/i, '.ass')
    try {
      if (fs.existsSync(assPath)) {
        return fs.readFileSync(assPath, 'utf-8')
      }
    } catch {
      /* ignore */
    }
    return null
  })

  ipcMain.handle(
    CHANNELS.PLAYER_FIND_LOCAL_FILE,
    async (
      _event,
      animeName: string,
      episodeInt: string,
      translationId: number,
      episodeLabel: string
    ) => {
      const episodes = store.get('downloadedEpisodes') as Record<
        string,
        { translationType: string; author: string; quality: number; translationId: number }
      >
      // Find meta for this translation — try new key format, then scan for legacy
      let meta: { author: string } | null = null
      for (const [key, val] of Object.entries(episodes)) {
        if (val.translationId === translationId) {
          // Verify key belongs to right anime episode (starts with some animeId:episodeInt)
          const parts = key.split(':')
          if (parts.length >= 2 && parts[1] === episodeInt) {
            meta = val
            break
          }
        }
      }
      if (!meta) return null

      const animeDirName = sanitizeFilename(animeName)
      const padded = episodeInt.padStart(2, '0')
      const base = sanitizeFilename(`${animeName} - ${padded}`)
      const authorTag = sanitizeFilename(meta.author)
      const taggedBase = `${base} [${authorTag}]`

      const dirsToCheck = [coldStorageService.getDownloadDir()]
      if (coldStorageService.isAdvanced()) {
        const coldDir = coldStorageService.getColdStorageDir()
        if (coldDir) dirsToCheck.push(coldDir)
      }

      const onResolved = (fp: string): void => {
        if (fp.toLowerCase().endsWith('.mp4')) {
          // animeId is 0 here because this handler only receives animeName; resolving
          // back to an id would require scanning recentAnimeMeta. The stats sample is
          // for human inspection (anime title + episode + filepath), so the missing
          // id is acceptable.
          void mp4StatsService.recordCheck(fp, {
            animeId: 0,
            animeName,
            episodeInt,
            episodeLabel
          })
        }
      }

      for (const dir of dirsToCheck) {
        const animeDir = path.join(dir, animeDirName)
        // Try tagged filename first
        for (const ext of ['.mkv', '.mp4']) {
          const fp = path.join(animeDir, `${taggedBase}${ext}`)
          if (fs.existsSync(fp)) {
            const subtitleContent = await (async () => {
              const assPath = fp.replace(/\.(mp4|mkv)$/i, '.ass')
              try {
                return fs.existsSync(assPath) ? fs.readFileSync(assPath, 'utf-8') : null
              } catch {
                return null
              }
            })()
            onResolved(fp)
            return { filePath: fp, subtitleContent }
          }
        }
        // Try legacy filename
        for (const ext of ['.mkv', '.mp4']) {
          const fp = path.join(animeDir, `${base}${ext}`)
          if (fs.existsSync(fp)) {
            const subtitleContent = await (async () => {
              const assPath = fp.replace(/\.(mp4|mkv)$/i, '.ass')
              try {
                return fs.existsSync(assPath) ? fs.readFileSync(assPath, 'utf-8') : null
              } catch {
                return null
              }
            })()
            onResolved(fp)
            return { filePath: fp, subtitleContent }
          }
        }
      }
      return null
    }
  )

  // Remux MKV to fragmented MP4 (stream copy) for progressive HTML5 playback.
  // See protocol.handle('anime-video', …) in index.ts for the streaming reader.
  ipcMain.handle(
    CHANNELS.PLAYER_REMUX_MKV,
    async (
      _event,
      mkvPath: string
    ): Promise<{ mp4Path: string; subtitleContent?: string } | { error: string }> => {
      const ffmpegPath = getFfmpegPath()
      const ffprobePath = getFfprobePath()
      if (!ffmpegPath) return { error: 'ffmpeg not available' }
      if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

      fs.mkdirSync(streamingService.tmpDir, { recursive: true })

      const stamp = Date.now()
      const baseName = path.basename(mkvPath, path.extname(mkvPath))
      const mp4Path = path.join(streamingService.tmpDir, `${baseName}-${stamp}.mp4`)

      Ffmpeg.setFfmpegPath(ffmpegPath)

      const remuxPromise = new Promise<void>((resolve, reject) => {
        Ffmpeg(mkvPath)
          .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
          .output(mp4Path)
          .on('error', (err) => {
            console.error('[remux] FFmpeg error:', err.message)
            reject(err)
          })
          .on('end', () => {
            console.log('[remux] Completed:', mp4Path)
            resolve()
          })
          .run()
      })

      const subtitlePromise = extractFirstSubtitle(
        ffmpegPath,
        ffprobePath,
        mkvPath,
        path.join(streamingService.tmpDir, `${baseName}-${stamp}.ass`)
      )

      try {
        const [, subtitleContent] = await Promise.all([remuxPromise, subtitlePromise])
        return { mp4Path, ...(subtitleContent ? { subtitleContent } : {}) }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: msg }
      }
    }
  )

  // Start an MSE-friendly fragmented MP4 pipe. Returns duration + codecs MIME so the
  // renderer can set MediaSource.duration and addSourceBuffer(mimeType) upfront.
  // Video bytes are pushed to the renderer via 'player:stream-chunk' events.
  ipcMain.handle(
    CHANNELS.PLAYER_REMUX_MKV_STREAM,
    async (
      event,
      mkvPath: string,
      initialSeek?: number
    ): Promise<MseOpenResult | { error: string }> => {
      const ffmpegPath = getFfmpegPath()
      const ffprobePath = getFfprobePath()
      if (!ffmpegPath) return { error: 'ffmpeg not available' }
      if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

      const probe = await streamingService.probeMkvForMse(mkvPath)
      if (!probe || !probe.streamCopyMimeType) return { error: 'Codecs not supported for MSE' }
      const streamCopyMime = probe.streamCopyMimeType

      fs.mkdirSync(streamingService.tmpDir, { recursive: true })

      const sessionId = randomUUID()
      const baseName = path.basename(mkvPath, path.extname(mkvPath))

      const session: MseSession = {
        proc: null as unknown as ChildProcess,
        pendingBytes: 0,
        stderrTail: [],
        done: false,
        error: null,
        senderId: event.sender.id,
        ready: false,
        prelude: [],
        mkvPath,
        generation: 0,
        videoCodec: probe.videoCodec,
        transcode: false,
        audioStrategy: 'copy',
        h264Encoder: null
      }
      streamingService.registerSession(sessionId, session)
      const requestedSeek =
        typeof initialSeek === 'number' && isFinite(initialSeek) && initialSeek > 0
          ? initialSeek
          : 0
      const startSeek =
        requestedSeek > 0 ? await streamingService.findKeyframeBefore(mkvPath, requestedSeek) : 0
      console.log(
        `[remux-stream] open session ${sessionId.slice(0, 8)} codec=${probe.videoCodec} mime="${streamCopyMime}" requested=${requestedSeek.toFixed(2)} keyframe=${startSeek.toFixed(2)}`
      )
      session.proc = streamingService.spawnFfmpegForSession(session, event, sessionId, startSeek)

      // Kick off subtitle extraction in parallel; push to renderer when ready.
      const assPath = path.join(streamingService.tmpDir, `${baseName}-${sessionId}.ass`)
      let hasSubtitlesPending = false
      try {
        if (ffprobePath) {
          Ffmpeg.setFfprobePath(ffprobePath)
          hasSubtitlesPending = await new Promise<boolean>((res) => {
            Ffmpeg.ffprobe(mkvPath, (err, metadata) => {
              res(err ? false : !!metadata.streams?.find((s) => s.codec_type === 'subtitle'))
            })
          })
        }
      } catch {
        /* ignore probe failures */
      }

      if (hasSubtitlesPending) {
        extractFirstSubtitle(ffmpegPath, ffprobePath, mkvPath, assPath)
          .then((content) => {
            if (!content) return
            const sender = event.sender
            if (sender && !sender.isDestroyed()) {
              sender.send(EVENT_CHANNELS.PLAYER_STREAM_SUBTITLES, { sessionId, content })
            }
          })
          .catch(() => {
            /* already logged */
          })
      }

      return {
        sessionId,
        generation: session.generation,
        duration: probe.duration,
        mimeType: streamCopyMime,
        hasSubtitlesPending,
        initialSeek: startSeek
      }
    }
  )

  // Same as `player:remux-mkv-stream` but re-encodes video to H.264 on the fly.
  // Used when the platform has no decoder for the source codec (typically HEVC
  // on Linux without VA-API). Audio is copied when AAC, otherwise transcoded
  // to AAC so MSE can play it.
  ipcMain.handle(
    CHANNELS.PLAYER_REMUX_MKV_STREAM_TRANSCODE,
    async (
      event,
      mkvPath: string,
      initialSeek?: number
    ): Promise<MseOpenResult | { error: string }> => {
      const ffmpegPath = getFfmpegPath()
      const ffprobePath = getFfprobePath()
      if (!ffmpegPath) return { error: 'ffmpeg not available' }
      if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

      const probe = await streamingService.probeMkvForMse(mkvPath)
      if (!probe) return { error: 'Probe failed' }

      fs.mkdirSync(streamingService.tmpDir, { recursive: true })

      const encoder = await streamingService.pickH264Encoder()
      // When the audio is being stream-copied, reflect its actual AAC object type
      // (mp4a.40.2 / .5 / .29) in the mime — otherwise MediaSource.isTypeSupported
      // will reject a perfectly valid HE-AAC stream. When we transcode audio we
      // force LC AAC, so mp4a.40.2 is always correct on that branch.
      const audioCodecForMime =
        probe.audioStrategy === 'copy' && probe.audioCodecString
          ? probe.audioCodecString
          : 'mp4a.40.2'
      const mimeType = `video/mp4; codecs="avc1.640028, ${audioCodecForMime}"`

      const sessionId = randomUUID()
      const baseName = path.basename(mkvPath, path.extname(mkvPath))

      const session: MseSession = {
        proc: null as unknown as ChildProcess,
        pendingBytes: 0,
        stderrTail: [],
        done: false,
        error: null,
        senderId: event.sender.id,
        ready: false,
        prelude: [],
        mkvPath,
        generation: 0,
        videoCodec: probe.videoCodec,
        transcode: true,
        audioStrategy: probe.audioStrategy,
        h264Encoder: encoder.name
      }
      streamingService.registerSession(sessionId, session)
      const requestedSeek =
        typeof initialSeek === 'number' && isFinite(initialSeek) && initialSeek > 0
          ? initialSeek
          : 0
      const startSeek =
        requestedSeek > 0 ? await streamingService.findKeyframeBefore(mkvPath, requestedSeek) : 0
      console.log(
        `[remux-stream] open TRANSCODE session ${sessionId.slice(0, 8)} encoder=${encoder.name} audio=${probe.audioStrategy} mime="${mimeType}" requested=${requestedSeek.toFixed(2)} keyframe=${startSeek.toFixed(2)}`
      )
      session.proc = streamingService.spawnFfmpegForSession(session, event, sessionId, startSeek)

      const assPath = path.join(streamingService.tmpDir, `${baseName}-${sessionId}.ass`)
      let hasSubtitlesPending = false
      try {
        if (ffprobePath) {
          Ffmpeg.setFfprobePath(ffprobePath)
          hasSubtitlesPending = await new Promise<boolean>((res) => {
            Ffmpeg.ffprobe(mkvPath, (err, metadata) => {
              res(err ? false : !!metadata.streams?.find((s) => s.codec_type === 'subtitle'))
            })
          })
        }
      } catch {
        /* ignore */
      }

      if (hasSubtitlesPending) {
        extractFirstSubtitle(ffmpegPath, ffprobePath, mkvPath, assPath)
          .then((content) => {
            if (!content) return
            const sender = event.sender
            if (sender && !sender.isDestroyed()) {
              sender.send(EVENT_CHANNELS.PLAYER_STREAM_SUBTITLES, { sessionId, content })
            }
          })
          .catch(() => {
            /* already logged */
          })
      }

      return {
        sessionId,
        generation: session.generation,
        duration: probe.duration,
        mimeType,
        hasSubtitlesPending,
        initialSeek: startSeek
      }
    }
  )

  // Forward seek past the buffered region: respawn ffmpeg with `-ss` so output
  // starts at (or just before) the requested timestamp. The renderer will have
  // already set sourceBuffer.timestampOffset to place fragments on the correct
  // MSE timeline position. Stale chunks from the old proc are filtered out by
  // the generation counter captured in spawnFfmpegForSession.
  ipcMain.handle(
    CHANNELS.PLAYER_STREAM_SEEK,
    async (event, sessionId: string, seekSeconds: number) => {
      const session = streamingService.getSession(sessionId)
      if (!session) return { error: 'session not found' }
      const requestedSeek = Math.max(0, seekSeconds)
      const keyframeTime =
        requestedSeek > 0
          ? await streamingService.findKeyframeBefore(session.mkvPath, requestedSeek)
          : 0
      session.generation++
      try {
        session.proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      session.pendingBytes = 0
      session.prelude = []
      session.done = false
      session.error = null
      // Hold new chunks in the prelude until the renderer has set its
      // SourceBuffer.timestampOffset and called player:stream-start again.
      // Otherwise first frames of the new run race ahead of the offset change
      // and get placed on the wrong MSE timeline.
      session.ready = false
      if (session.proc.stdout && session.proc.stdout.isPaused()) {
        try {
          session.proc.stdout.resume()
        } catch {
          /* ignore */
        }
      }
      session.proc = streamingService.spawnFfmpegForSession(session, event, sessionId, keyframeTime)
      return { ok: true, generation: session.generation, keyframeTime }
    }
  )

  // Handshake: renderer's MediaSource + SourceBuffer are ready to receive chunks.
  // Flush any buffered prelude (the MP4 moov header lives in here) and switch to
  // forwarding subsequent chunks directly.
  ipcMain.handle(CHANNELS.PLAYER_STREAM_START, (event, sessionId: string) => {
    const session = streamingService.getSession(sessionId)
    if (!session) return
    if (session.ready) return
    session.ready = true
    const sender = event.sender
    if (sender && !sender.isDestroyed()) {
      const gen = session.generation
      for (const chunk of session.prelude) {
        sender.send(EVENT_CHANNELS.PLAYER_STREAM_CHUNK, { sessionId, gen, data: chunk })
      }
    }
    session.prelude = []
  })

  // Backpressure ack: renderer reports bytes it has appended into its SourceBuffer.
  // When enough data has been consumed we resume the ffmpeg stdout pipe.
  ipcMain.handle(CHANNELS.PLAYER_STREAM_ACK, (_event, sessionId: string, bytesConsumed: number) => {
    const session = streamingService.getSession(sessionId)
    if (!session) return
    session.pendingBytes = Math.max(0, session.pendingBytes - bytesConsumed)
    if (session.pendingBytes < streamingService.lowWatermark && session.proc.stdout?.isPaused()) {
      session.proc.stdout.resume()
    }
  })

  ipcMain.handle(CHANNELS.PLAYER_CLEANUP_REMUX, async () => {
    for (const sessionId of streamingService.allSessionIds()) {
      streamingService.cleanupSession(sessionId)
    }
    try {
      if (fs.existsSync(streamingService.tmpDir)) {
        const files = fs.readdirSync(streamingService.tmpDir)
        for (const file of files) {
          try {
            fs.unlinkSync(path.join(streamingService.tmpDir, file))
          } catch {
            /* ignore */
          }
        }
        try {
          fs.rmdirSync(streamingService.tmpDir)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  })
}
