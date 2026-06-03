// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Sidebar from '../../../src/renderer/src/components/shared/Sidebar.vue'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'
import { useShikimoriStore } from '../../../src/renderer/src/stores/shikimori'
import { useSettingsStore } from '../../../src/renderer/src/stores/settings'

beforeEach(() => {
  // The downloads + shikimori stores subscribe to `window.api.on*` at setup.
  // A permissive stub returns a no-op unsubscribe handle for any access.
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => () => () => {} })
  setActivePinia(createPinia())
})

describe('Sidebar', () => {
  it('marks the nav item for the current view as active and tracks changes', async () => {
    const library = useLibraryStore()
    library.navigate('home')

    const wrapper = mount(Sidebar)

    const activeLabel = () => wrapper.find('.nav-item.active span').text()
    expect(wrapper.findAll('.nav-item.active')).toHaveLength(1)
    expect(activeLabel()).toBe('Home')

    library.navigate('library')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.nav-item.active')).toHaveLength(1)
    expect(activeLabel()).toBe('Library')
  })

  it('hides the Shikimori nav group and user chip until logged in', async () => {
    const shiki = useShikimoriStore()
    const wrapper = mount(Sidebar)
    expect(wrapper.find('.nav-label').exists()).toBe(false)
    expect(wrapper.find('.user-chip').exists()).toBe(false)

    // Login is derived from the store (the `shikimoriLoggedIn` prop was removed).
    shiki.user = { id: 1, nickname: 'mikkerlo', avatar: '' }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.nav-label').text()).toBe('Shikimori')
    expect(wrapper.find('.user-chip').exists()).toBe(true)
  })

  it('reflects the real Shikimori sync state in the footer chip', async () => {
    const shiki = useShikimoriStore()
    shiki.user = { id: 1, nickname: 'mikkerlo', avatar: '' }
    const wrapper = mount(Sidebar)

    // Empty offline queue → green "Synced".
    expect(wrapper.find('.u-sync').text()).toBe('Synced')
    expect(wrapper.find('.u-sync').classes()).not.toContain('offline')

    // Pending offline changes must NOT read "Synced" (the reviewed nit).
    shiki.offlineQueueLength = 2
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.u-sync').classes()).toContain('offline')
    expect(wrapper.find('.u-sync').text()).toContain('2 pending')
  })

  it('shows the update banner even when logged out (it is not gated on login)', () => {
    // Updates are app-level, not tied to Shikimori — a logged-out user with no
    // `.user-chip` footer must still see the banner pinned at the bottom.
    const settings = useSettingsStore()
    settings.updateStatus = { status: 'available', version: '4.1.12' }

    const wrapper = mount(Sidebar)
    expect(wrapper.find('.user-chip').exists()).toBe(false)
    expect(wrapper.find('.update-banner').exists()).toBe(true)
  })
})
