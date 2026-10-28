// @vitest-environment happy-dom
//
// Library → Shared Libraries management (#581): each section header's
// availability dot, badge, Last seen and "Last sync: never", the empty S9/S10
// slots, the ⋯ menu's Forget with its N/M confirmation, the Settings → Storage
// table, and the found-on-a-drive toast's Open starting the identity flow.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SharedLibrariesTab from '../../src/renderer/src/components/shared-library/SharedLibrariesTab.vue'
import SharedLibrariesTable from '../../src/renderer/src/components/shared-library/SharedLibrariesTable.vue'
import ForgetLibraryDialog from '../../src/renderer/src/components/shared-library/ForgetLibraryDialog.vue'
import OpenLibraryDialog from '../../src/renderer/src/components/shared-library/OpenLibraryDialog.vue'
import {
  forgetConfirmText,
  foundText,
  useSharedLibrariesStore
} from '../../src/renderer/src/stores/shared-libraries'

function lib(libraryId: string, over: Partial<AttachedLibraryInfo> = {}): AttachedLibraryInfo {
  return {
    libraryId,
    root: `/media/u/${libraryId}`,
    name: `Library ${libraryId}`,
    mode: 'metadata',
    ownerNickname: 'owner',
    role: 'owner',
    access: 'read-write',
    available: true,
    lastSeenAt: Date.now() - 3 * 3_600_000,
    lastSyncAt: null,
    pathOverflow: 0,
    mkvCount: 0,
    titles: [],
    ...over
  }
}

let list: AttachedLibraryInfo[]
let foundCb: ((f: SharedLibraryFound) => void) | null

function stubApi(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      sharedLibraryList: vi.fn().mockImplementation(async () => list),
      ffmpegCheck: vi.fn().mockResolvedValue({ available: true }),
      onSharedLibraryFound: (cb: (f: SharedLibraryFound) => void) => {
        foundCb = cb
        return () => {}
      },
      ...overrides
    },
    {
      get: (target, prop, recv) =>
        prop in target ? Reflect.get(target, prop, recv) : () => () => {}
    }
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
  list = []
  foundCb = null
})

describe('the management row', () => {
  it('renders availability dots, badges, Last seen only while unavailable, and Last sync: never', async () => {
    list = [
      lib('a', { role: 'owner' }),
      lib('b', { role: 'claim', available: false }),
      lib('c', { role: 'videos', mode: 'videos', ownerNickname: null, access: 'read-only' }),
      lib('d', { role: 'foreign' })
    ]
    stubApi()
    const w = mount(SharedLibrariesTab, { props: { starredIds: new Set<number>() } })
    await flushPromises()
    const sections = w.findAll('[data-testid="shared-library-section"]')
    expect(sections).toHaveLength(4)
    const dots = w.findAll('[data-testid="availability-dot"]')
    expect(dots.map((d) => d.attributes('data-available'))).toEqual([
      'true',
      'false',
      'true',
      'true'
    ])
    expect(dots[1].classes()).toContain('off')
    expect(w.findAll('[data-testid="role-badge"]').map((b) => b.text())).toEqual([
      'Owner',
      'Claimed',
      'Videos only',
      'Videos only'
    ])
    expect(sections[2].find('[data-testid="read-only-badge"]').exists()).toBe(true)
    expect(sections[0].find('[data-testid="read-only-badge"]').exists()).toBe(false)
    const seen = w.findAll('[data-testid="last-seen"]')
    expect(seen).toHaveLength(1)
    expect(sections[1].find('[data-testid="last-seen"]').text()).toBe('Last seen 3 h ago')
    expect(w.findAll('[data-testid="last-sync"]').map((s) => s.text())).toEqual(
      Array(4).fill('Last sync: never')
    )
  })

  it('the Sync now, history, status and conflict slots render nothing until filled', async () => {
    list = [lib('a')]
    stubApi()
    const w = mount(SharedLibrariesTab, { props: { starredIds: new Set<number>() } })
    await flushPromises()
    for (const slot of [
      'slot-sync-now',
      'slot-sync-history',
      'slot-sync-status',
      'slot-conflicts'
    ]) {
      const el = w.find(`[data-testid="${slot}"]`)
      expect(el.exists()).toBe(true)
      expect(el.element.childNodes).toHaveLength(0)
    }
    expect(w.text()).not.toMatch(/Sync now|Sync history/)
  })

  it('the ⋯ menu holds Open folder, Re-locate… and Forget; Forget opens the confirmation', async () => {
    list = [lib('a')]
    const fileOpen = vi.fn().mockResolvedValue('')
    stubApi({ fileOpen })
    const w = mount(SharedLibrariesTab, {
      props: { starredIds: new Set<number>() },
      attachTo: document.body
    })
    await flushPromises()
    await w.find('[data-testid="library-menu"]').trigger('click')
    expect(w.findAll('[role="menuitem"]').map((b) => b.text())).toEqual([
      'Open folder',
      'Re-locate…',
      'Forget'
    ])
    await w.find('[data-testid="menu-open-folder"]').trigger('click')
    expect(fileOpen).toHaveBeenCalledWith('/media/u/a')
    await w.find('[data-testid="library-menu"]').trigger('click')
    await w.find('[data-testid="menu-forget"]').trigger('click')
    expect(w.find('[data-testid="forget-text"]').text()).toBe(
      "Forget Library a? The drive isn't changed."
    )
    w.unmount()
  })

  it('Settings → Storage lists the same libraries with the same actions', async () => {
    list = [lib('a'), lib('b', { available: false, access: 'read-only' })]
    stubApi()
    const store = useSharedLibrariesStore()
    await store.refresh()
    const w = mount(SharedLibrariesTable)
    await flushPromises()
    const rows = w.findAll('[data-testid="shared-library-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('/media/u/a')
    expect(rows[0].text()).toContain('Connected')
    expect(rows[1].text()).toContain('Read-only')
    expect(rows[1].text()).toContain('3 h ago')
    expect(rows[1].text()).toContain('never')
    expect(w.findAll('[data-testid="library-menu"]')).toHaveLength(2)
  })
})

describe('the Forget confirmation', () => {
  it('N = 3, M = 1', () => {
    expect(forgetConfirmText('Trip', { libraryChanges: 3, resolutions: 1 })).toBe(
      "Forget Trip? 3 changes from this library and 1 review-screen choice for it will be discarded. Your watch state on this PC isn't changed, and the drive isn't changed."
    )
  })

  it('N = 0, M = 2: only the review-screen part', () => {
    expect(forgetConfirmText('Trip', { libraryChanges: 0, resolutions: 2 })).toBe(
      "Forget Trip? 2 review-screen choices for it will be discarded. Your watch state on this PC isn't changed, and the drive isn't changed."
    )
  })

  it('N = 1, M = 0: only the changes part', () => {
    expect(forgetConfirmText('Trip', { libraryChanges: 1, resolutions: 0 })).toBe(
      "Forget Trip? 1 change from this library will be discarded. Your watch state on this PC isn't changed, and the drive isn't changed."
    )
  })

  it('N = 0, M = 0: no warning, just the plain confirmation', () => {
    expect(forgetConfirmText('Trip', { libraryChanges: 0, resolutions: 0 })).toBe(
      "Forget Trip? The drive isn't changed."
    )
  })

  it('the dialog: plain first; main answers needsConfirm, the warning shows, the second Forget confirms', async () => {
    const forget = vi
      .fn()
      .mockResolvedValueOnce({
        needsConfirm: true,
        pendingCount: { libraryChanges: 3, resolutions: 1 }
      })
      .mockResolvedValueOnce({ needsConfirm: false })
    stubApi({ sharedLibraryForget: forget })
    const w = mount(ForgetLibraryDialog, { props: { library: { libraryId: 'x', name: 'Trip' } } })
    expect(w.find('[data-testid="forget-text"]').text()).toBe(
      "Forget Trip? The drive isn't changed."
    )
    expect(w.findAll('button').map((b) => b.text())).toEqual(['Cancel', 'Forget'])
    await w.find('[data-testid="forget-confirm"]').trigger('click')
    await flushPromises()
    expect(forget).toHaveBeenLastCalledWith('x', undefined)
    expect(w.find('[data-testid="forget-text"]').text()).toContain(
      '3 changes from this library and 1 review-screen choice for it will be discarded'
    )
    expect(w.emitted('forgotten')).toBeUndefined()
    await w.find('[data-testid="forget-confirm"]').trigger('click')
    await flushPromises()
    expect(forget).toHaveBeenLastCalledWith('x', { confirmDropPending: true })
    expect(w.emitted('forgotten')).toEqual([['x']])
  })
})

describe('the found-on-a-drive toast', () => {
  const found: SharedLibraryFound = {
    volume: 'KINGSTON',
    dir: '/media/u/KINGSTON',
    candidates: [
      {
        root: '/media/u/KINGSTON/Anime',
        libraryId: 'aaaaaaaa-0000-4000-8000-000000000001',
        name: 'Anime',
        ownerNickname: 'friend',
        mode: 'metadata',
        titleCount: 3,
        identity: 'choose'
      }
    ]
  }

  it('reads "Shared Library \'<name>\' (<nickname>) found on <volume>"', () => {
    expect(foundText(found)).toBe("Shared Library 'Anime' (friend) found on KINGSTON")
  })

  it('the event queues a toast; Open hands its libraries to the open flow without a picker, which starts the identity check', async () => {
    const pick = vi.fn()
    const attach = vi.fn().mockResolvedValue({ ok: true, library: lib('x') })
    stubApi({ sharedLibraryPickAndDiscover: pick, sharedLibraryAttach: attach })
    const store = useSharedLibrariesStore()
    foundCb!(found)
    expect(store.found).toEqual([found])
    store.openFound(store.found[0])
    expect(store.found).toEqual([])
    expect(store.openingFound).toEqual(found)

    const w = mount(OpenLibraryDialog, { props: { found: store.openingFound } })
    await flushPromises()
    expect(pick).not.toHaveBeenCalled()
    expect(w.find('[data-testid="identity-warning"]').exists()).toBe(true)
    await w.find('[data-testid="use-videos"]').trigger('click')
    await flushPromises()
    expect(attach).toHaveBeenCalledWith('aaaaaaaa-0000-4000-8000-000000000001', 'videos')
  })

  it('"Don\'t ask for this drive" remembers the libraryIds; a library attached meanwhile drops out', async () => {
    const dismiss = vi.fn().mockResolvedValue(undefined)
    stubApi({ sharedLibraryDismissPrompt: dismiss })
    const store = useSharedLibrariesStore()
    foundCb!(found)
    await store.dontAskFound(store.found[0])
    expect(dismiss).toHaveBeenCalledWith(['aaaaaaaa-0000-4000-8000-000000000001'])
    expect(store.found).toEqual([])

    foundCb!(found)
    list = [lib('aaaaaaaa-0000-4000-8000-000000000001')]
    await store.refresh()
    expect(store.found).toEqual([])
  })
})
