// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TrackerListView from '../../../src/renderer/src/components/views/TrackerListView.vue'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'
import { useShikimoriStore } from '../../../src/renderer/src/stores/shikimori'
import { shikimoriRateCache } from '../../../src/main/trackers/shikimori.provider'
import { SHIKIMORI_ORIGIN } from '../../../src/shared/shikimori'
import shikimoriRows from '../../fixtures/tracker-list/shikimori-rows.json'
import mainDom from '../../fixtures/tracker-list/shikimori-6.19.0-dom.json'

// The list page (#707): one tracker's `TrackerRateEntry[]` from the trackers
// store, the Shikimori dashboard only while Shikimori is selected.

const NOW = Date.parse('2026-05-30T12:00:00.000Z')

const SHIKI_USER: TrackerUser = { id: 1, nickname: 'tester', avatar: '' }
const ANILIST_USER: TrackerUser = { id: 7, nickname: 'ani-fan', avatar: null }
const MAL_USER: TrackerUser = { id: 3, nickname: 'mal-me', avatar: null }

function rate(id: number, status: string, episodes = 1, aired = 1): ShikiAnimeRateEntry {
  return {
    rate: { id, target_id: id, status, episodes, score: 8, updated_at: '2026-05-30T00:00:00Z' },
    shikiAnime: {
      id,
      name: `Show ${id}`,
      russian: `Шоу ${id}`,
      image: { original: 'https://shikimori.one/p.jpg', preview: '', x96: '', x48: '' },
      episodes: 12,
      episodes_aired: aired,
      kind: 'tv',
      score: '8.0',
      status: 'released'
    },
    smotretAnime: null
  } as unknown as ShikiAnimeRateEntry
}

// The Shikimori codec main serves `tracker:get-rates` with (T2a/T4b, #707).
const viaCodec = (rows: ShikiAnimeRateEntry[]): TrackerRateEntry[] =>
  rows.map((r) => shikimoriRateCache.entryOf(r as never))

const PROFILE: ShikimoriProfile = {
  id: 1,
  nickname: 'tester',
  avatar: '',
  friendsCount: 3,
  lists: [
    { status: 'planned', n: 12 },
    { status: 'watching', n: 7 },
    { status: 'completed', n: 41 },
    { status: 'dropped', n: 2 }
  ],
  scores: [0, 0, 0, 0, 1, 1, 6, 19, 14, 8],
  genres: [
    { name: 'Экшен', n: 9 },
    { name: 'Драма', n: 5 }
  ],
  stats: { titles: 62, episodes: 540, mean: 8.12, daysWatched: 9.0 }
}

// The profile the 6.19.0 DOM golden was recorded with.
const GOLDEN_PROFILE: ShikimoriProfile = {
  id: 1,
  nickname: 'tester',
  avatar: '',
  friendsCount: 3,
  lists: [
    { status: 'planned', n: 1 },
    { status: 'watching', n: 2 },
    { status: 'completed', n: 2 }
  ],
  scores: [0, 0, 0, 0, 0, 0, 1, 0, 1, 0],
  genres: [{ name: 'Экшен', n: 2 }],
  stats: { titles: 5, episodes: 17, mean: 8.0, daysWatched: 0.3 }
}

const RATES = [rate(10, 'completed'), rate(11, 'completed'), rate(12, 'watching', 1, 5)]

function entry(
  trackerId: TrackerId,
  malId: number,
  over: {
    values?: Partial<TrackerRateValues>
    anime?: Partial<TrackerRateEntry['anime']>
    updatedAt?: number | null
  } = {}
): TrackerRateEntry {
  return {
    trackerId,
    malId,
    remoteId: 5000 + malId,
    values: { episodes: 1, status: 'watching', score: 0, rewatches: 0, ...over.values },
    updatedAt: over.updatedAt === undefined ? NOW - 3_600_000 : over.updatedAt,
    anime: {
      title: `${trackerId} title ${malId}`,
      poster: `https://${trackerId}.example/${malId}.jpg`,
      kind: 'TV',
      episodes: 12,
      episodesAired: 12,
      status: 'FINISHED',
      ...over.anime
    },
    smotretAnime: null
  }
}

function account(trackerId: TrackerId, user: TrackerUser | null): TrackerAccount {
  return {
    trackerId,
    user,
    hasCredentials: user !== null,
    sessionExpired: false,
    needsSetup: false,
    credentialState: user ? 'ok' : 'none'
  }
}

function accountsState(
  connected: Partial<Record<TrackerId, TrackerUser>>,
  primary: TrackerId | null
): TrackerAccountsState {
  return {
    accounts: (['shikimori', 'anilist', 'mal'] as TrackerId[]).map((id) =>
      account(id, connected[id] ?? null)
    ),
    primary,
    mirror: {},
    featureSources: {},
    newTrackerCardsEnabled: true
  }
}

interface StubOpts {
  accounts?: TrackerAccountsState
  rates?: Partial<Record<TrackerId, TrackerRateEntry[] | Error>>
  queuedAfter?: Partial<Record<TrackerId, Record<number, TrackerRateValues>>>
  profile?: ShikimoriProfile | null
}

let emitAccounts: (next: TrackerAccountsState) => void = () => {}

function stubApi(opts: StubOpts = {}): Record<string, ReturnType<typeof vi.fn>> {
  const accountHandlers: ((next: TrackerAccountsState) => void)[] = []
  const real: Record<string, ReturnType<typeof vi.fn>> = {
    trackerListAccounts: vi.fn().mockResolvedValue(opts.accounts ?? accountsState({}, null)),
    trackerGetRates: vi.fn(async (id: TrackerId) => {
      const r = opts.rates?.[id]
      if (r instanceof Error) throw r
      return { trackerId: id, entries: r ?? [], queuedAfter: opts.queuedAfter?.[id] ?? {} }
    }),
    trackerGetSyncStatus: vi.fn().mockResolvedValue({
      state: 'idle',
      queueLength: 0,
      lastSyncAt: 0,
      lastSyncError: null,
      sessionExpired: false,
      needsSetup: false
    }),
    onTrackerAccountsChanged: vi.fn((cb: (next: TrackerAccountsState) => void) => {
      accountHandlers.push(cb)
      return () => {}
    }),
    shikimoriGetProfile: vi.fn().mockResolvedValue(opts.profile ?? null),
    libraryGetStatus: vi.fn().mockResolvedValue({}),
    libraryToggle: vi.fn().mockResolvedValue(true),
    // Must be a real stub: the Proxy fallback returns a *function*, and
    // `new Set(fn)` throws "not iterable".
    libraryGetPriority: vi.fn().mockResolvedValue([]),
    librarySetPriority: vi.fn().mockResolvedValue([]),
    shellOpenExternal: vi.fn().mockResolvedValue(true)
  }
  emitAccounts = (next) => accountHandlers.forEach((h) => h(next))
  ;(window as unknown as { api: unknown }).api = new Proxy(real, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
  return real
}

// A Shikimori-only user, as every pre-#707 case ran.
function stubShikimori(rows: ShikiAnimeRateEntry[], profile: ShikimoriProfile | null = PROFILE) {
  return stubApi({
    accounts: accountsState({ shikimori: SHIKI_USER }, 'shikimori'),
    rates: { shikimori: viaCodec(rows) },
    profile
  })
}

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(TrackerListView)
  await flushPromises()
  return wrapper
}

const cardTitles = (w: VueWrapper) => w.findAll('.results-grid .acard-title').map((t) => t.text())
const filterSelect = (w: VueWrapper) => w.find('.section-head select')
const trackerSelect = (w: VueWrapper) => w.find('header select')
const toWatchOption = (w: VueWrapper) =>
  filterSelect(w)
    .findAll('option')
    .find((o) => o.attributes('value') === 'to_watch')!
    .text()

// The DOM compare: scoped-style ids and Vue's placeholder comments aren't
// rendered output.
const norm = (html: string): string =>
  html.replace(/ data-v-[0-9a-f]+=""/g, '').replace(/<!--[\s\S]*?-->/g, '')

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TrackerListView: a Shikimori primary, as ShikimoriView was', () => {
  it('renders the four headline stats from the profile', async () => {
    stubShikimori(RATES)
    const wrapper = await mountView()

    const bigs = wrapper.findAll('.sk-big')
    expect(bigs).toHaveLength(4)
    expect(bigs[0].find('.v').text()).toBe('62')
    expect(bigs[1].find('.v').text()).toBe('540')
  })

  it('renders one legend entry per non-empty list and a 10-bar histogram', async () => {
    stubShikimori(RATES)
    const wrapper = await mountView()

    expect(wrapper.findAll('.sk-leg')).toHaveLength(4)
    expect(wrapper.findAll('.sk-hbar')).toHaveLength(10)
  })

  it('a legend click sets the watchlist status filter', async () => {
    stubShikimori(RATES)
    const wrapper = await mountView()

    // Default filter is "to_watch" → only the watching/unwatched entry (id 12).
    expect(wrapper.findAll('.results-grid .card-wrap')).toHaveLength(1)

    // Click the "Completed" legend → filter switches, grid shows both completed.
    const completed = wrapper.findAll('.sk-leg').find((b) => b.text().includes('Completed'))
    await completed!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.results-grid .card-wrap')).toHaveLength(2)
  })

  it('shows the connect affordance with no tracker connected, opening Settings › Trackers', async () => {
    stubApi()
    const wrapper = await mountView()

    expect(wrapper.find('.sk-profile').exists()).toBe(false)
    expect(wrapper.find('.empty-state').text()).toContain(
      'Connect a tracker in Settings to see your list'
    )
    await wrapper.find('.empty-state .cta-btn').trigger('click')
    const library = useLibraryStore()
    expect(library.currentView).toBe('settings')
    expect(library.pendingSettingsTab).toBe('trackers')
  })

  // The characterization (#707 step 2): the same rows through the Shikimori
  // codec render 6.19.0's ShikimoriView DOM, recorded from main's view.
  it('renders the same header and list DOM as 6.19.0, fed through the codec', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    stubShikimori(shikimoriRows as ShikiAnimeRateEntry[], GOLDEN_PROFILE)
    const w = await mountView()

    expect(norm(w.find('header').element.outerHTML)).toBe(mainDom.header)
    expect(norm(w.find('.body').element.outerHTML)).toBe(mainDom.toWatch)
    await filterSelect(w).setValue('')
    await flushPromises()
    expect(norm(w.find('.body').element.outerHTML)).toBe(mainDom.all)
  })

  it('card titles are russian || name, posters image.original made absolute, To Watch as before', async () => {
    stubShikimori(shikimoriRows as ShikiAnimeRateEntry[])
    const w = await mountView()
    await filterSelect(w).setValue('')
    await flushPromises()

    expect(cardTitles(w)).toEqual([
      'Шоу двенадцать',
      'Шоу десять',
      'Шоу тринадцать',
      'Show Eleven',
      'Шоу четырнадцать'
    ])
    const posters = w.findAll('.results-grid img.poster').map((i) => i.attributes('src'))
    // Not the codec's preview-first `poster` (the Home rail's pick, #698).
    expect(posters[0]).toBe(`${SHIKIMORI_ORIGIN}/system/animes/original/12.jpg`)
    expect(posters[3]).toBe('https://cdn.example/original/11.jpg')
    // Only id 12 is watching with episodes_aired > episodes.
    expect(toWatchOption(w)).toBe('To Watch (1)')
  })

  it('a queued after shows in the list before its queue drains', async () => {
    stubApi({
      accounts: accountsState({ shikimori: SHIKI_USER }, 'shikimori'),
      rates: { shikimori: viaCodec(RATES) },
      queuedAfter: {
        shikimori: { 10: { episodes: 4, status: 'watching', score: 8, rewatches: 0 } }
      },
      profile: PROFILE
    })
    const w = await mountView()
    // Id 10 is cached completed, queued watching 4/12 with 1 aired: not unwatched.
    expect(toWatchOption(w)).toBe('To Watch (1)')
    await filterSelect(w).setValue('watching')
    await flushPromises()
    expect(cardTitles(w)).toEqual(['Шоу 10', 'Шоу 12'])
    expect(w.findAll('.results-grid .episode-badge').map((b) => b.text())).toEqual([
      '4/12 ep',
      '1/12 ep'
    ])
  })

  it('"Sync now" re-reads the Shikimori rates and profile', async () => {
    const api = stubShikimori(RATES)
    const w = await mountView()
    api.trackerGetRates.mockClear()
    api.shikimoriGetProfile.mockClear()
    await w.find('.hdr-btn.outline').trigger('click')
    await flushPromises()
    expect(api.trackerGetRates.mock.calls).toEqual([['shikimori']])
    expect(api.shikimoriGetProfile).toHaveBeenCalledTimes(1)
  })

  it('an empty Shikimori list still reads "No anime in your Shikimori list."', async () => {
    stubShikimori([])
    const w = await mountView()
    expect(w.find('.status-text').text()).toBe('No anime in your Shikimori list.')
  })
})

describe('TrackerListView: another tracker', () => {
  it('AniList-only: the AniList list, not the connect state, and no Shikimori dashboard', async () => {
    const api = stubApi({
      accounts: accountsState({ anilist: ANILIST_USER }, 'anilist'),
      rates: {
        anilist: [
          entry('anilist', 1, { values: { episodes: 3 }, anime: { title: 'Demon Slayer' } }),
          entry('anilist', 2, {
            values: { status: 'completed', episodes: 12, score: 9 },
            anime: { title: 'Frieren', kind: 'TV', poster: 'https://anilist.example/cover.jpg' }
          })
        ]
      }
    })
    const w = await mountView()

    expect(w.find('header h2').text()).toBe('AniList')
    expect(w.find('header .sub').text()).toBe('· @ani-fan')
    expect(w.find('.empty-state').exists()).toBe(false)
    expect(w.find('.sk-profile').exists()).toBe(false)
    expect(w.find('.sk-bigstats').exists()).toBe(false)
    expect(api.shikimoriGetProfile).not.toHaveBeenCalled()
    // "Recent activity" renders on its own, from the rates.
    expect(w.find('.panel h4').text()).toBe('Recent activity')
    expect(w.findAll('.act-title').map((t) => t.text())).toEqual(['Demon Slayer', 'Frieren'])
    expect(toWatchOption(w)).toBe('To Watch (1)')

    await filterSelect(w).setValue('completed')
    await flushPromises()
    expect(cardTitles(w)).toEqual(['Frieren'])
    expect(w.find('.results-grid img.poster').attributes('src')).toBe(
      'https://anilist.example/cover.jpg'
    )
    expect(w.findAll('.results-grid .acard-meta span').map((s) => s.text())).toEqual([
      'TV',
      '· 12 ep'
    ])
    expect(w.find('.results-grid .score-badge').text()).toBe('9')
  })

  it('an empty AniList list reads "No anime in your AniList list."', async () => {
    stubApi({
      accounts: accountsState({ anilist: ANILIST_USER }, 'anilist'),
      rates: { anilist: [] }
    })
    const w = await mountView()
    expect(w.find('.status-text').text()).toBe('No anime in your AniList list.')
  })

  it('"Open profile" opens the selected tracker’s page', async () => {
    const api = stubApi({
      accounts: accountsState({ anilist: ANILIST_USER, mal: MAL_USER }, 'anilist'),
      rates: { anilist: [], mal: [] }
    })
    const w = await mountView()
    await w.find('.hdr-btn.ghost').trigger('click')
    await trackerSelect(w).setValue('mal')
    await flushPromises()
    await w.find('.hdr-btn.ghost').trigger('click')
    expect(api.shellOpenExternal.mock.calls).toEqual([
      ['https://anilist.co/user/ani-fan'],
      ['https://myanimelist.net/profile/mal-me']
    ])
  })

  it('MAL: an airing title with no aired count is not "To Watch"; a finished one behind is', async () => {
    stubApi({
      accounts: accountsState({ mal: MAL_USER }, 'mal'),
      rates: {
        mal: [
          // The codec's airing title: `episodesAired` null (#702).
          entry('mal', 1, {
            values: { episodes: 2 },
            anime: { episodes: null, episodesAired: null, status: 'currently_airing' }
          }),
          // Finished: `episodesAired = num_episodes`.
          entry('mal', 2, {
            values: { episodes: 5 },
            anime: { episodes: 12, episodesAired: 12, status: 'finished_airing' }
          })
        ]
      }
    })
    const w = await mountView()
    expect(toWatchOption(w)).toBe('To Watch (1)')
    expect(cardTitles(w)).toEqual(['mal title 2'])
  })
})

describe('TrackerListView: two trackers and the header dropdown', () => {
  const both = () => accountsState({ shikimori: SHIKI_USER, anilist: ANILIST_USER }, 'shikimori')

  it('no dropdown with one tracker', async () => {
    stubShikimori(RATES)
    const w = await mountView()
    expect(trackerSelect(w).exists()).toBe(false)
  })

  it('two trackers: the dropdown lists both, marks the primary, and switches the list', async () => {
    const api = stubApi({
      accounts: both(),
      rates: { shikimori: viaCodec(RATES), anilist: [entry('anilist', 1)] },
      profile: PROFILE
    })
    const w = await mountView()
    const options = trackerSelect(w).findAll('option')
    expect(options.map((o) => o.text())).toEqual(['Shikimori (primary)', 'AniList'])
    expect(cardTitles(w)).toEqual(['Шоу 12'])

    api.trackerGetRates.mockClear()
    await trackerSelect(w).setValue('anilist')
    await flushPromises()
    expect(w.find('header h2').text()).toBe('AniList')
    expect(cardTitles(w)).toEqual(['anilist title 1'])
    expect(api.trackerGetRates.mock.calls).toEqual([['anilist']])
  })

  it('AniList selected: no Shikimori dashboard although the profile is loaded, its own error and name', async () => {
    useShikimoriStore().profile = PROFILE
    stubApi({
      accounts: accountsState({ shikimori: SHIKI_USER, anilist: ANILIST_USER }, 'anilist'),
      rates: { shikimori: viaCodec(RATES), anilist: new Error('AniList is down') },
      profile: PROFILE
    })
    const w = await mountView()
    expect(useShikimoriStore().profile).not.toBeNull()
    expect(w.find('.sk-profile').exists()).toBe(false)
    expect(w.find('.sk-bigstats').exists()).toBe(false)
    expect(w.find('.error-text').text()).toBe('AniList is down')
    expect(w.find('header .sub').text()).toBe('· @ani-fan')
  })

  it('the selected tracker disconnecting falls back to the primary', async () => {
    stubApi({
      accounts: both(),
      rates: { shikimori: viaCodec(RATES), anilist: [entry('anilist', 1)] },
      profile: PROFILE
    })
    const w = await mountView()
    await trackerSelect(w).setValue('anilist')
    await flushPromises()
    expect(w.find('header h2').text()).toBe('AniList')

    emitAccounts(accountsState({ shikimori: SHIKI_USER }, 'shikimori'))
    await flushPromises()
    expect(w.find('header h2').text()).toBe('Shikimori')
    expect(cardTitles(w)).toEqual(['Шоу 12'])
    expect(w.find('.sk-profile').exists()).toBe(true)
  })

  it('a primary change resets the pick to the new primary', async () => {
    stubApi({
      accounts: both(),
      rates: { shikimori: viaCodec(RATES), anilist: [entry('anilist', 1)] },
      profile: PROFILE
    })
    const w = await mountView()
    await trackerSelect(w).setValue('anilist')
    await flushPromises()
    emitAccounts(accountsState({ shikimori: SHIKI_USER, anilist: ANILIST_USER }, 'anilist'))
    await flushPromises()
    expect(w.find('header h2').text()).toBe('AniList')
    emitAccounts(accountsState({ shikimori: SHIKI_USER, anilist: ANILIST_USER }, 'shikimori'))
    await flushPromises()
    expect(w.find('header h2').text()).toBe('Shikimori')
  })
})
