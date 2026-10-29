// Merge on export (#576): unmerged `.mp4` + `.ass` pairs go into one `.mkv`
// on the target through the download manager's ffmpeg (a real
// `DownloadManager` on a fake driver), behind its mutex and its player hold.
// The local files are never touched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DownloadManager, type DownloadItem } from '../../src/main/download-manager'
import { LIBRARY_DIR } from '../../src/main/lib/shared-library/read'
import { MERGE_TMP_SUFFIX } from '../../src/main/services/shared-library-export/copy'
import type { SharedLibraryExportDeps } from '../../src/main/services/shared-library-export'
import { fakeFfmpeg, flush, until, type FakeFfmpeg } from '../helpers/fake-ffmpeg'
import { makeExportEnv, sel, sha256, type ExportEnv } from '../helpers/shared-library-export'

const FFMPEG = '/fake/ffmpeg'
const FFPROBE = '/fake/ffprobe'

let env: ExportEnv
let dm: DownloadManager
let dmDir: string
let dmUserData: string
let ff: FakeFfmpeg
let ffmpegInfo: { available: boolean; encoders: string[] }

function makeEnv(more: Partial<SharedLibraryExportDeps> = {}): ExportEnv {
  const e = makeExportEnv({
    ffmpegCheck: async () => ffmpegInfo,
    merger: {
      merge: (req) => dm.mergeForExport({ ...req, ffmpegPath: FFMPEG, ffprobePath: FFPROBE }),
      cancel: (jobId) => dm.cancelExportMerge(jobId)
    },
    ...more
  })
  dm.setMergeHoldCheck(() => e.presence.isOpen())
  return e
}

beforeEach(() => {
  dmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmerge-dl-'))
  dmUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'xmerge-ud-'))
  dm = new DownloadManager(dmDir, {} as never, dmUserData)
  ff = fakeFfmpeg()
  dm.setFfmpegDriver(ff.driver)
  ffmpegInfo = { available: true, encoders: ['libx265'] }
})

afterEach(() => {
  dm.destroy()
  env?.cleanup()
  fs.rmSync(dmDir, { recursive: true, force: true })
  fs.rmSync(dmUserData, { recursive: true, force: true })
})

function manifestOf(root: string): SharedLibraryManifest {
  return JSON.parse(fs.readFileSync(path.join(root, LIBRARY_DIR, 'manifest.json'), 'utf8'))
}

function pair(e: ExportEnv, episodeInt = '1', translationId = 11) {
  return e.addEpisode({
    animeId: 202,
    title: 'Beta Show',
    episodeInt,
    translationId,
    ext: 'mp4',
    subtitle: true
  })
}

async function start(
  e: ExportEnv,
  keys: string[],
  more: Partial<ExportStartRequest> = {}
): Promise<ExportJobView> {
  const r = await e.svc.start({ selection: sel(...keys), target: e.drive, name: 'Trip', ...more })
  if (!r.ok) throw new Error(`start refused: ${r.reason}`)
  return r.job
}

const last = (e: ExportEnv): ExportJobView => e.updates[e.updates.length - 1]
const root = (e: ExportEnv): string => path.join(e.drive, 'Trip')

describe('merge on export (#576)', () => {
  it("'merge' writes one .mkv at the target and leaves the local .mp4 and .ass as they were", async () => {
    env = makeEnv()
    const p = pair(env)
    const before = [p.video, p.subtitle!].map((f) => fs.statSync(f).mtimeMs)
    const job = await start(env, [p.key], { unmerged: 'merge' })

    await until(() => ff.commands.length === 1, 'the merge command')
    const cmd = ff.commands[0]
    expect(cmd.inputs).toEqual([p.video, p.subtitle])
    expect(cmd.output_).toBe(
      path.join(root(env), 'Beta Show', `Beta Show - 01 [Studio].mkv${MERGE_TMP_SUFFIX}`)
    )
    expect(cmd.args).toEqual(expect.arrayContaining(['language=rus', 'title=Studio']))
    cmd.progress(47)
    await until(() => last(env).merge?.percent === 47, 'the 47% update')
    expect(last(env).merge).toEqual({ phase: 'merging', percent: 47 })
    cmd.finish('the merged mkv')
    await env.svc.settled(job.jobId)

    expect(last(env).status).toBe('completed')
    expect(last(env).merge).toBeNull()
    // The card's total is the written size once the file is done, not the pair's estimate.
    expect(last(env).bytesTotal).toBe('the merged mkv'.length)
    expect(last(env).bytesDone).toBe('the merged mkv'.length)
    const m = manifestOf(root(env))
    expect(m.items).toHaveLength(1)
    expect(m.items[0].path).toBe('Beta Show/Beta Show - 01 [Studio].mkv')
    expect(m.items[0].subtitlePath).toBeUndefined()
    const files = fs.readdirSync(path.join(root(env), 'Beta Show'))
    expect(files).toEqual(['Beta Show - 01 [Studio].mkv'])
    const mkv = path.join(root(env), 'Beta Show', 'Beta Show - 01 [Studio].mkv')
    expect(fs.readFileSync(mkv, 'utf8')).toBe('the merged mkv')
    expect(m.items[0].sha256).toBe(sha256(mkv))
    expect(m.items[0].size).toBe(fs.statSync(mkv).size)
    expect([p.video, p.subtitle!].map((f) => fs.statSync(f).mtimeMs)).toEqual(before)
  })

  it("'copy-as-is' copies both files, with no ffmpeg", async () => {
    env = makeEnv()
    const p = pair(env)
    const job = await start(env, [p.key], { unmerged: 'copy-as-is' })
    await env.svc.settled(job.jobId)
    expect(ff.commands).toHaveLength(0)
    expect(fs.readdirSync(path.join(root(env), 'Beta Show')).sort()).toEqual([
      'Beta Show - 01 [Studio].ass',
      'Beta Show - 01 [Studio].mp4'
    ])
  })

  it("the codec defaults to copy, not the Merging tab's videoCodec", async () => {
    env = makeEnv()
    env.store.set('videoCodec', 'libx265')
    const p = pair(env)
    const job = await start(env, [p.key], { unmerged: 'merge' })
    await until(() => ff.commands.length === 1, 'the merge command')
    expect(ff.commands[0].codec).toBe('copy')
    ff.commands[0].finish()
    await env.svc.settled(job.jobId)
  })

  it('a re-encode runs with the chosen codec; one this ffmpeg lacks is refused', async () => {
    env = makeEnv()
    const p = pair(env)
    const refused = await env.svc.start({
      selection: sel(p.key),
      target: env.drive,
      name: 'Trip',
      unmerged: 'merge',
      codec: 'hevc_nvenc'
    })
    expect(refused).toEqual({ ok: false, reason: expect.stringContaining('hevc_nvenc') })
    const job = await start(env, [p.key], { unmerged: 'merge', codec: 'libx265' })
    await until(() => ff.commands.length === 1, 'the merge command')
    expect(ff.commands[0].codec).toBe('libx265')
    ff.commands[0].finish()
    await env.svc.settled(job.jobId)
  })

  it('without ffmpeg the plan reports merge as disabled, and the job copies pairs as-is', async () => {
    ffmpegInfo = { available: false, encoders: [] }
    env = makeEnv()
    const p = pair(env)
    const plan = await env.svc.plan({ animeIds: null, target: null, name: 'Trip' })
    expect(plan.merge).toEqual({ available: false, encoders: [] })
    const job = await start(env, [p.key], { unmerged: 'merge', codec: 'libx265' })
    await env.svc.settled(job.jobId)
    expect(ff.commands).toHaveLength(0)
    expect(fs.readdirSync(path.join(root(env), 'Beta Show')).sort()).toEqual([
      'Beta Show - 01 [Studio].ass',
      'Beta Show - 01 [Studio].mp4'
    ])
  })

  it('the plan names a merged pair .mkv, and reports the encoders', async () => {
    env = makeEnv()
    const p = pair(env)
    const plan = await env.svc.plan({
      animeIds: null,
      target: env.drive,
      name: 'Trip',
      unmerged: 'merge'
    })
    expect(plan.merge).toEqual({ available: true, encoders: ['libx265'] })
    const ep = plan.titles[0].translations[0].episodes[0]
    expect(ep).toMatchObject({ key: p.key, unmerged: true })
  })

  it('a re-encode needs its source size plus 10% free', async () => {
    env = makeEnv()
    const p = pair(env)
    const size = fs.statSync(p.video).size + fs.statSync(p.subtitle!).size
    // Enough for a copy merge (size + 1%), not for a re-encode (size + 10% + 1%).
    const free = size + Math.ceil(size * 0.01) + 10
    env.svc = env.restart({ xfs: { statfs: async () => ({ bavail: free, bsize: 1 }) } })
    const r = await env.svc.start({
      selection: sel(p.key),
      target: env.drive,
      name: 'Trip',
      unmerged: 'merge',
      codec: 'libx265'
    })
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('Not enough free space') })
    const ok = await start(env, [p.key], { unmerged: 'merge' })
    await until(() => ff.commands.length === 1, 'the merge command')
    ff.commands[0].finish()
    await env.svc.settled(ok.jobId)
  })

  it('FAT32: a re-encode that fails with "File too large" is skipped, its temp file deleted, and the job goes on', async () => {
    env = makeEnv({ fsTypeProbe: async () => ({ fsType: 'fat32', mountPoint: null }) })
    const a = pair(env, '1', 11)
    const b = pair(env, '2', 12)
    const job = await start(env, [a.key, b.key], { unmerged: 'merge', codec: 'libx265' })
    await until(() => ff.commands.length === 1, 'the first merge')
    const tmp = ff.commands[0].output_!
    ff.commands[0].fail(
      'ffmpeg exited with code 1: av_interleaved_write_frame(): File too large',
      'partial'
    )
    await until(() => ff.commands.length === 2, 'the second merge')
    expect(fs.existsSync(tmp)).toBe(false)
    ff.commands[1].finish()
    await env.svc.settled(job.jobId)
    const v = last(env)
    expect(v.status).toBe('completed')
    expect(v.skipped).toEqual([
      { key: a.key, label: expect.any(String), reason: 'too-large-for-filesystem' }
    ])
    expect(v.failed).toEqual([])
    expect(manifestOf(root(env)).items.map((i) => i.path)).toEqual([
      'Beta Show/Beta Show - 02 [Studio].mkv'
    ])
  })

  it('a merge that fails otherwise fails that item only; no other codec is tried', async () => {
    env = makeEnv()
    const a = pair(env, '1', 11)
    const b = pair(env, '2', 12)
    const job = await start(env, [a.key, b.key], { unmerged: 'merge', codec: 'libx265' })
    await until(() => ff.commands.length === 1, 'the first merge')
    ff.commands[0].fail('ffmpeg exited with code 1: Conversion failed!')
    await until(() => ff.commands.length === 2, 'the second merge')
    expect(ff.commands[1].codec).toBe('libx265')
    ff.commands[1].finish()
    await env.svc.settled(job.jobId)
    expect(last(env).failed).toEqual([
      {
        key: a.key,
        label: expect.any(String),
        reason: expect.stringContaining('Conversion failed')
      }
    ])
  })

  it('waits for a download merge, then is held while the player is open; one release resumes it, with no queue pass', async () => {
    env = makeEnv()
    // A download merge holds the ffmpeg mutex.
    fs.writeFileSync(path.join(dmDir, 'q1.mp4'), 'queue video')
    const internals = dm as unknown as { queue: DownloadItem[] }
    internals.queue = [
      {
        id: 'v1',
        translationId: 900,
        kind: 'video',
        url: 'http://example.invalid/q1.mp4',
        filename: 'q1.mp4',
        animeName: 'Q',
        episodeLabel: 'q1',
        animeId: 9,
        episodeInt: '1',
        quality: 720,
        translationType: 'subRu',
        author: 'A',
        status: 'completed',
        bytesReceived: 0,
        totalBytes: 0,
        speed: 0
      }
    ]
    const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
    await until(() => ff.commands.length === 1, 'the queue merge')

    // `resumeHeldMerges`, registered beside the job's listener.
    let resumeCalls = 0
    let queuePasses = 0
    env.presence.onRelease(() => {
      resumeCalls++
      if (dm.takeHeldRequest()) {
        queuePasses++
        void dm.mergeCompleted(FFMPEG, FFPROBE)
      }
    })

    const p = pair(env)
    const job = await start(env, [p.key], { unmerged: 'merge' })
    await until(() => last(env).merge?.phase === 'waiting', 'Waiting for a download merge')

    env.presence.open = true
    ff.commands[0].finish()
    await cycle
    await until(() => last(env).status === 'held', 'the held job')
    expect(ff.commands).toHaveLength(1)
    expect(ff.probes).toEqual([path.join(dmDir, 'q1.mp4')])

    env.presence.open = false
    env.presence.release.emit()
    await until(() => ff.commands.length === 2, 'the resumed export merge')
    expect(ff.commands[1].inputs[0]).toBe(p.video)
    ff.commands[1].finish()
    await env.svc.settled(job.jobId)
    expect(last(env).status).toBe('completed')
    expect(resumeCalls).toBe(1)
    expect(queuePasses).toBe(0)
    expect(ff.commands).toHaveLength(2)
  })

  for (const kind of ['pause', 'cancel'] as const) {
    it(`${kind} while waiting behind a download merge returns before that merge ends, and nothing of the export runs (#576 review)`, async () => {
      env = makeEnv()
      fs.writeFileSync(path.join(dmDir, 'q1.mp4'), 'queue video')
      ;(dm as unknown as { queue: DownloadItem[] }).queue = [
        {
          id: 'v1',
          translationId: 900,
          kind: 'video',
          url: 'http://example.invalid/q1.mp4',
          filename: 'q1.mp4',
          animeName: 'Q',
          episodeLabel: 'q1',
          animeId: 9,
          episodeInt: '1',
          quality: 720,
          translationType: 'subRu',
          author: 'A',
          status: 'completed',
          bytesReceived: 0,
          totalBytes: 0,
          speed: 0
        }
      ]
      const cycle = dm.mergeCompleted(FFMPEG, FFPROBE)
      await until(() => ff.commands.length === 1, 'the download merge')

      const p = pair(env)
      const job = await start(env, [p.key], { unmerged: 'merge' })
      await until(() => last(env).merge?.phase === 'waiting', 'Waiting for a download merge')

      let stopped = false
      void (kind === 'pause' ? env.svc.pause(job.jobId) : env.svc.cancel(job.jobId)).then(() => {
        stopped = true
      })
      // Before the download merge ends: its command is still running.
      await until(() => stopped, `the ${kind} to return`, 1500)
      expect(ff.commands[0].settled).toBe(false)
      expect(last(env).status).toBe(kind === 'pause' ? 'paused' : 'cancelled')
      expect(last(env).merge).toBeNull()
      expect(last(env).failed).toEqual([])
      expect(ff.commands).toHaveLength(1)
      expect(ff.probes).toEqual([path.join(dmDir, 'q1.mp4')])

      ff.commands[0].finish()
      await cycle
      expect(dm.getMergeStatus(900)).toBe('completed')
      expect(ff.commands).toHaveLength(1)

      if (kind === 'pause') {
        await env.svc.resume(job.jobId)
        await until(() => ff.commands.length === 2, 'the export merge after Resume')
        expect(ff.commands[1].inputs[0]).toBe(p.video)
        ff.commands[1].finish()
        await env.svc.settled(job.jobId)
        expect(last(env).status).toBe('completed')
        expect(manifestOf(root(env)).items.map((i) => i.path)).toEqual([
          'Beta Show/Beta Show - 01 [Studio].mkv'
        ])
      }
    })
  }

  it('a Scan & merge that took the pair while the export waited: the export copies the .mkv it made', async () => {
    env = makeEnv()
    const p = pair(env)
    const scan = dm.scanAndMerge(FFMPEG, FFPROBE, 'copy', undefined, [env.hot])
    await until(() => ff.commands.length === 1, 'the scan merge')
    const job = await start(env, [p.key], { unmerged: 'merge' })
    await until(() => last(env).merge?.phase === 'waiting', 'the export waiting')
    ff.commands[0].finish('scan-made mkv')
    await scan
    await env.svc.settled(job.jobId)
    expect(ff.commands).toHaveLength(1)
    expect(last(env).status).toBe('completed')
    const mkv = path.join(root(env), 'Beta Show', 'Beta Show - 01 [Studio].mkv')
    expect(fs.readFileSync(mkv, 'utf8')).toBe('scan-made mkv')
  })

  it('Pause mid-merge kills only the export ffmpeg and deletes its temp file; Resume merges again', async () => {
    env = makeEnv()
    const p = pair(env)
    const job = await start(env, [p.key], { unmerged: 'merge' })
    await until(() => ff.commands.length === 1, 'the merge command')
    const tmp = ff.commands[0].output_!
    fs.writeFileSync(tmp, 'partial')
    await env.svc.pause(job.jobId)
    expect(ff.commands[0].signals).toEqual(['SIGKILL'])
    expect(last(env).status).toBe('paused')
    expect(fs.existsSync(tmp)).toBe(false)
    expect(last(env).failed).toEqual([])

    await env.svc.resume(job.jobId)
    await until(() => ff.commands.length === 2, 'the merge again')
    ff.commands[1].finish()
    await env.svc.settled(job.jobId)
    expect(last(env).status).toBe('completed')
  })

  it('quit mid-merge: destroy() kills ffmpeg and deletes the temp .mkv on the target; the job is paused at the next boot', async () => {
    env = makeEnv()
    const p = pair(env)
    const job = await start(env, [p.key], { unmerged: 'merge' })
    await until(() => ff.commands.length === 1, 'the merge command')
    const tmp = ff.commands[0].output_!
    fs.writeFileSync(tmp, 'partial')

    dm.destroy()
    expect(ff.commands[0].signals).toEqual(['SIGKILL'])
    expect(ff.unlinks).toEqual([tmp])
    expect(fs.existsSync(tmp)).toBe(false)
    await env.svc.settled(job.jobId)
    await flush()
    expect(last(env).failed).toEqual([])
    expect(last(env).status).toBe('running')

    const after = env.restart()
    await after.init()
    const [view] = after.list()
    expect(view.status).toBe('paused')
    expect(view.failed).toEqual([])
    expect(fs.existsSync(p.video)).toBe(true)
    expect(fs.existsSync(p.subtitle!)).toBe(true)
  })
})
