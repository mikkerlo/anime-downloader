// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import FriendsView from '../../../src/renderer/src/components/views/FriendsActivityView.vue'

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

function stubApi(opts: {
  user?: ShikiUser | null
  friends?: ShikiFriendCard[] | null
  activity?: ShikiFriendActivityEntry[]
}): Record<string, ReturnType<typeof vi.fn>> {
  const real: Record<string, ReturnType<typeof vi.fn>> = {
    shikimoriGetUser: vi.fn().mockResolvedValue(opts.user ?? null),
    shikimoriGetFriends: vi.fn().mockResolvedValue(opts.friends ?? null),
    shikimoriGetFriendsActivity: vi.fn().mockResolvedValue(opts.activity ?? []),
    shellOpenExternal: vi.fn().mockResolvedValue(true)
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(real, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
  return real
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
    const api = stubApi({
      user: { id: 1, nickname: 'me', avatar: '' },
      friends: FRIENDS,
      activity: ACTIVITY
    })
    const wrapper = mount(FriendsView)
    await flushPromises()
    expect(api.shikimoriGetFriendsActivity).not.toHaveBeenCalled()

    const activityTab = wrapper.findAll('.pill-tab').find((t) => t.text() === 'Activity')
    await activityTab!.trigger('click')
    await flushPromises()

    expect(api.shikimoriGetFriendsActivity).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.feed-row')).toHaveLength(1)
    expect(wrapper.find('.feed-text strong').text()).toBe('alice')
  })

  it('shows the connect affordance when logged out', async () => {
    stubApi({ user: null })
    const wrapper = mount(FriendsView)
    await flushPromises()
    expect(wrapper.find('.friend-grid').exists()).toBe(false)
    expect(wrapper.find('.empty-state').text()).toContain('Connect your Shikimori')
  })
})
