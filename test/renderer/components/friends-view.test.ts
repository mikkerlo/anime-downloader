// @vitest-environment happy-dom
// The Friends page (#179, #568; merged across trackers since #712). The
// Shikimori-only cases are the 6.x ones, with the stub answering the merged
// `tracker:get-friends*` reads from the same Shikimori data; the rest pin the
// AniList-only and two-source pages.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import FriendsView from '../../../src/renderer/src/components/views/FriendsActivityView.vue'
import FriendsPanel from '../../../src/renderer/src/components/detail/FriendsPanel.vue'
import { offlineApi, type OfflineApi } from '../../helpers/offline-api'
import { trackersApi, accountsState, type TrackersApi } from '../../helpers/trackers-api'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'

function card(id: number, nickname: string, online: boolean): ShikiFriendCard {
  return {
    id,
    nickname,
    avatar: '',
    lastOnlineAt: online ? new Date().toISOString() : '2026-05-01T00:00:00Z',
    online,
    titles: 50,
    mean: 8.1,
    mutual: 3,
    watching: {
      malId: 100 + id,
      animeId: 200 + id,
      title: `Watch ${id}`,
      image: 'p.jpg',
      episode: 4,
      total: 12,
      status: 'watching'
    }
  }
}

const FRIENDS = [card(1, 'alice', true), card(2, 'bob', false), card(3, 'carol', true)]

const ACTIVITY: ShikiFriendActivityEntry[] = [
  {
    friendId: 1,
    friendNickname: 'alice',
    friendAvatar: '',
    malId: 5114,
    animeName: 'FMA',
    animeImage: 'i.jpg',
    description: 'Watched episode 5',
    createdAt: '2026-05-30T00:00:00Z',
    smotretAnime: { id: 777 } as unknown as AnimeSearchResult
  }
]

/** A followed AniList user's card, as main sends it. */
function anilistCard(id: number, nickname: string): TrackerFriendCard {
  return {
    source: 'anilist',
    id,
    nickname,
    avatar: '',
    presence: false,
    lastOnlineAt: null,
    online: false,
    titles: 120,
    mean: 7.5,
    mutual: null,
    watching: null
  }
}

const shikiCard = (c: ShikiFriendCard): TrackerFriendCard => ({
  source: 'shikimori',
  presence: true,
  ...c
})

const shikiEntry = (e: ShikiFriendActivityEntry): TrackerFriendActivityEntry => ({
  source: 'shikimori',
  ...e,
  friendUrl: `https://shikimori.io/@${e.friendNickname}`,
  titleUrl: `https://shikimori.io/animes/${e.malId}`
})

function anilistEntry(
  friendId: number,
  nickname: string,
  createdAt: string,
  over: Partial<TrackerFriendActivityEntry> = {}
): TrackerFriendActivityEntry {
  return {
    source: 'anilist',
    friendId,
    friendNickname: nickname,
    friendAvatar: '',
    malId: 21,
    animeName: 'One Piece',
    animeImage: 'op.jpg',
    description: 'watched episode 1 - 3',
    createdAt,
    smotretAnime: null,
    friendUrl: `https://anilist.co/user/${nickname}`,
    titleUrl: 'https://anilist.co/anime/21',
    ...over
  }
}

const ME = { id: 1, nickname: 'me', avatar: '' }

function stubApi(opts: {
  /** Signs Shikimori in (the 6.x cases' switch). */
  user?: ShikiUser | null
  /** The connected trackers; defaults to Shikimori when `user` is set. */
  connected?: TrackerId[]
  friends?: ShikiFriendCard[] | null
  /** More cards, after Shikimori's (AniList's). */
  cards?: TrackerFriendCard[]
  sources?: TrackerFriendsResult['sources']
  activity?: ShikiFriendActivityEntry[]
  activityResult?: ShikiSnapshotResult<ShikiFriendActivityEntry[]>
  /** The merged feed as main sends it; wins over `activity` / `activityResult`. */
  feed?: TrackerFriendsActivityResult
  offline?: OfflineApi
}): { real: Record<string, ReturnType<typeof vi.fn>>; trackers: TrackersApi } {
  const connected = opts.connected ?? (opts.user ? (['shikimori'] as TrackerId[]) : [])
  const friendsSources = connected.filter((id) => id !== 'mal')
  const sources =
    opts.sources ?? Object.fromEntries(friendsSources.map((id) => [id, { status: 'ok' as const }]))
  const trackers = trackersApi({ accounts: accountsState(connected) })
  const feedOf = (): TrackerFriendsActivityResult => {
    if (opts.feed) return opts.feed
    const r = opts.activityResult ?? {
      data: opts.activity ?? [],
      fetchedAt: Date.now(),
      stale: false
    }
    return {
      data: r.data.map(shikiEntry),
      fetchedAt: r.fetchedAt,
      stale: r.stale,
      sources: { shikimori: { ...r, data: r.data.map(shikiEntry), status: 'ok' } }
    }
  }
  const real: Record<string, ReturnType<typeof vi.fn>> = {
    shikimoriGetUser: vi.fn().mockResolvedValue(opts.user ?? null),
    trackerGetFriends: vi.fn().mockResolvedValue({
      cards: [...(opts.friends ?? []).map(shikiCard), ...(opts.cards ?? [])],
      sources
    } satisfies TrackerFriendsResult),
    trackerGetFriendsActivity: vi.fn().mockImplementation(async () => feedOf()),
    shellOpenExternal: vi.fn().mockResolvedValue(true)
  }
  const target = { ...(opts.offline ?? offlineApi()).api, ...trackers.api, ...real }
  ;(window as unknown as { api: unknown }).api = new Proxy(target, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
  return { real, trackers }
}

async function openTab(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
  await flushPromises()
  const tab = wrapper.findAll('.pill-tab').find((t) => t.text() === label)
  await tab!.trigger('click')
  await flushPromises()
}

/** Every card's name and the URLs its Compare and Message buttons open. */
async function cardLinks(
  wrapper: ReturnType<typeof mount>,
  real: Record<string, ReturnType<typeof vi.fn>>
): Promise<[string, string, string][]> {
  const out: [string, string, string][] = []
  for (const c of wrapper.findAll('.friend-card')) {
    real.shellOpenExternal.mockClear()
    const [compare, message] = c.findAll('.fc-actions button')
    await compare.trigger('click')
    await message.trigger('click')
    const urls = real.shellOpenExternal.mock.calls.map((call) => call[0] as string)
    out.push([c.find('.fc-name').text(), urls[0], urls[1]])
  }
  return out
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('FriendsView', () => {
  it('renders a friend card per friend on the All tab', async () => {
    stubApi({ user: { id: 1, nickname: 'me', avatar: '' }, friends: FRIENDS })
    const wrapper = mount(FriendsView)
    await flushPromises()
    expect(wrapper.findAll('.friend-card')).toHaveLength(3)
  })

  it('Online tab filters to online friends only', async () => {
    stubApi({ user: { id: 1, nickname: 'me', avatar: '' }, friends: FRIENDS })
    const wrapper = mount(FriendsView)
    await flushPromises()

    const onlineTab = wrapper.findAll('.pill-tab').find((t) => t.text() === 'Online')
    await onlineTab!.trigger('click')
    await flushPromises()

    const names = wrapper.findAll('.fc-name').map((n) => n.text())
    expect(names).toEqual(['alice', 'carol']) // bob is offline
  })

  it('Activity tab lazily loads and renders the feed', async () => {
    const { real: api } = stubApi({
      user: { id: 1, nickname: 'me', avatar: '' },
      friends: FRIENDS,
      activity: ACTIVITY
    })
    const wrapper = mount(FriendsView)
    await flushPromises()
    expect(api.trackerGetFriendsActivity).not.toHaveBeenCalled()

    const activityTab = wrapper.findAll('.pill-tab').find((t) => t.text() === 'Activity')
    await activityTab!.trigger('click')
    await flushPromises()

    expect(api.trackerGetFriendsActivity).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.feed-row')).toHaveLength(1)
    expect(wrapper.find('.feed-text strong').text()).toBe('alice')
  })

  it('shows the connect affordance when logged out', async () => {
    stubApi({ user: null })
    const wrapper = mount(FriendsView)
    await flushPromises()
    expect(wrapper.find('.friend-grid').exists()).toBe(false)
    expect(wrapper.find('.empty-state').text()).toContain('Connect Shikimori or AniList')
  })

  it('Shikimori only: the header reads "· N on Shikimori", with no badges and no error lines', async () => {
    stubApi({
      user: ME,
      friends: FRIENDS,
      activity: [...ACTIVITY, { ...ACTIVITY[0], smotretAnime: null, friendId: 2 }],
      sources: { shikimori: { status: 'error', error: 'boom' } }
    })
    const wrapper = mount(FriendsView)
    await flushPromises()
    expect(wrapper.find('[data-testid="friends-counts"]').text()).toBe('· 3 on Shikimori')
    expect(wrapper.find('[data-testid="source-error"]').exists()).toBe(false)
    await openTab(wrapper, 'Activity')
    expect(wrapper.find('[data-testid="source-badge"]').exists()).toBe(false)
    // An unresolved Shikimori title stays plain text, as in 6.x.
    expect(wrapper.findAll('.feed-link-static').map((s) => s.text())).toEqual(['FMA'])
    expect(wrapper.find('[data-testid="feed-external"]').exists()).toBe(false)
  })

  it('a MyAnimeList-only user sees the connect affordance', async () => {
    stubApi({ connected: ['mal'] })
    const wrapper = mount(FriendsView)
    await flushPromises()
    expect(wrapper.find('.empty-state').text()).toContain('Connect Shikimori or AniList')
  })
})

describe('FriendsView — AniList only (#712)', () => {
  it('renders the two AniList cards with AniList links, no presence line and no Mutual stat', async () => {
    const { real } = stubApi({
      connected: ['anilist'],
      cards: [anilistCard(11, 'ann'), anilistCard(12, 'ben')]
    })
    const wrapper = mount(FriendsView)
    await flushPromises()

    expect(wrapper.find('.empty-state').exists()).toBe(false)
    expect(wrapper.find('[data-testid="friends-counts"]').text()).toBe('· 2 on AniList')
    expect(wrapper.findAll('.friend-card')).toHaveLength(2)
    expect(wrapper.find('.fc-pres').exists()).toBe(false)
    expect(wrapper.find('.fc-dot').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('offline')
    expect(wrapper.findAll('.fc-stat .l').map((l) => l.text())).toEqual([
      'Titles',
      'Mean',
      'Titles',
      'Mean'
    ])
    expect(await cardLinks(wrapper, real)).toEqual([
      ['ann', 'https://anilist.co/user/ann/animelist', 'https://anilist.co/user/ann'],
      ['ben', 'https://anilist.co/user/ben/animelist', 'https://anilist.co/user/ben']
    ])
  })

  it('a session expired shows its line with a sign-in action, beside the cached cards', async () => {
    stubApi({
      connected: ['anilist'],
      cards: [anilistCard(11, 'ann')],
      sources: { anilist: { status: 'error', error: 'Session expired', sessionExpired: true } }
    })
    const wrapper = mount(FriendsView)
    await flushPromises()
    const line = wrapper.find('[data-testid="source-error"]')
    expect(line.text()).toContain('AniList: session expired')
    await line.find('button').trigger('click')
    const library = useLibraryStore()
    expect(library.currentView).toBe('settings')
    expect(library.pendingSettingsTab).toBe('trackers')
    expect(wrapper.findAll('.friend-card')).toHaveLength(1)
  })
})

describe('FriendsView — two sources (#712)', () => {
  const BOTH: TrackerId[] = ['shikimori', 'anilist']

  it('shows both sources’ cards without de-duplicating, one count per source', async () => {
    stubApi({
      connected: BOTH,
      friends: [card(1, 'bob', true)],
      cards: [anilistCard(40, 'bob'), anilistCard(41, 'dan')]
    })
    const wrapper = mount(FriendsView)
    await flushPromises()
    expect(wrapper.findAll('.fc-name').map((n) => n.text())).toEqual(['bob', 'bob', 'dan'])
    expect(wrapper.find('[data-testid="friends-counts"]').text()).toBe(
      '· 1 on Shikimori · 2 on AniList'
    )
  })

  it('a Shikimori friend and an AniList follow with the same id each keep their own card and links', async () => {
    const { real, trackers } = stubApi({
      connected: BOTH,
      friends: [card(5, 'sam', false), card(2, 'sue', false)],
      cards: [anilistCard(5, 'ann')]
    })
    // The refresh broadcasts reach the store through its subscription.
    let emitRefreshed: ((e: TrackerFriendsRefreshedEvent) => void) | undefined
    ;(window as unknown as { api: Record<string, unknown> }).api.onTrackerFriendsRefreshed = (
      cb: (e: TrackerFriendsRefreshedEvent) => void
    ) => {
      emitRefreshed = cb
      return () => {}
    }
    void trackers
    const wrapper = mount(FriendsView)
    await flushPromises()
    expect(await cardLinks(wrapper, real)).toEqual([
      ['sam', 'https://shikimori.io/@sam/list/anime', 'https://shikimori.io/@sam'],
      ['sue', 'https://shikimori.io/@sue/list/anime', 'https://shikimori.io/@sue'],
      ['ann', 'https://anilist.co/user/ann/animelist', 'https://anilist.co/user/ann']
    ])

    // Both sources refresh in one tick, reordering the grid around the shared id.
    emitRefreshed!({
      trackerId: 'shikimori',
      cards: [shikiCard(card(2, 'sue', false)), shikiCard(card(5, 'sam', false))]
    })
    emitRefreshed!({ trackerId: 'anilist', cards: [anilistCard(5, 'ann'), anilistCard(9, 'ivy')] })
    await flushPromises()
    expect(await cardLinks(wrapper, real)).toEqual([
      ['sue', 'https://shikimori.io/@sue/list/anime', 'https://shikimori.io/@sue'],
      ['sam', 'https://shikimori.io/@sam/list/anime', 'https://shikimori.io/@sam'],
      ['ann', 'https://anilist.co/user/ann/animelist', 'https://anilist.co/user/ann'],
      ['ivy', 'https://anilist.co/user/ivy/animelist', 'https://anilist.co/user/ivy']
    ])
  })

  it('Online shows only the Shikimori cards that are online', async () => {
    stubApi({ connected: BOTH, friends: FRIENDS, cards: [anilistCard(1, 'zed')] })
    const wrapper = mount(FriendsView)
    await openTab(wrapper, 'Online')
    expect(wrapper.findAll('.fc-name').map((n) => n.text())).toEqual(['alice', 'carol'])
  })

  it('the merged feed: newest first as main sends it, a badge on every item, links by smotretAnime', async () => {
    const feed: TrackerFriendActivityEntry[] = [
      anilistEntry(5, 'ann', '2026-06-02T00:00:00.000Z'),
      shikiEntry({ ...ACTIVITY[0], createdAt: '2026-06-01T00:00:00Z' }),
      anilistEntry(6, 'ivy', '2026-05-31T00:00:00.000Z', {
        smotretAnime: { id: 888 } as unknown as AnimeSearchResult
      }),
      shikiEntry({ ...ACTIVITY[0], friendId: 2, friendNickname: 'bob', smotretAnime: null })
    ]
    const { real } = stubApi({
      connected: BOTH,
      friends: FRIENDS,
      feed: {
        data: feed,
        fetchedAt: Date.now(),
        stale: false,
        sources: {
          shikimori: { data: [], fetchedAt: Date.now(), stale: false, status: 'ok' },
          anilist: { data: [], fetchedAt: Date.now(), stale: false, status: 'ok' }
        }
      }
    })
    const wrapper = mount(FriendsView)
    await openTab(wrapper, 'Activity')
    const library = useLibraryStore()
    const openAnime = vi.spyOn(library, 'openAnime')

    const rows = wrapper.findAll('.feed-row')
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.find('[data-testid="source-badge"]').text())).toEqual([
      'AL',
      'Sh',
      'AL',
      'Sh'
    ])
    // AniList, unresolved: the title and the friend link to AniList.
    await rows[0].find('[data-testid="feed-external"]').trigger('click')
    await rows[0].find('.feed-friend').trigger('click')
    expect(real.shellOpenExternal.mock.calls.map((c) => c[0])).toEqual([
      'https://anilist.co/anime/21',
      'https://anilist.co/user/ann'
    ])
    // Resolved on smotret: in-app, whichever the source.
    await rows[1].find('.feed-link').trigger('click')
    await rows[2].find('.feed-link').trigger('click')
    expect(openAnime.mock.calls.map((c) => c[0])).toEqual([777, 888])
    // Shikimori, unresolved: plain text, and the friend's name is not a link.
    expect(rows[3].find('.feed-link-static').text()).toBe('FMA')
    expect(rows[3].find('.feed-friend').exists()).toBe(false)
  })

  it('AniList’s session expired: its line, with Shikimori’s items and AniList’s stale snapshot', async () => {
    const shiki = shikiEntry(ACTIVITY[0])
    const old = anilistEntry(5, 'ann', '2026-05-29T00:00:00.000Z')
    stubApi({
      connected: BOTH,
      friends: FRIENDS,
      cards: [anilistCard(5, 'ann')],
      sources: {
        shikimori: { status: 'ok' },
        anilist: { status: 'error', error: 'Session expired', sessionExpired: true }
      },
      feed: {
        data: [shiki, old],
        fetchedAt: Date.now() - 10 * 60_000,
        stale: true,
        sources: {
          shikimori: { data: [shiki], fetchedAt: Date.now(), stale: false, status: 'ok' },
          anilist: {
            data: [old],
            fetchedAt: Date.now() - 10 * 60_000,
            stale: true,
            status: 'error',
            error: 'Session expired',
            sessionExpired: true
          }
        }
      }
    })
    const wrapper = mount(FriendsView)
    await flushPromises()
    expect(wrapper.find('[data-testid="source-error"]').text()).toContain(
      'AniList: session expired'
    )
    expect(wrapper.findAll('.fc-name').map((n) => n.text())).toEqual([
      'alice',
      'bob',
      'carol',
      'ann'
    ])
    await openTab(wrapper, 'Activity')
    expect(wrapper.find('[data-testid="source-error"]').text()).toContain(
      'AniList: session expired'
    )
    expect(wrapper.findAll('.feed-row')).toHaveLength(2)
    expect(wrapper.find('[data-testid="activity-stamp"]').text()).toBe('Last updated 10 min ago')
  })

  it('names both sources in the empty grid and the empty feed', async () => {
    stubApi({ connected: BOTH, friends: [] })
    const wrapper = mount(FriendsView)
    await flushPromises()
    expect(wrapper.text()).toContain('No Shikimori or AniList friends yet.')
    await openTab(wrapper, 'Activity')
    expect(wrapper.text()).toContain('No recent activity from your Shikimori or AniList friends.')
  })
})

describe('FriendsPanel — the detail block (#712)', () => {
  function rate(
    source: TrackerId,
    nickname: string,
    score: number,
    status: ShikiUserRateStatus = 'completed'
  ): TrackerFriendRate {
    return { source, nickname, avatar: '', status, score, episodes: 0 }
  }

  it('two sources: one list per source under its heading, a summary across both, a 0 score hidden', () => {
    const w = mount(FriendsPanel, {
      props: {
        friendsLoading: false,
        friendsRates: [
          { source: 'shikimori', status: 'ok', rates: [rate('shikimori', 'bob', 9)] },
          {
            source: 'anilist',
            status: 'ok',
            rates: [rate('anilist', 'bob', 8.5), rate('anilist', 'cy', 0, 'watching')]
          }
        ]
      }
    })
    expect(w.findAll('[data-testid="friends-source-head"]').map((h) => h.text())).toEqual([
      'Shikimori',
      'AniList'
    ])
    const sections = w.findAll('.friend-source')
    expect(sections.map((s) => s.findAll('.friend-name').map((n) => n.text()))).toEqual([
      ['bob'],
      ['bob', 'cy']
    ])
    expect(sections[1].findAll('.friend-act').map((a) => a.text())).toEqual([
      'Completed· ★ 8.5',
      'Watching'
    ])
    expect(w.find('.panel-summary').text()).toBe('2 completed · 1 watching')
  })

  it('one source: today’s block, with no heading', () => {
    const w = mount(FriendsPanel, {
      props: {
        friendsLoading: false,
        friendsRates: [{ source: 'shikimori', status: 'ok', rates: [rate('shikimori', 'bob', 9)] }]
      }
    })
    expect(w.find('[data-testid="friends-source-head"]').exists()).toBe(false)
    expect(w.findAll('.friend-row')).toHaveLength(1)
  })

  it('no rate from any source: the empty line', () => {
    const w = mount(FriendsPanel, {
      props: {
        friendsLoading: false,
        friendsRates: [
          { source: 'shikimori', status: 'ok', rates: [] },
          { source: 'anilist', status: 'error', error: 'x', rates: [] }
        ]
      }
    })
    expect(w.text()).toContain('None of your friends have watched this anime')
  })
})

describe('FriendsView — Activity offline (#568)', () => {
  async function openActivity(wrapper: ReturnType<typeof mount>): Promise<void> {
    await openTab(wrapper, 'Activity')
  }

  it('offline: renders the snapshot with a "Last updated" stamp', async () => {
    stubApi({
      user: ME,
      friends: FRIENDS,
      activityResult: { data: ACTIVITY, fetchedAt: Date.now() - 3 * 60_000, stale: true },
      offline: offlineApi('offline-manual')
    })
    const wrapper = mount(FriendsView)
    await openActivity(wrapper)

    expect(wrapper.findAll('.feed-row')).toHaveLength(1)
    expect(wrapper.find('[data-testid="activity-stamp"]').text()).toBe('Last updated 3 min ago')
  })

  it('offline with no snapshot: the OfflineNotice, in manual mode offering to go online', async () => {
    const offline = offlineApi('offline-manual')
    stubApi({
      user: ME,
      friends: FRIENDS,
      activityResult: { data: [], fetchedAt: null, stale: true },
      offline
    })
    const wrapper = mount(FriendsView)
    await openActivity(wrapper)

    const notice = wrapper.find('[data-testid="offline-notice"]')
    expect(notice.text()).toContain('Friends activity needs an internet connection')
    const action = notice.find('[data-testid="offline-notice-action"]')
    expect(action.text()).toBe('Work offline is on — go online')
    expect(wrapper.text()).not.toContain('No recent activity')
  })

  it('online and fresh: no stamp — today', async () => {
    stubApi({ user: ME, friends: FRIENDS, activity: ACTIVITY })
    const wrapper = mount(FriendsView)
    await openActivity(wrapper)
    expect(wrapper.find('[data-testid="activity-stamp"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="offline-notice"]').exists()).toBe(false)
  })

  it('back online after an offline-served feed refetches once', async () => {
    const offline = offlineApi('offline-auto')
    const { real: api } = stubApi({
      user: ME,
      friends: FRIENDS,
      activityResult: { data: [], fetchedAt: null, stale: true },
      offline
    })
    const wrapper = mount(FriendsView)
    await openActivity(wrapper)
    expect(api.trackerGetFriendsActivity).toHaveBeenCalledTimes(1)

    api.trackerGetFriendsActivity.mockResolvedValue({
      data: ACTIVITY.map(shikiEntry),
      fetchedAt: Date.now(),
      stale: false,
      sources: {}
    })
    offline.emit('online')
    await flushPromises()
    expect(api.trackerGetFriendsActivity).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('.feed-row')).toHaveLength(1)
    expect(wrapper.find('[data-testid="offline-notice"]').exists()).toBe(false)
  })

  it('two stale sources: the stamp shows the older fetchedAt main merged', async () => {
    const at = (min: number): number => Date.now() - min * 60_000
    stubApi({
      connected: ['shikimori', 'anilist'],
      friends: FRIENDS,
      feed: {
        data: [shikiEntry(ACTIVITY[0])],
        fetchedAt: at(20),
        stale: true,
        sources: {
          shikimori: { data: [], fetchedAt: at(5), stale: true, status: 'ok' },
          anilist: { data: [], fetchedAt: at(20), stale: true, status: 'ok' }
        }
      },
      offline: offlineApi('offline-manual')
    })
    const wrapper = mount(FriendsView)
    await openActivity(wrapper)
    expect(wrapper.find('[data-testid="activity-stamp"]').text()).toBe('Last updated 20 min ago')
  })
})
