// @vitest-environment happy-dom
// Session expiry is not a logout (#244): Shikimori rejected the stored refresh
// token, but the account, its caches and the queued updates are all still here.
// The Connectors card therefore keeps its identity and swaps only the chip and
// the primary action — a "Connect Shikimori" empty state would tell the user
// their data is gone.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ConnectorsTab from '../../../src/renderer/src/components/settings/ConnectorsTab.vue'
import { useShikimoriStore } from '../../../src/renderer/src/stores/shikimori'

const api = {
  getSetting: vi.fn(async () => ''),
  setSetting: vi.fn(async () => undefined),
  shikimoriGetUser: vi.fn(async () => null),
  shikimoriGetAuthUrl: vi.fn(async () => 'https://shikimori.io/oauth/authorize?x=1'),
  shellOpenExternal: vi.fn(async () => true),
  shikimoriGetSyncStatus: vi.fn(async () => ({
    state: 'idle',
    queueLength: 0,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired: false
  }))
}

const apiProxy = new Proxy(api as unknown as Record<string, unknown>, {
  get: (target, prop) => (prop in target ? target[prop as string] : () => () => {})
})

async function mountTab(sessionExpired: boolean, queueLength = 0) {
  // The store pulls the sync status on init (#244 §6c), so the flag has to come
  // from the bridge — assigning it on the store would just be overwritten.
  api.shikimoriGetSyncStatus.mockResolvedValue({
    state: 'idle',
    queueLength,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired
  })
  const pinia = createPinia()
  setActivePinia(pinia)
  const shiki = useShikimoriStore()
  shiki.user = { id: 1, nickname: 'mikkerlo', avatar: '' }
  const wrapper = mount(ConnectorsTab, { global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: unknown }).api = apiProxy
  setActivePinia(createPinia())
})

describe('ConnectorsTab — expired Shikimori session', () => {
  it('keeps the account card and shows Connected while the session is healthy', async () => {
    const wrapper = await mountTab(false)
    expect(wrapper.find('.conn-card').text()).toContain('Connected')
    expect(wrapper.find('.chip.red').exists()).toBe(false)
    expect(wrapper.text()).toContain('Disconnect')
  })

  it('swaps the chip and offers Reconnect instead of Disconnect when expired', async () => {
    const wrapper = await mountTab(true)

    const card = wrapper.find('.conn-card')
    expect(card.text()).toContain('mikkerlo')
    expect(card.find('.chip.red').text()).toContain('Session expired')
    expect(card.text()).toContain('Reconnect')
    expect(card.text()).not.toContain('Disconnect')
  })

  it('names the pending update count that will sync after reconnecting', async () => {
    const wrapper = await mountTab(true, 3)
    expect(wrapper.find('.conn-card').text()).toMatch(/3 pending updates will sync/)
  })

  it('Reconnect runs the normal auth-URL flow and reveals the code form', async () => {
    const wrapper = await mountTab(true)
    // Browser did not open — the copyable link + code input must appear.
    api.shellOpenExternal.mockResolvedValueOnce(false)

    await wrapper.find('.conn-card button').trigger('click')
    await flushPromises()

    expect(api.shikimoriGetAuthUrl).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.shikimori-auth').exists()).toBe(true)
    expect(wrapper.find('input[placeholder="Paste authorization code..."]').exists()).toBe(true)
  })
})
