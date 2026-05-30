// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsShell from '../../../src/renderer/src/components/settings/SettingsShell.vue'

// Each tab is stubbed with an identifiable marker so we can assert the panel
// swaps without standing up every tab's window.api plumbing. The shell only
// renders the active tab (keep-alive), so the markers also prove the
// <component :is> binding tracks the rail.
const tabStub = (name: string) => ({ template: `<div class="stub-${name}" />` })

function mountShell() {
  return mount(SettingsShell, {
    global: {
      plugins: [createPinia()],
      stubs: {
        GeneralTab: tabStub('general'),
        StorageTab: tabStub('storage'),
        PlayerTab: tabStub('player'),
        ConnectorsTab: tabStub('connectors'),
        MergingTab: tabStub('merging'),
        ShortcutsTab: tabStub('shortcuts'),
        WatchTogetherTab: tabStub('watch-together'),
        DebugTab: tabStub('debug')
      }
    }
  })
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => () => () => {} })
  setActivePinia(createPinia())
})

describe('SettingsShell', () => {
  it('renders the side rail (not the old top tab bar)', () => {
    const wrapper = mountShell()
    // Regression contract: the redesign moves tabs into a left rail.
    expect(wrapper.find('.settings-layout').exists()).toBe(true)
    expect(wrapper.find('.settings-nav').exists()).toBe(true)
    // The legacy horizontal `.tabs > .tab` bar must be gone.
    expect(wrapper.find('.tabs').exists()).toBe(false)
    expect(wrapper.find('.tab').exists()).toBe(false)
  })

  it('renders one rail button per tab, all eight tabs', () => {
    const wrapper = mountShell()
    const tabs = wrapper.findAll('.settings-tab')
    expect(tabs).toHaveLength(8)
    expect(tabs.map((t) => t.find('.st-label').text())).toEqual([
      'General',
      'Storage',
      'Player',
      'Connectors',
      'Merging',
      'Shortcuts',
      'Watch Together',
      'Debug'
    ])
  })

  it('marks exactly one tab active, General by default, with aria-current', () => {
    const wrapper = mountShell()
    const active = wrapper.findAll('.settings-tab.active')
    expect(active).toHaveLength(1)
    expect(active[0].find('.st-label').text()).toBe('General')
    expect(active[0].attributes('aria-current')).toBe('page')
    // Default panel is the General stub.
    expect(wrapper.find('.stub-general').exists()).toBe(true)
    expect(wrapper.find('.stub-storage').exists()).toBe(false)
  })

  it('moves the active marker and swaps the panel when another tab is clicked', async () => {
    const wrapper = mountShell()
    const storageBtn = wrapper.findAll('.settings-tab')[1]
    await storageBtn.trigger('click')

    const active = wrapper.findAll('.settings-tab.active')
    expect(active).toHaveLength(1)
    expect(active[0].find('.st-label').text()).toBe('Storage')
    expect(active[0].attributes('aria-current')).toBe('page')
    // Panel swapped from General to Storage.
    expect(wrapper.find('.stub-general').exists()).toBe(false)
    expect(wrapper.find('.stub-storage').exists()).toBe(true)
  })

  it('shows the in-development badge only on Watch Together', () => {
    const wrapper = mountShell()
    const badges = wrapper.findAll('.st-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0].text()).toBe('in development')
    const wt = wrapper.findAll('.settings-tab')[6]
    expect(wt.find('.st-badge').exists()).toBe(true)
  })
})
