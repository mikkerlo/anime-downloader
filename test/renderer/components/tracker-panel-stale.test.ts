// @vitest-environment happy-dom
// A rate from main's cached list (#570) carries the detail page's "Saved"
// stamp, with the offline wording only while the app is offline.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, computed } from 'vue'
import TrackerPanel from '../../../src/renderer/src/components/detail/TrackerPanel.vue'
import { TrackerKey } from '../../../src/renderer/src/components/detail/keys'
import { offlineApi } from '../../helpers/offline-api'

function trackerRateStub(stale: boolean, mediaId?: number) {
  return {
    rateStale: computed(() => stale),
    mediaId: ref<number | undefined>(mediaId),
    rateStatus: ref('watching'),
    rateEpisodes: ref(4),
    rateScore: ref(7),
    rateRewatches: ref(0),
    loading: ref(false),
    saving: ref(false),
    saveError: ref(''),
    syncState: computed(() => 'idle' as const),
    lastSyncError: computed(() => null),
    save: vi.fn(),
    triggerSyncNow: vi.fn()
  }
}

async function mountPanel(
  stale: boolean,
  mode: OfflineMode,
  opts: { primary?: TrackerId; mediaId?: number } = {}
) {
  const primary = opts.primary ?? 'shikimori'
  const offline = offlineApi(mode)
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      ...offline.api,
      trackerListAccounts: vi.fn().mockResolvedValue({
        accounts: [
          {
            trackerId: primary,
            user: { id: 1, nickname: 'me', avatar: null },
            hasCredentials: true,
            sessionExpired: false,
            needsSetup: false,
            credentialState: 'ok'
          }
        ],
        primary,
        mirror: {},
        featureSources: {}
      } satisfies TrackerAccountsState),
      trackerGetRates: vi.fn(async (trackerId: TrackerId) => ({
        trackerId,
        entries: [],
        queuedAfter: {}
      })),
      trackerGetSyncStatus: vi.fn().mockResolvedValue({
        state: 'idle',
        queueLength: 0,
        lastSyncAt: 0,
        lastSyncError: null,
        sessionExpired: false,
        needsSetup: false
      } satisfies TrackerSyncStatus)
    } as Record<string, unknown>,
    { get: (t, p) => (p in t ? t[p as string] : () => () => {}) }
  )
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(TrackerPanel, {
    props: { anime: { myAnimeListId: 5114, numberOfEpisodes: 12 } as unknown as AnimeDetail },
    global: {
      plugins: [pinia],
      provide: { [TrackerKey as unknown as symbol]: trackerRateStub(stale, opts.mediaId) }
    }
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('TrackerPanel — cached rate stamp (#570)', () => {
  it('offline: a cached rate reads "Saved, offline"', async () => {
    const wrapper = await mountPanel(true, 'offline-manual')
    expect(wrapper.find('[data-testid="shiki-saved-badge"]').text()).toBe('Saved, offline')
  })

  it('online (a failed read): a cached rate reads "Saved", with no offline wording', async () => {
    const wrapper = await mountPanel(true, 'online')
    expect(wrapper.find('[data-testid="shiki-saved-badge"]').text()).toBe('Saved')
  })

  it('a live rate has no stamp', async () => {
    const wrapper = await mountPanel(false, 'offline-manual')
    expect(wrapper.find('[data-testid="shiki-saved-badge"]').exists()).toBe(false)
  })

  it('an AniList primary gets the same stamp, and its link once tracker:get-rate carries a media id', async () => {
    const wrapper = await mountPanel(true, 'offline-manual', { primary: 'anilist', mediaId: 21 })
    expect(wrapper.find('[data-testid="shiki-saved-badge"]').text()).toBe('Saved, offline')
    const link = wrapper.find('a.sk-open')
    expect(link.attributes('href')).toBe('https://anilist.co/anime/21')
    expect(link.attributes('title')).toBe('Open on AniList')
  })
})
