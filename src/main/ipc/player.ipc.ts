import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { type ChildProcess } from 'child_process'
import Ffmpeg from 'fluent-ffmpeg'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import { sanitizeFilename } from '../download-manager'
import { probeMp4Faststart } from '../mp4-faststart'
import type { MseSession } from '../streaming'
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
    // was called. On Windows the userData-installed ffmpeg is not on PATH,
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

/**
 * Bumped by every `player:cleanup-remux` sweep (#280). The two MSE open
 * handlers capture it at entry and self-reap if it moved by the time they have
 * registered their session — that is the only thing that closes the window
 * where a cleanup issued at unmount *overtakes* a registration still stuck
 * behind `probeMkvForMse`: the sweep finds no session, the registration lands
 * behind it, and the ffmpeg it spawns survives until the next `.mkv` open.
 *
 * Module-local rather than a `register` local so it is unambiguously one
 * counter for the whole router; `register` is called once per app boot.
 */
let cleanupGeneration = 0

/**
 * Normalises the renderer's requested open position into the `-ss` both MSE
 * open handlers spawn ffmpeg at (#275). Folds the long-standing non-finite /
 * `<= 0` guard together with an upper bound against the probed duration.
 *
 * **Rejects at `duration`, never clamps to it.** ffmpeg's Matroska demuxer
 * clamps an out-of-range input seek to the last keyframe and emits the final
 * GOP, so `-ss duration`, `-ss 3000` and `-ss 999999` all produce the *same*
 * byte-identical run — clamping the request to `duration` is provably clamping
 * it to 999999, and the session opens parked at the last frame, hits `ended`
 * and auto-advances to the next episode. No pre-roll margin fixes that either:
 * the window it has to clear is the release's final GOP (measured 0.645 s to
 * 10.428 s across three real files), so any fixed margin either lands back
 * inside the final-GOP case or fabricates a resume point in content the user
 * has no recorded relationship with. A position that is not inside the file is
 * not a seek — it is a stale record — and there is nowhere correct to land, so
 * the open starts at 0. That is the same rule `resolveMkvSpawnTarget` already
 * applies with its `< 0.95` gate, just against the authoritative duration
 * instead of the record's own.
 *
 * `duration` needs no validity check at the call sites: `probeMkvForMse`
 * returns `null` unless it is finite and `> 0`, and both handlers bail on that
 * before they get here.
 *
 * The `console.warn` is the point of the rejection being visible at all — a
 * refused seek means some caller computed a target outside the file, which is
 * otherwise entirely silent.
 *
 * Returns the decision (`refused`) alongside the value, because the renderer
 * needs it too and re-deriving it there from transported numbers is what #295
 * removes: `refused` is set by the *same* expression that takes the branch, so
 * the callers wire a boolean rather than repeating the comparison. Note that
 * `seek` is 0 on two different paths — the refusal here and the non-finite /
 * `<= 0` normalisation above it — so `seek === 0` is not the decision and
 * inferring `refused` from it (on either side of the IPC boundary) would
 * misclassify the normalisation, and any zeroing path added later.
 */
function boundInitialSeek(
  initialSeek: number | undefined,
  duration: number,
  sessionId: string
): { seek: number; refused: boolean } {
  const requested =
    typeof initialSeek === 'number' && isFinite(initialSeek) && initialSeek > 0 ? initialSeek : 0
  if (requested >= duration) {
    console.warn(
      `[remux-stream] session ${sessionId.slice(0, 8)} refusing requested seek ${requested.toFixed(2)} — at or past the file's duration ${duration.toFixed(2)}; opening at 0`
    )
    return { seek: 0, refused: true }
  }
  return { seek: requested, refused: false }
}

export function register({
  store,
  smotretApi,
  coldStorageService,
  streamingService,
  mp4StatsService,
  downloadManager,
  playerLockService,
  getFfmpegPath,
  getFfprobePath
}: AppDeps): void {
  // Watch-while-downloading (#63): the renderer reports which local file it
  // has open so DownloadManager defers the .part rename + merge meanwhile.
  ipcMain.handle(CHANNELS.PLAYER_OPENED, (_event, filePath: string) => {
    if (typeof filePath === 'string' && filePath) playerLockService.open(filePath)
  })
  ipcMain.handle(CHANNELS.PLAYER_CLOSED, (_event, filePath: string) => {
    if (typeof filePath === 'string' && filePath) playerLockService.close(filePath)
  })

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
    // .part-aware (#63): a growing `x.mp4.part` session maps to the same
    // sibling `x.ass` as its final file would.
    const assPath = filePath.replace(/\.(mp4|mkv)(\.part)?$/i, '.ass')
    // Unrecognized extension — never read the video file itself back as ASS.
    if (assPath === filePath) return null
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
      // Two-way lock (#63): while ffmpeg is merging this translation, the
      // .mkv at the final path is half-written and the source .mp4 is about
      // to be unlinked — neither is safe to open. Fall back to CDN streaming;
      // _mergeAll defers merges of files the player grabs first.
      if (downloadManager.getMergeStatus(translationId) === 'merging') return null

      // Watch-while-downloading (#63): a translation still in flight has no
      // downloadedEpisodes metadata and no final file — resolve the growing
      // .part straight from the download queue, but only when its head is
      // already faststart (moov before mdat; a moov-at-end partial cannot be
      // played, so the caller falls back to CDN streaming).
      const findPartial = async (): Promise<{
        filePath: string
        subtitleContent: string | null
        isPartial: true
        totalBytes: number
      } | null> => {
        const partial = downloadManager.getPartialVideoPath(translationId)
        if (!partial || !fs.existsSync(partial.partPath)) return null
        const probe = await probeMp4Faststart(partial.partPath)
        if (!probe?.faststart) return null
        const assPath = partial.partPath.replace(/\.mp4\.part$/i, '.ass')
        let subtitleContent: string | null = null
        try {
          subtitleContent = fs.existsSync(assPath) ? fs.readFileSync(assPath, 'utf-8') : null
        } catch {
          /* ignore */
        }
        return {
          filePath: partial.partPath,
          subtitleContent,
          isPartial: true,
          totalBytes: partial.totalBytes
        }
      }

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
      if (!meta) return findPartial()

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
      // Meta existed (e.g. an older completed download of this translation)
      // but no file survived on disk — a fresh re-download may be in flight.
      return findPartial()
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
    ): Promise<MseOpenResult | { requiresTranscode: true } | { error: string }> => {
      // Captured at handler *entry*, not module load: every legitimate
      // cleanup-then-open sequence in the renderer awaits `playerCleanupRemux`
      // before opening the next session, so the bump always lands before this
      // read and a `!==` comparison against the captured value never misfires.
      const openedAtGeneration = cleanupGeneration
      const ffmpegPath = getFfmpegPath()
      const ffprobePath = getFfprobePath()
      if (!ffmpegPath) return { error: 'ffmpeg not available' }
      if (!fs.existsSync(mkvPath)) return { error: 'File not found' }

      const probe = await streamingService.probeMkvForMse(mkvPath)
      if (!probe || !probe.streamCopyMimeType) return { error: 'Codecs not supported for MSE' }
      // `hevcTranscodeOnPlay === 'always'` never plays the copy session — the
      // renderer used to discover that only after this handler had probed,
      // spawned ffmpeg, and kicked off subtitle extraction, then SIGKILLed it
      // all to start the transcode. Short-circuit before any work instead.
      if (probe.videoCodec === 'hevc' && store.get('hevcTranscodeOnPlay') === 'always') {
        return { requiresTranscode: true }
      }
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
      // Self-reap (#280). The check belongs here — directly under
      // `registerSession`, above `spawnFfmpegForSession` — because at this
      // point nothing has been spawned: `cleanupSession` is pure
      // deregistration and the `return` is what makes the ffmpeg process never
      // exist at all. It also skips the subtitle extraction below. Placed
      // after the spawn it would buy a spawn-then-kill where a never-spawn was
      // available.
      if (cleanupGeneration !== openedAtGeneration) {
        streamingService.cleanupSession(sessionId)
        return { error: 'cancelled' }
      }
      // Below the self-reap above on purpose (#275): a cancelled open has
      // already returned, so it never spends a `console.warn` on a seek that
      // will never reach ffmpeg. Above `probeCopyTimestampOffset` and the spawn
      // for the same reason the #198 note below gives — bounding inside
      // `spawnFfmpegForSession` would let ffmpeg run at one seek while the
      // offset probe measured another, which is the subtitles-run-ahead desync.
      const { seek: requestedSeek, refused: refusedSeek } = boundInitialSeek(
        initialSeek,
        probe.duration,
        sessionId
      )
      // Seek ffmpeg at the RAW requested time — do NOT pre-snap to a keyframe. A
      // pre-snapped `-ss <keyframe>` double-snaps to the *previous* keyframe (the
      // Matroska seek deadzone), landing ~one GOP early while the renderer labels
      // the buffer with the un-snapped time → the classic subtitles-run-ahead
      // desync. Probe the run's true timestampOffset concurrently with the spawn
      // (its result feeds only the IPC reply, not the session ffmpeg) so the
      // probe never delays first bytes (#198).
      const offsetPromise =
        requestedSeek > 0
          ? streamingService.probeCopyTimestampOffset(mkvPath, requestedSeek, probe.videoCodec)
          : Promise.resolve(0)
      session.proc = streamingService.spawnFfmpegForSession(
        session,
        event,
        sessionId,
        requestedSeek
      )

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

      const contentStart = await offsetPromise
      // Re-read at the reply (#280). The check above the spawn closes the
      // "no ffmpeg is spawned behind a sweep" hole, but the window reopens
      // below it: the `Ffmpeg.ffprobe` promise and `await offsetPromise` are
      // two more suspension points, and a cleanup landing in either one DOES
      // find the session and sweeps it — yet the handler would still return a
      // full success payload naming a dead, deregistered `sessionId`, leaving
      // the renderer on a `MediaSource` that never receives a byte. Reading
      // the generation once more here is what makes the invariant
      // `docs/player.md` states — *no reply ever describes a swept session* —
      // true rather than merely aspirational. The `cleanupSession` call here is
      // defence in depth, not load-bearing: the generation only moves from
      // `player:cleanup-remux`, whose bump + sweep + unlink are one synchronous
      // block, so by the time we read a moved generation this session has
      // already been deregistered and the call is the `if (!session) return`
      // no-op. It stays so the `return` is never the only thing standing
      // between a moved generation and a live registration.
      if (cleanupGeneration !== openedAtGeneration) {
        streamingService.cleanupSession(sessionId)
        return { error: 'cancelled' }
      }
      console.log(
        `[remux-stream] open session ${sessionId.slice(0, 8)} codec=${probe.videoCodec} mime="${streamCopyMime}" requested=${requestedSeek.toFixed(2)} contentStart=${contentStart.toFixed(2)}`
      )
      return {
        sessionId,
        generation: session.generation,
        duration: probe.duration,
        mimeType: streamCopyMime,
        hasSubtitlesPending,
        contentStart,
        refusedSeek
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
      const openedAtGeneration = cleanupGeneration
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
      // Same self-reap as the copy handler (#280) — directly under
      // `registerSession`, above the spawn.
      if (cleanupGeneration !== openedAtGeneration) {
        streamingService.cleanupSession(sessionId)
        return { error: 'cancelled' }
      }
      // Same bound as the copy handler (#275), in the same place: below the
      // self-reap, above `probeSeekAnchor` and the spawn, so the anchor probe
      // and ffmpeg read one value by construction.
      const { seek: requestedSeek, refused: refusedSeek } = boundInitialSeek(
        initialSeek,
        probe.duration,
        sessionId
      )
      // Transcode video is frame-accurate (accurate-seek discards to the exact
      // `-ss`), but a copied AAC track can't be trimmed: it starts at the seek's
      // keyframe cluster and anchors `-avoid_negative_ts make_zero` up to one GOP
      // before the request. probeSeekAnchor measures that audio landing (or
      // returns the raw request for a full transcode); labeling with the raw
      // request on the audio-copy path plays ~one GOP behind the clock — the
      // #198 desync, transcode edition. Probed concurrently with the spawn.
      const anchorPromise = streamingService.probeSeekAnchor(session, requestedSeek)
      session.proc = streamingService.spawnFfmpegForSession(
        session,
        event,
        sessionId,
        requestedSeek
      )

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

      const contentStart = await anchorPromise
      // Same reply-time re-read as the copy handler (#280) — the suspension
      // points below the spawn reopen the window the check above it closed.
      if (cleanupGeneration !== openedAtGeneration) {
        streamingService.cleanupSession(sessionId)
        return { error: 'cancelled' }
      }
      console.log(
        `[remux-stream] open TRANSCODE session ${sessionId.slice(0, 8)} encoder=${encoder.name} audio=${probe.audioStrategy} mime="${mimeType}" requested=${requestedSeek.toFixed(2)} contentStart=${contentStart.toFixed(2)}`
      )
      return {
        sessionId,
        generation: session.generation,
        duration: probe.duration,
        mimeType,
        hasSubtitlesPending,
        contentStart,
        refusedSeek
      }
    }
  )

  // Forward seek past the buffered region: respawn ffmpeg at the RAW requested
  // timestamp and return the run's true timestampOffset so the renderer can map
  // the new fragments onto the file timeline. probeSeekAnchor measures it per
  // run type: full measurement for copy (absolute landing minus the mux's
  // emitted start), the copied audio track's landing for transcode-with-copied-
  // audio, the raw request for a full transcode. The renderer keeps the playhead
  // at the user's target — decoding starts from the buffer's leading keyframe,
  // so it plays in sync (see use-mse-player). Stale chunks from the old proc are
  // filtered by the generation counter in spawnFfmpegForSession.
  ipcMain.handle(
    CHANNELS.PLAYER_STREAM_SEEK,
    async (event, sessionId: string, seekSeconds: number) => {
      const session = streamingService.getSession(sessionId)
      if (!session) return { error: 'session not found' }
      const requestedSeek = Math.max(0, seekSeconds)
      // Probe concurrently with the respawn below — the offset feeds only the
      // IPC reply, and the renderer holds new chunks in the prelude until it
      // has set timestampOffset and re-handshaken, so this never races the data.
      // probeSeekAnchor picks the anchor per run type (copy → full measurement,
      // transcode+copied-audio → audio landing, full transcode → raw request).
      const offsetPromise = streamingService.probeSeekAnchor(session, requestedSeek)
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
      session.proc = streamingService.spawnFfmpegForSession(
        session,
        event,
        sessionId,
        requestedSeek
      )
      return { ok: true, generation: session.generation, timestampOffset: await offsetPromise }
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
    // Bump first, before the sweep: an open handler whose `registerSession`
    // lands *after* this sweep must still see the move and self-reap (#280).
    cleanupGeneration++
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
