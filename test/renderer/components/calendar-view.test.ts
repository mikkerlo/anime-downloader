// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import CalendarView from '../../../src/renderer/src/components/views/CalendarView.vue'
import { offlineApi, type OfflineApi } from '../../helpers/offline-api'
import { accountsState, trackersApi } from '../../helpers/trackers-api'

// The calendar reads the resolved `calendar` source (#709): Shikimori signed
// in unless a test passes other accounts.
function stubWith(
  overrides: Record<string, unknown>,
  offline: OfflineApi = offlineApi(),
  accounts: TrackerAccountsState = accountsState(['shikimori'])
): void {
  const shikimoriUser = accounts.accounts.find((a) => a.trackerId === 'shikimori')?.user ?? null
  const target = {
    ...trackersApi({ accounts }).api,
    shikimoriGetUser: vi.fn().mockResolvedValue(shikimoriUser),
    ...offline.api,
    ...overrides
  }
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

function resultFrom(
  data: CalendarEntry[],
  fetchedAt: number | null,
  stale: boolean,
  trackerId: TrackerId | null = 'shikimori'
): TrackerCalendarResult {
  return { trackerId, data, fetchedAt, stale }
}

const BASE = {
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
    stubWith({
      ...BASE,
      trackerGetCalendar: vi
        .fn()
        .mockResolvedValue(
          resultFrom(
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

// The offline rules hold whichever tracker is the `calendar` source (#709):
// each case runs with that tracker the only account.
describe.each(['shikimori', 'anilist'] as const)(
  'CalendarView — offline (#568), %s source',
  (source) => {
    const twoHoursAgo = (): number => Date.now() - 2 * 60 * 60 * 1000
    const stubApi = (
      overrides: Record<string, unknown>,
      offline: OfflineApi = offlineApi()
    ): void => stubWith(overrides, offline, accountsState([source]))
    const result = (data: CalendarEntry[], fetchedAt: number | null, stale: boolean) =>
      resultFrom(data, fetchedAt, stale, source)

    it('offline: paints the snapshot with a "Last updated" stamp', async () => {
      stubApi(
        {
          ...BASE,
          trackerGetCalendar: vi
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
        { ...BASE, trackerGetCalendar: vi.fn().mockResolvedValue(result([], null, true)) },
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
        trackerGetCalendar: vi
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
        trackerGetCalendar: vi
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
      stubApi({ ...BASE, trackerGetCalendar: getCalendar }, offline)
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
      stubApi({ ...BASE, trackerGetCalendar: getCalendar }, offline)
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
  }
)

describe('CalendarView — the `calendar` source (#709)', () => {
  it('only AniList connected: renders the AniList entries', async () => {
    const getCalendar = vi
      .fn()
      .mockResolvedValue(
        resultFrom(
          [
            entry(new Date(2026, 2, 18, 20, 0, 0), 'Frieren'),
            entry(new Date(2026, 2, 19, 21, 0, 0), 'ONE PIECE')
          ],
          Date.now(),
          false,
          'anilist'
        )
      )
    stubWith({ ...BASE, trackerGetCalendar: getCalendar }, offlineApi(), accountsState(['anilist']))
    const wrapper = mount(CalendarView)
    await flushPromises()

    expect(getCalendar).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.ce-title').map((t) => t.text())).toEqual(['Frieren', 'ONE PIECE'])
    expect(wrapper.find('.empty-state').exists()).toBe(false)
  })

  it('Shikimori + AniList with AniList primary: reads the calendar through the one channel', async () => {
    const getCalendar = vi
      .fn()
      .mockResolvedValue(
        resultFrom(
          [entry(new Date(2026, 2, 18, 20, 0, 0), 'Frieren')],
          Date.now(),
          false,
          'anilist'
        )
      )
    stubWith(
      { ...BASE, trackerGetCalendar: getCalendar },
      offlineApi(),
      accountsState(['shikimori', 'anilist'], 'anilist')
    )
    const wrapper = mount(CalendarView)
    await flushPromises()

    expect(getCalendar).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.ce-title').map((t) => t.text())).toEqual(['Frieren'])
  })

  it('MyAnimeList only: the not-available state, and no calendar read', async () => {
    const getCalendar = vi.fn()
    stubWith({ ...BASE, trackerGetCalendar: getCalendar }, offlineApi(), accountsState(['mal']))
    const wrapper = mount(CalendarView)
    await flushPromises()

    expect(wrapper.find('.empty-state p').text()).toBe(
      'The calendar needs AniList or Shikimori — MyAnimeList has no airing schedule.'
    )
    expect(getCalendar).not.toHaveBeenCalled()
  })

  it('waits for the accounts state before choosing: a slow first read still loads', async () => {
    let answer!: (s: TrackerAccountsState) => void
    const getCalendar = vi
      .fn()
      .mockResolvedValue(
        resultFrom(
          [entry(new Date(2026, 2, 18, 20, 0, 0), 'Frieren')],
          Date.now(),
          false,
          'anilist'
        )
      )
    stubWith({
      ...BASE,
      trackerGetCalendar: getCalendar,
      trackerListAccounts: vi.fn(
        () => new Promise<TrackerAccountsState>((resolve) => (answer = resolve))
      )
    })
    const wrapper = mount(CalendarView)
    await flushPromises()
    expect(getCalendar).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Connect to Shikimori')

    answer(accountsState(['anilist']))
    await flushPromises()
    expect(getCalendar).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.ce-title').map((t) => t.text())).toEqual(['Frieren'])
  })
})

describe('CalendarView — not connected', () => {
  it('points to the Shikimori card in Settings → Trackers (#700)', async () => {
    const getCalendar = vi.fn()
    stubWith({ ...BASE, trackerGetCalendar: getCalendar }, offlineApi(), accountsState([]))
    const wrapper = mount(CalendarView)
    await flushPromises()

    expect(wrapper.find('.empty-state p').text()).toBe(
      'Connect to Shikimori in Settings → Trackers to see the calendar.'
    )
    expect(getCalendar).not.toHaveBeenCalled()
  })
})
