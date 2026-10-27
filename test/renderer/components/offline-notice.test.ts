// @vitest-environment happy-dom
// The shared offline empty state (#568) and its one-subscription contract: the
// views read the lifetime-scoped offline store and never subscribe themselves.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import OfflineNotice from '../../../src/renderer/src/components/shared/OfflineNotice.vue'
import SearchView from '../../../src/renderer/src/components/views/SearchView.vue'
import CalendarView from '../../../src/renderer/src/components/views/CalendarView.vue'
import { offlineApi, type OfflineApi } from '../../helpers/offline-api'

function install(offline: OfflineApi): OfflineApi {
  const target: Record<string, unknown> = {
    ...offline.api,
    offlineSetManual: vi.fn(offline.api.offlineSetManual),
    offlineRetry: vi.fn(offline.api.offlineRetry),
    shikimoriGetUser: vi.fn().mockResolvedValue(null),
    getSetting: vi.fn().mockResolvedValue('week'),
    autoDlListSubscriptions: vi.fn().mockResolvedValue([])
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(target, {
    get: (t, p, r) => (p in t ? Reflect.get(t, p, r) : () => () => {})
  })
  return offline
}

const api = (): Record<string, ReturnType<typeof vi.fn>> =>
  (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('OfflineNotice (#568)', () => {
  it('manual mode: the button turns Work offline off', async () => {
    install(offlineApi('offline-manual'))
    const wrapper = mount(OfflineNotice, { props: { reason: 'Needs the network' } })
    await flushPromises()

    expect(wrapper.find('p').text()).toBe('Needs the network')
    const button = wrapper.find('[data-testid="offline-notice-action"]')
    expect(button.text()).toBe('Work offline is on — go online')
    await button.trigger('click')
    expect(api().offlineSetManual).toHaveBeenCalledWith(false)
    expect(api().offlineRetry).not.toHaveBeenCalled()
  })

  it('auto mode: the button is Retry and probes now', async () => {
    install(offlineApi('offline-auto'))
    const wrapper = mount(OfflineNotice, { props: { reason: 'Needs the network' } })
    await flushPromises()

    const button = wrapper.find('[data-testid="offline-notice-action"]')
    expect(button.text()).toBe('Retry')
    await button.trigger('click')
    expect(api().offlineRetry).toHaveBeenCalledTimes(1)
    expect(api().offlineSetManual).not.toHaveBeenCalled()
  })

  it('mounting and unmounting the offline-aware views leaves one store subscription', async () => {
    const offline = install(offlineApi('offline-manual'))
    for (let i = 0; i < 3; i++) {
      for (const view of [SearchView, CalendarView]) {
        const wrapper = mount(view)
        await flushPromises()
        wrapper.unmount()
      }
    }
    expect(offline.listenerCount()).toBe(1)
  })
})
