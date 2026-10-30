// Pre-fetch during export (#577), end to end: a real `DownloadManager` on a
// fake network and a fake ffmpeg, the real episode-completion tails, and the
// export service, over temp hot / cold roots and a temp drive. Readiness is
// one evaluation (`evaluatePrefetchItem`), run on the download and merge
// events, on a tick while an item waits, and when a job runs after a boot;
// each case below pins a way an item becomes ready that an event-only job
// would miss, or a way a ready-looking item must still wait.

import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { itemKey } from '../../src/main/lib/shared-library/format'
import { LIBRARY_DIR, readLibrary } from '../../src/main/lib/shared-library/read'
import { writeManifest } from '../../src/main/lib/shared-library/write'
import { JOBS_DIR } from '../../src/main/services/shared-library-export'
import {
  ALREADY_ON_DRIVE,
  NO_MERGED_FILE,
  type JobRecord
} from '../../src/main/services/shared-library-export/job'
import {
  DOWNLOAD_CANCELLED,
  MERGE_GRACE_MS,
  NO_LONGER_QUEUED,
  SUBTITLES_FAILED
} from '../../src/main/services/shared-library-export/prefetch-readiness'
import { flush, until } from '../helpers/fake-ffmpeg'
import {
  filesUnder,
  jobOf,
  makePrefetchRig,
  TICK_MS,
  untilEvaluated,
  untilPrefetch,
  type PrefetchRig
} from '../helpers/prefetch-rig'
import { sel, sha256 } from '../helpers/shared-library-export'

let rig: PrefetchRig
afterEach(() => rig?.cleanup())

const ALPHA = 101
const TITLE = 'Alpha Show'

/** Alpha Show: episode 1 downloaded (Studio), episodes 2-4 in the cached list only. */
function seedAlpha(r: PrefetchRig): { a1: string } {
  const a1 = r.env.addEpisode({
    animeId: ALPHA,
    title: TITLE,
    episodeInt: '1',
    translationId: 11
  }).key
  r.seedTitle({
    animeId: ALPHA,
    title: TITLE,
    episodes: [
      { episodeInt: '1', translations: [{ id: 11, author: 'Studio' }] },
      {
        episodeInt: '2',
        translations: [
          { id: 92, author: 'Other', type: 'voiceRu', height: 1080 },
          { id: 12, author: 'Studio' }
        ]
      },
      { episodeInt: '3', translations: [{ id: 13, author: 'Studio' }] },
      { episodeInt: '4', translations: [{ id: 14, author: 'Studio' }] }
    ]
  })
  return { a1 }
}

const pf = (episodeInt: string, translationId: number): ExportSelectionItem => ({
  animeId: ALPHA,
  episodeInt,
  translationId
})
const keyOf = (episodeInt: string, translationId: number): string =>
  `${ALPHA}:${episodeInt}:${translationId}`

async function start(
  r: PrefetchRig,
  selection: string[],
  prefetch: ExportSelectionItem[],
  more: Partial<ExportStartRequest> = {}
): Promise<string> {
  const res = await r.svc.start({
    selection: sel(...selection),
    prefetch,
    target: r.env.drive,
    name: 'Trip',
    ...more
  })
  if (!res.ok) throw new Error(`start refused: ${res.reason}`)
  return res.job.jobId
}

const root = (r: PrefetchRig): string => path.join(r.env.drive, 'Trip')
const manifestKeys = (r: PrefetchRig): string[] => {
  const m = JSON.parse(
    fs.readFileSync(path.join(root(r), LIBRARY_DIR, 'manifest.json'), 'utf8')
  ) as SharedLibraryManifest
  return m.items.map(itemKey).sort()
}
const hotFile = (r: PrefetchRig, episodeInt: string, ext: string): string =>
  path.join(r.env.hot, TITLE, `${TITLE} - ${episodeInt.padStart(2, '0')} [Studio].${ext}`)
const driveFiles = (r: PrefetchRig): string[] =>
  filesUnder(root(r)).filter((f) => !f.startsWith('.anime-dl') && f !== 'index.html')

describe('pre-fetch during export (#577) — the download path', () => {
  it('enqueues the missing items with the right translation, folder and height, and copies each as it completes', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(13)
    const jobId = await start(rig, [a1], [pf('2', 12), pf('3', 13)])

    expect(
      rig.enqueued.flat().map((q) => [q.translationId, q.animeName, q.height, q.author])
    ).toEqual([
      [12, TITLE, 720, 'Studio'],
      [13, TITLE, 720, 'Studio']
    ])

    // Episode 2 lands and is copied while episode 3 is still downloading.
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'done')
    expect(jobOf(rig, jobId).prefetch?.find((p) => p.key === keyOf('3', 13))?.state).not.toBe(
      'done'
    )
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].mp4`)
    expect(jobOf(rig, jobId).status).toBe('running')

    rig.net.release(13)
    await rig.svc.settled(jobId)
    expect(jobOf(rig, jobId).status).toBe('completed')
    expect(manifestKeys(rig)).toEqual([a1, keyOf('2', 12), keyOf('3', 13)].sort())
    expect(sha256(path.join(root(rig), TITLE, `${TITLE} - 03 [Studio].mp4`))).toBe(
      sha256(hotFile(rig, '3', 'mp4'))
    )
    // The downloads stay on this PC.
    expect(fs.existsSync(hotFile(rig, '3', 'mp4'))).toBe(true)
  })

  it('a selection with missing items exports them too, not only the downloaded ones', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    const jobId = await start(rig, [a1], [pf('4', 14)])
    await rig.svc.settled(jobId)
    expect(manifestKeys(rig)).toEqual([a1, keyOf('4', 14)].sort())
    expect(driveFiles(rig)).toEqual(
      [
        `${TITLE}/${TITLE} - 01 [Studio].mkv`,
        `${TITLE}/${TITLE} - 04 [Studio].ass`,
        `${TITLE}/${TITLE} - 04 [Studio].mp4`
      ].sort()
    )
  })

  it('episode completion still writes the pre-fetched video’s entry while the export listens (red on a single-slot hook)', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await rig.svc.settled(jobId)
    const entries = rig.env.store.get('downloadedEpisodes') as Record<string, unknown>
    expect(entries[keyOf('2', 12)]).toEqual({
      translationType: 'subRu',
      author: 'Studio',
      quality: 720,
      translationId: 12
    })
    expect(manifestKeys(rig)).toContain(keyOf('2', 12))
  })

  it('a failed download fails its item with the row’s own error, and the job completes', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.failVideo(13)
    const jobId = await start(rig, [a1], [pf('2', 12), pf('3', 13)])
    await rig.svc.settled(jobId)
    const job = jobOf(rig, jobId)
    expect(job.status).toBe('completed')
    expect(job.failed).toEqual([
      {
        key: keyOf('3', 13),
        label: `${TITLE} — 3 серия`,
        reason: rig.dm.getItem('video-13')!.error
      }
    ])
    expect(job.failed[0].reason).toMatch(/^Server sent text\/html instead of video/)
    expect(manifestKeys(rig)).toEqual([a1, keyOf('2', 12)].sort())
  })

  it('cancelling the export leaves its downloads queued', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => jobOf(rig, jobId).filesDone === 1, 'the downloaded item')
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'downloading')
    await rig.svc.cancel(jobId)
    expect(jobOf(rig, jobId).status).toBe('cancelled')
    expect(rig.dm.getItem('video-12')!.status).toBe('downloading')
    rig.net.release(12)
    await until(() => rig.dm.getItem('video-12')!.status === 'completed', 'the download')
    expect(fs.existsSync(hotFile(rig, '2', 'mp4'))).toBe(true)
    expect(manifestKeys(rig)).toEqual([a1])
  })

  it('a pre-fetched file larger than the drive’s free space at its copy fails that item, and the job completes', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => jobOf(rig, jobId).filesDone === 1, 'the downloaded item')
    // The stick filled up meanwhile: less room than the real `.mp4`.
    rig.driveFree.bytes = rig.net.videoBytes(12).length - 1
    rig.net.release(12)
    await rig.svc.settled(jobId)
    const job = jobOf(rig, jobId)
    expect(job.status).toBe('completed')
    expect(job.failed.map((f) => [f.key, f.reason])).toEqual([
      [keyOf('2', 12), 'Not enough space on the drive']
    ])
    expect(driveFiles(rig)).toEqual([`${TITLE}/${TITLE} - 01 [Studio].mkv`])
  })
})

describe('pre-fetch (#577) — offline', () => {
  it('going offline mid-job leaves the item waiting for the connection, and it completes once back online', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'downloading')
    rig.offline.on = true
    rig.dm.suspendForOffline()
    rig.net.release(12)
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'waiting-connection')
    // Several ticks later: still waiting, not failed.
    await new Promise((r) => setTimeout(r, TICK_MS * 6))
    const job = jobOf(rig, jobId)
    expect(job.status).toBe('running')
    expect(job.failed).toEqual([])
    rig.offline.on = false
    rig.dm.resumeAfterOffline()
    await rig.svc.settled(jobId)
    expect(manifestKeys(rig)).toEqual([a1, keyOf('2', 12)].sort())
  })
})

describe('pre-fetch (#577) — kill and resume', () => {
  it('re-checks every item from the queue and the disk: arrived → copied with no event, queued → waits, gone → failed, none re-enqueued', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    rig.net.hold(13)
    rig.net.hold(14)
    const jobId = await start(rig, [a1], [pf('2', 12), pf('3', 13), pf('4', 14)])
    await until(() => jobOf(rig, jobId).filesDone === 1, 'the downloaded item')
    // Stop the job before item 1 (episode 2) can be copied, then let its download finish.
    await rig.svc.pause(jobId)
    rig.net.release(12)
    await until(() => rig.dm.getItem('video-12')?.status === 'completed', 'episode 2’s download')
    await until(
      () => keyOf('2', 12) in (rig.env.store.get('downloadedEpisodes') as object),
      'episode 2’s entry'
    )
    // Item 3 (episode 4) leaves the queue.
    rig.dm.cancel('video-14')
    const enqueues = rig.enqueued.length

    await rig.boot()
    expect(jobOf(rig, jobId).status).toBe('paused')
    await rig.svc.resume(jobId)
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'done')
    // Copied with no new `onVideoDownloaded` event: the boot evaluation found it.
    expect(rig.videoEvents).toEqual([])
    await untilPrefetch(rig, jobId, keyOf('4', 14), 'failed')
    expect(jobOf(rig, jobId).failed.find((f) => f.key === keyOf('4', 14))?.reason).toBe(
      NO_LONGER_QUEUED
    )
    // Item 2 (episode 3) waits: `loadQueue` left its download paused.
    expect(jobOf(rig, jobId).prefetch?.find((p) => p.key === keyOf('3', 13))?.state).toBe(
      'waiting-download'
    )
    expect(rig.dm.getItem('video-13')?.status).toBe('paused')
    rig.dm.resumeAll()
    rig.net.release(13)
    await rig.svc.settled(jobId)
    expect(jobOf(rig, jobId).status).toBe('completed')
    expect(manifestKeys(rig)).toEqual([a1, keyOf('2', 12), keyOf('3', 13)].sort())
    expect(rig.enqueued.length).toBe(enqueues)
    expect(rig.dm.getItem('video-14')).toBeNull()
  })

  it('a resumed item whose download failed is failed with the row’s error, not “no longer queued”', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'downloading')
    await rig.boot(() => {
      const file = path.join(rig.env.userData, 'queue.json')
      const q = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const item of q.queue) {
        if (item.id === 'video-12') Object.assign(item, { status: 'failed', error: 'HTTP 403' })
      }
      fs.writeFileSync(file, JSON.stringify(q))
    })
    await rig.svc.resume(jobId)
    await rig.svc.settled(jobId)
    const job = jobOf(rig, jobId)
    expect(job.status).toBe('completed')
    expect(job.failed.map((f) => [f.key, f.reason])).toEqual([[keyOf('2', 12), 'HTTP 403']])
  })

  it('the job file keeps each pre-fetch item’s translation, state and doneAt', async () => {
    rig = makePrefetchRig({ autoMerge: true })
    const { a1 } = seedAlpha(rig)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'waiting-merge')
    await rig.svc.pause(jobId)
    const rec = JSON.parse(
      fs.readFileSync(path.join(rig.env.userData, JOBS_DIR, `${jobId}.json`), 'utf8')
    ) as JobRecord
    expect(rec.prefetch).toEqual([
      expect.objectContaining({
        key: keyOf('2', 12),
        translationId: 12,
        animeName: TITLE,
        state: 'waiting',
        doneAt: rig.clock.t
      })
    ])
  })
})

describe('pre-fetch (#577) — readiness beyond the events', () => {
  it('auto-merge off: a subtitle that lands after its video is copied within a tick, with no event for it', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12, 'subtitle')
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => rig.dm.getItem('video-12')?.status === 'completed', 'the video')
    await new Promise((r) => setTimeout(r, TICK_MS * 4))
    expect(jobOf(rig, jobId).prefetch?.[0].state).toBe('waiting-download')
    const events = rig.videoEvents.length
    rig.net.release(12, 'subtitle')
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'done')
    expect(rig.videoEvents.length).toBe(events)
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].ass`)
  })

  it('auto-merge on but no ffmpeg: ready as a pair at once, and a fresh boot decides the same', async () => {
    rig = makePrefetchRig({ autoMerge: true, ffmpegAvailable: false })
    const { a1 } = seedAlpha(rig)
    rig.net.hold(13)
    const jobId = await start(rig, [a1], [pf('2', 12), pf('3', 13)])
    // Live: no merge comes, and the pair goes without waiting for one.
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'done')
    // At boot: the same state gives the same answer.
    await rig.svc.pause(jobId)
    rig.net.release(13)
    await until(() => rig.dm.getItem('video-13')?.status === 'completed', 'episode 3')
    await until(() => rig.dm.getItem('sub-13')?.status === 'completed', 'episode 3’s subtitle')
    await rig.boot()
    await rig.svc.resume(jobId)
    await rig.svc.settled(jobId)
    expect(driveFiles(rig)).toEqual(
      [
        `${TITLE}/${TITLE} - 01 [Studio].mkv`,
        `${TITLE}/${TITLE} - 02 [Studio].ass`,
        `${TITLE}/${TITLE} - 02 [Studio].mp4`,
        `${TITLE}/${TITLE} - 03 [Studio].ass`,
        `${TITLE}/${TITLE} - 03 [Studio].mp4`
      ].sort()
    )
    expect(rig.mergeCalls.n).toBe(0)
  })

  it('a failed merge leaves the pair, copied within a tick', async () => {
    rig = makePrefetchRig({ autoMerge: true })
    const { a1 } = seedAlpha(rig)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => rig.ff.commands.length === 1, 'the merge')
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'waiting-merge')
    rig.ff.commands[0].fail('Invalid data found when processing input')
    await until(() => rig.dm.getMergeStatus(12) === 'failed', 'the failed merge')
    await rig.svc.settled(jobId)
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].mp4`)
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].ass`)
  })

  it('a cancelled merge: waits through the grace, then the pair goes', async () => {
    rig = makePrefetchRig({ autoMerge: true })
    const { a1 } = seedAlpha(rig)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => rig.ff.commands.length === 1, 'the merge')
    rig.dm.cancelMerge(12)
    await until(() => !rig.dm.isMergeCycleActive(), 'the cycle to end')
    expect(rig.dm.getMergeStatus(12)).toBeNull()
    // Before the grace: still waiting, however many ticks pass.
    await untilEvaluated(rig, jobId, rig.predicateReads.n)
    expect(jobOf(rig, jobId).prefetch?.[0].state).toBe('waiting-merge')
    rig.clock.t += MERGE_GRACE_MS
    await rig.svc.settled(jobId)
    expect(jobOf(rig, jobId).status).toBe('completed')
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].mp4`)
  })

  it('no false cancel: a merge held by the player waits at 60 s, then only the .mkv is copied', async () => {
    rig = makePrefetchRig({ autoMerge: true })
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    // The player opens after the downloaded item is on the drive.
    await until(() => jobOf(rig, jobId).filesDone === 1, 'the downloaded item')
    rig.env.presence.open = true
    rig.net.release(12)
    await until(() => rig.dm.hasHeldMerge(), 'the held merge')
    // The player closed, but its release hasn't run the held merge yet.
    rig.env.presence.open = false
    expect(rig.dm.getMergeStatus(12)).toBeNull()
    rig.clock.t += 60_000
    await untilEvaluated(rig, jobId, rig.predicateReads.n)
    rig.clock.t += 60_000
    await untilEvaluated(rig, jobId, rig.predicateReads.n)
    expect(jobOf(rig, jobId).prefetch?.[0].state).toBe('waiting-merge')
    rig.env.presence.release.emit()
    await until(() => rig.ff.commands.length === 1, 'the resumed merge')
    rig.ff.commands[0].finish('mkv-bytes')
    await rig.svc.settled(jobId)
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].mkv`)
    expect(rig.reads.filter((p) => p.endsWith(' - 02 [Studio].mp4'))).toEqual([])
  })

  it('no false cancel: a group waiting for the ffmpeg mutex waits, then only the .mkv is copied', async () => {
    rig = makePrefetchRig({ autoMerge: true })
    const { a1 } = seedAlpha(rig)
    // Another export's merge holds the mutex.
    const src = path.join(rig.env.dir, 'blocker.mp4')
    fs.writeFileSync(src, 'x')
    const blocker = rig.dm.mergeForExport({
      jobId: 'other-export',
      videoPath: src,
      subtitlePath: null,
      outputPath: path.join(rig.env.dir, 'blocker.mkv'),
      codec: 'copy',
      ffmpegPath: '/fake/ffmpeg',
      ffprobePath: '/fake/ffmpeg'
    })
    await until(() => rig.ff.commands.length === 1, 'the blocking merge')
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => rig.dm.isMergeCycleActive(), 'the queue cycle')
    expect(rig.dm.getMergeStatus(12)).toBeNull()
    rig.clock.t += 60_000
    await untilEvaluated(rig, jobId, rig.predicateReads.n)
    rig.clock.t += 60_000
    await untilEvaluated(rig, jobId, rig.predicateReads.n)
    expect(jobOf(rig, jobId).prefetch?.[0].state).toBe('waiting-merge')
    rig.ff.commands[0].finish('other')
    await blocker
    await until(() => rig.ff.commands.length === 2, 'the queue’s merge')
    rig.ff.commands[1].finish('mkv-bytes')
    await rig.svc.settled(jobId)
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].mkv`)
    expect(rig.reads.filter((p) => p.endsWith(' - 02 [Studio].mp4'))).toEqual([])
  })

  for (const order of ['job-first', 'merge-first'] as const) {
    it(`no copy in the window before the merge starts (${order}): only the .mkv is copied`, async () => {
      rig = makePrefetchRig({ autoMerge: true })
      const { a1 } = seedAlpha(rig)
      // The merge is requested and held: both rows are complete, a merge is
      // expected, and none has started, for as long as the test needs.
      let open!: () => void
      rig.mergeGate.current = new Promise<void>((r) => (open = r))
      try {
        let go: () => void = () => {}
        let atCopy: Promise<void> = Promise.resolve()
        if (order === 'job-first') {
          // The job evaluates the pre-fetched item while it downloads.
          rig.net.hold(12)
        } else {
          // The downloaded item's copy is held until the merge is requested, so
          // the job hasn't evaluated the pre-fetched item yet.
          let reached!: () => void
          atCopy = new Promise<void>((r) => (reached = r))
          rig.copyGate.current = {
            match: / - 01 \[Studio\]\.mkv/,
            reached,
            go: new Promise<void>((r) => (go = r))
          }
        }
        const jobId = await start(rig, [a1], [pf('2', 12)])
        const atStart = rig.predicateReads.n
        if (order === 'job-first') {
          await until(() => rig.predicateReads.n > atStart, 'the job evaluating')
          expect(rig.mergeCalls.n).toBe(0)
          rig.net.release(12)
        }
        await atCopy
        await until(() => rig.mergeCalls.n === 1, 'the merge request')
        const atRequest = rig.predicateReads.n
        if (order === 'merge-first') {
          expect(atRequest).toBe(atStart)
          go()
        }
        await untilEvaluated(rig, jobId, atRequest)
        expect(jobOf(rig, jobId).prefetch?.[0].state).toBe('waiting-merge')
        expect(rig.reads.filter((p) => p.endsWith('.mp4') || p.endsWith('.ass'))).toEqual([])
        expect(rig.ff.commands).toHaveLength(0)
        open()
        await until(() => rig.ff.commands.length === 1, 'the merge')
        rig.ff.commands[0].finish('mkv-bytes')
        await rig.svc.settled(jobId)
        expect(driveFiles(rig)).toEqual(
          [`${TITLE}/${TITLE} - 01 [Studio].mkv`, `${TITLE}/${TITLE} - 02 [Studio].mkv`].sort()
        )
        expect(rig.reads.filter((p) => p.endsWith('.mp4') || p.endsWith('.ass'))).toEqual([])
      } finally {
        open()
      }
    })
  }

  it('the post-copy guard: a merge that starts while the pair is copied leaves no pair and no entry, then the .mkv goes', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    let reached!: () => void
    const atCopy = new Promise<void>((r) => (reached = r))
    let go!: () => void
    rig.copyGate.current = {
      match: / - 02 \[Studio\]\.ass/,
      reached,
      go: new Promise<void>((r) => (go = r))
    }
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await atCopy
    // "Merge finished" while the pair's second file is being copied.
    const merging = rig.dm.mergeCompleted('/fake/ffmpeg', '/fake/ffmpeg', 'copy')
    await until(() => rig.dm.getMergeStatus(12) === 'merging', 'the merge to start')
    go()
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'waiting-merge')
    expect(driveFiles(rig)).toEqual([`${TITLE}/${TITLE} - 01 [Studio].mkv`])
    rig.ff.commands[0].finish('mkv-bytes')
    await merging
    await rig.svc.settled(jobId)
    expect(driveFiles(rig)).toEqual(
      [`${TITLE}/${TITLE} - 01 [Studio].mkv`, `${TITLE}/${TITLE} - 02 [Studio].mkv`].sort()
    )
    expect(manifestKeys(rig)).toEqual([a1, keyOf('2', 12)].sort())
  })

  for (const autoMerge of [true, false]) {
    it(`'deferred' (auto-merge ${autoMerge ? 'on' : 'off'}): waits under the player lock, then copies what finalize leaves`, async () => {
      rig = makePrefetchRig({ autoMerge })
      const { a1 } = seedAlpha(rig)
      rig.locked.add(hotFile(rig, '2', 'mp4'))
      const jobId = await start(rig, [a1], [pf('2', 12)])
      await until(() => rig.dm.getMergeStatus(12) === 'deferred', 'the deferred finish')
      // `onVideoDownloaded` fired with a path that isn't on disk yet.
      expect(rig.videoEvents).toContain(12)
      expect(fs.existsSync(hotFile(rig, '2', 'mp4'))).toBe(false)
      await untilEvaluated(rig, jobId, rig.predicateReads.n)
      const job = jobOf(rig, jobId)
      expect(job.prefetch?.[0].state).toBe('waiting-merge')
      expect(job.failed).toEqual([])
      rig.locked.clear()
      const finalized = rig.finalizeDeferred()
      if (autoMerge) {
        await until(() => rig.ff.commands.length === 1, 'the merge')
        rig.ff.commands[0].finish('mkv-bytes')
      }
      await finalized
      await rig.svc.settled(jobId)
      expect(driveFiles(rig)).toContain(
        autoMerge ? `${TITLE}/${TITLE} - 02 [Studio].mkv` : `${TITLE}/${TITLE} - 02 [Studio].mp4`
      )
    })
  }

  it('a subtitle that fails: the item goes video-only, with the warning, without waiting', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12, 'subtitle')
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => rig.dm.getItem('video-12')?.status === 'completed', 'the video')
    // Its retries ran out: the row ends failed.
    rig.dm.pause('sub-12')
    Object.assign(rig.dm.getItem('sub-12')!, { status: 'failed', error: 'HTTP 404 Not Found' })
    await rig.svc.settled(jobId)
    const job = jobOf(rig, jobId)
    expect(job.status).toBe('completed')
    expect(job.prefetch?.[0]).toMatchObject({ state: 'done', warning: SUBTITLES_FAILED })
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].mp4`)
    expect(driveFiles(rig)).not.toContain(`${TITLE}/${TITLE} - 02 [Studio].ass`)
  })

  it('a cancelled download fails its item with “Download cancelled”', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'downloading')
    rig.dm.cancel('video-12')
    await rig.svc.settled(jobId)
    expect(jobOf(rig, jobId).failed.map((f) => f.reason)).toEqual([DOWNLOAD_CANCELLED])
  })
})

describe('pre-fetch (#577) — the copy guards, the cold move and the listeners', () => {
  it('the pre-copy guard: a pair planned before a merge finished is planned again, as the .mkv', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => jobOf(rig, jobId).filesDone === 1, 'the downloaded item')
    // The player opens; the pair is planned (no merge is expected) and its copy waits for the player.
    rig.env.presence.open = true
    rig.net.release(12)
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'copying')
    await until(() => jobOf(rig, jobId).status === 'held', 'the hold')
    // The player closes and "Merge finished" runs before the job is woken.
    rig.env.presence.open = false
    const merging = rig.dm.mergeCompleted('/fake/ffmpeg', '/fake/ffmpeg', 'copy')
    await until(() => rig.ff.commands.length === 1, 'the merge')
    rig.ff.commands[0].finish('mkv-bytes')
    await merging
    expect(fs.existsSync(hotFile(rig, '2', 'mp4'))).toBe(false)
    rig.env.presence.release.emit()
    await rig.svc.settled(jobId)
    const job = jobOf(rig, jobId)
    expect(job.failed).toEqual([])
    expect(driveFiles(rig)).toEqual(
      [`${TITLE}/${TITLE} - 01 [Studio].mkv`, `${TITLE}/${TITLE} - 02 [Studio].mkv`].sort()
    )
  })

  it('a source an auto-move takes to cold mid-copy is found again and copied once more', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    const coldDir = path.join(rig.env.cold, TITLE)
    let moved = false
    rig.onRead = (p) => {
      if (moved || p !== hotFile(rig, '2', 'mp4')) return
      moved = true
      fs.mkdirSync(coldDir, { recursive: true })
      for (const ext of ['mp4', 'ass']) {
        fs.renameSync(
          hotFile(rig, '2', ext),
          path.join(coldDir, path.basename(hotFile(rig, '2', ext)))
        )
      }
    }
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await rig.svc.settled(jobId)
    expect(moved).toBe(true)
    expect(jobOf(rig, jobId).failed).toEqual([])
    expect(manifestKeys(rig)).toEqual([a1, keyOf('2', 12)].sort())
    expect(sha256(path.join(root(rig), TITLE, `${TITLE} - 02 [Studio].mp4`))).toBe(
      sha256(path.join(coldDir, `${TITLE} - 02 [Studio].mp4`))
    )
  })

  it('the job’s download and merge listeners are removed when it pauses and when it ends', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    type Lists = {
      videoDownloadedListeners: { size: () => number }
      mergeCompleteListeners: { size: () => number }
    }
    const sizes = (): number[] => {
      const l = rig.dm as unknown as Lists
      return [l.videoDownloadedListeners.size(), l.mergeCompleteListeners.size()]
    }
    const before = sizes()
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => jobOf(rig, jobId).filesDone === 1, 'the downloaded item')
    expect(sizes()).toEqual([before[0] + 1, before[1] + 1])
    await rig.svc.pause(jobId)
    expect(sizes()).toEqual(before)
    await rig.svc.resume(jobId)
    await until(() => sizes()[0] === before[0] + 1, 'the resumed listeners')
    rig.net.release(12)
    await rig.svc.settled(jobId)
    expect(sizes()).toEqual(before)
  })
})

describe("pre-fetch (#577) — 'pending'", () => {
  it('a kill mid-merge, then a boot with nothing queued: the pair (not the truncated .mkv) goes after the grace, and no merge is started', async () => {
    rig = makePrefetchRig({ autoMerge: true })
    const { a1 } = seedAlpha(rig)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => rig.ff.commands.length === 1, 'the merge')
    expect(rig.dm.getMergeStatus(12)).toBe('merging')
    await rig.boot(() => {
      // What the killed ffmpeg left at the final path.
      fs.writeFileSync(hotFile(rig, '2', 'mkv'), 'truncated')
    })
    expect(rig.dm.getMergeStatus(12)).toBe('pending')
    expect(fs.existsSync(hotFile(rig, '2', 'mkv'))).toBe(false)
    await rig.svc.resume(jobId)
    await untilEvaluated(rig, jobId, rig.predicateReads.n)
    expect(jobOf(rig, jobId).prefetch?.[0].state).toBe('waiting-merge')
    rig.clock.t += MERGE_GRACE_MS
    await rig.svc.settled(jobId)
    expect(jobOf(rig, jobId).status).toBe('completed')
    expect(driveFiles(rig)).toEqual(
      [
        `${TITLE}/${TITLE} - 01 [Studio].mkv`,
        `${TITLE}/${TITLE} - 02 [Studio].ass`,
        `${TITLE}/${TITLE} - 02 [Studio].mp4`
      ].sort()
    )
    expect(rig.mergeCalls.n).toBe(0)
  })

  it("'deferred' → finalize with auto-merge off leaves 'pending': the pair goes on the first tick, with no grace", async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.locked.add(hotFile(rig, '2', 'mp4'))
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => rig.dm.getMergeStatus(12) === 'deferred', 'the deferred finish')
    rig.locked.clear()
    await rig.finalizeDeferred()
    expect(rig.dm.getMergeStatus(12)).toBe('pending')
    // The clock doesn't move: a grace could never pass.
    await rig.svc.settled(jobId)
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].mp4`)
  })

  it("a held 'pending' (the hold during the probe) waits, then the .mkv goes after the held merge runs", async () => {
    rig = makePrefetchRig({ autoMerge: true })
    const { a1 } = seedAlpha(rig)
    rig.ff.setProbe(async () => {
      rig.env.presence.open = true
      return 60
    })
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => jobOf(rig, jobId).filesDone === 1, 'the downloaded item')
    rig.net.release(12)
    await until(() => rig.dm.hasHeldMerge(), 'the hold during the probe')
    expect(rig.dm.getMergeStatus(12)).toBe('pending')
    rig.env.presence.open = false
    rig.ff.setProbe(async () => 60)
    rig.clock.t += 60_000
    await untilEvaluated(rig, jobId, rig.predicateReads.n)
    rig.clock.t += 60_000
    await untilEvaluated(rig, jobId, rig.predicateReads.n)
    expect(jobOf(rig, jobId).prefetch?.[0].state).toBe('waiting-merge')
    rig.env.presence.release.emit()
    await until(() => rig.ff.commands.length === 1, 'the resumed merge')
    rig.ff.commands[0].finish('mkv-bytes')
    await rig.svc.settled(jobId)
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].mkv`)
    expect(rig.reads.filter((p) => p.endsWith(' - 02 [Studio].mp4'))).toEqual([])
  })
})

describe('pre-fetch (#577) — auto-merge toggled mid-job (re-read per evaluation)', () => {
  it('turned on before a group completes: the merge runs and the .mkv is copied, never the pair', async () => {
    rig = makePrefetchRig({ autoMerge: false })
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    // The job has read the predicate (off) at least once before the toggle.
    await until(() => rig.predicateReads.n > 0, 'an evaluation')
    rig.env.store.set('autoMerge', true)
    rig.net.release(12)
    await until(() => rig.ff.commands.length === 1, 'the merge')
    rig.ff.commands[0].finish('mkv-bytes')
    await rig.svc.settled(jobId)
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].mkv`)
    expect(rig.reads.filter((p) => p.endsWith(' - 02 [Studio].mp4'))).toEqual([])
  })

  it('turned off before a group completes: no merge runs and the pair goes on the first tick, with no grace', async () => {
    rig = makePrefetchRig({ autoMerge: true })
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => rig.predicateReads.n > 0, 'an evaluation')
    rig.env.store.set('autoMerge', false)
    rig.net.release(12)
    // The clock doesn't move: a grace could never pass.
    await rig.svc.settled(jobId)
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].mp4`)
    expect(rig.ff.commands).toEqual([])
  })
})

describe('pre-fetch (#577) — Merge into MKV with auto-merge off', () => {
  it('the pair becomes one .mkv on the target; the local pair stays and the queue never merges', async () => {
    rig = makePrefetchRig({ autoMerge: false })
    const { a1 } = seedAlpha(rig)
    const jobId = await start(rig, [a1], [pf('2', 12)], { unmerged: 'merge' })
    await until(() => rig.ff.commands.length === 1, 'the export merge')
    rig.ff.commands[0].finish('mkv-bytes')
    await rig.svc.settled(jobId)
    expect(driveFiles(rig)).toEqual(
      [`${TITLE}/${TITLE} - 01 [Studio].mkv`, `${TITLE}/${TITLE} - 02 [Studio].mkv`].sort()
    )
    expect(fs.existsSync(hotFile(rig, '2', 'mp4'))).toBe(true)
    expect(fs.existsSync(hotFile(rig, '2', 'ass'))).toBe(true)
    expect(rig.mergeCalls.n).toBe(0)
    expect(rig.dm.getMergeStatus(12)).toBeNull()
  })
})

describe('pre-fetch (#577) — the drive already has it (review of 8f2dacb4)', () => {
  /** Export episode 2 by pre-fetch, then free the space here: its files and entry go. */
  async function exportedThenDeleted(r: PrefetchRig, a1: string): Promise<{ file: string }> {
    const first = await start(r, [a1], [pf('2', 12)])
    await r.svc.settled(first)
    await r.svc.cancel(first) // dismiss the finished card
    for (const ext of ['mp4', 'ass']) fs.rmSync(hotFile(r, '2', ext))
    const entries = r.env.store.get('downloadedEpisodes') as Record<string, unknown>
    delete entries[keyOf('2', 12)]
    r.env.store.set('downloadedEpisodes', entries)
    return { file: path.join(root(r), TITLE, `${TITLE} - 02 [Studio].mp4`) }
  }

  it('the trip flow: an episode on the drive but no longer here is "on the drive" in the plan, and never downloaded again or written', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    const { file } = await exportedThenDeleted(rig, a1)
    const before = { sha: sha256(file), mtimeMs: fs.statSync(file).mtimeMs }
    const enqueues = rig.enqueued.length

    const plan = await rig.svc.plan({ animeIds: [ALPHA], target: rig.env.drive, name: 'Trip' })
    expect(plan.titles[0].notDownloaded.find((e) => e.episodeInt === '2')).toBeDefined()
    expect(plan.target?.presentMissing).toEqual([keyOf('2', 12)])

    // Picked alone: nothing to do.
    const alone = await rig.svc.start({
      selection: [],
      prefetch: [pf('2', 12)],
      target: rig.env.drive,
      name: 'Trip'
    })
    expect(alone).toMatchObject({ ok: false, reason: expect.stringMatching(/^Nothing to copy/) })
    // Picked with another missing episode: only that one is downloaded.
    const jobId = await start(rig, [], [pf('2', 12), pf('3', 13)])
    await rig.svc.settled(jobId)
    expect(
      rig.enqueued
        .slice(enqueues)
        .flat()
        .map((q) => q.translationId)
    ).toEqual([13])
    expect(jobOf(rig, jobId).prefetch?.map((p) => p.key)).toEqual([keyOf('3', 13)])
    expect(fs.existsSync(hotFile(rig, '2', 'mp4'))).toBe(false)
    expect({ sha: sha256(file), mtimeMs: fs.statSync(file).mtimeMs }).toEqual(before)
    expect(manifestKeys(rig)).toEqual([a1, keyOf('2', 12), keyOf('3', 13)].sort())
  })

  it('a key another PC added after the start is never written over: the item fails "Already on the drive"', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => jobOf(rig, jobId).filesDone === 1, 'the downloaded item')
    // Another PC exports episode 2 into the same library meanwhile.
    const theirs = path.join(root(rig), TITLE, `${TITLE} - 02 [Studio].mp4`)
    fs.writeFileSync(theirs, 'their copy')
    const r = await readLibrary(root(rig))
    if (r.status !== 'ok') throw new Error(r.status)
    await writeManifest(
      root(rig),
      {
        libraryId: r.manifest.libraryId,
        name: r.manifest.name,
        owner: r.manifest.owner,
        mode: r.manifest.mode,
        titles: r.manifest.titles,
        items: [
          ...r.manifest.items,
          {
            animeId: ALPHA,
            episodeInt: '2',
            translationId: 12,
            translationType: 'subRu',
            author: 'Studio',
            quality: 720,
            path: `${TITLE}/${TITLE} - 02 [Studio].mp4`,
            size: 10,
            sha256: sha256(theirs)
          }
        ],
        naming: r.manifest.naming
      },
      { installId: 'pc-other', appVersion: '5.0.37', shikimoriUserId: null, claim: null },
      r.manifest.generation
    )
    rig.net.release(12)
    await rig.svc.settled(jobId)
    const job = jobOf(rig, jobId)
    expect(job.status).toBe('completed')
    expect(job.failed.map((f) => [f.key, f.reason])).toEqual([[keyOf('2', 12), ALREADY_ON_DRIVE]])
    expect(fs.readFileSync(theirs, 'utf8')).toBe('their copy')
  })
})

describe('pre-fetch (#577) — a key another PC adds after the item was planned (review of 8f2dacb4)', () => {
  it('is checked again just before the copy: the item fails "Already on the drive" and their file stays', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => jobOf(rig, jobId).filesDone === 1, 'the downloaded item')
    // The player opens: the pair is planned, and its copy waits for the player.
    rig.env.presence.open = true
    rig.net.release(12)
    await untilPrefetch(rig, jobId, keyOf('2', 12), 'copying')
    await until(() => jobOf(rig, jobId).status === 'held', 'the hold')
    const theirs = path.join(root(rig), TITLE, `${TITLE} - 02 [Studio] (theirs).mp4`)
    fs.writeFileSync(theirs, 'their copy')
    const r = await readLibrary(root(rig))
    if (r.status !== 'ok') throw new Error(r.status)
    await writeManifest(
      root(rig),
      {
        libraryId: r.manifest.libraryId,
        name: r.manifest.name,
        owner: r.manifest.owner,
        mode: r.manifest.mode,
        titles: r.manifest.titles,
        items: [
          ...r.manifest.items,
          {
            animeId: ALPHA,
            episodeInt: '2',
            translationId: 12,
            translationType: 'subRu',
            author: 'Studio',
            quality: 720,
            path: `${TITLE}/${TITLE} - 02 [Studio] (theirs).mp4`,
            size: 10,
            sha256: sha256(theirs)
          }
        ],
        naming: r.manifest.naming
      },
      { installId: 'pc-other', appVersion: '5.0.37', shikimoriUserId: null, claim: null },
      r.manifest.generation
    )
    rig.env.presence.open = false
    rig.env.presence.release.emit()
    await rig.svc.settled(jobId)
    const job = jobOf(rig, jobId)
    expect(job.failed.map((f) => [f.key, f.reason])).toEqual([[keyOf('2', 12), ALREADY_ON_DRIVE]])
    expect(driveFiles(rig)).not.toContain(`${TITLE}/${TITLE} - 02 [Studio].mp4`)
    const m = JSON.parse(
      fs.readFileSync(path.join(root(rig), LIBRARY_DIR, 'manifest.json'), 'utf8')
    )
    expect(
      m.items
        .filter((i: SharedLibraryItem) => itemKey(i) === keyOf('2', 12))
        .map((i: SharedLibraryItem) => i.path)
    ).toEqual([`${TITLE}/${TITLE} - 02 [Studio] (theirs).mp4`])
  })
})

describe('pre-fetch (#577) — the decision and the files agree (review of 8f2dacb4)', () => {
  it('a merged .mkv here with a stray pair in the cold root: the .mkv is copied, the job ends', async () => {
    rig = makePrefetchRig({ autoMerge: true })
    const { a1 } = seedAlpha(rig)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => rig.ff.commands.length === 1, 'the merge')
    await rig.svc.pause(jobId)
    rig.ff.commands[0].finish('mkv-bytes')
    await until(() => rig.dm.getMergeStatus(12) === 'completed', 'the merge')
    // A stray pair in the cold root: the folder scan keeps the cold entry last.
    const coldDir = path.join(rig.env.cold, TITLE)
    fs.mkdirSync(coldDir, { recursive: true })
    fs.writeFileSync(path.join(coldDir, `${TITLE} - 02 [Studio].mp4`), 'stray')
    fs.writeFileSync(path.join(coldDir, `${TITLE} - 02 [Studio].ass`), 'stray')
    await rig.svc.resume(jobId)
    await rig.svc.settled(jobId)
    expect(jobOf(rig, jobId).status).toBe('completed')
    expect(driveFiles(rig)).toContain(`${TITLE}/${TITLE} - 02 [Studio].mkv`)
    expect(rig.reads.filter((p) => p.endsWith(' - 02 [Studio].mp4'))).toEqual([])
  })

  it('a downloaded item whose downloadedEpisodes entry a kill lost is still found and copied (manual run)', async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => jobOf(rig, jobId).filesDone === 1, 'the downloaded item')
    await rig.svc.pause(jobId)
    rig.net.release(12)
    await until(() => rig.dm.getItem('sub-12')?.status === 'completed', 'the downloads')
    await until(() => rig.dm.getItem('video-12')?.status === 'completed', 'the downloads')
    // The store's coalesced write never reached the disk: the entry is gone after the restart.
    await rig.boot(() => {
      const entries = rig.env.store.get('downloadedEpisodes') as Record<string, unknown>
      delete entries[keyOf('2', 12)]
      rig.env.store.set('downloadedEpisodes', entries)
    })
    await rig.svc.resume(jobId)
    await rig.svc.settled(jobId)
    expect(jobOf(rig, jobId).failed).toEqual([])
    expect(manifestKeys(rig)).toEqual([a1, keyOf('2', 12)].sort())
  })

  it("'completed' with only the pair on disk: the item fails after a few evaluations instead of waiting forever", async () => {
    rig = makePrefetchRig()
    const { a1 } = seedAlpha(rig)
    rig.net.hold(12)
    const jobId = await start(rig, [a1], [pf('2', 12)])
    await until(() => jobOf(rig, jobId).filesDone === 1, 'the downloaded item')
    // A status that outranks the disk: merged, but no .mkv here.
    const internals = rig.dm as unknown as { mergeStatuses: Map<number, { status: string }> }
    internals.mergeStatuses.set(12, { status: 'completed' })
    rig.net.release(12)
    await rig.svc.settled(jobId)
    const job = jobOf(rig, jobId)
    expect(job.status).toBe('completed')
    expect(job.failed.map((f) => [f.key, f.reason])).toEqual([[keyOf('2', 12), NO_MERGED_FILE]])
  })
})

void flush
