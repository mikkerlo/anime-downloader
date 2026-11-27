// `createCalendarCache` (#747): the calendar section's invalidation counter,
// over an in-memory `createDisplaySnapshots`. The provider flows that drive it
// are `test/ipc/shikimori-offline-views.ipc.test.ts` and
// `test/ipc/tracker-calendar.ipc.test.ts`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createCalendarCache,
  createDisplaySnapshots,
  type CalendarSnapshot
} from '../../src/main/trackers/display-snapshots'

const ME = 7
const T0 = new Date('2026-11-28T12:00:00Z').getTime()

function setup() {
  const snapshots = createDisplaySnapshots<{ calendar: CalendarSnapshot<string> }>({
    sections: ['calendar'],
    currentUserId: () => ME,
    label: '[test]',
    revive: { calendar: (stored, userId) => ({ ...stored, userId, invalidated: true }) }
  })
  return { snapshots, cache: createCalendarCache(snapshots) }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createCalendarCache (#747)', () => {
  it('put with no since stores a fresh record: the direct callers’ meaning', () => {
    const { cache } = setup()
    cache.invalidate()
    const put = cache.put(['a'], ME)
    expect(put).toEqual({ data: ['a'], fetchedAt: T0, userId: ME, invalidated: false })
    expect(cache.get()).toEqual(put)
  })

  it('begin then put with no invalidate between them stores invalidated: false', () => {
    const { cache } = setup()
    cache.invalidate()
    const since = cache.begin()
    cache.put(['a'], ME, since)
    expect(cache.get()).toMatchObject({ data: ['a'], invalidated: false })
  })

  it('begin, invalidate with no record, put: stored invalidated: true', () => {
    const { cache } = setup()
    const since = cache.begin()
    cache.invalidate()
    expect(cache.get()).toBeNull()
    cache.put(['a'], ME, since)
    expect(cache.get()).toMatchObject({ data: ['a'], invalidated: true })
  })

  it('begin, invalidate with a record, put: the old record is marked and the new one stored invalidated', () => {
    const { cache } = setup()
    cache.put(['old'], ME)
    const since = cache.begin()
    cache.invalidate()
    expect(cache.get()).toMatchObject({ data: ['old'], invalidated: true })
    vi.setSystemTime(T0 + 1000)
    cache.put(['new'], ME, since)
    expect(cache.get()).toEqual({
      data: ['new'],
      fetchedAt: T0 + 1000,
      userId: ME,
      invalidated: true
    })
  })

  it('every invalidate counts: a later fetch’s since sees the latest', () => {
    const { cache } = setup()
    const first = cache.begin()
    cache.invalidate()
    cache.invalidate()
    const second = cache.begin()
    expect(second).not.toBe(first)
    cache.put(['a'], ME, second)
    expect(cache.get()?.invalidated).toBe(false)
  })

  it('a put for a user who is not signed in stores nothing, whatever since is', () => {
    const { cache } = setup()
    cache.put(['mine'], ME)
    const since = cache.begin()
    expect(cache.put(['other'], ME + 1)).toMatchObject({ userId: ME + 1, invalidated: false })
    expect(cache.put(['other'], ME + 1, since)).toMatchObject({ invalidated: false })
    cache.invalidate()
    expect(cache.put(['other'], null, since)).toMatchObject({ invalidated: true })
    expect(cache.get()).toMatchObject({ data: ['mine'] })
  })
})
