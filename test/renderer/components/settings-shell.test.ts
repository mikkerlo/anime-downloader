// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsShell from '../../../src/renderer/src/components/settings/SettingsShell.vue'
import StorageTab from '../../../src/renderer/src/components/settings/StorageTab.vue'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'

// Each tab is stubbed with an identifiable marker so we can assert the panel
// swaps without standing up every tab's window.api plumbing. The shell only
// renders the active tab (keep-alive), so the markers also prove the
// <component :is> binding tracks the rail.
const tabStub = (name: string) => ({ template: `<div class="stub-${name}" />` })

function mountShell(pinia = createPinia()) {
  return mount(SettingsShell, {
    global: {
      plugins: [pinia],
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

  // The Shikimori "sign in again" affordances deep-link straight to Connectors
  // (#244); the shell owns `activeTab` locally, so the target is parked on the
  // library store and consumed here.
  it('opens on the tab a deep link parked before mount, then forgets it', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const library = useLibraryStore()
    library.navigateToSettingsTab('connectors')

    const wrapper = mountShell(pinia)

    expect(wrapper.find('.stub-connectors').exists()).toBe(true)
    expect(library.pendingSettingsTab).toBeNull()
    // A later manual visit still opens on General.
    expect(mountShell(pinia).find('.stub-general').exists()).toBe(true)
  })

  it('switches tabs on a deep link raised while Settings is already open', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const library = useLibraryStore()
    const wrapper = mountShell(pinia)
    expect(wrapper.find('.stub-general').exists()).toBe(true)

    library.navigateToSettingsTab('connectors')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.stub-connectors').exists()).toBe(true)
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

// The Storage tab's half of #440. The shell stubs this tab out above, so the
// group below mounts it for real — it is the closest harness, and the tab is
// where every control added for the issue lives.
//
// Two contracts are asserted rather than one. The visible one is that a stale
// root is reachable from whichever mode the user is in. The invisible one is
// that Clear goes through `storageClearRoot` and NOT `autoSave`/`setSetting`:
// the latter only writes the store, leaving the download manager's cached
// directory on the root that was just cleared.
describe('StorageTab — clearing a stale storage root (#440)', () => {
  const EMPTY_ROOTS: StorageRootsState = {
    downloadDir: '',
    hotStorageDir: '',
    coldStorageDir: '',
    autoMoveToCold: false,
    missingRoot: null
  }

  const api = {
    getSetting: vi.fn(
      async (key: string): Promise<unknown> => (key === 'storageMode' ? 'simple' : null)
    ),
    setSetting: vi.fn(async () => undefined),
    storageGetMissingRoot: vi.fn(async () => EMPTY_ROOTS),
    storageClearRoot: vi.fn(async () => EMPTY_ROOTS),
    cleanupGetSnoozed: vi.fn(async () => ({}))
  }

  const apiProxy = new Proxy(api as unknown as Record<string, unknown>, {
    get: (target, prop) => (prop in target ? target[prop as string] : () => () => {})
  })

  async function mountTab(
    roots: Partial<StorageRootsState> = {},
    storageMode: 'simple' | 'advanced' = 'simple'
  ) {
    const state = { ...EMPTY_ROOTS, ...roots }
    api.storageGetMissingRoot.mockResolvedValue(state)
    api.getSetting.mockImplementation(async (key: string) =>
      key === 'storageMode' ? storageMode : null
    )
    const wrapper = mount(StorageTab)
    await flushPromises()
    return wrapper
  }

  const buttonWithText = (wrapper: VueWrapper, text: string) =>
    wrapper.findAll('button').find((b) => b.text() === text)

  /** Open the confirm dialog from a button, then accept it. */
  async function clickThroughConfirm(wrapper: VueWrapper, trigger: string): Promise<void> {
    await buttonWithText(wrapper, trigger)!.trigger('click')
    await buttonWithText(wrapper, 'Clear folder')!.trigger('click')
    await flushPromises()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { api: unknown }).api = apiProxy
    api.storageGetMissingRoot.mockResolvedValue(EMPTY_ROOTS)
    api.storageClearRoot.mockResolvedValue(EMPTY_ROOTS)
    api.cleanupGetSnoozed.mockResolvedValue({})
  })

  it('offers no Clear on a root that is already unset', async () => {
    const wrapper = await mountTab()
    expect(buttonWithText(wrapper, 'Clear')).toBeUndefined()
  })

  it('clears downloadDir through storageClearRoot, never through setSetting', async () => {
    const wrapper = await mountTab({ downloadDir: '/old/dl' })

    await clickThroughConfirm(wrapper, 'Clear')

    expect(api.storageClearRoot).toHaveBeenCalledTimes(1)
    expect(api.storageClearRoot).toHaveBeenCalledWith('downloadDir')
    // The plan the review rejected: `autoSave('downloadDir', '')` lands here.
    expect(api.setSetting).not.toHaveBeenCalled()
  })

  it('does not clear anything until the confirm is accepted', async () => {
    const wrapper = await mountTab({ downloadDir: '/old/dl' })

    await buttonWithText(wrapper, 'Clear')!.trigger('click')
    expect(api.storageClearRoot).not.toHaveBeenCalled()

    await buttonWithText(wrapper, 'Cancel')!.trigger('click')
    await flushPromises()
    expect(api.storageClearRoot).not.toHaveBeenCalled()
  })

  it('warns that the files stay put AND that the downloads vanish from the app', async () => {
    const wrapper = await mountTab({ downloadDir: '/old/dl' })
    await buttonWithText(wrapper, 'Clear')!.trigger('click')

    const copy = wrapper.find('.cleanup-modal').text()
    // Both halves, because clearing is not metadata-neutral: an unmounted root
    // still holds files whose entries the next GC pass collects.
    expect(copy).toMatch(/No files are moved or deleted/)
    expect(copy).toMatch(/disappear from the app until you re-pick this folder/)
  })

  it('says the cold clear also turns auto-move off, and only for that root', async () => {
    const advanced = await mountTab({ hotStorageDir: '/hot', coldStorageDir: '/cold' }, 'advanced')
    const clears = advanced.findAll('button').filter((b) => b.text() === 'Clear')
    expect(clears).toHaveLength(2)

    await clears[1].trigger('click')
    expect(advanced.find('.cleanup-modal').text()).toContain('Auto-move to cold storage')

    await buttonWithText(advanced, 'Cancel')!.trigger('click')
    await clears[0].trigger('click')
    expect(advanced.find('.cleanup-modal').text()).not.toContain('Auto-move to cold storage')
  })

  // The case the issue is actually about: the stale root belongs to advanced
  // mode and the user is in simple mode, so its own row is not rendered at all.
  it('surfaces a stale cold root from simple mode, where its own row is hidden', async () => {
    const wrapper = await mountTab({
      downloadDir: '/dl',
      coldStorageDir: '/gone',
      missingRoot: '/gone'
    })

    expect(wrapper.text()).toContain('Storage folder not found: /gone')
    // Proof the row is genuinely absent — the notice is the only way in.
    expect(wrapper.text()).not.toContain('Cold storage (finished files)')

    await clickThroughConfirm(wrapper, 'Clear Cold storage')

    expect(api.storageClearRoot).toHaveBeenCalledWith('coldStorageDir')
  })

  it('surfaces a stale hot root from advanced mode too — the notice is mode-independent', async () => {
    const wrapper = await mountTab(
      { hotStorageDir: '/gone', coldStorageDir: '/cold', missingRoot: '/gone' },
      'advanced'
    )

    expect(wrapper.text()).toContain('Storage folder not found: /gone')
    await clickThroughConfirm(wrapper, 'Clear Hot storage')

    expect(api.storageClearRoot).toHaveBeenCalledWith('hotStorageDir')
  })

  it('drops the notice on the state the clear handler returns, with no re-read', async () => {
    const wrapper = await mountTab({
      downloadDir: '/dl',
      coldStorageDir: '/gone',
      missingRoot: '/gone'
    })
    api.storageGetMissingRoot.mockClear()

    await clickThroughConfirm(wrapper, 'Clear Cold storage')

    expect(wrapper.text()).not.toContain('Storage folder not found')
    expect(api.storageGetMissingRoot).not.toHaveBeenCalled()
  })

  it('shows no notice while every configured root is on disk', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl' })
    expect(wrapper.text()).not.toContain('Storage folder not found')
  })
})
