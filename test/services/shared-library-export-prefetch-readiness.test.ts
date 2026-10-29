// `evaluatePrefetchItem` (#577): the one readiness decision for a pre-fetched
// export item, live, at resume and at boot. A pure function of what it is
// handed, so each row of the decision table in docs/shared-library.md
// ("Pre-fetch") is one case here; the integration file drives the same rows
// through a real `DownloadManager`.

import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_CANCELLED,
  MERGE_GRACE_MS,
  NO_LONGER_QUEUED,
  PREFETCH_TICK_MS,
  SUBTITLES_FAILED,
  evaluatePrefetchItem,
  type PrefetchMemory,
  type PrefetchRow,
  type PrefetchState
} from '../../src/main/services/shared-library-export/prefetch-readiness'

const T0 = 1_000_000

const row = (status: PrefetchRow['status'], more: Partial<PrefetchRow> = {}): PrefetchRow => ({
  status,
  bytesReceived: 0,
  totalBytes: 0,
  ...more
})

/** A finished group with its `.mp4` on disk, no merge status, and no merge expected. */
const finished = (more: Partial<PrefetchState> = {}): PrefetchState => ({
  video: row('completed'),
  subtitle: row('completed'),
  mergeStatus: null,
  mergeExpected: false,
  mergeInFlight: false,
  files: { mkv: false, video: true },
  offline: false,
  now: T0,
  ...more
})

const decide = (s: PrefetchState, m: PrefetchMemory = {}) => evaluatePrefetchItem(s, m).decision

describe('evaluatePrefetchItem (#577) — the downloads', () => {
  it.each(['queued', 'downloading', 'paused'] as const)(
    'a %s video row waits for its download, with its progress',
    (status) => {
      expect(
        decide(finished({ video: row(status, { bytesReceived: 25, totalBytes: 100 }) }))
      ).toEqual({ kind: 'wait', on: 'download', percent: 25 })
    }
  )

  it('offline, a queued or downloading row waits for the connection; a paused one for the download', () => {
    expect(decide(finished({ offline: true, video: row('queued') }))).toMatchObject({
      on: 'connection'
    })
    expect(decide(finished({ offline: true, video: row('downloading') }))).toMatchObject({
      on: 'connection'
    })
    expect(decide(finished({ offline: true, video: row('paused') }))).toMatchObject({
      on: 'download'
    })
  })

  it('a failed video row fails the item with the row’s own error; a cancelled one with “Download cancelled”', () => {
    expect(decide(finished({ video: row('failed', { error: 'HTTP 403' }) }))).toEqual({
      kind: 'failed',
      reason: 'HTTP 403'
    })
    expect(decide(finished({ video: row('cancelled') }))).toEqual({
      kind: 'failed',
      reason: DOWNLOAD_CANCELLED
    })
  })

  it('a subtitle still going is waited for, even after its video finished', () => {
    expect(decide(finished({ subtitle: row('downloading') }))).toMatchObject({
      kind: 'wait',
      on: 'download'
    })
  })

  it.each(['failed', 'cancelled'] as const)(
    'a %s subtitle leaves the video, with the warning',
    (status) => {
      expect(decide(finished({ subtitle: row(status) }))).toEqual({
        kind: 'ready',
        as: 'pair',
        warning: SUBTITLES_FAILED
      })
    }
  )

  it('no rows and no files: “Download no longer queued”; files without rows go on', () => {
    const none = { video: null, subtitle: null }
    expect(decide(finished({ ...none, files: { mkv: false, video: false } }))).toEqual({
      kind: 'failed',
      reason: NO_LONGER_QUEUED
    })
    expect(decide(finished({ ...none, files: { mkv: false, video: true } }))).toMatchObject({
      kind: 'ready',
      as: 'pair'
    })
    expect(decide(finished({ ...none, files: { mkv: true, video: false } }))).toMatchObject({
      kind: 'ready',
      as: 'mkv'
    })
  })
})

describe('evaluatePrefetchItem (#577) — the merge status', () => {
  it("'deferred' waits, even with the final file not on disk yet", () => {
    expect(
      decide(finished({ mergeStatus: 'deferred', files: { mkv: false, video: false } }))
    ).toEqual({ kind: 'wait', on: 'merge', percent: 0 })
  })

  it("'merging' waits, whatever the predicate says", () => {
    expect(decide(finished({ mergeStatus: 'merging' }))).toMatchObject({ kind: 'wait' })
  })

  it("'completed', or an .mkv on disk, is the .mkv", () => {
    expect(decide(finished({ mergeStatus: 'completed' }))).toMatchObject({
      kind: 'ready',
      as: 'mkv'
    })
    expect(decide(finished({ files: { mkv: true, video: false } }))).toMatchObject({
      kind: 'ready',
      as: 'mkv'
    })
  })

  it("'failed' is the unmerged pair, even with a merge expected", () => {
    expect(decide(finished({ mergeStatus: 'failed', mergeExpected: true }))).toMatchObject({
      kind: 'ready',
      as: 'pair'
    })
  })
})

describe.each([null, 'pending'] as const)(
  'evaluatePrefetchItem (#577) — step 6, status %s (the same rule for both)',
  (mergeStatus) => {
    it('no merge expected: the pair, on the first evaluation', () => {
      expect(decide(finished({ mergeStatus }))).toEqual({
        kind: 'ready',
        as: 'pair',
        warning: null
      })
    })

    it('a merge expected and one in flight or held: waits, however long', () => {
      const s = finished({ mergeStatus, mergeExpected: true, mergeInFlight: true })
      let m: PrefetchMemory = {}
      for (let t = T0; t <= T0 + 120_000; t += PREFETCH_TICK_MS) {
        const r = evaluatePrefetchItem({ ...s, now: t }, m)
        expect(r.decision).toMatchObject({ kind: 'wait', on: 'merge' })
        m = r.memory
      }
    })

    it('a merge expected and nothing in flight: the pair after two idle evaluations ≥ 3 s apart and ≥ 5 s past doneAt', () => {
      const s = finished({ mergeStatus, mergeExpected: true })
      let r = evaluatePrefetchItem(s, {})
      expect(r.decision.kind).toBe('wait')
      expect(r.memory).toEqual({ doneAt: T0, idleSince: T0 })
      r = evaluatePrefetchItem({ ...s, now: T0 + PREFETCH_TICK_MS }, r.memory)
      expect(r.decision.kind).toBe('wait') // 3 s apart, but only 3 s past doneAt
      r = evaluatePrefetchItem({ ...s, now: T0 + MERGE_GRACE_MS - 1 }, r.memory)
      expect(r.decision.kind).toBe('wait')
      r = evaluatePrefetchItem({ ...s, now: T0 + MERGE_GRACE_MS }, r.memory)
      expect(r.decision).toEqual({ kind: 'ready', as: 'pair', warning: null })
    })

    it('long past doneAt, the two idle sightings must still be ≥ 3 s apart', () => {
      const s = finished({ mergeStatus, mergeExpected: true })
      const late = T0 + 60_000
      let r = evaluatePrefetchItem({ ...s, now: late }, { doneAt: T0 })
      expect(r.decision.kind).toBe('wait')
      r = evaluatePrefetchItem({ ...s, now: late + PREFETCH_TICK_MS - 1 }, r.memory)
      expect(r.decision.kind).toBe('wait')
      r = evaluatePrefetchItem({ ...s, now: late + PREFETCH_TICK_MS }, r.memory)
      expect(r.decision.kind).toBe('ready')
    })

    it('a merge in flight between the two sightings starts the count again', () => {
      const s = finished({ mergeStatus, mergeExpected: true })
      let r = evaluatePrefetchItem(s, { doneAt: T0 - 60_000 })
      r = evaluatePrefetchItem({ ...s, now: T0 + 1000, mergeInFlight: true }, r.memory)
      expect(r.memory.idleSince).toBeUndefined()
      r = evaluatePrefetchItem({ ...s, now: T0 + PREFETCH_TICK_MS }, r.memory)
      expect(r.decision.kind).toBe('wait')
      r = evaluatePrefetchItem({ ...s, now: T0 + 2 * PREFETCH_TICK_MS }, r.memory)
      expect(r.decision.kind).toBe('ready')
    })
  }
)

describe('evaluatePrefetchItem (#577) — doneAt', () => {
  it('is set at the first evaluation that sees the rows finished, and a persisted one is kept', () => {
    expect(evaluatePrefetchItem(finished({ video: row('downloading') }), {}).memory.doneAt).toBe(
      undefined
    )
    expect(evaluatePrefetchItem(finished({ mergeStatus: 'merging' }), {}).memory.doneAt).toBe(T0)
    expect(
      evaluatePrefetchItem(finished({ mergeStatus: 'merging' }), { doneAt: T0 - 5 }).memory.doneAt
    ).toBe(T0 - 5)
  })
})
