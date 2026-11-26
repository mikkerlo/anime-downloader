// @vitest-environment happy-dom
// The detail panel is where the reported failure was seen: marking an episode
// watched with a dead refresh token rendered `String(err)` — "ShikiApiError:
// Shikimori API error: 400" — with no hint that the edit was recoverable or
// that re-authenticating would fix it (#244). Since #704 the panel edits the
// primary tracker and takes its sync state from the trackers store.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, computed } from 'vue'
import TrackerPanel from '../../../src/renderer/src/components/detail/TrackerPanel.vue'
import { TrackerKey } from '../../../src/renderer/src/components/detail/keys'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'

const getSyncStatus = vi.fn()
const listAccounts = vi.fn()

const apiProxy = new Proxy(
  {
    trackerGetSyncStatus: getSyncStatus,
    trackerListAccounts: listAccounts,
    trackerGetRates: vi.fn(async (trackerId: TrackerId) => ({
      trackerId,
      entries: [],
      queuedAfter: {}
    }))
  } as Record<string, unknown>,
  {
    get: (target, prop) => (prop in target ? target[prop as string] : () => () => {})
  }
)

/** Minimal stand-in for `useTrackerRate()`, which the panel injects. */
function trackerRateStub(saveError: string) {
  const syncStatus = ref({ state: 'idle' as const })
  return {
    rateStale: computed(() => false),
    mediaId: ref<number | undefined>(undefined),
    rateStatus: ref('watching'),
    rateEpisodes: ref(4),
    rateScore: ref(7),
    rateRewatches: ref(0),
    loading: ref(false),
    saving: ref(false),
    saveError: ref(saveError),
    syncState: computed(() => syncStatus.value.state),
    lastSyncError: computed(() => null),
    save: vi.fn(),
    triggerSyncNow: vi.fn()
  }
}

async function mountPanel(
  sessionExpired: boolean,
  queueLength = 0,
  saveError = '',
  primary: TrackerId = 'shikimori'
) {
  listAccounts.mockResolvedValue({
    accounts: [
      {
        trackerId: primary,
        user: { id: 1, nickname: 'mikkerlo', avatar: null },
        hasCredentials: !sessionExpired,
        sessionExpired,
        needsSetup: false,
        credentialState: sessionExpired ? 'none' : 'ok'
      }
    ],
    primary,
    mirror: {},
    featureSources: {}
  } satisfies TrackerAccountsState)
  getSyncStatus.mockResolvedValue({
    state: 'idle',
    queueLength,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired,
    needsSetup: false
  } satisfies TrackerSyncStatus)
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(TrackerPanel, {
    props: { anime: { myAnimeListId: 5114, numberOfEpisodes: 64 } as unknown as AnimeDetail },
    global: {
      plugins: [pinia],
      provide: {
        [TrackerKey as unknown as symbol]: trackerRateStub(saveError)
      }
    }
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: unknown }).api = apiProxy
  setActivePinia(createPinia())
})

describe('TrackerPanel — expired session banner', () => {
  it('renders nothing extra while the session is healthy', async () => {
    const wrapper = await mountPanel(false)
    expect(wrapper.find('.shiki-expired').exists()).toBe(false)
  })

  it('replaces the raw error string with an actionable banner when expired', async () => {
    const wrapper = await mountPanel(true, 0, 'ShikiApiError: Shikimori API error: 400')

    expect(wrapper.find('.shiki-expired').text()).toContain('Shikimori session expired')
    expect(wrapper.find('.shiki-error').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Shikimori API error: 400')
  })

  it('says the queued changes are kept, and does not claim the user is offline', async () => {
    const wrapper = await mountPanel(true, 2)

    const banner = wrapper.find('.shiki-expired')
    expect(banner.text()).toMatch(/2 changes pending/)
    // The "Working offline" chip would be a lie — the network is fine.
    expect(wrapper.find('.shiki-offline').exists()).toBe(false)
  })

  it('"Sign in again" deep-links to Settings → Connectors', async () => {
    const wrapper = await mountPanel(true)
    const library = useLibraryStore()

    await wrapper.find('.shiki-expired-btn').trigger('click')

    expect(library.currentView).toBe('settings')
    expect(library.pendingSettingsTab).toBe('connectors')
  })

  // The Shikimori-only golden: today's header, link and banner copy, byte for byte.
  it('a Shikimori primary keeps the Shikimori header, link and banner copy', async () => {
    const wrapper = await mountPanel(true, 1)

    const h4 = wrapper.find('h4')
    expect(h4.find('.sk-logo').text()).toBe('Sh')
    expect(h4.text().replace(/\s+/g, ' ')).toBe('ShShikimori Open ↗')
    const link = h4.find('a.sk-open')
    expect(link.attributes('href')).toBe('https://shikimori.io/animes/5114')
    expect(link.attributes('title')).toBe('Open on Shikimori')
    expect(wrapper.find('.shiki-expired-title').text()).toBe('Shikimori session expired')
    expect(wrapper.find('.shiki-expired-body').text().replace(/\s+/g, ' ')).toBe(
      'Shikimori rejected the saved sign-in. Your changes are kept and will sync once you sign in again. 1 change pending.'
    )
  })

  it('an AniList primary names AniList in the banner, with the queued count', async () => {
    const wrapper = await mountPanel(true, 3, 'AniList error', 'anilist')

    expect(wrapper.find('.sk-logo').text()).toBe('AL')
    expect(wrapper.find('.shiki-expired-title').text()).toBe('AniList session expired')
    expect(wrapper.find('.shiki-expired-body').text()).toMatch(
      /^AniList rejected the saved sign-in\..*3 changes pending\.$/s
    )
    expect(wrapper.find('.shiki-error').exists()).toBe(false)
    // No media id from tracker:get-rate (#703 fills it): no AniList link.
    expect(wrapper.find('a.sk-open').exists()).toBe(false)
  })

  it('a MAL primary links to MyAnimeList by MAL id', async () => {
    const wrapper = await mountPanel(false, 0, '', 'mal')
    expect(wrapper.find('h4').text()).toContain('MyAnimeList')
    expect(wrapper.find('a.sk-open').attributes('href')).toBe('https://myanimelist.net/anime/5114')
  })
})
