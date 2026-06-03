// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SidebarUpdateBanner from '../../../src/renderer/src/components/shared/SidebarUpdateBanner.vue'
import { useSettingsStore, type UiUpdateStatus } from '../../../src/renderer/src/stores/settings'

const updateDownload = vi.fn()
const updateInstall = vi.fn()

beforeEach(() => {
  updateDownload.mockClear()
  updateInstall.mockClear()
  // The settings store eagerly subscribes to these at init, so they must exist.
  ;(window as unknown as { api: unknown }).api = {
    onFfmpegDownloadProgress: () => () => {},
    onFpcalcDownloadProgress: () => () => {},
    onUpdateStatus: () => () => {},
    updateDownload,
    updateInstall
  }
  setActivePinia(createPinia())
})

function mountBanner(status: UiUpdateStatus) {
  const store = useSettingsStore()
  store.updateStatus = status
  return { wrapper: mount(SidebarUpdateBanner), store }
}

describe('SidebarUpdateBanner', () => {
  it('shows the Download action and version when an update is available', async () => {
    const { wrapper } = mountBanner({ status: 'available', version: '4.1.12' })
    expect(wrapper.find('.update-banner').exists()).toBe(true)
    expect(wrapper.text()).toContain('Update available')
    expect(wrapper.text()).toContain('v4.1.12')

    await wrapper.get('.ub-action').trigger('click')
    expect(updateDownload).toHaveBeenCalledTimes(1)
    expect(updateInstall).not.toHaveBeenCalled()
  })

  it('shows progress (no action button) while downloading', () => {
    const { wrapper } = mountBanner({ status: 'downloading', percent: 42 })
    expect(wrapper.find('.update-banner').exists()).toBe(true)
    expect(wrapper.find('.ub-progress').exists()).toBe(true)
    expect(wrapper.text()).toContain('42%')
    expect(wrapper.find('.ub-action').exists()).toBe(false)
    // No dismiss mid-download.
    expect(wrapper.find('.ub-dismiss').exists()).toBe(false)
  })

  it('shows a Restart action when the update is ready to install', async () => {
    const { wrapper } = mountBanner({ status: 'ready' })
    expect(wrapper.text()).toContain('Update ready')
    await wrapper.get('.ub-action').trigger('click')
    expect(updateInstall).toHaveBeenCalledTimes(1)
    expect(updateDownload).not.toHaveBeenCalled()
  })

  // Regression guard: the banner must stay silent for non-actionable states —
  // in particular `error`, which fires in dev mode ("not available").
  it.each(['idle', 'checking', 'up-to-date', 'error'] as const)(
    'renders nothing for status "%s"',
    (status) => {
      const { wrapper } = mountBanner({ status })
      expect(wrapper.find('.update-banner').exists()).toBe(false)
    }
  )

  it('hides when dismissed, then re-surfaces on a fresh "ready" transition', async () => {
    const { wrapper, store } = mountBanner({ status: 'available', version: '4.1.12' })
    await wrapper.get('.ub-dismiss').trigger('click')
    expect(wrapper.find('.update-banner').exists()).toBe(false)

    store.updateStatus = { status: 'downloading', percent: 80 }
    await wrapper.vm.$nextTick()
    // Still dismissed while downloading.
    expect(wrapper.find('.update-banner').exists()).toBe(false)

    store.updateStatus = { status: 'ready' }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.update-banner').exists()).toBe(true)
    expect(wrapper.text()).toContain('Update ready')
  })
})
