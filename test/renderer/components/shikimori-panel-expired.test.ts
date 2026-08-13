// @vitest-environment happy-dom
// The detail panel is where the reported failure was seen: marking an episode
// watched with a dead refresh token rendered `String(err)` — "ShikiApiError:
// Shikimori API error: 400" — with no hint that the edit was recoverable or
// that re-authenticating would fix it (#244).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, computed } from 'vue'
import ShikimoriPanel from '../../../src/renderer/src/components/detail/ShikimoriPanel.vue'
import { ShikimoriKey } from '../../../src/renderer/src/components/detail/keys'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'

const getSyncStatus = vi.fn()

const apiProxy = new Proxy({ shikimoriGetSyncStatus: getSyncStatus } as Record<string, unknown>, {
  get: (target, prop) => (prop in target ? target[prop as string] : () => () => {})
})

/** Minimal stand-in for `useShikimori()`, which the panel injects. */
function shikimoriStub(shikiError: string) {
  const syncStatus = ref({ state: 'idle' as const })
  return {
    shikiUser: ref({ id: 1, nickname: 'mikkerlo', avatar: '' }),
    shikiStatus: ref('watching'),
    shikiEpisodes: ref(4),
    shikiScore: ref(7),
    shikiRewatches: ref(0),
    shikiLoading: ref(false),
    shikiSaving: ref(false),
    shikiError: ref(shikiError),
    syncState: computed(() => syncStatus.value.state),
    lastSyncError: computed(() => null),
    shikiSave: vi.fn(),
    triggerSyncNow: vi.fn()
  }
}

async function mountPanel(sessionExpired: boolean, queueLength = 0, shikiError = '') {
  getSyncStatus.mockResolvedValue({
    state: 'idle',
    queueLength,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired
  })
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(ShikimoriPanel, {
    props: { anime: { myAnimeListId: 5114, numberOfEpisodes: 64 } as unknown as AnimeDetail },
    global: {
      plugins: [pinia],
      provide: {
        [ShikimoriKey as unknown as symbol]: shikimoriStub(shikiError)
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

describe('ShikimoriPanel — expired session banner', () => {
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
})
