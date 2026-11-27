// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Sidebar from '../../../src/renderer/src/components/shared/Sidebar.vue'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'
import { useShikimoriStore } from '../../../src/renderer/src/stores/shikimori'
import { useSettingsStore } from '../../../src/renderer/src/stores/settings'

// The chip reads `useTrackersStore` (#699): the primary account's user, and
// `aggregateSyncState` across every connected tracker.

const SHIKI_USER: TrackerUser = { id: 1, nickname: 'mikkerlo', avatar: 'https://shiki/a.png' }
const ANILIST_USER: TrackerUser = { id: 7, nickname: 'ani-fan', avatar: 'https://anilist/b.png' }

function account(trackerId: TrackerId, user: TrackerUser | null): TrackerAccount {
  return {
    trackerId,
    user,
    hasCredentials: user !== null,
    sessionExpired: false,
    needsSetup: false,
    credentialState: user ? 'ok' : 'none'
  }
}

function accountsState(
  connected: Partial<Record<TrackerId, TrackerUser>>,
  primary: TrackerId | null
): TrackerAccountsState {
  return {
    accounts: (['shikimori', 'anilist', 'mal'] as TrackerId[]).map((id) =>
      account(id, connected[id] ?? null)
    ),
    primary,
    mirror: {},
    featureSources: {}
  }
}

function status(over: Partial<TrackerSyncStatus> = {}): TrackerSyncStatus {
  return {
    state: 'idle',
    queueLength: 0,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired: false,
    needsSetup: false,
    ...over
  }
}

type Handler<T> = (payload: T) => void

interface Rig {
  emitSyncStatus: (trackerId: TrackerId, s: TrackerSyncStatus) => void
  emitQueue: (trackerId: TrackerId, length: number) => void
  emitAccounts: (next: TrackerAccountsState) => void
}

let rig: Rig
let wrapper: VueWrapper | null = null

function stubApi(
  initial: TrackerAccountsState,
  syncByTracker: Partial<Record<TrackerId, TrackerSyncStatus>> = {}
): void {
  const syncHandlers: Handler<TrackerSyncStatusEvent>[] = []
  const queueHandlers: Handler<TrackerOfflineQueueChangedEvent>[] = []
  const accountHandlers: Handler<TrackerAccountsState>[] = []
  const sub =
    <T>(list: Handler<T>[]) =>
    (cb: Handler<T>) => {
      list.push(cb)
      return () => {}
    }
  // The downloads + shikimori stores subscribe to `window.api.on*` at setup.
  // A permissive stub returns a no-op unsubscribe handle for any other access.
  // The getters the stores await are explicit, so their replies are real
  // payloads, not the fallback's function.
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      shikimoriGetSyncStatus: async () => ({
        state: 'idle',
        queueLength: 0,
        lastSyncAt: 0,
        lastSyncError: null,
        sessionExpired: false
      }),
      trackerListAccounts: async () => initial,
      trackerGetSyncStatus: async (id: TrackerId) => syncByTracker[id] ?? status(),
      trackerGetRates: async (id: TrackerId) => ({ trackerId: id, entries: [], queuedAfter: {} }),
      onTrackerSyncStatus: sub(syncHandlers),
      onTrackerOfflineQueueChanged: sub(queueHandlers),
      onTrackerAccountsChanged: sub(accountHandlers)
    } as Record<string, unknown>,
    {
      get: (target, prop) => target[prop as string] ?? (() => () => {})
    }
  )
  rig = {
    emitSyncStatus: (trackerId, s) => syncHandlers.forEach((h) => h({ trackerId, status: s })),
    emitQueue: (trackerId, length) =>
      queueHandlers.forEach((h) => h({ trackerId, length, queuedAfter: {} })),
    emitAccounts: (next) => accountHandlers.forEach((h) => h(next))
  }
}

async function mountSidebar(): Promise<VueWrapper> {
  wrapper = mount(Sidebar, { attachTo: document.body })
  // The trackers store's accounts pull, then each connected tracker's load.
  await flushPromises()
  return wrapper
}

const popover = (w: VueWrapper) => w.find('[data-testid="sync-popover"]')

beforeEach(() => {
  stubApi(accountsState({}, null))
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('Sidebar', () => {
  it('marks the nav item for the current view as active and tracks changes', async () => {
    const library = useLibraryStore()
    library.navigate('home')

    const w = await mountSidebar()

    const activeLabel = () => w.find('.nav-item.active span').text()
    expect(w.findAll('.nav-item.active')).toHaveLength(1)
    expect(activeLabel()).toBe('Home')

    library.navigate('library')
    await w.vm.$nextTick()
    expect(w.findAll('.nav-item.active')).toHaveLength(1)
    expect(activeLabel()).toBe('Library')
  })

  it('hides the Shikimori nav group and user chip until logged in', async () => {
    const shiki = useShikimoriStore()
    const w = await mountSidebar()
    expect(w.find('.nav-label').exists()).toBe(false)
    expect(w.find('.user-chip').exists()).toBe(false)

    // The nav group is still the Shikimori login's (#707); the chip is the
    // trackers store's.
    shiki.user = { id: 1, nickname: 'mikkerlo', avatar: '' }
    rig.emitAccounts(accountsState({ shikimori: SHIKI_USER }, 'shikimori'))
    await flushPromises()
    expect(w.find('.nav-label').text()).toBe('Shikimori')
    expect(w.find('.user-chip').exists()).toBe(true)
  })

  describe('one tracker: the chip as it always was, no popover', () => {
    it('reflects the real Shikimori sync state in the footer chip', async () => {
      stubApi(accountsState({ shikimori: SHIKI_USER }, 'shikimori'))
      const w = await mountSidebar()

      expect(w.find('.u-name').text()).toBe('mikkerlo')
      expect(w.find('img.user-avatar').attributes('src')).toBe('https://shiki/a.png')
      // Empty offline queue → green "Synced", a status line and not a button.
      expect(w.find('.u-sync').text()).toBe('Synced')
      expect(w.find('.u-sync').element.tagName).toBe('DIV')
      expect(w.find('.u-sync').classes()).not.toContain('offline')

      // Pending offline changes must NOT read "Synced" (the reviewed nit).
      rig.emitQueue('shikimori', 2)
      await w.vm.$nextTick()
      expect(w.find('.u-sync').classes()).toContain('offline')
      expect(w.find('.u-sync').text()).toBe('2 pending')

      rig.emitSyncStatus('shikimori', status({ state: 'syncing', queueLength: 2 }))
      await w.vm.$nextTick()
      expect(w.find('.u-sync').text()).toBe('Syncing…')

      await w.find('.u-sync').trigger('click')
      await w.find('.user-chip').trigger('click')
      expect(popover(w).exists()).toBe(false)
    })

    it('surfaces an expired session on the chip even with an empty queue', async () => {
      // Gated on `sessionExpired` alone: the drain returns immediately on an
      // empty queue, so an expired user with nothing pending would otherwise
      // see a green "Synced" and no indication anywhere (#244).
      stubApi(accountsState({ shikimori: SHIKI_USER }, 'shikimori'))
      const library = useLibraryStore()
      const w = await mountSidebar()

      rig.emitSyncStatus('shikimori', status({ sessionExpired: true }))
      await w.vm.$nextTick()

      const chip = w.find('.u-sync')
      expect(chip.classes()).toContain('expired')
      expect(chip.text()).toBe('Session expired')
      expect(chip.attributes('title')).toBe('Shikimori rejected the stored session — sign in again')

      await chip.trigger('click')
      expect(popover(w).exists()).toBe(false)
      expect(library.currentView).toBe('settings')
      expect(library.pendingSettingsTab).toBe('connectors')
    })

    it('without Shikimori: the AniList account fills the chip with its own state', async () => {
      stubApi(accountsState({ anilist: ANILIST_USER }, 'anilist'), {
        anilist: status({ queueLength: 1 })
      })
      const w = await mountSidebar()

      expect(w.find('.nav-label').exists()).toBe(false)
      expect(w.find('.u-name').text()).toBe('ani-fan')
      expect(w.find('img.user-avatar').attributes('src')).toBe('https://anilist/b.png')
      expect(w.find('.u-sync').text()).toBe('1 pending')
      expect(w.find('.u-sync').classes()).toContain('offline')

      rig.emitSyncStatus('anilist', status({ sessionExpired: true }))
      await w.vm.$nextTick()
      expect(w.find('.u-sync').text()).toBe('Session expired')
      expect(w.find('.u-sync').attributes('title')).toBe(
        'AniList rejected the stored session — sign in again'
      )
      await w.find('.u-sync').trigger('click')
      expect(popover(w).exists()).toBe(false)
    })

    it('falls back to the initial when the primary has no avatar', async () => {
      stubApi(accountsState({ anilist: { ...ANILIST_USER, avatar: null } }, 'anilist'))
      const w = await mountSidebar()
      expect(w.find('img.user-avatar').exists()).toBe(false)
      expect(w.find('div.user-avatar').text()).toBe('A')
    })

    // #731 review: a lone tracker in "Needs setup" (MAL with no client ID)
    // gets the same Settings deep link the expired chip has.
    it('a lone tracker in "Needs setup" is a button that deep-links to Settings', async () => {
      stubApi(accountsState({ mal: { id: 3, nickname: 'mal-me', avatar: null } }, 'mal'), {
        mal: status({ needsSetup: true })
      })
      const library = useLibraryStore()
      library.navigate('home')
      const w = await mountSidebar()

      const chip = w.find('.user-meta .u-sync')
      expect(chip.text()).toBe('Needs setup')
      expect(chip.element.tagName).toBe('BUTTON')
      expect(chip.classes()).toContain('offline')
      expect(chip.attributes('title')).toBe('MyAnimeList needs setup — open Settings')

      await chip.trigger('click')
      expect(popover(w).exists()).toBe(false)
      expect(library.currentView).toBe('settings')
      expect(library.pendingSettingsTab).toBe('connectors')
    })
  })

  describe('two trackers: the worst state, and a popover per tracker', () => {
    it('reads the worst state and lists each tracker with its own state', async () => {
      stubApi(accountsState({ shikimori: SHIKI_USER, anilist: ANILIST_USER }, 'shikimori'), {
        shikimori: status({ queueLength: 3 }),
        anilist: status({ sessionExpired: true })
      })
      const w = await mountSidebar()

      // The primary's account on the chip.
      expect(w.find('.u-name').text()).toBe('mikkerlo')
      const chip = w.find('.user-meta .u-sync')
      expect(chip.text()).toBe('Session expired')
      expect(chip.classes()).toContain('expired')
      expect(popover(w).exists()).toBe(false)

      await chip.trigger('click')
      const rows = popover(w).findAll('.sync-row')
      expect(rows.map((r) => r.attributes('data-tracker'))).toEqual(['shikimori', 'anilist'])
      expect(rows[0].find('.sync-row-name').text()).toBe('Shikimori')
      expect(rows[0].find('.u-sync').text()).toBe('3 pending')
      expect(rows[0].find('button').exists()).toBe(false)
      expect(rows[1].find('.sync-row-name').text()).toBe('AniList')
      expect(rows[1].find('.u-sync').text()).toBe('Session expired')
      expect(rows[1].find('button.sync-row-link').attributes('title')).toBe(
        'AniList rejected the stored session — sign in again'
      )
    })

    it('sums the pending counts when no tracker is expired', async () => {
      stubApi(accountsState({ shikimori: SHIKI_USER, anilist: ANILIST_USER }, 'anilist'), {
        shikimori: status({ queueLength: 3 }),
        anilist: status({ queueLength: 2 })
      })
      const w = await mountSidebar()

      expect(w.find('.u-name').text()).toBe('ani-fan')
      expect(w.find('.user-meta .u-sync').text()).toBe('5 pending')
      expect(w.find('.user-meta .u-sync').classes()).toContain('offline')

      await w.find('.user-meta .u-sync').trigger('click')
      const labels = popover(w)
        .findAll('.sync-row .u-sync')
        .map((r) => r.text())
      expect(labels).toEqual(['3 pending', '2 pending'])
    })

    it('an overall "Session expired" opens the popover; the row deep-links; Esc returns focus', async () => {
      stubApi(accountsState({ shikimori: SHIKI_USER, anilist: ANILIST_USER }, 'shikimori'), {
        anilist: status({ sessionExpired: true, queueLength: 2 })
      })
      const library = useLibraryStore()
      library.navigate('home')
      const w = await mountSidebar()

      const chip = w.find('.user-meta .u-sync')
      expect(chip.text()).toBe('Session expired')
      await chip.trigger('click')

      // The click opened the breakdown and parked no Settings tab.
      expect(popover(w).exists()).toBe(true)
      expect(chip.attributes('aria-expanded')).toBe('true')
      expect(library.currentView).toBe('home')
      expect(library.pendingSettingsTab).toBeNull()
      // An expired row with a queue shows its pending count beside its state.
      const anilistRow = popover(w).find('[data-tracker="anilist"]')
      expect(anilistRow.find('.sync-row-pending').text()).toBe('2 pending')

      // Esc closes, and focus returns to the chip.
      ;(w.find('.nav-item').element as HTMLElement).focus()
      expect(document.activeElement).not.toBe(chip.element)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await flushPromises()
      expect(popover(w).exists()).toBe(false)
      expect(document.activeElement).toBe(chip.element)

      // An outside click closes it too.
      await chip.trigger('click')
      expect(popover(w).exists()).toBe(true)
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      await flushPromises()
      expect(popover(w).exists()).toBe(false)

      // The expired row's button is the deep link.
      await chip.trigger('click')
      const link = popover(w).find('[data-tracker="anilist"] button.sync-row-link')
      expect(link.element.tagName).toBe('BUTTON')
      await link.trigger('click')
      expect(library.currentView).toBe('settings')
      expect(library.pendingSettingsTab).toBe('connectors')
      expect(popover(w).exists()).toBe(false)
    })

    it('a "Needs setup" row links to Settings too', async () => {
      stubApi(
        accountsState(
          { shikimori: SHIKI_USER, mal: { id: 3, nickname: 'm', avatar: null } },
          'shikimori'
        ),
        {
          mal: status({ needsSetup: true })
        }
      )
      const w = await mountSidebar()
      expect(w.find('.user-meta .u-sync').text()).toBe('Needs setup')
      await w.find('.user-meta .u-sync').trigger('click')
      const mal = popover(w).find('[data-tracker="mal"]')
      expect(mal.find('.sync-row-name').text()).toBe('MyAnimeList')
      expect(mal.find('.u-sync').text()).toBe('Needs setup')
      expect(mal.find('button.sync-row-link').exists()).toBe(true)
    })

    it('a tracker disconnecting back to one closes the popover and restores the plain chip', async () => {
      stubApi(accountsState({ shikimori: SHIKI_USER, anilist: ANILIST_USER }, 'shikimori'))
      const w = await mountSidebar()
      await w.find('.user-meta .u-sync').trigger('click')
      expect(popover(w).exists()).toBe(true)

      rig.emitAccounts(accountsState({ shikimori: SHIKI_USER }, 'shikimori'))
      await flushPromises()
      expect(popover(w).exists()).toBe(false)
      expect(w.find('.user-meta .u-sync').element.tagName).toBe('DIV')
    })
  })

  it('shows the update banner even when logged out (it is not gated on login)', async () => {
    // Updates are app-level, not tied to a tracker — a logged-out user with no
    // `.user-chip` footer must still see the banner pinned at the bottom.
    const settings = useSettingsStore()
    settings.updateStatus = { status: 'available', version: '4.1.12' }

    const w = await mountSidebar()
    expect(w.find('.user-chip').exists()).toBe(false)
    expect(w.find('.update-banner').exists()).toBe(true)
  })
})
