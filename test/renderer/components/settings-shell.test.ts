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
    missingRoot: null,
    // #451 widened the state. Nothing is configured here, so the resolver lands
    // on the downloads fallback and reports `downloadDir` as the key a root move
    // would write.
    effectiveRoot: '',
    effectiveRootKey: 'downloadDir',
    effectiveRootMissing: false,
    rebindOffered: false
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

  // #454: the lookup is a loop over `ROOT_KEYS` rather than a hand-written `if`
  // chain, and this is the case that pins the order it must keep. Two keys hold
  // the same absent path — which happens for real, since `downloadDir` is the
  // advanced-mode fallback a user may well have pointed at their hot folder —
  // so the notice has to name the key `missingConfiguredRoot()` picked, i.e.
  // the earlier one in `ROOT_KEYS`. Reversing the loop makes this clear
  // `hotStorageDir` instead, and nothing else in the suite would notice.
  it('resolves an ambiguous missing root to the first key in ROOT_KEYS order', async () => {
    const wrapper = await mountTab(
      { downloadDir: '/gone', hotStorageDir: '/gone', missingRoot: '/gone' },
      'advanced'
    )

    expect(wrapper.text()).toContain('Storage folder not found: /gone')
    await clickThroughConfirm(wrapper, 'Clear Download folder')

    expect(api.storageClearRoot).toHaveBeenCalledWith('downloadDir')
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
    missingRoot: null,
    // #451 widened the state. Nothing is configured here, so the resolver lands
    // on the downloads fallback and reports `downloadDir` as the key a root move
    // would write.
    effectiveRoot: '',
    effectiveRootKey: 'downloadDir',
    effectiveRootMissing: false,
    rebindOffered: false
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
    missingRoot: null,
    // #451 widened the state. Nothing is configured here, so the resolver lands
    // on the downloads fallback and reports `downloadDir` as the key a root move
    // would write.
    effectiveRoot: '',
    effectiveRootKey: 'downloadDir',
    effectiveRootMissing: false,
    rebindOffered: false
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

// The Storage tab's half of #451. #440's notice tells the user to "re-pick the
// folder to resume", which #449 honours only for a drive that returns at the
// same path — a relocated one is a genuine root move and the pickers refuse it.
// The tab now offers the validated move instead, and the condition it is offered
// under is the whole point: `missingRoot` is the *first* missing stored root, so
// in advanced mode with a stale `downloadDir` it names `downloadDir` while the
// root actually holding the stranded work is the hot one. Main therefore reports
// the resolution itself and the tab gates on one boolean, re-deriving nothing.
//
// That boolean is `rebindOffered`, not `effectiveRootMissing` (#455 review): the
// bare missing-root fact is also true on a fresh install, where `downloadDir` is
// unset and nothing has created `<Downloads>/anime-dl` yet, so gating on it
// offered the action to users with an empty queue.
describe('StorageTab — pointing a relocated root at its new folder (#451)', () => {
  const EMPTY_ROOTS: StorageRootsState = {
    downloadDir: '',
    hotStorageDir: '',
    coldStorageDir: '',
    autoMoveToCold: false,
    missingRoot: null,
    effectiveRoot: '',
    effectiveRootKey: 'downloadDir',
    effectiveRootMissing: false,
    rebindOffered: false
  }

  const OFFER = 'My downloads moved to another folder'
  const REFUSAL = 'Nothing was changed: the unfinished downloads were not found under /new.'

  const rebindResult = (over: Partial<StorageRebindRootResult> = {}): StorageRebindRootResult => ({
    dir: null,
    refusedReason: null,
    roots: EMPTY_ROOTS,
    matched: [],
    unmatched: [],
    ...over
  })

  const api = {
    getSetting: vi.fn(async (_key: string): Promise<unknown> => null),
    setSetting: vi.fn(async () => undefined),
    storageGetMissingRoot: vi.fn(async () => EMPTY_ROOTS),
    storageRebindRoot: vi.fn(async () => rebindResult()),
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

  const clickOffer = async (wrapper: VueWrapper): Promise<void> => {
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes(OFFER))!
      .trigger('click')
    await flushPromises()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as unknown as { api: unknown }).api = apiProxy
    api.storageGetMissingRoot.mockResolvedValue(EMPTY_ROOTS)
    api.cleanupGetSnoozed.mockResolvedValue({})
    api.storageRebindRoot.mockResolvedValue(rebindResult())
  })

  it('offers the action while the effective root is away', async () => {
    const wrapper = await mountTab({
      downloadDir: '/gone',
      missingRoot: '/gone',
      effectiveRoot: '/gone',
      effectiveRootMissing: true,
      rebindOffered: true
    })

    expect(wrapper.text()).toContain(OFFER)
  })

  // The fresh-install regression (#455 review). `downloadDir` is unset, so the
  // resolver lands on `<Downloads>/anime-dl`, which nothing has created yet —
  // `effectiveRootMissing` is therefore true for a user who has downloaded
  // nothing. Main answers `rebindOffered: false` because there is no root-bound
  // work, and the row must follow that rather than the bare fact.
  it('does not offer it on a fresh install, where the root is merely uncreated', async () => {
    const wrapper = await mountTab({
      effectiveRoot: '/home/u/Downloads/anime-dl',
      effectiveRootMissing: true,
      rebindOffered: false
    })

    expect(wrapper.text()).not.toContain(OFFER)
  })

  // The case the review's own correction is about, and the one a `missingRoot`
  // comparison gets wrong: the stale root is `downloadDir`, the live work is
  // under the hot root, and nothing is stranded — so the notice stays and the
  // action does not appear.
  it('does not offer it when the missing root is not the effective one', async () => {
    const wrapper = await mountTab(
      {
        downloadDir: '/gone',
        hotStorageDir: '/hot',
        missingRoot: '/gone',
        effectiveRoot: '/hot',
        effectiveRootKey: 'hotStorageDir',
        effectiveRootMissing: false,
        rebindOffered: false
      },
      'advanced'
    )

    expect(wrapper.text()).toContain('Storage folder not found: /gone')
    expect(wrapper.text()).not.toContain(OFFER)
  })

  it('names the effective root key, which in advanced mode is hot storage', async () => {
    const wrapper = await mountTab(
      {
        hotStorageDir: '/gone',
        missingRoot: '/gone',
        effectiveRoot: '/gone',
        effectiveRootKey: 'hotStorageDir',
        effectiveRootMissing: true,
        rebindOffered: true
      },
      'advanced'
    )

    const row = wrapper
      .findAll('.set-row')
      .find((r) => r.text().includes(OFFER))!
      .text()
    expect(row).toContain('Hot storage')
  })

  // The same contract as #447's pickers: main validates and writes the key in
  // the handler that re-syncs the manager, so a `set-setting` echo would either
  // duplicate that write or perform the one main just refused.
  it('goes through storageRebindRoot and never through set-setting', async () => {
    const wrapper = await mountTab({
      downloadDir: '/gone',
      effectiveRoot: '/gone',
      effectiveRootMissing: true,
      rebindOffered: true
    })
    api.storageRebindRoot.mockResolvedValue(
      rebindResult({
        dir: '/new',
        roots: { ...EMPTY_ROOTS, downloadDir: '/new', effectiveRoot: '/new' },
        matched: [{ filename: 'Anime/Anime - 01 [X].mp4', reason: null }]
      })
    )

    await clickOffer(wrapper)

    expect(api.storageRebindRoot).toHaveBeenCalledTimes(1)
    expect(api.setSetting).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('/new')
    expect(wrapper.text()).toContain('found all 1 unfinished file(s)')
  })

  // The handler moves the root and nothing else, so a `paused` item is still
  // paused afterwards (#455 review). The outcome row therefore points at the
  // Downloads page instead of claiming the items resumed, which sent people
  // looking for downloads that were not running.
  it('tells the user to resume the matched files rather than saying they resumed', async () => {
    const wrapper = await mountTab({
      downloadDir: '/gone',
      effectiveRoot: '/gone',
      effectiveRootMissing: true,
      rebindOffered: true
    })
    api.storageRebindRoot.mockResolvedValue(
      rebindResult({
        dir: '/new',
        roots: { ...EMPTY_ROOTS, effectiveRoot: '/new' },
        matched: [
          { filename: 'Anime/Anime - 01 [X].mp4', reason: null },
          { filename: 'Anime/Anime - 02 [X].mp4', reason: null }
        ]
      })
    )

    await clickOffer(wrapper)

    expect(wrapper.text()).toContain('found all 2 unfinished file(s) there')
    expect(wrapper.text()).toContain('Resume them from the Downloads page')
    expect(wrapper.text()).not.toContain('resumed against them')
  })

  // An accepted move clears `rebindOffered` and takes the offer off screen with
  // it, so the confirmation has to live in its own row or it would never be
  // seen.
  it('still shows the outcome once the offer itself is gone', async () => {
    const wrapper = await mountTab({
      downloadDir: '/gone',
      effectiveRoot: '/gone',
      effectiveRootMissing: true,
      rebindOffered: true
    })
    api.storageRebindRoot.mockResolvedValue(
      rebindResult({ dir: '/new', roots: { ...EMPTY_ROOTS, effectiveRoot: '/new' } })
    )

    await clickOffer(wrapper)

    expect(wrapper.text()).not.toContain(OFFER)
    expect(wrapper.text()).toContain('Now using /new')
  })

  it('shows a refusal verbatim and adopts the unchanged roots', async () => {
    const wrapper = await mountTab({
      downloadDir: '/gone',
      missingRoot: '/gone',
      effectiveRoot: '/gone',
      effectiveRootMissing: true,
      rebindOffered: true
    })
    api.storageRebindRoot.mockResolvedValue(
      rebindResult({
        refusedReason: REFUSAL,
        roots: {
          ...EMPTY_ROOTS,
          downloadDir: '/gone',
          missingRoot: '/gone',
          effectiveRoot: '/gone',
          effectiveRootMissing: true,
          rebindOffered: true
        },
        unmatched: [{ filename: 'Anime/Anime - 02 [X].mp4', reason: 'its .part file is not there' }]
      })
    )

    await clickOffer(wrapper)

    expect(wrapper.text()).toContain(REFUSAL)
    // The offer is still there, because nothing was written and the root is
    // still away.
    expect(wrapper.text()).toContain(OFFER)
    expect(api.setSetting).not.toHaveBeenCalled()
  })
})
