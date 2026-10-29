// A Pause or Cancel that lands before an export merge starts (#576 review,
// r4407269396). `mergeItem` awaits the item's `persist`, `mkdir` and temp
// cleanup before it wires its abort to `merger.cancel`; a stop in that window
// must still keep ffmpeg from starting, and `pause()` / `cancel()` must return
// without waiting out a merge. Driven on an `ExportJob` with a `persist` the
// test holds, over a real `DownloadManager` on the fake ffmpeg driver.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DownloadManager } from '../../src/main/download-manager'
import { createLibrary } from '../../src/main/lib/shared-library/write'
import { MERGE_TMP_SUFFIX, nodeFs } from '../../src/main/services/shared-library-export/copy'
import {
  ExportJob,
  type JobItem,
  type JobRecord
} from '../../src/main/services/shared-library-export/job'
import type { ResolvedItem } from '../../src/main/services/shared-library-export/plan'
import { buildMeta } from '../../src/main/services/shared-library-export/snapshot'
import { fakeFfmpeg, until, type FakeFfmpeg } from '../helpers/fake-ffmpeg'
import { PC_ACTOR, fakePresence } from '../helpers/shared-library-export'

const LIB = '5d1e2f3a-4b5c-4d6e-8f70-819a2b3c4d5e'

let dir: string
let dm: DownloadManager
let ff: FakeFfmpeg

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xmerge-stop-')))
  fs.mkdirSync(path.join(dir, 'dl'))
  fs.mkdirSync(path.join(dir, 'ud'))
  dm = new DownloadManager(path.join(dir, 'dl'), {} as never, path.join(dir, 'ud'))
  ff = fakeFfmpeg()
  dm.setFfmpegDriver(ff.driver)
})

afterEach(() => {
  dm.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Each await `mergeItem` makes before it wires its abort to the merger. */
type Gate = 'persist' | 'mkdir' | 'unlink'

/** A job with one merge item; the `gateAt` step before the merge waits until released. */
async function setup(gateAt: Gate = 'persist'): Promise<{
  job: ExportJob
  rec: JobRecord
  heldAtMerge: () => boolean
  release: () => void
  root: string
}> {
  const root = path.join(dir, 'drive', 'Trip')
  fs.mkdirSync(path.dirname(root), { recursive: true })
  await createLibrary(
    root,
    { libraryId: LIB, name: 'Trip', owner: null, mode: 'videos', titles: [], items: [] },
    PC_ACTOR
  )
  const src = path.join(dir, 'src')
  fs.mkdirSync(src)
  const video = path.join(src, 'Show - 01 [Studio].mp4')
  const ass = path.join(src, 'Show - 01 [Studio].ass')
  fs.writeFileSync(video, 'video')
  fs.writeFileSync(ass, '[Script Info]')

  const item: JobItem = {
    key: '7:1:70',
    animeId: 7,
    episodeInt: '1',
    translationId: 70,
    translationType: 'subRu',
    author: 'Studio',
    quality: 720,
    label: 'Episode 1',
    path: 'Show/Show - 01 [Studio].mkv',
    renamed: false,
    videoSize: 18,
    subtitleSize: 0,
    merge: true
  }
  const source: ResolvedItem = {
    key: item.key,
    animeId: 7,
    episodeInt: '1',
    translationId: 70,
    translationType: 'subRu',
    author: 'Studio',
    quality: 720,
    title: 'Show',
    label: 'Episode 1',
    videoPath: video,
    ext: '.mp4',
    videoSize: 5,
    subtitlePath: ass,
    subtitleSize: 13
  }
  const rec: JobRecord = {
    version: 1,
    jobId: 'job-stop',
    libraryId: LIB,
    libraryName: 'Trip',
    root,
    createdAt: 1,
    status: 'running',
    items: [item],
    titles: [{ animeId: 7, name: 'Show' }],
    doneFiles: {},
    done: [],
    failed: {},
    fsType: 'unknown',
    unmerged: 'merge',
    codec: 'copy',
    current: null,
    missing: 0,
    snapshotted: [],
    note: null,
    error: null
  }

  let held = false
  let releaseGate: () => void = () => {}
  const gate = new Promise<void>((r) => {
    releaseGate = r
  })
  const hold = async (): Promise<void> => {
    if (held) return
    held = true
    await gate
  }
  const titleDir = path.join(root, 'Show')
  const tmp = path.join(titleDir, `Show - 01 [Studio].mkv${MERGE_TMP_SUFFIX}`)
  const job = new ExportJob(rec, {
    xfs: {
      ...nodeFs,
      mkdir: async (p) => {
        if (gateAt === 'mkdir' && p === titleDir) await hold()
        return nodeFs.mkdir(p)
      },
      unlink: async (p) => {
        if (gateAt === 'unlink' && p === tmp) await hold()
        return nodeFs.unlink(p)
      }
    },
    presence: fakePresence(),
    actor: () => PC_ACTOR,
    resolve: async () => source,
    snapshot: (animeId) => ({ meta: buildMeta(animeId, null, null), posterFile: null }),
    candidates: async () => [],
    // The persist that marks the merge item current (just before the merge).
    persist: async (r) => {
      if (gateAt === 'persist' && r.current?.rel === item.path) await hold()
    },
    update: () => {},
    checkpointEvery: 10,
    retryMs: 10_000,
    setTimer: () => null,
    clearTimer: () => {},
    merger: {
      merge: (req) =>
        dm.mergeForExport({ ...req, ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe' }),
      cancel: (jobId) => dm.cancelExportMerge(jobId)
    }
  })
  return { job, rec, heldAtMerge: () => held, release: releaseGate, root }
}

describe('a stop before the export merge starts (#576 review)', () => {
  const cases = [
    ['pause', 'persist'],
    ['cancel', 'persist'],
    ['pause', 'mkdir'],
    ['pause', 'unlink']
  ] as const
  for (const [kind, gateAt] of cases) {
    it(`${kind} while the ${gateAt} before the merge is pending: no ffmpeg command, nothing recorded done`, async () => {
      const { job, rec, heldAtMerge, release, root } = await setup(gateAt)
      void job.run()
      await until(heldAtMerge, `the ${gateAt} before the merge`)

      let returned = false
      const stopped = (kind === 'pause' ? job.pause() : job.cancel()).then(() => {
        returned = true
      })
      release()
      // Either the stop returns, or (the bug) ffmpeg starts for the merge.
      await until(() => returned || ff.commands.length > 0, 'the stop or a command')
      const commands = ff.commands.length
      // On the bug, let the merge finish so the job can stop at all.
      for (const c of ff.commands) c.finish()
      await stopped

      expect(commands).toBe(0)
      expect(ff.probes).toEqual([])
      expect(rec.status).toBe(kind === 'pause' ? 'paused' : 'cancelled')
      expect(rec.done).toEqual([])
      expect(rec.doneFiles).toEqual({})
      const files = fs.existsSync(path.join(root, 'Show'))
        ? fs.readdirSync(path.join(root, 'Show'))
        : []
      expect(files).toEqual([])
    })
  }

  it('a stop after the merge started still kills only that merge (the existing path)', async () => {
    const { job, rec, heldAtMerge, release } = await setup()
    void job.run()
    await until(heldAtMerge, 'the persist before the merge')
    release()
    await until(() => ff.commands.length === 1, 'the merge command')
    await job.pause()
    expect(ff.commands[0].signals).toEqual(['SIGKILL'])
    expect(rec.status).toBe('paused')
    expect(rec.done).toEqual([])
  })
})
