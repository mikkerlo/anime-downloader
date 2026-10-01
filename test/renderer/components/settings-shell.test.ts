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

  // The cold clear's `autoMoveToCold: false` arrives as part of the handler's
  // returned state, so adopting it must stay silent. A `watch(autoMoveToCold)`
  // that saves on every change turns that adoption into a second, redundant
  // `set-setting('autoMoveToCold', false)` — which contradicts the IPC test's
  // "same handler, not a follow-up renderer write", and makes `onActivated`'s
  // refresh echo back whatever main changed. Only a user toggle may write.
  it('adopts the handler-written auto-move off without echoing a renderer write', async () => {
    const wrapper = await mountTab(
      { hotStorageDir: '/hot', coldStorageDir: '/cold', autoMoveToCold: true },
      'advanced'
    )
    expect(wrapper.find('.switch').attributes('aria-pressed')).toBe('true')
    api.storageClearRoot.mockResolvedValue({
      ...EMPTY_ROOTS,
      hotStorageDir: '/hot',
      autoMoveToCold: false
    })

    const clears = wrapper.findAll('button').filter((b) => b.text() === 'Clear')
    await clears[1].trigger('click')
    await buttonWithText(wrapper, 'Clear folder')!.trigger('click')
    await flushPromises()

    expect(api.storageClearRoot).toHaveBeenCalledWith('coldStorageDir')
    // The switch did follow main down — this is adoption, not a no-op.
    expect(wrapper.find('.switch').attributes('aria-pressed')).toBe('false')
    expect(api.setSetting).not.toHaveBeenCalled()
  })

  // The other half of the same contract: dropping the watcher must not drop
  // persistence for the toggle a user actually flips.
  it('still persists a user toggle of the auto-move switch', async () => {
    const wrapper = await mountTab({ hotStorageDir: '/hot', coldStorageDir: '/cold' }, 'advanced')

    await wrapper.find('.switch').trigger('click')

    expect(api.setSetting).toHaveBeenCalledTimes(1)
    expect(api.setSetting).toHaveBeenCalledWith('autoMoveToCold', true)
    expect(wrapper.find('.switch').attributes('aria-pressed')).toBe('true')

    await wrapper.find('.switch').trigger('click')

    expect(api.setSetting).toHaveBeenLastCalledWith('autoMoveToCold', false)
    expect(wrapper.find('.switch').attributes('aria-pressed')).toBe('false')
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

// The Storage tab's half of #443. The mode toggle used to persist through
// `watch(storageMode) → autoSave('storageMode', …)`, a plain `set-setting` that
// no main-side code reacted to — so the download manager kept writing to the
// root the user had just left. It now goes through `storage:set-mode`, which can
// also refuse, and refusing is why the `ref` may not flip on the click.
describe('StorageTab — switching storage mode (#443)', () => {
  const EMPTY_ROOTS: StorageRootsState = {
    downloadDir: '',
    hotStorageDir: '',
    coldStorageDir: '',
    autoMoveToCold: false,
    missingRoot: null
  }

  const api = {
    getSetting: vi.fn(async (_key: string): Promise<unknown> => null),
    setSetting: vi.fn(async () => undefined),
    storageGetMissingRoot: vi.fn(async () => EMPTY_ROOTS),
    storageSetMode: vi.fn(async () => ({
      mode: 'advanced' as StorageMode,
      refusedReason: null as string | null,
      roots: EMPTY_ROOTS
    })),
    cleanupGetSnoozed: vi.fn(async () => ({}))
  }

  const apiProxy = new Proxy(api as unknown as Record<string, unknown>, {
    get: (target, prop) => (prop in target ? target[prop as string] : () => () => {})
  })

  async function mountTab(
    roots: Partial<StorageRootsState> = {},
    storageMode: StorageMode = 'simple'
  ) {
    api.storageGetMissingRoot.mockResolvedValue({ ...EMPTY_ROOTS, ...roots })
    api.getSetting.mockImplementation(async (key: string) =>
      key === 'storageMode' ? storageMode : null
    )
    const wrapper = mount(StorageTab)
    await flushPromises()
    return wrapper
  }

  const modeButton = (wrapper: VueWrapper, label: 'Simple' | 'Advanced') =>
    wrapper.findAll('.set-seg button').find((b) => b.text() === label)!

  const activeMode = (wrapper: VueWrapper) =>
    wrapper
      .findAll('.set-seg button')
      .find((b) => b.classes('on'))!
      .text()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { api: unknown }).api = apiProxy
    api.storageGetMissingRoot.mockResolvedValue(EMPTY_ROOTS)
    api.cleanupGetSnoozed.mockResolvedValue({})
  })

  // The behaviour-difference case: `setSetting('storageMode', 'advanced')` is
  // what lands here on `main`.
  it('switches through storageSetMode, never through setSetting', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl', hotStorageDir: '/hot' })
    api.storageSetMode.mockResolvedValue({
      mode: 'advanced',
      refusedReason: null,
      roots: { ...EMPTY_ROOTS, downloadDir: '/dl', hotStorageDir: '/hot' }
    })

    await modeButton(wrapper, 'Advanced').trigger('click')
    await flushPromises()

    expect(api.storageSetMode).toHaveBeenCalledTimes(1)
    expect(api.storageSetMode).toHaveBeenCalledWith('advanced')
    expect(api.setSetting).not.toHaveBeenCalled()
    expect(activeMode(wrapper)).toBe('Advanced')
  })

  it('does not call the handler for the mode already in force', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl' })

    await modeButton(wrapper, 'Simple').trigger('click')
    await flushPromises()

    expect(api.storageSetMode).not.toHaveBeenCalled()
  })

  // Refusing is the half an optimistic `ref` would hide: the segmented control
  // has to stay on the mode main kept, not the one that was clicked.
  it('keeps the old mode and shows the reason when main refuses', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl', hotStorageDir: '/hot' })
    api.storageSetMode.mockResolvedValue({
      mode: 'simple',
      refusedReason: 'Downloads are still in progress or waiting to merge.',
      roots: { ...EMPTY_ROOTS, downloadDir: '/dl', hotStorageDir: '/hot' }
    })

    await modeButton(wrapper, 'Advanced').trigger('click')
    await flushPromises()

    expect(activeMode(wrapper)).toBe('Simple')
    expect(wrapper.text()).toContain('Downloads are still in progress or waiting to merge.')
    // The advanced-mode rows must not be on screen either — the refusal is not
    // a half-applied switch.
    expect(wrapper.text()).not.toContain('Hot storage (active downloads)')
    expect(api.setSetting).not.toHaveBeenCalled()
  })

  it('clears the refusal once a later switch is accepted', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl', hotStorageDir: '/hot' })
    api.storageSetMode.mockResolvedValue({
      mode: 'simple',
      refusedReason: 'Downloads are still in progress or waiting to merge.',
      roots: { ...EMPTY_ROOTS, downloadDir: '/dl', hotStorageDir: '/hot' }
    })
    await modeButton(wrapper, 'Advanced').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Downloads are still in progress')

    api.storageSetMode.mockResolvedValue({
      mode: 'advanced',
      refusedReason: null,
      roots: { ...EMPTY_ROOTS, downloadDir: '/dl', hotStorageDir: '/hot' }
    })
    await modeButton(wrapper, 'Advanced').trigger('click')
    await flushPromises()

    expect(activeMode(wrapper)).toBe('Advanced')
    expect(wrapper.text()).not.toContain('Downloads are still in progress')
  })

  it('adopts the root state the handler returns, as the clear already does', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl' })
    api.storageSetMode.mockResolvedValue({
      mode: 'advanced',
      refusedReason: null,
      roots: { ...EMPTY_ROOTS, downloadDir: '/dl', hotStorageDir: '/hot', missingRoot: '/gone' }
    })

    await modeButton(wrapper, 'Advanced').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('/hot')
    expect(wrapper.text()).toContain('Storage folder not found: /gone')
  })

  // The pre-existing display bug the review asked to fold in. `getDownloadDir()`
  // falls through hot → downloadDir → fallback, so a user who switches to
  // advanced without picking a hot dir is still downloading into `downloadDir` —
  // and the row used to tell them "Default (Downloads/anime-dl)".
  it('shows the downloadDir fall-through in the hot row, not "Default"', async () => {
    const wrapper = await mountTab({ downloadDir: '/a', hotStorageDir: '' }, 'advanced')

    const hotRow = wrapper.text()
    expect(hotRow).toContain('/a')
    expect(hotRow).not.toContain('Default (Downloads/anime-dl)')
  })

  it('still says "Default" in the hot row when no root is set at all', async () => {
    const wrapper = await mountTab({ downloadDir: '', hotStorageDir: '' }, 'advanced')

    expect(wrapper.text()).toContain('Default (Downloads/anime-dl)')
  })
})

// The Storage tab's half of #447. Both root-moving pickers now answer with
// `StoragePickDirResult` rather than a path, because main refuses the pick while
// the download manager still has work bound to the current root — and the tab
// read a bare `null` as "cancelled", so a refusal sent that way would have
// discarded the pick silently.
describe('StorageTab — refused folder picks (#447)', () => {
  const EMPTY_ROOTS: StorageRootsState = {
    downloadDir: '',
    hotStorageDir: '',
    coldStorageDir: '',
    autoMoveToCold: false,
    missingRoot: null
  }

  const REFUSAL = 'Downloads are still in progress or waiting to merge — finish or cancel them.'

  const pickResult = (over: Partial<StoragePickDirResult> = {}): StoragePickDirResult => ({
    dir: null,
    refusedReason: null,
    roots: EMPTY_ROOTS,
    ...over
  })

  const api = {
    getSetting: vi.fn(async (_key: string): Promise<unknown> => null),
    setSetting: vi.fn(async () => undefined),
    storageGetMissingRoot: vi.fn(async () => EMPTY_ROOTS),
    downloadPickDir: vi.fn(async () => pickResult()),
    storagePickHotDir: vi.fn(async () => pickResult()),
    storageSetMode: vi.fn(async () => ({
      mode: 'advanced' as StorageMode,
      refusedReason: null as string | null,
      roots: EMPTY_ROOTS
    })),
    cleanupGetSnoozed: vi.fn(async () => ({}))
  }

  const apiProxy = new Proxy(api as unknown as Record<string, unknown>, {
    get: (target, prop) => (prop in target ? target[prop as string] : () => () => {})
  })

  async function mountTab(
    roots: Partial<StorageRootsState> = {},
    storageMode: StorageMode = 'simple'
  ) {
    api.storageGetMissingRoot.mockResolvedValue({ ...EMPTY_ROOTS, ...roots })
    api.getSetting.mockImplementation(async (key: string) =>
      key === 'storageMode' ? storageMode : null
    )
    const wrapper = mount(StorageTab)
    await flushPromises()
    return wrapper
  }

  const browse = async (wrapper: VueWrapper, row: string): Promise<void> => {
    const target = wrapper
      .findAll('.set-row')
      .find((r) => r.text().includes(row))!
      .findAll('button')
      .find((b) => b.text() === 'Browse')!
    await target.trigger('click')
    await flushPromises()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { api: unknown }).api = apiProxy
    api.storageGetMissingRoot.mockResolvedValue(EMPTY_ROOTS)
    api.cleanupGetSnoozed.mockResolvedValue({})
    api.downloadPickDir.mockResolvedValue(pickResult())
    api.storagePickHotDir.mockResolvedValue(pickResult())
  })

  // The behaviour-difference case for the nit in the review: `pickDir` called
  // `autoSave('downloadDir', dir)` after main had already written the key, so a
  // refusal would have echoed the root main just declined straight back through
  // `set-setting`.
  it('never writes downloadDir through set-setting, refused or not', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl' })
    api.downloadPickDir.mockResolvedValue(
      pickResult({ refusedReason: REFUSAL, roots: { ...EMPTY_ROOTS, downloadDir: '/dl' } })
    )

    await browse(wrapper, 'Download folder')

    expect(api.setSetting).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('/dl')
    expect(wrapper.text()).not.toContain('/elsewhere')
  })

  it('does not write it on an accepted pick either — main already did', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl' })
    api.downloadPickDir.mockResolvedValue(
      pickResult({ dir: '/new', roots: { ...EMPTY_ROOTS, downloadDir: '/new' } })
    )

    await browse(wrapper, 'Download folder')

    expect(api.setSetting).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('/new')
  })

  it.each([
    ['Download folder', 'simple' as StorageMode, () => api.downloadPickDir],
    ['Hot storage', 'advanced' as StorageMode, () => api.storagePickHotDir]
  ])('shows the reason when main refuses a %s pick', async (row, storageMode, picker) => {
    const wrapper = await mountTab({ downloadDir: '/dl', hotStorageDir: '/hot' }, storageMode)
    picker().mockResolvedValue(pickResult({ refusedReason: REFUSAL }))

    await browse(wrapper, row)

    expect(wrapper.text()).toContain(REFUSAL)
  })

  // Where it renders, not just that it renders. `modeRefusedReason` sits in the
  // "Storage mode" group under the segmented control; a picker refusal there
  // would explain a Browse click next to a control the user never touched.
  it('renders the refusal in the Locations group, not under the mode toggle', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl' })
    api.downloadPickDir.mockResolvedValue(pickResult({ refusedReason: REFUSAL }))

    await browse(wrapper, 'Download folder')

    const groups = wrapper.findAll('.set-group')
    const holder = groups.find((g) => g.text().includes(REFUSAL))!
    expect(holder.text()).toContain('Locations')
    expect(holder.text()).not.toContain('Storage mode')
  })

  it('clears the refusal on the next pick that goes through', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl' })
    api.downloadPickDir.mockResolvedValue(pickResult({ refusedReason: REFUSAL }))
    await browse(wrapper, 'Download folder')
    expect(wrapper.text()).toContain(REFUSAL)

    api.downloadPickDir.mockResolvedValue(
      pickResult({ dir: '/new', roots: { ...EMPTY_ROOTS, downloadDir: '/new' } })
    )
    await browse(wrapper, 'Download folder')

    expect(wrapper.text()).not.toContain(REFUSAL)
  })

  // An accepted mode switch proves the predicate was false, so a standing
  // picker refusal is stale.
  it('clears the refusal on the next accepted mode switch', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl', hotStorageDir: '/hot' })
    api.downloadPickDir.mockResolvedValue(pickResult({ refusedReason: REFUSAL }))
    await browse(wrapper, 'Download folder')
    expect(wrapper.text()).toContain(REFUSAL)

    api.storageSetMode.mockResolvedValue({
      mode: 'advanced',
      refusedReason: null,
      roots: { ...EMPTY_ROOTS, downloadDir: '/dl', hotStorageDir: '/hot' }
    })
    await wrapper
      .findAll('.set-seg button')
      .find((b) => b.text() === 'Advanced')!
      .trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain(REFUSAL)
  })

  // Cancelling says nothing about whether the work the refusal named is
  // finished, so the notice stays up.
  it('keeps the refusal on screen when the next dialog is cancelled', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl' })
    api.downloadPickDir.mockResolvedValue(pickResult({ refusedReason: REFUSAL }))
    await browse(wrapper, 'Download folder')

    api.downloadPickDir.mockResolvedValue(pickResult())
    await browse(wrapper, 'Download folder')

    expect(wrapper.text()).toContain(REFUSAL)
  })

  // The pickers carry root state now, so the tab adopts it from the reply
  // instead of re-reading it — one round trip, and nothing that can disagree
  // with what main just wrote.
  it('adopts the roots from the pick reply, with no re-read', async () => {
    const wrapper = await mountTab({ downloadDir: '/dl' })
    api.storageGetMissingRoot.mockClear()
    api.downloadPickDir.mockResolvedValue(
      pickResult({
        dir: '/new',
        roots: { ...EMPTY_ROOTS, downloadDir: '/new', missingRoot: '/gone' }
      })
    )

    await browse(wrapper, 'Download folder')

    expect(wrapper.text()).toContain('/new')
    expect(wrapper.text()).toContain('Storage folder not found: /gone')
    expect(api.storageGetMissingRoot).not.toHaveBeenCalled()
  })
})
