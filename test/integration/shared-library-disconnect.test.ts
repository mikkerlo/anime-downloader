// A drive disconnected mid-episode (#582), through the real attached-library
// service, the real `anime-video://` handler, and the real player router and
// streaming service with real ffmpeg.
//
// On POSIX, renaming the library dir doesn't break a read that is already open:
// the open fd keeps reading. A removal shows up on the NEXT open: the next
// Range request for `anime-video://`, and ffmpeg's respawn on a seek outside
// the buffer for MSE. Both tests trigger exactly that.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { register as registerPlayer } from '../../src/main/ipc/player.ipc'
import {
  createAttachedLibraryService,
  type AttachedLibraryServiceDeps
} from '../../src/main/services/attached-library'
import { createAnimeVideoHandler } from '../../src/main/streaming/anime-video-protocol'
import { createStreamingService, type MseSession } from '../../src/main/streaming'
import { CHANNELS } from '../../src/shared/ipc/channels'
import type { AppDeps } from '../../src/main/ipc'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { cleanup, tempRoot } from '../helpers/shared-library'
import { FIXTURE_LIBRARY_ID, copyFixtureLibrary } from '../helpers/attached-library'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const MP4 = 'Frieren~3f2a1c/Frieren~3f2a1c - 01 [Crunchyroll].mp4'
const MKV = 'Dungeon Meshi/Dungeon Meshi - 01 [AniLibria].mkv'
const OWNER = { id: 4242, nickname: 'owner', avatar: '' }

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

function makeService(over: Partial<AttachedLibraryServiceDeps> = {}) {
  const store = new InMemoryStorage({
    shikimoriUser: OWNER,
    shikimoriCredentials: null,
    downloadedAnime: {},
    downloadedEpisodes: {},
    attachedLibraries: {},
    hevcTranscodeOnPlay: 'ask'
  })
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const svc = createAttachedLibraryService({
    store,
    checkFfmpeg: async () => ({ available: true }),
    log,
    ...over
  })
  return { svc, store, log }
}

async function attach(svc: ReturnType<typeof makeService>['svc'], root: string): Promise<void> {
  await svc.discover(root)
  const res = await svc.attach(FIXTURE_LIBRARY_ID)
  if (!res.ok) throw new Error(res.error)
}

const disconnectLines = (log: { warn: ReturnType<typeof vi.fn> }): unknown[] =>
  log.warn.mock.calls.filter((c) => String(c[0]).includes('drive-disconnected'))

describe('anime-video:// mid-play', () => {
  it('the next Range request after a rename is a 404 from the stat catch, logged once', async () => {
    const { svc, log } = makeService()
    const root = copyFixtureLibrary()
    await attach(svc, root)
    const handler = createAnimeVideoHandler({
      getActiveDownload: () => null,
      onUnreadable: (fp, err) => void svc.reportUnreadable(fp, err)
    })
    const file = path.join(root, MP4)
    const url = 'anime-video://' + encodeURIComponent(file)
    const range = (start: number, end: number): Request =>
      new Request(url, { headers: { Range: `bytes=${start}-${end}` } })

    const first = await handler(range(0, 999))
    expect(first.status).toBe(206)
    expect((await first.arrayBuffer()).byteLength).toBe(1000)
    fs.renameSync(root, `${root}-away`)

    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      for (let i = 0; i < 3; i++) {
        const next = await handler(range(1000, 1999))
        expect(next.status).toBe(404)
      }
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(unhandled).not.toHaveBeenCalled()
    expect(disconnectLines(log)).toHaveLength(1)
    expect(String(disconnectLines(log)[0])).toContain('ENOENT')
  })

  it('a missing local file is a 404 with no drive-disconnected line', async () => {
    const { svc, log } = makeService()
    await attach(svc, copyFixtureLibrary())
    const handler = createAnimeVideoHandler({
      getActiveDownload: () => null,
      onUnreadable: (fp, err) => void svc.reportUnreadable(fp, err)
    })
    const local = path.join(tempRoot(), 'gone.mp4')
    const res = await handler(new Request('anime-video://' + encodeURIComponent(local)))
    expect(res.status).toBe(404)
    expect(disconnectLines(log)).toHaveLength(0)
  })
})

const hasFfmpeg =
  (spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf-8' }).stdout ?? '').includes(
    'libx264'
  ) && spawnSync('ffprobe', ['-version']).status === 0

describe.skipIf(!hasFfmpeg)('MSE mid-play (real ffmpeg)', () => {
  let longMkv: string

  beforeAll(() => {
    // 60 s of 160x90 H.264 + AAC, so a seek to 45 s is outside what the first run sent.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-dl-disconnect-mkv-'))
    longMkv = path.join(dir, 'long.mkv')
    const r = spawnSync(
      'ffmpeg',
      [
        ...['-hide_banner', '-loglevel', 'error', '-y'],
        ...['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24'],
        ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
        ...['-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48'],
        ...['-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', longMkv]
      ],
      { encoding: 'utf-8' }
    )
    if (r.status !== 0) throw new Error(`fixture build failed: ${r.stderr}`)
    return () => fs.rmSync(dir, { recursive: true, force: true })
  })

  async function rig(): Promise<{
    root: string
    file: string
    open: () => Promise<MseOpenResult>
    openRaw: () => Promise<MseOpenResult | PlayerOpenError>
    seek: (sessionId: string, t: number) => Promise<unknown>
    errors: PlayerStreamErrorPayload[]
    session: (id: string) => MseSession | undefined
    cleanupAll: () => Promise<void>
  }> {
    const { svc, store } = makeService()
    const root = copyFixtureLibrary()
    fs.copyFileSync(longMkv, path.join(root, MKV))
    await attach(svc, root)
    const tmpDir = path.join(tempRoot(), 'remux')
    const streamingService = createStreamingService({
      tmpDir,
      getFfmpegPath: () => 'ffmpeg',
      getFfprobePath: () => 'ffprobe',
      classifyExit: (input) => svc.classifyMissing(input),
      channels: {
        streamChunk: EVENT_CHUNK,
        streamEnd: 'player:stream-end',
        streamError: EVENT_ERROR,
        streamProgress: 'player:stream-progress'
      }
    })
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    registerPlayer({
      store,
      streamingService,
      smotretApi: {},
      coldStorageService: {},
      mp4StatsService: {},
      // No ffprobe: no subtitle extraction writing into the tmpDir.
      getFfmpegPath: () => 'ffmpeg',
      getFfprobePath: () => '',
      attachedLibraryService: svc
    } as unknown as AppDeps)
    const handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
    const errors: PlayerStreamErrorPayload[] = []
    const event = {
      sender: {
        id: 1,
        isDestroyed: () => false,
        send: (channel: string, payload: unknown): void => {
          if (channel === EVENT_ERROR) errors.push(payload as PlayerStreamErrorPayload)
        }
      }
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = path.join(root, MKV)
    return {
      root,
      file,
      openRaw: async () =>
        (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(event, file, 0)) as
          | MseOpenResult
          | PlayerOpenError,
      open: async () => {
        const res = (await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(event, file, 0)) as
          | MseOpenResult
          | PlayerOpenError
        if ('error' in res) throw new Error(res.error)
        await handlers.get(CHANNELS.PLAYER_STREAM_START)!(event, res.sessionId)
        return res
      },
      seek: (sessionId, t) =>
        Promise.resolve(handlers.get(CHANNELS.PLAYER_STREAM_SEEK)!(event, sessionId, t)),
      errors,
      session: (id) => streamingService.getSession(id),
      cleanupAll: async () => {
        await handlers.get(CHANNELS.PLAYER_CLEANUP_REMUX)!(event)
      }
    }
  }

  const EVENT_CHUNK = 'player:stream-chunk'
  const EVENT_ERROR = 'player:stream-error'

  async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
    const until = Date.now() + ms
    while (!pred()) {
      if (Date.now() > until) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  it('a respawn after the dir is renamed fails with reason drive-disconnected', async () => {
    const r = await rig()
    try {
      const { sessionId } = await r.open()
      fs.renameSync(r.root, `${r.root}-away`)
      await r.seek(sessionId, 45)
      await waitFor(() => r.errors.length > 0)
      expect(r.errors).toEqual([
        { sessionId, error: expect.stringContaining('ffmpeg exited'), reason: 'drive-disconnected' }
      ])
    } finally {
      await r.cleanupAll()
    }
  }, 60_000)

  it('the same failed respawn with the input still present carries no reason: it ends, as on main', async () => {
    const r = await rig()
    try {
      const { sessionId } = await r.open()
      // Still there, but no longer a file ffmpeg can read: the respawn exits non-zero.
      fs.writeFileSync(r.file, 'not a matroska file')
      await r.seek(sessionId, 45)
      await waitFor(() => r.session(sessionId)?.done === true)
      await new Promise((res) => setTimeout(res, 50))
      expect(r.errors).toEqual([])
      expect(r.session(sessionId)?.endPending).toBe(true)
    } finally {
      await r.cleanupAll()
    }
  }, 60_000)

  it('an open after the drive is gone returns the reason (the open-time result)', async () => {
    const r = await rig()
    expect(await r.openRaw()).not.toHaveProperty('error')
    await r.cleanupAll()
    fs.renameSync(r.root, `${r.root}-away`)
    expect(await r.openRaw()).toEqual({ error: 'File not found', reason: 'drive-disconnected' })
  }, 60_000)
})

describe('Retry at a new root', () => {
  it("re-resolves through player:find-local-file, and the reopened session's spawn gets the \\\\?\\ form of the NEW path", async () => {
    // Windows' `\\?\` form stood in for on POSIX, as S7a's spawn test does.
    const marked = (p: string): string => `\\\\?\\${p}`
    const { svc, store } = makeService({ spawnPath: { ...path, toNamespacedPath: marked } })
    const mounts = tempRoot()
    const oldRoot = path.join(mounts, 'E', 'Fixture library')
    fs.mkdirSync(path.dirname(oldRoot), { recursive: true })
    fs.cpSync(copyFixtureLibrary(), oldRoot, { recursive: true })
    await attach(svc, oldRoot)

    // Unplugged, then back under another letter: the poller's two calls.
    const newRoot = path.join(mounts, 'F', 'Fixture library')
    fs.mkdirSync(path.dirname(newRoot), { recursive: true })
    fs.renameSync(oldRoot, newRoot)
    svc.markUnavailable(FIXTURE_LIBRARY_ID, oldRoot)
    expect(await svc.reopenAt(FIXTURE_LIBRARY_ID, newRoot)).toBe(true)

    const streaming = {
      tmpDir: path.join(tempRoot(), 'remux'),
      probeMkvForMse: vi.fn().mockResolvedValue({
        duration: 1420,
        videoCodec: 'h264',
        audioCodecName: 'aac',
        audioStrategy: 'copy',
        streamCopyMimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
        audioCodecString: 'mp4a.40.2'
      }),
      probeCopyTimestampOffset: vi.fn().mockResolvedValue(0),
      registerSession: vi.fn(),
      cleanupSession: vi.fn(),
      spawnFfmpegForSession: vi.fn().mockReturnValue({ kill: vi.fn() })
    }
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    registerPlayer({
      store,
      streamingService: streaming,
      smotretApi: {},
      coldStorageService: {},
      mp4StatsService: { recordCheck: vi.fn() },
      downloadManager: {
        getMergeStatus: vi.fn().mockReturnValue(null),
        getPartialVideoPath: vi.fn().mockReturnValue(null)
      },
      getFfmpegPath: () => '/bin/ffmpeg',
      getFfprobePath: () => '',
      attachedLibraryService: svc
    } as unknown as AppDeps)
    const handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const ev = { sender: { id: 1, isDestroyed: () => false, send: () => {} } }

    const found = (await handlers.get(CHANNELS.PLAYER_FIND_LOCAL_FILE)!(
      ev,
      'Dungeon Meshi',
      '1',
      9101,
      '1',
      202
    )) as PlayerLocalFileResult
    const onNew = path.join(fs.realpathSync(newRoot), MKV)
    expect(found).toMatchObject({ filePath: onNew, libraryId: FIXTURE_LIBRARY_ID })

    await handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(ev, found.filePath, 0)
    const session = streaming.spawnFfmpegForSession.mock.calls[0][0] as MseSession
    expect(session.mkvPath).toBe(marked(onNew))
    expect(session.inputPath).toBe(onNew)
    expect(streaming.probeMkvForMse).toHaveBeenCalledWith(marked(onNew))
    expect(JSON.stringify(streaming.spawnFfmpegForSession.mock.calls)).not.toContain(
      path.join('E', 'Fixture library')
    )
  })
})
