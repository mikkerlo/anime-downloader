// Opening a Shared Library and playing from it (#578), through the real
// `shared-library` and `player` routers, the real AttachedLibraryService and
// the real ColdStorageService on a temp download root.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { register as registerPlayer } from '../../src/main/ipc/player.ipc'
import { register as registerSharedLibrary } from '../../src/main/ipc/shared-library.ipc'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { ROOT_KEYS } from '../../src/shared/storage-roots'
import { createAttachedLibraryService } from '../../src/main/services/attached-library'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import { sanitizeFilename } from '../../src/main/download-manager'
import { parseEpisodeFromFilename } from '../../src/main/lib/filename'
import type { AppDeps } from '../../src/main/ipc'
import { makeHarness } from '../helpers/app-harness'
import { cleanup, tempRoot } from '../helpers/shared-library'
import {
  FIXTURE_LIBRARY,
  FIXTURE_LIBRARY_ID,
  copyFixtureLibrary
} from '../helpers/attached-library'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const MP4 = 'Frieren~3f2a1c/Frieren~3f2a1c - 01 [Crunchyroll].mp4'
const MKV = 'Dungeon Meshi/Dungeon Meshi - 01 [AniLibria].mkv'
const OWNER = { id: 4242, nickname: 'owner', avatar: '' }

let handlers: Map<string, Handler>
let downloadDir: string
let drive: string
let getMergeStatus: ReturnType<typeof vi.fn>
let getPartialVideoPath: ReturnType<typeof vi.fn>
let harness: ReturnType<typeof makeHarness>
let deps: AppDeps

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return Promise.resolve(handlers.get(channel)!({ sender: { id: 1 } }, ...args) as T)
}

const findLocal = (
  animeName: string,
  episodeInt: string,
  translationId: number,
  animeId?: number
): Promise<PlayerLocalFileResult | null> =>
  call(CHANNELS.PLAYER_FIND_LOCAL_FILE, animeName, episodeInt, translationId, episodeInt, animeId)

async function open(dir = drive): Promise<SharedLibraryAttachResult> {
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [dir] })
  const found = await call<SharedLibraryDiscovery>(CHANNELS.SHARED_LIBRARY_PICK_AND_DISCOVER)
  expect(found.candidates.map((c) => c.libraryId)).toEqual([FIXTURE_LIBRARY_ID])
  return call(CHANNELS.SHARED_LIBRARY_ATTACH, FIXTURE_LIBRARY_ID)
}

/** A local download of Frieren 01 in the app's own download root, under its rebuilt name. */
function localDownload(): string {
  harness.store.set('downloadedEpisodes', {
    '101:1': { translationType: 'subRu', author: 'Crunchyroll', quality: 1080, translationId: 9001 }
  })
  const dir = path.join(downloadDir, 'Frieren')
  fs.mkdirSync(dir, { recursive: true })
  const fp = path.join(dir, 'Frieren - 01 [Crunchyroll].mp4')
  fs.copyFileSync(path.join(FIXTURE_LIBRARY, MP4), fp)
  return fp
}

beforeEach(() => {
  downloadDir = fs.realpathSync(tempRoot())
  drive = copyFixtureLibrary()
  getMergeStatus = vi.fn().mockReturnValue(null)
  getPartialVideoPath = vi.fn().mockReturnValue(null)
  harness = makeHarness({
    shikimoriUser: OWNER,
    downloadDir,
    storageMode: 'simple',
    hotStorageDir: '',
    coldStorageDir: '',
    downloadedEpisodes: {},
    downloadedAnime: {},
    watchProgress: {},
    attachedLibraries: {}
  })
  const coldStorageService = createColdStorageService({
    store: harness.store as never,
    downloadsFallbackDir: downloadDir,
    sanitizeFilename,
    parseEpisodeFromFilename,
    scanEpisodeFiles: () => ({}),
    invalidateFileCache: () => {},
    broadcast: harness.broadcast,
    usageProgressChannel: 'usage-progress',
    cleanupPendingChannel: 'cleanup-pending',
    cleanupFinishedChannel: 'cleanup-finished',
    fileEpisodesChangedChannel: 'file-episodes-changed'
  })
  const attachedLibraryService = createAttachedLibraryService({
    store: harness.store,
    checkFfmpeg: async () => ({ available: true }),
    onChanged: () => harness.broadcast('shared-libraries:changed'),
    log: { log: () => {}, warn: () => {}, error: () => {} }
  })
  deps = {
    store: harness.store,
    smotretApi: {},
    coldStorageService,
    streamingService: {},
    mp4StatsService: { recordCheck: vi.fn() },
    downloadManager: { getMergeStatus, getPartialVideoPath },
    playerLockService: { open: vi.fn(), close: vi.fn() },
    playerPresenceService: { open: vi.fn(), close: vi.fn() },
    getFfmpegPath: () => '',
    getFfprobePath: () => '',
    attachedLibraryService
  } as unknown as AppDeps
  ;(BrowserWindow as unknown as { fromWebContents: () => null }).fromWebContents = () => null
  ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
  registerPlayer(deps)
  registerSharedLibrary(deps)
  handlers = new Map(
    (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('the open flow over IPC', () => {
  it('pick → discover → attach → list, with the titles from the snapshot', async () => {
    const res = await open()
    expect(res.ok).toBe(true)
    const list = await call<AttachedLibraryInfo[]>(CHANNELS.SHARED_LIBRARY_LIST)
    expect(list.map((l) => [l.name, l.role, l.titles.map((t) => t.name)])).toEqual([
      ['Fixture library', 'owner', ['Frieren', 'Dungeon Meshi']]
    ])
    expect(harness.broadcasts().map((b) => b.channel)).toContain('shared-libraries:changed')
    const title = await call<AttachedTitleDetail>(
      CHANNELS.SHARED_LIBRARY_GET_TITLE,
      FIXTURE_LIBRARY_ID,
      202
    )
    expect(title.episodes[0].items[0]).toMatchObject({ translationId: 9101, container: 'mkv' })
  })

  it('a cancelled dialog discovers nothing', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await call(CHANNELS.SHARED_LIBRARY_PICK_AND_DISCOVER)).toEqual({
      dir: null,
      candidates: []
    })
  })
})

describe('PLAYER_FIND_LOCAL_FILE with animeId', () => {
  it("resolves a shortened item path from the manifest; the title-rebuilt path doesn't find it", async () => {
    await open()
    const hit = await findLocal('Frieren', '1', 9001, 101)
    expect(hit?.filePath).toBe(fs.realpathSync(path.join(drive, MP4)))
    expect(hit?.subtitleContent).toContain('fixture subtitle')
    // Without the manifest branch (no animeId), only the rebuilt name is tried.
    expect(await findLocal('Frieren', '1', 9001)).toBeNull()
  })

  it('refuses an item whose path leads outside the root', async () => {
    const outside = tempRoot()
    fs.cpSync(path.join(drive, 'Dungeon Meshi'), outside, { recursive: true })
    fs.rmSync(path.join(drive, 'Dungeon Meshi'), { recursive: true })
    fs.symlinkSync(outside, path.join(drive, 'Dungeon Meshi'))
    await open()
    expect(await findLocal('Dungeon Meshi', '1', 9101, 202)).toBeNull()
  })

  it('re-checks at play time: a file swapped for a symlink out of the root after attaching is refused', async () => {
    await open()
    expect(await findLocal('Dungeon Meshi', '1', 9101, 202)).not.toBeNull()
    const outside = path.join(tempRoot(), 'elsewhere.mkv')
    fs.copyFileSync(path.join(drive, MKV), outside)
    fs.rmSync(path.join(drive, MKV))
    fs.symlinkSync(outside, path.join(drive, MKV))
    expect(await findLocal('Dungeon Meshi', '1', 9101, 202)).toBeNull()
  })

  it('local wins; after the local file is deleted, the drive path is returned', async () => {
    await open()
    const local = localDownload()
    expect((await findLocal('Frieren', '1', 9001, 101))?.filePath).toBe(local)
    fs.rmSync(local)
    expect((await findLocal('Frieren', '1', 9001, 101))?.filePath).toBe(
      fs.realpathSync(path.join(drive, MP4))
    )
  })

  describe('each null exit falls through to the drive', () => {
    it('mid-merge', async () => {
      await open()
      localDownload()
      getMergeStatus.mockReturnValue('merging')
      expect((await findLocal('Frieren', '1', 9001, 101))?.filePath).toBe(
        fs.realpathSync(path.join(drive, MP4))
      )
      expect(getPartialVideoPath).not.toHaveBeenCalled()
    })

    it('no metadata', async () => {
      await open()
      expect((await findLocal('Frieren', '1', 9001, 101))?.filePath).toBe(
        fs.realpathSync(path.join(drive, MP4))
      )
      expect(getPartialVideoPath).toHaveBeenCalledWith(9001)
    })

    it('metadata, but no final file', async () => {
      await open()
      fs.rmSync(localDownload())
      expect((await findLocal('Frieren', '1', 9001, 101))?.filePath).toBe(
        fs.realpathSync(path.join(drive, MP4))
      )
      expect(getPartialVideoPath).toHaveBeenCalledWith(9001)
    })
  })

  it('a local faststart .part beats the drive', async () => {
    await open()
    const part = path.join(downloadDir, 'Frieren', 'Frieren - 01 [Crunchyroll].mp4.part')
    fs.mkdirSync(path.dirname(part), { recursive: true })
    fs.copyFileSync(path.join(FIXTURE_LIBRARY, MP4), part)
    getPartialVideoPath.mockReturnValue({ partPath: part, totalBytes: 4096 })
    const hit = await findLocal('Frieren', '1', 9001, 101)
    expect(hit).toMatchObject({ filePath: part, isPartial: true })
  })

  it('an episode no library holds stays null', async () => {
    await open()
    expect(await findLocal('Frieren', '2', 9001, 101)).toBeNull()
  })
})

describe('spawn paths', () => {
  // Windows' `\\?\` form, stood in on POSIX: the routing is what this pins.
  const marked = (p: string): string => `\\\\?\\${p}`

  function remuxDeps(): {
    streaming: Record<string, ReturnType<typeof vi.fn>>
    handler: (filePath: string) => Promise<unknown>
    transcode: (filePath: string) => Promise<unknown>
  } {
    const tmp = tempRoot()
    const streaming = {
      probeMkvForMse: vi.fn().mockResolvedValue({
        duration: 2,
        videoCodec: 'h264',
        audioCodecName: 'aac',
        audioStrategy: 'copy',
        streamCopyMimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
        audioCodecString: 'mp4a.40.2'
      }),
      probeCopyTimestampOffset: vi.fn().mockResolvedValue(0),
      probeSeekAnchor: vi.fn().mockResolvedValue(0),
      pickH264Encoder: vi.fn().mockResolvedValue({ name: 'libx264', videoArgs: [] }),
      registerSession: vi.fn(),
      cleanupSession: vi.fn(),
      spawnFfmpegForSession: vi.fn().mockReturnValue({ kill: vi.fn() })
    }
    const service = createAttachedLibraryService({
      store: harness.store,
      checkFfmpeg: async () => ({ available: true }),
      spawnPath: { ...path, toNamespacedPath: marked },
      log: { log: () => {}, warn: () => {}, error: () => {} }
    })
    ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
    registerPlayer({
      ...deps,
      streamingService: { ...streaming, tmpDir: tmp },
      getFfmpegPath: () => '/bin/ffmpeg',
      attachedLibraryService: service
    } as unknown as AppDeps)
    registerSharedLibrary({ ...deps, attachedLibraryService: service } as unknown as AppDeps)
    handlers = new Map(
      (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
    )
    const ev = { sender: { id: 1, isDestroyed: () => false, send: () => {} } }
    return {
      streaming,
      handler: (fp) => Promise.resolve(handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM)!(ev, fp)),
      transcode: (fp) =>
        Promise.resolve(handlers.get(CHANNELS.PLAYER_REMUX_MKV_STREAM_TRANSCODE)!(ev, fp))
    }
  }

  it("the remux session's spawn receives spawnPathFor's result for a drive file", async () => {
    const { streaming, handler, transcode } = remuxDeps()
    await open()
    const onDrive = path.join(drive, MKV)
    await handler(onDrive)
    expect(streaming.probeMkvForMse).toHaveBeenCalledWith(marked(onDrive))
    expect(streaming.probeCopyTimestampOffset.mock.calls[0][0]).toBe(marked(onDrive))
    expect(streaming.spawnFfmpegForSession.mock.calls[0][0].mkvPath).toBe(marked(onDrive))
    await transcode(onDrive)
    expect(streaming.spawnFfmpegForSession.mock.calls[1][0].mkvPath).toBe(marked(onDrive))
  })

  it('a local file keeps exactly its argument', async () => {
    const { streaming, handler } = remuxDeps()
    await open()
    const local = path.join(downloadDir, 'local.mkv')
    fs.copyFileSync(path.join(drive, MKV), local)
    await handler(local)
    expect(streaming.probeMkvForMse).toHaveBeenCalledWith(local)
    expect(streaming.spawnFfmpegForSession.mock.calls[0][0].mkvPath).toBe(local)
  })
})

describe('scan exclusion', () => {
  it('no attached path reaches ROOT_KEYS, the cold-storage roots, cleanup, the usage scan or dirsToCheck', async () => {
    // The drive also holds Frieren 01 under the download folder's own name, so
    // any scan that looked at the drive would find it.
    fs.mkdirSync(path.join(drive, 'Frieren'))
    fs.copyFileSync(
      path.join(FIXTURE_LIBRARY, MP4),
      path.join(drive, 'Frieren', 'Frieren - 01 [Crunchyroll].mp4')
    )
    harness.store.set('downloadedAnime', {
      '101': { id: 101, title: 'Frieren', titles: {}, posterUrlSmall: '' }
    })
    harness.store.set('watchProgress', {
      '101:1': { position: 1, duration: 1, updatedAt: 1, watched: true, watchedAt: 1 }
    })
    harness.store.set('downloadedEpisodes', {
      '101:1': {
        translationType: 'subRu',
        author: 'Crunchyroll',
        quality: 1080,
        translationId: 9001
      }
    })
    await open()

    const real = fs.realpathSync(drive)
    const touches = (p: string): boolean =>
      [drive, real].some((r) => p === r || p.startsWith(r + path.sep))

    for (const key of ROOT_KEYS) expect(touches(String(harness.store.get(key) ?? ''))).toBe(false)
    const cold = deps.coldStorageService
    for (const p of [
      cold.getDownloadDir(),
      cold.getColdStorageDir(),
      ...cold.dirsForScan(),
      ...cold.allConfiguredRoots()
    ]) {
      expect(touches(p)).toBe(false)
    }
    expect(cold.findCleanupCandidates(1)).toEqual([])
    const usage = await cold.scanUsage()
    expect(usage.fileCount).toBe(0)
    // The player's dirsToCheck: the rebuilt name on the drive is never tried.
    expect(await findLocal('Frieren', '1', 9001)).toBeNull()
  })
})
