// The ffmpeg mutex (#576): one ffmpeg at a time across the download queue's
// merge cycle, Scan & merge and a Shared Library export's merge. The lock is
// taken per merge and handed FIFO, so a waiting export runs after at most the
// one queue merge or scan file holding it. Driven through `setFfmpegDriver`
// with fake commands that end only when the test says so.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DownloadManager,
  type DownloadItem,
  type ExportMergeOptions,
  type MergeStatus
} from '../../src/main/download-manager'
import { VIDEO_CODEC_OPTIONS } from '../../src/shared/video-codecs'
import { fakeFfmpeg, flush, until, type FakeFfmpeg } from '../helpers/fake-ffmpeg'

const FFMPEG = '/fake/ffmpeg'
const FFPROBE = '/fake/ffprobe'

function makeItem(overrides: Partial<DownloadItem>): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: 'ep1.mp4',
    animeName: 'Anime',
    episodeLabel: 'ep1',
    animeId: 100,
    episodeInt: '1',
    quality: 720,
    translationType: 'subRu',
    author: 'Author',
    status: 'completed',
    bytesReceived: 0,
    totalBytes: 0,
    speed: 0,
    ...overrides
  }
}

type Internals = {
  queue: DownloadItem[]
  mergeStatuses: Map<number, { status: MergeStatus; error?: string; percent?: number }>
  cancelledMerges: Set<number>
  persistQueue: () => void
}

describe('DownloadManager ffmpeg mutex and mergeForExport (#576)', () => {
  let userDataDir: string
  let downloadDir: string
  let exportSrc: string
  let target: string
  let dm: DownloadManager
  let ff: FakeFfmpeg
  let held: boolean

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-xmerge-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-xmerge-dl-'))
    exportSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-xmerge-src-'))
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-xmerge-drive-'))
    dm = new DownloadManager(downloadDir, {} as never, userDataDir)
    ff = fakeFfmpeg()
    dm.setFfmpegDriver(ff.driver)
    held = false
    dm.setMergeHoldCheck(() => held)
  })

  afterEach(() => {
    dm.destroy()
    for (const d of [userDataDir, downloadDir, exportSrc, target]) {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  const internals = (): Internals => dm as unknown as Internals

  /** `n` completed episodes in the queue, each 'pending' and persisted. */
  function seedGroups(n: number): void {
    const queue: DownloadItem[] = []
    for (let i = 1; i <= n; i++) {
      fs.writeFileSync(path.join(downloadDir, `ep${i}.mp4`), `video ${i}`)
      queue.push(
        makeItem({
          id: `video-${i}`,
          translationId: i,
          filename: `ep${i}.mp4`,
          episodeInt: String(i),
          episodeLabel: `ep${i}`
        })
      )
      internals().mergeStatuses.set(i, { status: 'pending' })
    }
    internals().queue = queue
    internals().persistQueue()
  }

  const persisted = (tid: number): string | undefined => {
    const file = path.join(userDataDir, 'queue.json')
    if (!fs.existsSync(file)) return undefined
    return JSON.parse(fs.readFileSync(file, 'utf-8')).mergeStatuses?.[String(tid)]?.status
  }

  function exportOpts(over: Partial<ExportMergeOptions> = {}): ExportMergeOptions {
    const videoPath = path.join(exportSrc, 'Show - 01 [Studio].mp4')
    const subtitlePath = path.join(exportSrc, 'Show - 01 [Studio].ass')
    if (!fs.existsSync(videoPath)) fs.writeFileSync(videoPath, 'export video')
    if (!fs.existsSync(subtitlePath)) fs.writeFileSync(subtitlePath, '[Script Info]')
    return {
      jobId: 'job-1',
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      videoPath,
      subtitlePath,
      outputPath: path.join(target, 'Show - 01.mkv.anime-dl-tmp.mkv'),
      codec: 'copy',
      subMeta: { language: 'rus', title: 'Studio' },
      ...over
    }
  }
  const isExport = (i: number): boolean => ff.commands[i]?.inputs[0].startsWith(exportSrc) ?? false
  const inputName = (i: number): string => path.basename(ff.commands[i].inputs[0])

  describe('no overlap', () => {
    it('an export merge creates no command while a queue merge runs, and runs after it', async () => {
      seedGroups(1)
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await until(() => ff.commands.length === 1, 'the queue command')

      let waited = false
      const exp = dm.mergeForExport(exportOpts({ onWaiting: () => (waited = true) }))
      for (let i = 0; i < 5; i++) await flush()
      expect(ff.commands).toHaveLength(1)
      expect(waited).toBe(true)

      ff.commands[0].finish()
      await until(() => ff.commands.length === 2, 'the export command')
      expect(isExport(1)).toBe(true)
      ff.commands[1].finish()
      expect(await exp).toBe('done')
      await cycle
      expect(ff.commands).toHaveLength(2)
    })

    it('a queue group waits behind an export merge', async () => {
      seedGroups(1)
      const exp = dm.mergeForExport(exportOpts())
      await until(() => ff.commands.length === 1, 'the export command')
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      for (let i = 0; i < 5; i++) await flush()
      expect(ff.commands).toHaveLength(1)

      ff.commands[0].finish()
      expect(await exp).toBe('done')
      await until(() => ff.commands.length === 2, 'the queue command')
      expect(inputName(1)).toBe('ep1.mp4')
      ff.commands[1].finish()
      await cycle
      expect(dm.getMergeStatus(1)).toBe('completed')
    })
  })

  it('no starvation: a waiting export runs right after the queue merge holding the lock, however many triggers arrive', async () => {
    seedGroups(3)
    const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
    await until(() => ff.commands.length === 1, 'group 1')
    expect(inputName(0)).toBe('ep1.mp4')

    const exp = dm.mergeForExport(exportOpts())
    await flush()
    // More triggers: `mergeRequested` keeps the cycle alive.
    void dm.mergeCompleted(FFMPEG, FFPROBE)
    void dm.mergeCompleted(FFMPEG, FFPROBE)
    for (let i = 0; i < 5; i++) await flush()
    expect(ff.commands).toHaveLength(1)

    ff.commands[0].finish()
    await until(() => ff.commands.length === 2, 'the next command')
    expect(isExport(1)).toBe(true)
    for (let i = 0; i < 5; i++) await flush()
    expect(ff.commands).toHaveLength(2)

    ff.commands[1].finish()
    expect(await exp).toBe('done')
    await until(() => ff.commands.length === 3, 'group 2')
    expect(inputName(2)).toBe('ep2.mp4')
    ff.commands[2].finish()
    await until(() => ff.commands.length === 4, 'group 3')
    expect(inputName(3)).toBe('ep3.mp4')
    ff.commands[3].finish()
    await cycle
    expect(ff.commands).toHaveLength(4)
    expect([1, 2, 3].map((t) => dm.getMergeStatus(t))).toEqual([
      'completed',
      'completed',
      'completed'
    ])
  })

  describe('Scan & merge', () => {
    function seedScan(n: number): void {
      const dir = path.join(downloadDir, 'Show')
      fs.mkdirSync(dir)
      for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(dir, `s${i}.mp4`), `scan ${i}`)
    }

    it('a waiting export runs right after the current scan file', async () => {
      seedScan(3)
      const scan = dm.scanAndMerge(FFMPEG, FFPROBE)
      await until(() => ff.commands.length === 1, 'scan file 1')
      const exp = dm.mergeForExport(exportOpts())
      for (let i = 0; i < 5; i++) await flush()
      expect(ff.commands).toHaveLength(1)

      ff.commands[0].finish()
      await until(() => ff.commands.length === 2, 'the next command')
      expect(isExport(1)).toBe(true)
      for (let i = 0; i < 5; i++) await flush()
      expect(ff.commands).toHaveLength(2)
      ff.commands[1].finish()
      expect(await exp).toBe('done')
      await until(() => ff.commands.length === 3, 'scan file 2')
      ff.commands[2].finish()
      await until(() => ff.commands.length === 4, 'scan file 3')
      ff.commands[3].finish()
      expect(await scan).toEqual({ merged: 3, failed: [] })
    })

    it('a scan started while an export merges waits for that file, then completes (no busy reply)', async () => {
      seedScan(1)
      const exp = dm.mergeForExport(exportOpts())
      await until(() => ff.commands.length === 1, 'the export command')
      const scan = dm.scanAndMerge(FFMPEG, FFPROBE)
      for (let i = 0; i < 5; i++) await flush()
      expect(ff.commands).toHaveLength(1)

      ff.commands[0].finish()
      expect(await exp).toBe('done')
      await until(() => ff.commands.length === 2, 'the scan command')
      ff.commands[1].finish()
      expect(await scan).toEqual({ merged: 1, failed: [] })
    })
  })

  describe('cycle semantics, with a queue group waiting behind an export', () => {
    async function exportRunningGroupWaiting(): Promise<{
      exp: Promise<string>
      cycle: Promise<void>
    }> {
      seedGroups(1)
      const exp = dm.mergeForExport(exportOpts())
      await until(() => ff.commands.length === 1, 'the export command')
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      for (let i = 0; i < 5; i++) await flush()
      expect(ff.commands).toHaveLength(1)
      return { exp, cycle }
    }

    it('a global Cancel while waiting ends the pass after the acquire: no queue command, still pending', async () => {
      const { exp, cycle } = await exportRunningGroupWaiting()
      dm.cancelMerge()
      ff.commands[0].finish()
      expect(await exp).toBe('done')
      await cycle
      expect(ff.commands).toHaveLength(1)
      expect(dm.getMergeStatus(1)).toBe('pending')
      expect(persisted(1)).toBe('pending')
      expect(internals().cancelledMerges.size).toBe(0)
    })

    it('a hold that goes up while waiting stops the group at the gate; resumeHeldMerges merges it once', async () => {
      const { exp, cycle } = await exportRunningGroupWaiting()
      held = true
      ff.commands[0].finish()
      expect(await exp).toBe('done')
      await cycle
      expect(ff.commands).toHaveLength(1)
      expect(dm.getMergeStatus(1)).toBe('pending')

      held = false
      expect(dm.takeHeldRequest()).toBe(true)
      const resumed = dm.mergeCompleted(FFMPEG, FFPROBE)
      await until(() => ff.commands.length === 2, 'the resumed merge')
      expect(inputName(1)).toBe('ep1.mp4')
      ff.commands[1].finish()
      await resumed
      expect(dm.getMergeStatus(1)).toBe('completed')
      expect(ff.commands).toHaveLength(2)
    })

    it('persist order: pending on disk while waiting, merging on disk before its command', async () => {
      const { exp, cycle } = await exportRunningGroupWaiting()
      expect(persisted(1)).toBe('pending')
      let onDiskAtCreate: string | undefined
      ff.onCreate = () => {
        onDiskAtCreate = persisted(1)
      }
      ff.commands[0].finish()
      await exp
      await until(() => ff.commands.length === 2, 'the queue command')
      expect(onDiskAtCreate).toBe('merging')
      ff.commands[1].finish()
      await cycle
    })

    it('a queue trigger during an export merge is not lost', async () => {
      const { exp, cycle } = await exportRunningGroupWaiting()
      ff.commands[0].finish()
      await exp
      await until(() => ff.commands.length === 2, 'the queue command')
      ff.commands[1].finish()
      await cycle
      expect(dm.getMergeStatus(1)).toBe('completed')
      expect(fs.existsSync(path.join(downloadDir, 'ep1.mkv'))).toBe(true)
    })
  })

  describe('cancel scoping', () => {
    it("a global Cancel doesn't kill an export merge, and the export completes", async () => {
      const exp = dm.mergeForExport(exportOpts())
      await until(() => ff.commands.length === 1, 'the export command')
      dm.cancelMerge()
      dm.cancelMerge(7)
      await flush()
      expect(ff.commands[0].signals).toEqual([])
      ff.commands[0].finish()
      expect(await exp).toBe('done')
      expect(fs.readFileSync(exportOpts().outputPath, 'utf8')).toBe('merged')
    })

    it('a global Cancel during a queue merge still kills it', async () => {
      seedGroups(1)
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await until(() => ff.commands.length === 1, 'the queue command')
      dm.cancelMerge()
      expect(ff.commands[0].signals).toEqual(['SIGKILL'])
      await cycle
      expect(dm.getMergeStatus(1)).toBeNull()
    })

    it('cancelExportMerge on a waiting export rejects at once, before the merge in front ends, and leaves the queue', async () => {
      seedGroups(2)
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await until(() => ff.commands.length === 1, 'group 1')
      const exp = dm.mergeForExport(exportOpts())
      let outcome: string | null = null
      void exp.then(
        () => (outcome = 'resolved'),
        (e: Error) => (outcome = e.name)
      )
      for (let i = 0; i < 5; i++) await flush()
      dm.cancelExportMerge('job-1')
      // Group 1 is still running: the export gave up its place anyway.
      await until(() => outcome !== null, 'the export to give up its wait')
      expect(outcome).toBe('AbortError')
      expect(ff.commands[0].settled).toBe(false)

      // Group 2 is next in line, and nothing of the export ever ran.
      ff.commands[0].finish()
      await until(() => ff.commands.length === 2, 'group 2')
      expect(inputName(1)).toBe('ep2.mp4')
      ff.commands[1].finish()
      await cycle
      expect(ff.probes.filter((p) => p.startsWith(exportSrc))).toEqual([])
      expect(ff.commands).toHaveLength(2)

      // The lock isn't stuck on the export that left.
      const again = dm.mergeForExport(exportOpts())
      await until(() => ff.commands.length === 3, 'a later export merge')
      ff.commands[2].finish()
      expect(await again).toBe('done')
    })

    it('cancelExportMerge kills only its own job, and stops one still waiting before it spawns', async () => {
      seedGroups(1)
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await until(() => ff.commands.length === 1, 'the queue command')
      const exp = dm.mergeForExport(exportOpts())
      await flush()
      dm.cancelExportMerge('job-1')
      expect(ff.commands[0].signals).toEqual([])
      ff.commands[0].finish()
      await expect(exp).rejects.toMatchObject({ name: 'AbortError' })
      await cycle
      expect(ff.commands).toHaveLength(1)

      const running = dm.mergeForExport(exportOpts())
      await until(() => ff.commands.length === 2, 'the export command')
      dm.cancelExportMerge('another-job')
      expect(ff.commands[1].signals).toEqual([])
      dm.cancelExportMerge('job-1')
      expect(ff.commands[1].signals).toEqual(['SIGKILL'])
      await expect(running).rejects.toThrow(/killed/)
    })
  })

  it('destroy() during an export merge kills it and unlinks its temp output; a waiting group spawns nothing and stays pending', async () => {
    seedGroups(1)
    const opts = exportOpts()
    const exp = dm.mergeForExport(opts)
    await until(() => ff.commands.length === 1, 'the export command')
    fs.writeFileSync(opts.outputPath, 'partial')
    const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
    await flush()

    dm.destroy()
    expect(ff.commands[0].signals).toEqual(['SIGKILL'])
    expect(ff.unlinks).toEqual([opts.outputPath])
    expect(fs.existsSync(opts.outputPath)).toBe(false)
    await expect(exp).rejects.toMatchObject({ name: 'MergeQuitError' })
    await cycle
    expect(ff.commands).toHaveLength(1)
    expect(persisted(1)).toBe('pending')
    expect(fs.existsSync(opts.videoPath)).toBe(true)
    expect(fs.existsSync(opts.subtitlePath!)).toBe(true)
  })

  describe('the hold', () => {
    it('held at entry: returns held, and ffprobe never runs', async () => {
      held = true
      expect(await dm.mergeForExport(exportOpts())).toBe('held')
      expect(ff.probes).toEqual([])
      expect(ff.commands).toHaveLength(0)
    })

    it('held during the probe: still held, with no command', async () => {
      ff.setProbe(async () => {
        held = true
        return 60
      })
      expect(await dm.mergeForExport(exportOpts())).toBe('held')
      expect(ff.probes).toHaveLength(1)
      expect(ff.commands).toHaveLength(0)
    })

    it('never sets the queue held request', async () => {
      held = true
      await dm.mergeForExport(exportOpts())
      expect(dm.takeHeldRequest()).toBe(false)
    })
  })

  it("returns 'gone' when the source went while it waited, without spawning", async () => {
    const opts = exportOpts()
    fs.unlinkSync(opts.videoPath)
    expect(await dm.mergeForExport(opts)).toBe('gone')
    expect(ff.probes).toEqual([])
  })

  it('never touches queue state or the sources', async () => {
    seedGroups(1)
    const opts = exportOpts()
    const before = fs.readFileSync(path.join(userDataDir, 'queue.json'), 'utf8')
    const exp = dm.mergeForExport(opts)
    await until(() => ff.commands.length === 1, 'the export command')
    ff.commands[0].finish()
    await exp
    await flush()
    expect(fs.readFileSync(path.join(userDataDir, 'queue.json'), 'utf8')).toBe(before)
    expect(fs.existsSync(opts.videoPath)).toBe(true)
    expect(fs.existsSync(opts.subtitlePath!)).toBe(true)
  })

  it('merges the subtitle with the same language and title metadata as the queue', async () => {
    const exp = dm.mergeForExport(exportOpts())
    await until(() => ff.commands.length === 1, 'the export command')
    const cmd = ff.commands[0]
    expect(cmd.inputs).toEqual([exportOpts().videoPath, exportOpts().subtitlePath])
    expect(cmd.args).toEqual(
      expect.arrayContaining(['-c:s', 'ass', 'language=rus', 'title=Studio'])
    )
    cmd.finish()
    await exp
  })

  it.each(VIDEO_CODEC_OPTIONS.map((c) => c.value))(
    'never downscales: codec %s gets no scale filter or size',
    async (codec) => {
      const exp = dm.mergeForExport(exportOpts({ codec }))
      await until(() => ff.commands.length === 1, 'the export command')
      const cmd = ff.commands[0]
      expect(cmd.codec).toBe(codec)
      const resizing = ['size', 'videoFilters', 'videoFilter', 'aspect', 'autopad', 'complexFilter']
      expect(cmd.calls.filter((c) => resizing.includes(c.method))).toEqual([])
      for (const arg of cmd.args) {
        expect(arg).not.toMatch(/scale/i)
        expect(['-s', '-vf', '-filter:v', '-filter_complex', '-lavfi']).not.toContain(arg)
      }
      cmd.finish()
      await exp
    }
  )
})
