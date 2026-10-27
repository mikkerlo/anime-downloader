// Clocks (clamp, later-wins) and the drive tombstone GC (#572 §6–7), plus the
// module's purity: nothing under lib/sync-state/ imports `fs`, so no file
// mtime can become a clock.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import {
  MAX_FUTURE_SKEW_MS,
  clampSyncDoc,
  laterClock
} from '../../../src/main/lib/sync-state/clock'
import { TOMBSTONE_MAX_AGE_MS, pruneDocTombstones } from '../../../src/main/lib/sync-state/gc'

const NOW = Date.UTC(2026, 9, 27)
const DAY = 24 * 60 * 60 * 1000

function doc(at: number): SyncDoc {
  return {
    stateVersion: 1,
    stateMinor: 0,
    installId: 'pc-a',
    titles: {
      '1': {
        watch: {
          '3': {
            position: { value: { position: 1, duration: 2 }, at, origin: 'pc-b' },
            watched: { value: false, at: NOW, origin: 'pc-b' },
            watchedAt: null
          }
        },
        starred: { value: true, at, origin: 'pc-b' }
      }
    },
    priorityOrder: { value: [], at, origin: 'pc-b' },
    tombstones: { '2': { priority: { deleted: true, at, origin: 'pc-b' } } }
  }
}

describe('clampSyncDoc', () => {
  it('moves an `at` more than 120 s in the future back to now, and reports each clamp', () => {
    const input = doc(NOW + MAX_FUTURE_SKEW_MS + 1)
    const { doc: out, clamped } = clampSyncDoc(input, NOW)
    expect(clamped.map((c) => c.path)).toEqual([
      'titles.1.watch.3.position',
      'titles.1.starred',
      'priorityOrder',
      'tombstones.2.priority'
    ])
    expect(out.titles['1'].starred!.at).toBe(NOW)
    expect(out.tombstones['2'].priority!.at).toBe(NOW)
    expect(input.titles['1'].starred!.at).toBe(NOW + MAX_FUTURE_SKEW_MS + 1)
  })

  it('leaves a clock exactly 120 s ahead alone', () => {
    expect(clampSyncDoc(doc(NOW + MAX_FUTURE_SKEW_MS), NOW).clamped).toEqual([])
  })
})

describe('laterClock', () => {
  it('takes the later `at`, and side A on a tie', () => {
    const a = { at: 5, origin: 'a' }
    const b = { at: 5, origin: 'b' }
    expect(laterClock(a, b)).toBe(a)
    expect(laterClock(a, { at: 6, origin: 'b' }).origin).toBe('b')
  })
})

describe('pruneDocTombstones (the drive side)', () => {
  const stone = (ageDays: number): SyncTombstone => ({
    deleted: true,
    at: NOW - ageDays * DAY,
    origin: 'pc-b'
  })

  it('drops a tombstone older than 365 days and keeps a 364-day-old one', () => {
    expect(TOMBSTONE_MAX_AGE_MS).toBe(365 * DAY)
    expect(
      pruneDocTombstones(
        { '1': { starred: stone(366), priority: stone(364) }, '2': { starred: stone(366) } },
        NOW,
        ['1', '2']
      )
    ).toEqual({ '1': { priority: stone(364) } })
  })

  it("drops a tombstone whose title left the library's scope", () => {
    expect(
      pruneDocTombstones({ '1': { starred: stone(1) }, '9': { starred: stone(1) } }, NOW, ['1'])
    ).toEqual({
      '1': { starred: stone(1) }
    })
  })
})

describe('lib/sync-state/ is pure', () => {
  it('no module imports fs, so no mtime can be read as a clock', () => {
    const dir = resolve(__dirname, '../../../src/main/lib/sync-state')
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
    expect(files.sort()).toEqual([
      'apply.ts',
      'bases.ts',
      'clock.ts',
      'field-table.ts',
      'gc.ts',
      'project.ts',
      'skip.ts'
    ])
    for (const file of files) {
      const src = readFileSync(resolve(dir, file), 'utf8')
      expect(src, file).not.toMatch(/from ['"](node:)?(fs|fs\/promises|original-fs)['"]/)
      expect(src, file).not.toMatch(/require\(['"](node:)?fs/)
      expect(src, file).not.toMatch(/\bmtime/)
    }
  })
})
