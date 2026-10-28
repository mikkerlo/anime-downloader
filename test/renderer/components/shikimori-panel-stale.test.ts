// @vitest-environment happy-dom
// A rate from main's cached list (#570) carries the detail page's "Saved"
// stamp, with the offline wording only while the app is offline.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, computed } from 'vue'
import ShikimoriPanel from '../../../src/renderer/src/components/detail/ShikimoriPanel.vue'
import { ShikimoriKey } from '../../../src/renderer/src/components/detail/keys'
import { offlineApi } from '../../helpers/offline-api'

function shikimoriStub(stale: boolean) {
  return {
    shikiUser: ref({ id: 1, nickname: 'me', avatar: '' }),
    shikiRateStale: computed(() => stale),
    shikiStatus: ref('watching'),
    shikiEpisodes: ref(4),
    shikiScore: ref(7),
    shikiRewatches: ref(0),
    shikiLoading: ref(false),
    shikiSaving: ref(false),
    shikiError: ref(''),
    syncState: computed(() => 'idle' as const),
    lastSyncError: computed(() => null),
    shikiSave: vi.fn(),
    triggerSyncNow: vi.fn()
  }
}

async function mountPanel(stale: boolean, mode: OfflineMode) {
  const offline = offlineApi(mode)
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      ...offline.api,
      shikimoriGetSyncStatus: vi.fn().mockResolvedValue({
        state: 'idle',
        queueLength: 0,
        lastSyncAt: 0,
        lastSyncError: null,
        sessionExpired: false
      })
    } as Record<string, unknown>,
    { get: (t, p) => (p in t ? t[p as string] : () => () => {}) }
  )
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(ShikimoriPanel, {
    props: { anime: { myAnimeListId: 5114, numberOfEpisodes: 12 } as unknown as AnimeDetail },
    global: {
      plugins: [pinia],
      provide: { [ShikimoriKey as unknown as symbol]: shikimoriStub(stale) }
    }
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('ShikimoriPanel — cached rate stamp (#570)', () => {
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
})
