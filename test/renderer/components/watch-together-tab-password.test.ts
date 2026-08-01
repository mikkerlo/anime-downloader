// @vitest-environment happy-dom
// The Syncplay password is owned by main (#216): Settings writes it through
// syncplay:set-password and may only ask *whether* one is stored. It must never
// be read back into the renderer, and must never ride along on syncplay:connect
// — main injects it, so every join flow authenticates identically.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WatchTogetherTab from '../../../src/renderer/src/components/settings/WatchTogetherTab.vue'

const api = {
  getSetting: vi.fn(async () => ({
    lastHost: 'syncplay.test',
    lastPort: 8999,
    lastRoom: 'r',
    username: 'u',
    autoReconnect: true
  })),
  setSetting: vi.fn(async () => undefined),
  syncplayHasPassword: vi.fn(async () => false),
  syncplaySetPassword: vi.fn(async () => undefined),
  syncplayConnect: vi.fn(async () => undefined),
  syncplayDisconnect: vi.fn(async () => undefined),
  onSyncplayConnectionStatus: vi.fn(() => () => {})
}

// The tab pulls in useShikimoriStore, which eagerly subscribes to unrelated
// channels; everything we don't assert on falls through to a no-op subscriber.
const apiProxy = new Proxy(api as unknown as Record<string, unknown>, {
  get: (target, prop) => (prop in target ? target[prop as string] : () => () => {})
})

async function mountTab() {
  const wrapper = mount(WatchTogetherTab, { global: { plugins: [createPinia()] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  api.syncplayHasPassword.mockResolvedValue(false)
  ;(window as unknown as { api: unknown }).api = apiProxy
  setActivePinia(createPinia())
  vi.useFakeTimers()
})

describe('WatchTogetherTab password handling (#216)', () => {
  it('stores a typed password via syncplay:set-password, not in the settings object', async () => {
    const wrapper = await mountTab()

    await wrapper.find('#sp-password').setValue('hunter2')
    await vi.advanceTimersByTimeAsync(700)

    expect(api.syncplaySetPassword).toHaveBeenCalledWith('hunter2')
    // The `syncplay` settings object is overwritten wholesale on every save —
    // a password in there would be leaked to disk in the clear and then dropped.
    for (const [, value] of api.setSetting.mock.calls) {
      expect(JSON.stringify(value)).not.toContain('hunter2')
    }
  })

  it('never sends the password on syncplay:connect — main injects it', async () => {
    const wrapper = await mountTab()
    await wrapper.find('#sp-password').setValue('hunter2')

    await wrapper.find('.btn').trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    // Flushed before connecting, so a just-typed password still applies.
    expect(api.syncplaySetPassword).toHaveBeenCalledWith('hunter2')
    const cfg = api.syncplayConnect.mock.calls[0]?.[0] as Record<string, unknown>
    expect(cfg).toBeDefined()
    expect(cfg).not.toHaveProperty('password')
  })

  it('shows a saved state without ever reading the password back', async () => {
    api.syncplayHasPassword.mockResolvedValue(true)
    const wrapper = await mountTab()

    const input = wrapper.find('#sp-password')
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(input.attributes('placeholder')).toContain('saved')
    expect(wrapper.text()).toContain('Clear')
  })

  it('clears the stored password with an empty string', async () => {
    api.syncplayHasPassword.mockResolvedValue(true)
    const wrapper = await mountTab()

    const clear = wrapper.findAll('button').find((b) => b.text() === 'Clear')!
    await clear.trigger('click')
    await flushPromises()

    expect(api.syncplaySetPassword).toHaveBeenCalledWith('')
    expect(wrapper.findAll('button').some((b) => b.text() === 'Clear')).toBe(false)
  })
})
