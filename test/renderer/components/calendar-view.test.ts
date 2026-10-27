// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import CalendarView from '../../../src/renderer/src/components/views/CalendarView.vue'
import { offlineApi, type OfflineApi } from '../../helpers/offline-api'

function stubApi(overrides: Record<string, unknown>, offline: OfflineApi = offlineApi()): void {
  const target = { ...offline.api, ...overrides }
  ;(window as unknown as { api: unknown }).api = new Proxy(target, {
    get: (t, prop, recv) => (prop in t ? Reflect.get(t, prop, recv) : () => () => {})
  })
}

function entry(at: Date, name: string): CalendarEntry {
  return {
    malId: Math.floor(at.getTime() / 1000),
    animeId: 1,
    name,
    posterUrl: 'p.jpg',
    kind: 'tv',
    episodeInt: '3',
    nextEpisodeAt: at.toISOString(),
    userStatus: 'watching'
  }
}

function result(
  data: CalendarEntry[],
  fetchedAt: number | null,
  stale: boolean
): ShikiSnapshotResult<CalendarEntry[]> {
  return { data, fetchedAt, stale }
}

const BASE = {
  shikimoriGetUser: vi.fn().mockResolvedValue({ id: 1, nickname: 'me' }),
  getSetting: vi.fn().mockResolvedValue('week'),
  autoDlListSubscriptions: vi.fn().mockResolvedValue([])
}

beforeEach(() => {
  setActivePinia(createPinia())
  // Fixed "today" — Wednesday 2026-03-18 09:00 local — so every `new Date()`
  // in the component (now, todayPos, startOfWeek) is deterministic.
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 2, 18, 9, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CalendarView — today column detection (JS-driven todayPos)', () => {
  it('flags exactly the column for the real date, and clears it when paging off the visible week', async () => {
    stubApi({
      ...BASE,
      shikimoriGetCalendar: vi
        .fn()
        .mockResolvedValue(
          result(
            [
              entry(new Date(2026, 2, 18, 20, 0, 0), 'Airs today'),
              entry(new Date(2026, 2, 25, 20, 0, 0), 'Airs next week')
            ],
            Date.now(),
            false
          )
        )
    })

    const wrapper = mount(CalendarView)
    await flushPromises()

    // Exactly one column carries the accent highlight, and it is Wednesday.
    const todayCols = wrapper.findAll('.cal-col.today')
    expect(todayCols).toHaveLength(1)
    expect(todayCols[0].find('.today-tag').text()).toBe('Today')
    expect(todayCols[0].find('.cal-dayname').text()).toBe('Wed')

    // Page forward one week: today is no longer on the page, highlight clears.
    const navButtons = wrapper.findAll('.icon-btn')
    await navButtons[1].trigger('click') // next week
    await nextTick()

    // The next week still renders a grid (the second entry lives there)…
    expect(wrapper.findAll('.cal-col').length).toBeGreaterThan(0)
    // …but no column is "today".
    expect(wrapper.findAll('.cal-col.today')).toHaveLength(0)
  })
})

describe('CalendarView — offline (#568)', () => {
  const twoHoursAgo = (): number => Date.now() - 2 * 60 * 60 * 1000

  it('offline: paints the snapshot with a "Last updated" stamp', async () => {
    stubApi(
      {
        ...BASE,
        shikimoriGetCalendar: vi
          .fn()
          .mockResolvedValue(
            result([entry(new Date(2026, 2, 18, 20, 0, 0), 'Airs today')], twoHoursAgo(), true)
          )
      },
      offlineApi('offline-manual')
    )
    const wrapper = mount(CalendarView)
    await flushPromises()

    expect(wrapper.find('[data-testid="calendar-stamp"]').text()).toBe('Last updated 2 h ago')
    expect(wrapper.findAll('.ce')).toHaveLength(1)
    expect(wrapper.find('[data-testid="offline-notice"]').exists()).toBe(false)
  })

  it('offline with no snapshot: shows the OfflineNotice', async () => {
    stubApi(
      { ...BASE, shikimoriGetCalendar: vi.fn().mockResolvedValue(result([], null, true)) },
      offlineApi('offline-auto')
    )
    const wrapper = mount(CalendarView)
    await flushPromises()

    const notice = wrapper.find('[data-testid="offline-notice"]')
    expect(notice.text()).toContain('Calendar needs an internet connection')
    expect(notice.find('[data-testid="offline-notice-action"]').text()).toBe('Retry')
    expect(wrapper.find('[data-testid="calendar-stamp"]').exists()).toBe(false)
  })

  it('online and fresh: no stamp, no notice — today', async () => {
    stubApi({
      ...BASE,
      shikimoriGetCalendar: vi
        .fn()
        .mockResolvedValue(
          result([entry(new Date(2026, 2, 18, 20, 0, 0), 'Airs today')], Date.now(), false)
        )
    })
    const wrapper = mount(CalendarView)
    await flushPromises()

    expect(wrapper.find('[data-testid="calendar-stamp"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="offline-notice"]').exists()).toBe(false)
  })

  it('online, served stale after a failed fetch: a neutral stamp, never offline wording', async () => {
    stubApi({
      ...BASE,
      shikimoriGetCalendar: vi
        .fn()
        .mockResolvedValue(
          result([entry(new Date(2026, 2, 18, 20, 0, 0), 'Airs today')], twoHoursAgo(), true)
        )
    })
    const wrapper = mount(CalendarView)
    await flushPromises()

    expect(wrapper.find('[data-testid="calendar-stamp"]').text()).toBe('Last updated 2 h ago')
    expect(wrapper.text()).not.toMatch(/offline|internet connection/i)
  })

  it('going offline shows the stamp without a reload; back online refetches once', async () => {
    const offline = offlineApi()
    const getCalendar = vi
      .fn()
      .mockResolvedValue(
        result([entry(new Date(2026, 2, 18, 20, 0, 0), 'Airs today')], Date.now(), false)
      )
    stubApi({ ...BASE, shikimoriGetCalendar: getCalendar }, offline)
    const wrapper = mount(CalendarView)
    await flushPromises()
    expect(wrapper.find('[data-testid="calendar-stamp"]').exists()).toBe(false)

    offline.emit('offline-manual')
    await flushPromises()
    expect(wrapper.find('[data-testid="calendar-stamp"]').text()).toBe('Last updated just now')
    expect(getCalendar).toHaveBeenCalledTimes(1)

    // A fresh snapshot needs no refetch on the way back.
    offline.emit('online')
    await flushPromises()
    expect(getCalendar).toHaveBeenCalledTimes(1)
  })

  it('back online after an offline-served snapshot refetches exactly once', async () => {
    const offline = offlineApi('offline-manual')
    const getCalendar = vi
      .fn()
      .mockResolvedValueOnce(result([], null, true))
      .mockResolvedValue(
        result([entry(new Date(2026, 2, 18, 20, 0, 0), 'Airs today')], Date.now(), false)
      )
    stubApi({ ...BASE, shikimoriGetCalendar: getCalendar }, offline)
    const wrapper = mount(CalendarView)
    await flushPromises()
    expect(wrapper.find('[data-testid="offline-notice"]').exists()).toBe(true)

    offline.emit('online')
    await flushPromises()
    expect(getCalendar).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="offline-notice"]').exists()).toBe(false)
    expect(wrapper.findAll('.ce')).toHaveLength(1)

    await flushPromises()
    expect(getCalendar).toHaveBeenCalledTimes(2)
  })
})
