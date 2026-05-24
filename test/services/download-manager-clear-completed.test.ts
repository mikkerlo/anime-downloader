import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DownloadManager,
  type DownloadItem,
  type MergeStatus
} from '../../src/main/download-manager'

function makeItem(overrides: Partial<DownloadItem>): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: 'anime/file.mp4',
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
}

function seed(
  dm: DownloadManager,
  items: DownloadItem[],
  merges: [number, { status: MergeStatus }][] = []
): void {
  const internals = dm as unknown as Internals
  internals.queue = items
  internals.mergeStatuses.clear()
  for (const [tid, ms] of merges) internals.mergeStatuses.set(tid, ms)
}

describe('DownloadManager.clearCompleted', () => {
  let tmpDir: string
  let dm: DownloadManager

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-test-'))
    const stubApi = {} as never
    dm = new DownloadManager('/tmp/anime-dl-test-downloads', stubApi, tmpDir)
  })

  afterEach(() => {
    dm.destroy()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes ready-for-merge groups (completed items with no merge entry)', () => {
    seed(dm, [makeItem({ translationId: 1, id: 'video-1', status: 'completed' })])
    expect(dm.getEpisodeGroups()).toHaveLength(1)

    dm.clearCompleted()

    expect(dm.getEpisodeGroups()).toHaveLength(0)
  })

  it('keeps groups whose merge is in progress', () => {
    seed(
      dm,
      [makeItem({ translationId: 1, id: 'video-1', status: 'completed' })],
      [[1, { status: 'merging' }]]
    )
    dm.clearCompleted()

    expect(dm.getEpisodeGroups()).toHaveLength(1)
    expect(dm.getEpisodeGroups()[0].mergeStatus).toBe('merging')
  })

  it('keeps groups recovered from a crashed merge (pending) so user can retry', () => {
    seed(
      dm,
      [makeItem({ translationId: 1, id: 'video-1', status: 'completed' })],
      [[1, { status: 'pending' }]]
    )
    dm.clearCompleted()

    expect(dm.getEpisodeGroups()).toHaveLength(1)
  })

  it('removes merged groups (regression — existing behavior preserved)', () => {
    seed(
      dm,
      [makeItem({ translationId: 1, id: 'video-1', status: 'completed' })],
      [[1, { status: 'completed' }]]
    )
    dm.clearCompleted()

    expect(dm.getEpisodeGroups()).toHaveLength(0)
  })

  it('removes merge-failed groups (regression — existing behavior preserved)', () => {
    seed(
      dm,
      [makeItem({ translationId: 1, id: 'video-1', status: 'completed' })],
      [[1, { status: 'failed' }]]
    )
    dm.clearCompleted()

    expect(dm.getEpisodeGroups()).toHaveLength(0)
  })

  it('removes cancelled and failed item groups (regression — existing behavior preserved)', () => {
    seed(dm, [
      makeItem({ translationId: 1, id: 'video-1', status: 'cancelled' }),
      makeItem({ translationId: 2, id: 'video-2', status: 'failed' })
    ])
    dm.clearCompleted()

    expect(dm.getEpisodeGroups()).toHaveLength(0)
  })

  it('keeps downloading/paused/queued groups', () => {
    seed(dm, [
      makeItem({ translationId: 1, id: 'video-1', status: 'downloading' }),
      makeItem({ translationId: 2, id: 'video-2', status: 'paused' }),
      makeItem({ translationId: 3, id: 'video-3', status: 'queued' })
    ])
    dm.clearCompleted()

    expect(dm.getEpisodeGroups()).toHaveLength(3)
  })

  it('clears ready-for-merge alongside merged in a single sweep', () => {
    seed(
      dm,
      [
        makeItem({ translationId: 1, id: 'video-1', status: 'completed' }),
        makeItem({ translationId: 2, id: 'video-2', status: 'completed' }),
        makeItem({ translationId: 3, id: 'video-3', status: 'downloading' })
      ],
      [[2, { status: 'completed' }]]
    )
    dm.clearCompleted()

    const remaining = dm.getEpisodeGroups()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].translationId).toBe(3)
  })
})
