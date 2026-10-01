// `verifyRootBoundFilesUnder()` — the file check behind a validated root move
// (#451).
//
// #440 told a user whose storage root went away to "re-pick the folder to
// resume", and #449 kept that door open only for a drive that comes back at the
// *same* path: `rootMoveRefusal()` exempts a re-pick that resolves to the root
// already in force, and refuses everything else while `hasRootBoundWork()`
// holds. A drive that returns as `/media/user/DISK1_` is a genuine root move, so
// it is refused, and the user's only exits are to cancel the stranded work or to
// clear the root — neither of which is "resume".
//
// Shape (1) from the plan review: a **validated root move**, not a per-item root
// (which is still the change #443 declined). The items carry no root of their
// own, so there is no binding to rewrite — every path comes from the manager's
// single cached `downloadDir`. What makes the move safe is therefore not a
// rewrite but this check: re-binding to a root that does not actually hold the
// partial files converts a clear refusal into silent data loss on the next merge
// or cancel, which is strictly worse than today's over-blocking.
//
// A plain "is a file with that name there" test would not do it, so the review
// pinned a per-state definition of "the expected file is present", and this file
// is that table:
//
//   - `queued`/`paused`/`failed` with `bytesReceived > 0` → `<root>/<name>.part`
//     exists **and** its size is `bytesReceived`, or short of it by at most
//     `PART_IN_FLIGHT_SLACK`. The important one: on resume `startDownload` stats
//     the `.part` and sends `Range: bytes=<size>-`
//     (`src/main/download-manager.ts:1420-1425`), so a same-named `.part`
//     belonging to some other download is appended to with no error anywhere.
//     The slack is not laxity: `trackProgress` counts a chunk before `throttle`
//     and the write stream see it and `destroy()` persists before aborting, so a
//     quit mid-download leaves the counter ahead of the file with no later
//     chance to reconcile it (#455 review). A `.part` *longer* than the counter
//     still refuses.
//   - `completed` still owed a merge → the finished artifact exists. `_mergeAll`
//     reads the video at `src/main/download-manager.ts:1067` and the subtitle at
//     `src/main/download-manager.ts:1081`, and skips a missing video with a
//     silent `continue`.
//   - a `deferred` merge → either the `.part` or the final file, because
//     `finalizeDeferred` handles both (`src/main/download-manager.ts:994-998`).
//   - `queued` with `bytesReceived === 0` → nothing on disk to check, excluded.
//   - `downloading` items and `merging` merges → `busy`, which the caller
//     refuses on: those hold paths in locals under the old root, and
//     `mkdirSync(…, { recursive: true })`
//     (`src/main/download-manager.ts:1416`) can recreate a dead mount path, so
//     a live write may be landing somewhere that is neither root.
//
// The method mutates nothing — the `store.set` + `resyncDownloadDir()` half
// lives in the IPC handler, the way `rootMoveRefusal()` gates the pickers, and
// `test/ipc/storage-rebind-root.ipc.test.ts` covers it there.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { join } from 'path'
import {
  DownloadManager,
  PART_IN_FLIGHT_SLACK,
  type DownloadItem,
  type MergeStatus
} from '../../src/main/download-manager'

const ANIME_DIR = 'Anime'
const VIDEO = path.join(ANIME_DIR, 'Anime - 01 [X].mp4')
const SUBTITLE = path.join(ANIME_DIR, 'Anime - 01 [X].ass')

type Internals = {
  queue: DownloadItem[]
  mergeStatuses: Map<number, { status: MergeStatus; error?: string; percent?: number }>
  downloadDir: string
}

function makeItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: VIDEO,
    animeName: 'Anime',
    episodeLabel: '1',
    animeId: 100,
    episodeInt: '1',
    quality: 720,
    translationType: 'subRu',
    author: 'X',
    status: 'paused',
    bytesReceived: 0,
    totalBytes: 0,
    speed: 0,
    ...overrides
  }
}

describe('DownloadManager — verifyRootBoundFilesUnder (#451)', () => {
  let oldRoot: string
  let newRoot: string
  let userDataDir: string
  let dm: DownloadManager

  function seed(items: DownloadItem[], merges: [number, MergeStatus][] = []): void {
    const internals = dm as unknown as Internals
    internals.queue = items
    internals.mergeStatuses.clear()
    for (const [tid, status] of merges) internals.mergeStatuses.set(tid, { status })
  }

  /** Write `bytes` bytes at `<root>/<rel>`, creating the anime directory. */
  function put(root: string, rel: string, bytes = 5): string {
    const abs = join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, Buffer.alloc(bytes, 1))
    return abs
  }

  const check = (): RootRebindCheck => dm.verifyRootBoundFilesUnder(newRoot)
  const names = (reports: RootBoundFileReport[]): string[] => reports.map((r) => r.filename)

  beforeEach(() => {
    oldRoot = fs.mkdtempSync(join(os.tmpdir(), 'rebind-old-'))
    newRoot = fs.mkdtempSync(join(os.tmpdir(), 'rebind-new-'))
    userDataDir = fs.mkdtempSync(join(os.tmpdir(), 'rebind-userdata-'))
    dm = new DownloadManager(oldRoot, {} as never, userDataDir)
  })

  afterEach(() => {
    dm.destroy()
    for (const dir of [oldRoot, newRoot, userDataDir]) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // The wrong-files protection, and the reason a name match is not enough. A
  // `.part` of the wrong size is either someone else's download or a truncated
  // copy; resuming onto it appends from its own length and produces a file that
  // is corrupt in the middle with nothing reporting an error.
  describe('a partial transfer is matched by name AND by size', () => {
    it('matches a .part whose size is exactly bytesReceived', () => {
      put(newRoot, VIDEO + '.part', 1024)
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])

      const result = check()

      expect(names(result.matched)).toEqual([VIDEO])
      expect(result.unmatched).toEqual([])
      expect(result.busy).toEqual([])
    })

    // THE case. The file is there, the name is right, and re-binding to it
    // would corrupt the download on the next resume. A `.part` *longer* than
    // the counter is the direction no in-flight buffer can explain — the
    // counter only ever runs ahead of the file, never behind it — so this is
    // the one that stays an unconditional refusal (#455 review).
    it('refuses a .part longer than bytesReceived, and says both sizes', () => {
      put(newRoot, VIDEO + '.part', 2048)
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])

      const result = check()

      expect(result.matched).toEqual([])
      expect(names(result.unmatched)).toEqual([VIDEO])
      expect(result.unmatched[0].reason).toContain('2048')
      expect(result.unmatched[0].reason).toContain('1024')
    })

    // The counter is incremented by `trackProgress`, the first `pipeline` stage,
    // so it already counts bytes that `throttle` and the write stream have not
    // received; and `destroy()` runs `persistQueue()` before it aborts, so a
    // quit mid-download persists that inflated number. By the next start the
    // drive is gone and nothing can stat the `.part` to correct it — which is
    // exactly the state this check runs in — so a `.part` short by at most what
    // the pipeline could have held is our own file, and demanding equality would
    // refuse the move for the case the issue calls the common one.
    it('matches a .part short of bytesReceived by less than the in-flight slack', () => {
      put(newRoot, VIDEO + '.part', 1024)
      seed([makeItem({ status: 'paused', bytesReceived: 1024 + 64 * 1024 })])

      const result = check()

      expect(names(result.matched)).toEqual([VIDEO])
      expect(result.unmatched).toEqual([])
    })

    // The bound itself, pinned at the edge rather than at a round number, so a
    // change to `PART_IN_FLIGHT_SLACK` cannot quietly turn one of these into the
    // other.
    it('matches a .part short by exactly the slack and refuses one byte past it', () => {
      put(newRoot, VIDEO + '.part', 1024)
      seed([makeItem({ status: 'paused', bytesReceived: 1024 + PART_IN_FLIGHT_SLACK })])

      expect(names(check().matched)).toEqual([VIDEO])

      seed([makeItem({ status: 'paused', bytesReceived: 1024 + PART_IN_FLIGHT_SLACK + 1 })])

      const result = check()

      expect(result.matched).toEqual([])
      expect(names(result.unmatched)).toEqual([VIDEO])
      expect(result.unmatched[0].reason).toContain('different file')
    })

    // Far short is the foreign-`.part` case the slack must not swallow: a
    // same-named stub from an unrelated download resumes from its own length and
    // writes a file that is corrupt in the middle with nothing reporting it.
    it('refuses a .part short of bytesReceived by more than the slack', () => {
      put(newRoot, VIDEO + '.part', 10)
      seed([makeItem({ status: 'paused', bytesReceived: PART_IN_FLIGHT_SLACK + 4096 })])

      const result = check()

      expect(result.matched).toEqual([])
      expect(names(result.unmatched)).toEqual([VIDEO])
      expect(result.unmatched[0].reason).toContain('10')
    })

    it('refuses a partial transfer with no .part under the candidate root', () => {
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])

      const result = check()

      expect(result.matched).toEqual([])
      expect(names(result.unmatched)).toEqual([VIDEO])
      expect(result.unmatched[0].reason).toContain('not there')
    })

    // The old root still holding the file is not a match: the whole point is
    // whether the *candidate* root can serve the work after the write.
    it('does not accept a .part that is only under the root in force', () => {
      put(oldRoot, VIDEO + '.part', 1024)
      seed([makeItem({ status: 'paused', bytesReceived: 1024 })])

      expect(check().unmatched).toHaveLength(1)
    })

    it.each([['paused'], ['failed'], ['queued']] as const)(
      'applies the .part rule to a %s item with bytes on disk',
      (status) => {
        put(newRoot, VIDEO + '.part', 7)
        seed([makeItem({ status, bytesReceived: 7 })])

        expect(names(check().matched)).toEqual([VIDEO])
      }
    )

    // `resumeAll()` flips `paused` → `queued` and keeps `bytesReceived`, so a
    // `queued` item is not automatically a fresh one — only a zero-byte one is.
    // The `.part` is *longer* than the counter rather than a few bytes shorter,
    // which the slack would now accept — the point here is only that a `queued`
    // item carrying bytes is file-checked at all, so it needs a mismatch the
    // slack cannot excuse.
    it('checks a queued item that carries bytes, which resumeAll produces', () => {
      put(newRoot, VIDEO + '.part', 9)
      seed([makeItem({ status: 'queued', bytesReceived: 7 })])

      expect(names(check().unmatched)).toEqual([VIDEO])
    })
  })

  // Nothing has been written for these, so there is nothing a root move can
  // strand — and requiring a file would make the common "queue filled, drive
  // unplugged before the first byte" case unrecoverable for no gain.
  describe('an item with nothing on disk is excluded rather than refused', () => {
    it('excludes a queued item with zero bytes from both lists', () => {
      seed([makeItem({ status: 'queued', bytesReceived: 0 })])

      const result = check()

      expect(result.matched).toEqual([])
      expect(result.unmatched).toEqual([])
    })

    it('excludes a cancelled item even with bytes, since every path is already dead', () => {
      seed([makeItem({ status: 'cancelled', bytesReceived: 1024 })])

      const result = check()

      expect(result.matched).toEqual([])
      expect(result.unmatched).toEqual([])
    })

    // `hasRootBoundWork()`'s one inert case: a `completed` item whose merge has
    // itself completed re-derives no path later.
    it('excludes a completed item whose merge completed', () => {
      seed([makeItem({ status: 'completed' })], [[1, 'completed']])

      const result = check()

      expect(result.matched).toEqual([])
      expect(result.unmatched).toEqual([])
    })
  })

  // The clause `hasRootBoundWork()` exists for: a finished video with no merge
  // entry at all is where every episode sits with autoMerge off, and `_mergeAll`
  // still rebuilds its path from the manager's field.
  describe('a completed item still owed a merge needs its finished artifact', () => {
    it('matches the finished video of an unmerged episode', () => {
      put(newRoot, VIDEO)
      seed([makeItem({ status: 'completed' })])

      expect(names(check().matched)).toEqual([VIDEO])
    })

    it('refuses when the finished video is absent', () => {
      seed([makeItem({ status: 'completed' })])

      expect(names(check().unmatched)).toEqual([VIDEO])
    })

    it('refuses an episode whose merge failed and whose video is absent', () => {
      seed([makeItem({ status: 'completed' })], [[1, 'failed']])

      expect(names(check().unmatched)).toEqual([VIDEO])
    })

    // `_mergeAll` reads the subtitle too, so a video-only match would still
    // produce a merge that silently drops the subtitle track.
    it('requires the subtitle as well when the group has one', () => {
      put(newRoot, VIDEO)
      seed([
        makeItem({ status: 'completed' }),
        makeItem({ id: 'sub-1', kind: 'subtitle', filename: SUBTITLE, status: 'completed' })
      ])

      const result = check()

      expect(names(result.matched)).toEqual([VIDEO])
      expect(names(result.unmatched)).toEqual([SUBTITLE])
    })

    it('matches both halves of a complete pair', () => {
      put(newRoot, VIDEO)
      put(newRoot, SUBTITLE)
      seed([
        makeItem({ status: 'completed' }),
        makeItem({ id: 'sub-1', kind: 'subtitle', filename: SUBTITLE, status: 'completed' })
      ])

      const result = check()

      expect(names(result.matched)).toEqual([VIDEO, SUBTITLE])
      expect(result.unmatched).toEqual([])
    })
  })

  // A deferred episode is mid-finalize: the video downloaded while the player
  // held the file open, so it may still be a `.part` awaiting the rename, or the
  // rename may already have happened. `finalizeDeferred` copes with both, so the
  // check has to accept both rather than picking one and refusing the other.
  describe('a deferred merge accepts either shape of the video file', () => {
    it('matches when only the .part is there', () => {
      put(newRoot, VIDEO + '.part')
      seed([makeItem({ status: 'completed' })], [[1, 'deferred']])

      expect(names(check().matched)).toEqual([VIDEO])
    })

    it('matches when only the finished file is there', () => {
      put(newRoot, VIDEO)
      seed([makeItem({ status: 'completed' })], [[1, 'deferred']])

      expect(names(check().matched)).toEqual([VIDEO])
    })

    it('refuses when neither is there', () => {
      seed([makeItem({ status: 'completed' })], [[1, 'deferred']])

      expect(names(check().unmatched)).toEqual([VIDEO])
      expect(check().unmatched[0].reason).toContain('.part')
    })
  })

  // Live work is reported separately from a file miss because no file check can
  // settle it: the running write holds its paths in locals taken under the old
  // root, and the caller has to refuse rather than validate.
  describe('live work is reported as busy, not file-checked', () => {
    it('reports a downloading item as busy even with a perfect .part', () => {
      put(newRoot, VIDEO + '.part', 1024)
      seed([makeItem({ status: 'downloading', bytesReceived: 1024 })])

      const result = check()

      expect(result.busy).toHaveLength(1)
      expect(result.busy[0]).toContain(VIDEO)
      expect(result.matched).toEqual([])
      expect(result.unmatched).toEqual([])
    })

    it('reports a merging merge as busy', () => {
      put(newRoot, VIDEO)
      seed([makeItem({ status: 'completed' })], [[1, 'merging']])

      const result = check()

      expect(result.busy).toHaveLength(1)
      expect(result.matched).toEqual([])
      expect(result.unmatched).toEqual([])
    })
  })

  // The division of labour the review asked for: this method answers, the
  // handler writes. A method that re-pointed the manager itself could not be
  // called before the decision to write, which is the only useful position.
  it('mutates nothing — not the queue, not the merges, not the cached root', () => {
    put(newRoot, VIDEO + '.part', 1024)
    const item = makeItem({ status: 'paused', bytesReceived: 1024 })
    seed([item], [[1, 'pending']])

    check()

    const internals = dm as unknown as Internals
    expect(internals.downloadDir).toBe(oldRoot)
    expect(internals.queue).toEqual([item])
    expect(dm.getMergeStatus(1)).toBe('pending')
  })

  // All-or-nothing is not a UX preference, it is what shape (1) can represent:
  // there is one root for the whole queue, so "re-bind the matched ones" has no
  // meaning. The caller refuses on any unmatched entry, which is also what stops
  // an empty folder from validating trivially — a queue holding real partial
  // work can never come back with an empty `unmatched` and an empty `matched`.
  it('reports the matched and the unmatched together, for a mixed queue', () => {
    put(newRoot, VIDEO + '.part', 1024)
    seed([
      makeItem({ status: 'paused', bytesReceived: 1024 }),
      makeItem({
        id: 'video-2',
        translationId: 2,
        filename: path.join(ANIME_DIR, 'Anime - 02 [X].mp4'),
        status: 'failed',
        bytesReceived: 2048
      })
    ])

    const result = check()

    expect(names(result.matched)).toEqual([VIDEO])
    expect(names(result.unmatched)).toEqual([path.join(ANIME_DIR, 'Anime - 02 [X].mp4')])
  })
})
