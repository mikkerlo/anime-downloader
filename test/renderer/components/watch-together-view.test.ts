// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WatchTogetherView from '../../../src/renderer/src/components/views/WatchTogetherView.vue'
import { offlineApi, type OfflineApi } from '../../helpers/offline-api'

const READY_STATUS: SyncplayStatus = {
  state: 'ready',
  host: 'sync.example',
  port: 8999,
  room: 'movie-night',
  username: 'me',
  tls: true
}

const APP_PEER: SyncplayRoomUser = {
  username: 'friend',
  file: { name: 'Frieren - 12', duration: 1420 },
  isReady: true,
  animeDlAppMeta: { animeId: 42, malId: 100, episodeInt: '12', translationId: 601 }
}

const MPV_PEER: SyncplayRoomUser = {
  username: 'mpv-user',
  file: { name: 'Frieren.S01E12.mkv', duration: 1420 },
  isReady: false
}

function stubApi(opts: {
  status?: SyncplayStatus
  users?: SyncplayRoomUser[]
  offline?: OfflineApi
}): Record<string, ReturnType<typeof vi.fn>> {
  const real: Record<string, ReturnType<typeof vi.fn>> = {
    syncplayGetStatus: vi.fn().mockResolvedValue(opts.status ?? { state: 'idle' }),
    syncplayGetRoomUsers: vi.fn().mockResolvedValue(opts.users ?? []),
    syncplayConnect: vi.fn().mockResolvedValue(undefined),
    syncplayDisconnect: vi.fn().mockResolvedValue(undefined),
    getSetting: vi.fn().mockResolvedValue({ lastRoom: 'movie-night', username: 'me' }),
    setSetting: vi.fn().mockResolvedValue(undefined),
    shikimoriGetUser: vi.fn().mockResolvedValue(null),
    getAnime: vi.fn().mockRejectedValue(new Error('not stubbed')),
    onSyncplayConnectionStatus: vi.fn(() => () => {}),
    onSyncplayRoomUsers: vi.fn(() => () => {})
  }
  // Tests add methods to `real` after the stub is installed, so it stays the target.
  Object.assign(real, (opts.offline ?? offlineApi()).api)
  ;(window as unknown as { api: unknown }).api = new Proxy(real, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
  return real
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('WatchTogetherView', () => {
  it('shows the connect form with the saved room when not connected', async () => {
    stubApi({ status: { state: 'idle' } })
    const wrapper = mount(WatchTogetherView)
    await flushPromises()
    expect(wrapper.text()).toContain('Not connected')
    expect((wrapper.find('.wt-input').element as HTMLInputElement).value).toBe('movie-night')
    expect(wrapper.find('.wt-user-row').exists()).toBe(false)
  })

  it('surfaces the full disconnect error from status', async () => {
    stubApi({
      status: {
        state: 'disconnected',
        error: 'Connection closed — connect ECONNREFUSED 93.184.216.34:8999'
      }
    })
    const wrapper = mount(WatchTogetherView)
    await flushPromises()
    expect(wrapper.find('.wt-error').text()).toBe(
      'Connection closed — connect ECONNREFUSED 93.184.216.34:8999'
    )
  })

  it('lists room members excluding self, gating "Join & watch" on animeDlAppMeta', async () => {
    stubApi({
      status: READY_STATUS,
      users: [{ username: 'me', file: null }, APP_PEER, MPV_PEER]
    })
    const wrapper = mount(WatchTogetherView)
    await flushPromises()

    const rows = wrapper.findAll('.wt-user-row')
    expect(rows).toHaveLength(2)

    const appRow = rows.find((r) => r.text().includes('friend'))!
    expect(appRow.text()).toContain('Frieren - 12')
    expect(appRow.find('button').exists()).toBe(true)

    // mpv/VLC peer: file listed, but no auto-join button (no app metadata).
    const mpvRow = rows.find((r) => r.text().includes('mpv-user'))!
    expect(mpvRow.text()).toContain('Frieren.S01E12.mkv')
    expect(mpvRow.find('button').exists()).toBe(false)
  })

  it('re-reads the room and opens the peer episode on "Join & watch"', async () => {
    const api = stubApi({ status: READY_STATUS, users: [APP_PEER] })
    api.getAnime.mockResolvedValue({
      data: {
        id: 42,
        title: 'Frieren',
        titles: {},
        posterUrlSmall: '',
        posterUrl: '',
        numberOfEpisodes: 12,
        type: 'tv',
        typeTitle: 'TV',
        year: 2023,
        season: 'fall',
        descriptions: [],
        genres: [],
        episodes: [
          { id: 900, episodeFull: '12 серия', episodeInt: '12', episodeType: 'tv', isActive: 1 }
        ]
      },
      source: 'api'
    })
    api.getEpisodesBatchCached = vi.fn().mockResolvedValue({
      data: [
        {
          id: 900,
          episodeFull: '12 серия',
          episodeInt: '12',
          episodeType: 'tv',
          translations: [
            {
              id: 601,
              type: 'subRu',
              typeKind: 'sub',
              typeLang: 'ru',
              authorsSummary: 'a',
              isActive: 1,
              width: 1920,
              height: 1080,
              duration: '24:00'
            }
          ]
        }
      ],
      source: 'api'
    })
    api.downloadedEpisodesGet = vi.fn().mockResolvedValue({})
    api.playerGetStreamUrl = vi
      .fn()
      .mockResolvedValue({ streamUrl: 'u', subtitleContent: null, availableStreams: [] })

    const wrapper = mount(WatchTogetherView)
    await flushPromises()
    await wrapper.find('.wt-user-row button').trigger('click')
    await flushPromises()

    // Freshest room state fetched at click time, then the stream resolved for
    // the peer's translation.
    expect(api.syncplayGetRoomUsers.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(api.playerGetStreamUrl).toHaveBeenCalledWith(601, 1080)
    const { usePlayerStore } = await import('../../../src/renderer/src/stores/player')
    expect(usePlayerStore().playerState?.episodeLabel).toBe('12')
    expect(wrapper.find('.wt-error').exists()).toBe(false)
  })
})

describe('WatchTogetherView — offline (#568)', () => {
  const REASON = 'Watch Together needs an internet connection'

  it('offline: Join room is disabled with the reason, and Enter does not connect', async () => {
    const api = stubApi({ status: { state: 'idle' }, offline: offlineApi('offline-manual') })
    const wrapper = mount(WatchTogetherView)
    await flushPromises()

    const join = wrapper.find('[data-testid="wt-connect"]')
    expect(join.attributes('disabled')).toBeDefined()
    expect(join.attributes('title')).toBe(REASON)
    expect(wrapper.find('[data-testid="offline-notice"] p').text()).toBe(REASON)

    await wrapper.find('.wt-input').trigger('keyup.enter')
    await flushPromises()
    expect(api.syncplayConnect).not.toHaveBeenCalled()
  })

  it('shows why a session open when the app went offline was ended', async () => {
    stubApi({
      status: { state: 'disconnected', error: 'Offline — Watch Together needs the network' },
      offline: offlineApi('offline-auto')
    })
    const wrapper = mount(WatchTogetherView)
    await flushPromises()
    expect(wrapper.find('.wt-error').text()).toBe('Offline — Watch Together needs the network')
  })

  it('online: Join room is enabled and connects — today', async () => {
    const api = stubApi({ status: { state: 'idle' } })
    const wrapper = mount(WatchTogetherView)
    await flushPromises()

    const join = wrapper.find('[data-testid="wt-connect"]')
    expect(join.attributes('disabled')).toBeUndefined()
    expect(join.attributes('title')).toBeUndefined()
    expect(wrapper.find('[data-testid="offline-notice"]').exists()).toBe(false)
    await join.trigger('click')
    await flushPromises()
    expect(api.syncplayConnect).toHaveBeenCalledTimes(1)
  })

  it('toggling offline on the view disables and re-enables Join room without a reload', async () => {
    const offline = offlineApi()
    stubApi({ status: { state: 'idle' }, offline })
    const wrapper = mount(WatchTogetherView)
    await flushPromises()
    const join = (): ReturnType<typeof wrapper.find> => wrapper.find('[data-testid="wt-connect"]')

    offline.emit('offline-manual')
    await flushPromises()
    expect(join().attributes('disabled')).toBeDefined()
    offline.emit('online')
    await flushPromises()
    expect(join().attributes('disabled')).toBeUndefined()
  })
})
