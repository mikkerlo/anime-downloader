// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import CalendarView from '../../../src/renderer/src/components/views/CalendarView.vue'

function stubApi(overrides: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(overrides, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
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
      shikimoriGetUser: vi.fn().mockResolvedValue({ id: 1, nickname: 'me' }),
      getSetting: vi.fn().mockResolvedValue('week'),
      autoDlListSubscriptions: vi.fn().mockResolvedValue([]),
      shikimoriGetCalendar: vi.fn().mockResolvedValue([
        entry(new Date(2026, 2, 18, 20, 0, 0), 'Airs today'),
        entry(new Date(2026, 2, 25, 20, 0, 0), 'Airs next week')
      ])
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
