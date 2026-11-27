// @vitest-environment happy-dom
// Settings → Trackers with two or more accounts (#701): the primary radio and
// badge, the primary choice after a disconnect, the mirror toggles and their
// confirm, the feature-source dropdowns, and the second-tracker flag hiding
// Connect. The fake plays main's side of all three trackers: each setter and
// logout announces `tracker:accounts-changed` before its reply, as main does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TrackersTab from '../../../src/renderer/src/components/settings/TrackersTab.vue'
import { useTrackersStore } from '../../../src/renderer/src/stores/trackers'

enableAutoUnmount(afterEach)

type Listener<T> = (data: T) => void
const IDS: TrackerId[] = ['shikimori', 'anilist', 'mal']

interface FakeMain {
  users: Partial<Record<TrackerId, TrackerUser>>
  expired: Partial<Record<TrackerId, boolean>>
  queue: Partial<Record<TrackerId, number>>
  /** The stored `trackerPrimary`; resolved as main's `resolvePrimary` does. */
  storedPrimary: TrackerId | null
  mirror: Partial<Record<TrackerId, boolean>>
  featureSources: Partial<Record<TrackerFeature, TrackerId>>
  secondTrackerEnabled: boolean
  primaryCapable: TrackerId[]
}

const user = (id: TrackerId): TrackerUser => ({
  id: IDS.indexOf(id) + 1,
  nickname: `${id}-user`,
  avatar: null
})

function createMultiApi() {
  const main: FakeMain = {
    users: {},
    expired: {},
    queue: {},
    storedPrimary: null,
    mirror: {},
    featureSources: {},
    secondTrackerEnabled: true,
    // Main today: all three trackers' primary writers are registered.
    primaryCapable: ['shikimori', 'anilist', 'mal']
  }
  const accountsChanged: Listener<TrackerAccountsState>[] = []

  const resolvedPrimary = (): TrackerId | null => {
    if (main.storedPrimary && main.users[main.storedPrimary]) return main.storedPrimary
    return IDS.find((id) => main.users[id]) ?? null
  }

  function accountsState(): TrackerAccountsState {
    return {
      accounts: IDS.map((id): TrackerAccount => {
        const u = main.users[id] ?? null
        const expired = main.expired[id] === true
        return {
          trackerId: id,
          user: u,
          hasCredentials: u !== null && !expired,
          sessionExpired: u !== null && expired,
          needsSetup: false,
          credentialState: u !== null && !expired ? 'ok' : 'none'
        }
      }),
      primary: resolvedPrimary(),
      mirror: { ...main.mirror },
      featureSources: { ...main.featureSources },
      newTrackerCardsEnabled: true,
      secondTrackerEnabled: main.secondTrackerEnabled,
      primaryCapable: [...main.primaryCapable]
    }
  }

  function announce(): void {
    const next = accountsState()
    for (const cb of [...accountsChanged]) cb(next)
  }

  const status = (id: TrackerId): TrackerSyncStatus => ({
    state: 'idle',
    queueLength: main.queue[id] ?? 0,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired: main.expired[id] === true,
    needsSetup: false
  })

  const api = {
    getSetting: vi.fn(async () => ''),
    setSetting: vi.fn(async () => undefined),
    trackerListAccounts: vi.fn(async () => accountsState()),
    onTrackerAccountsChanged: vi.fn((cb: Listener<TrackerAccountsState>) => {
      accountsChanged.push(cb)
      return () => void accountsChanged.splice(accountsChanged.indexOf(cb), 1)
    }),
    trackerGetSyncStatus: vi.fn(async (id: TrackerId) => status(id)),
    trackerGetRates: vi.fn(async (id: TrackerId) => ({
      trackerId: id,
      entries: [],
      queuedAfter: {}
    })),
    shikimoriGetUser: vi.fn(async () => main.users.shikimori ?? null),
    trackerGetParkedQueues: vi.fn(async (): Promise<TrackerParkedQueueSummary[]> => []),
    trackerLogout: vi.fn(
      async (id: TrackerId, _opts?: TrackerLogoutOptions): Promise<TrackerLogoutResult> => {
        const wasPrimary = resolvedPrimary() === id
        delete main.users[id]
        main.queue[id] = 0
        const remaining = IDS.filter((t) => main.users[t])
        // #696 § 4: the first remaining tracker becomes primary at once.
        if (wasPrimary) main.storedPrimary = remaining[0] ?? null
        announce()
        return wasPrimary && remaining.length >= 2
          ? { needsPrimaryChoice: { candidates: remaining } }
          : {}
      }
    ),
    trackerSetPrimary: vi.fn(async (id: TrackerId) => {
      main.storedPrimary = id
      announce()
      return accountsState()
    }),
    trackerSetMirror: vi.fn(
      async (
        id: TrackerId,
        enabled: boolean,
        opts?: TrackerSetMirrorOptions
      ): Promise<TrackerSetMirrorResult> => {
        const on = main.mirror[id] !== false
        if (on === enabled) return { applied: false }
        if (enabled) {
          main.mirror[id] = true
          announce()
          return { applied: true, offerReconcile: true }
        }
        if (!opts?.confirm) return { applied: false, pendingMirrorChanges: 3 }
        main.mirror[id] = false
        announce()
        return { applied: true, discarded: 3 }
      }
    ),
    trackerSetFeatureSource: vi.fn(async (feature: TrackerFeature, id: TrackerId | null) => {
      if (id === null) delete main.featureSources[feature]
      else main.featureSources[feature] = id
      announce()
      return accountsState()
    }),
    shikimoriGetAuthUrl: vi.fn(async () => 'https://shikimori.io/oauth/authorize?x=1'),
    trackerBeginAuth: vi.fn(async (): Promise<TrackerAuthResult> => ({ status: 'cancelled' })),
    trackerCompleteAuth: vi.fn(async (): Promise<TrackerAuthResult> => ({ status: 'cancelled' }))
  }

  const proxy = new Proxy(api as unknown as Record<string, unknown>, {
    get: (target, prop) => (prop in target ? target[prop as string] : () => () => {})
  })

  return {
    main,
    api,
    announce,
    install(): void {
      ;(window as unknown as { api: unknown }).api = proxy
    }
  }
}

let fake = createMultiApi()

function connect(...ids: TrackerId[]): void {
  for (const id of ids) fake.main.users[id] = user(id)
}

beforeEach(() => {
  vi.clearAllMocks()
  fake = createMultiApi()
  fake.install()
  setActivePinia(createPinia())
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

async function mountTab(): Promise<VueWrapper> {
  const wrapper = mount(TrackersTab, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

const card = (w: VueWrapper, id: TrackerId) => w.find(`[data-tracker-id="${id}"]`)
const radioOf = (w: VueWrapper, id: TrackerId) => card(w, id).find('input[name="tracker-primary"]')
const switchOf = (w: VueWrapper, id: TrackerId) => card(w, id).find('.mirror-row .switch')
const badgeOn = (w: VueWrapper): string[] =>
  IDS.filter((id) => card(w, id).exists() && card(w, id).find('.primary-badge').exists())
const pendingDialog = (w: VueWrapper) => w.find('.pending-modal')
const primaryDialog = (w: VueWrapper) => w.find('.tracker-primary-dialog')
const featureRow = (w: VueWrapper, f: TrackerFeature) => w.find(`[data-feature="${f}"]`)
const optionsOf = (w: VueWrapper, f: TrackerFeature): string[] =>
  featureRow(w, f)
    .findAll('option')
    .map((o) => o.text())

describe('only with two or more connected accounts', () => {
  it.each([[[] as TrackerId[]], [['shikimori'] as TrackerId[]], [['anilist'] as TrackerId[]]])(
    'with %j connected: no radio, badge, mirror toggle or Feature sources group',
    async (ids) => {
      connect(...ids)
      const w = await mountTab()
      expect(w.find('input[name="tracker-primary"]').exists()).toBe(false)
      expect(w.find('.primary-badge').exists()).toBe(false)
      expect(w.find('.switch').exists()).toBe(false)
      expect(w.find('.feature-sources').exists()).toBe(false)
      expect(w.find('select').exists()).toBe(false)
    }
  )

  it('with two: the radios, the badge on the primary, the mirror toggle on the other, and Feature sources', async () => {
    connect('shikimori', 'anilist')
    const w = await mountTab()
    expect(radioOf(w, 'shikimori').exists()).toBe(true)
    expect(radioOf(w, 'anilist').exists()).toBe(true)
    expect(badgeOn(w)).toEqual(['shikimori'])
    expect(switchOf(w, 'shikimori').exists()).toBe(false)
    expect(switchOf(w, 'anilist').exists()).toBe(true)
    expect(switchOf(w, 'anilist').classes()).toContain('on')
    expect(w.find('.feature-sources').exists()).toBe(true)
  })

  it('an expired second account still counts as connected', async () => {
    connect('shikimori', 'anilist')
    fake.main.expired.anilist = true
    const w = await mountTab()
    expect(switchOf(w, 'anilist').exists()).toBe(true)
    expect(w.find('.feature-sources').exists()).toBe(true)
  })
})

describe('switching the primary', () => {
  it("clicking AniList's radio calls trackerSetPrimary once, never setSetting, and the badge follows the broadcast", async () => {
    connect('shikimori', 'anilist')
    const w = await mountTab()
    expect(badgeOn(w)).toEqual(['shikimori'])

    await radioOf(w, 'anilist').setValue(true)
    await flushPromises()

    expect(fake.api.trackerSetPrimary).toHaveBeenCalledTimes(1)
    expect(fake.api.trackerSetPrimary).toHaveBeenCalledWith('anilist')
    expect(fake.api.setSetting).not.toHaveBeenCalled()
    expect(badgeOn(w)).toEqual(['anilist'])
    expect(switchOf(w, 'shikimori').exists()).toBe(true)
    expect(switchOf(w, 'anilist').exists()).toBe(false)
  })

  it('the badge moves on a broadcast alone, with no setter call', async () => {
    connect('shikimori', 'anilist')
    const w = await mountTab()
    fake.main.storedPrimary = 'anilist'
    fake.announce()
    await flushPromises()
    expect(badgeOn(w)).toEqual(['anilist'])
  })
})

describe('the picker offers only trackers with a primary write path', () => {
  it('main today registers a MyAnimeList writer (#702): its card offers the radio, and picking it sets MAL primary', async () => {
    connect('shikimori', 'mal')
    const w = await mountTab()
    expect(radioOf(w, 'mal').exists()).toBe(true)
    await radioOf(w, 'mal').setValue(true)
    await flushPromises()
    expect(fake.api.trackerSetPrimary).toHaveBeenCalledWith('mal')
    expect(badgeOn(w)).toEqual(['mal'])
  })

  it('a tracker with no registered writer gets no radio, and gets it once one is registered', async () => {
    connect('shikimori', 'mal')
    fake.main.primaryCapable = ['shikimori', 'anilist']
    const w = await mountTab()
    expect(switchOf(w, 'mal').exists()).toBe(true)
    expect(radioOf(w, 'mal').exists()).toBe(false)
    expect(radioOf(w, 'shikimori').exists()).toBe(true)

    fake.main.primaryCapable = ['shikimori', 'anilist', 'mal']
    fake.announce()
    await flushPromises()
    expect(radioOf(w, 'mal').exists()).toBe(true)
  })

  it('a primary disconnect leaving AniList and MyAnimeList, with no MAL writer: no dialog offers MAL', async () => {
    connect('shikimori', 'anilist', 'mal')
    fake.main.primaryCapable = ['shikimori', 'anilist']
    const w = await mountTab()
    await card(w, 'shikimori')
      .findAll('button')
      .find((b) => b.text() === 'Disconnect')!
      .trigger('click')
    await flushPromises()
    expect(fake.api.trackerLogout).toHaveBeenCalledTimes(1)
    expect(primaryDialog(w).exists()).toBe(false)
    expect(badgeOn(w)).toEqual(['anilist'])
  })
})

describe('disconnecting the primary', () => {
  const disconnect = async (w: VueWrapper, id: TrackerId): Promise<void> => {
    await card(w, id)
      .findAll('button')
      .find((b) => b.text() === 'Disconnect')!
      .trigger('click')
    await flushPromises()
  }

  it('three accounts: the dialog lists the two remaining, the interim pre-selected; Confirm on the other sets it', async () => {
    connect('shikimori', 'anilist', 'mal')
    const w = await mountTab()
    await disconnect(w, 'shikimori')

    const dialog = primaryDialog(w)
    expect(dialog.exists()).toBe(true)
    const radios = dialog.findAll<HTMLInputElement>('input[type="radio"]')
    expect(radios.map((r) => r.element.value)).toEqual(['anilist', 'mal'])
    expect(radios.map((r) => r.element.checked)).toEqual([true, false])
    expect(dialog.find('[data-action="cancel"]').exists()).toBe(false)

    await radios[1]!.setValue(true)
    await dialog.find('[data-action="confirm"]').trigger('click')
    await flushPromises()
    expect(fake.api.trackerSetPrimary).toHaveBeenCalledTimes(1)
    expect(fake.api.trackerSetPrimary).toHaveBeenCalledWith('mal')
    expect(primaryDialog(w).exists()).toBe(false)
  })

  it.each(['escape', 'backdrop', 'confirm-interim'] as const)(
    'closing the dialog (%s) keeps the interim primary and makes no trackerSetPrimary call',
    async (how) => {
      connect('shikimori', 'anilist', 'mal')
      const w = await mountTab()
      await disconnect(w, 'shikimori')
      expect(primaryDialog(w).exists()).toBe(true)

      if (how === 'escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      else if (how === 'backdrop') await w.find('.primary-backdrop').trigger('click')
      else await primaryDialog(w).find('[data-action="confirm"]').trigger('click')
      await flushPromises()

      expect(primaryDialog(w).exists()).toBe(false)
      expect(fake.api.trackerSetPrimary).not.toHaveBeenCalled()
      expect(badgeOn(w)).toEqual(['anilist'])
      expect(fake.main.storedPrimary).toBe('anilist')
    }
  )

  it('two accounts: disconnecting the primary shows no dialog', async () => {
    connect('shikimori', 'anilist')
    const w = await mountTab()
    await disconnect(w, 'shikimori')
    expect(fake.api.trackerLogout).toHaveBeenCalledTimes(1)
    expect(primaryDialog(w).exists()).toBe(false)
  })

  it('a non-empty queue: the pending prompt first, the primary choice only after the logout resolves', async () => {
    connect('shikimori', 'anilist', 'mal')
    fake.main.queue.shikimori = 2
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = fake.api.trackerLogout.getMockImplementation()!
    fake.api.trackerLogout.mockImplementationOnce(async (id, opts) => {
      await gate
      return real(id, opts)
    })
    const w = await mountTab()
    await disconnect(w, 'shikimori')

    expect(pendingDialog(w).exists()).toBe(true)
    expect(primaryDialog(w).exists()).toBe(false)
    expect(fake.api.trackerLogout).not.toHaveBeenCalled()

    await pendingDialog(w).find('[data-action="keep"]').trigger('click')
    await flushPromises()
    expect(fake.api.trackerLogout).toHaveBeenCalledWith('shikimori', { pending: 'keep' })
    expect(primaryDialog(w).exists()).toBe(false)

    release()
    await flushPromises()
    expect(primaryDialog(w).exists()).toBe(true)
  })

  it('a rejected logout opens no primary-choice dialog', async () => {
    connect('shikimori', 'anilist', 'mal')
    fake.main.queue.shikimori = 2
    fake.api.trackerLogout.mockRejectedValueOnce(new Error('logout failed'))
    const w = await mountTab()
    await disconnect(w, 'shikimori')
    await pendingDialog(w).find('[data-action="discard"]').trigger('click')
    await flushPromises()

    expect(fake.api.trackerLogout).toHaveBeenCalledTimes(1)
    expect(primaryDialog(w).exists()).toBe(false)
    expect(w.find('.pending-error').text()).toContain('logout failed')
  })
})

describe('the mirror toggle', () => {
  it("switching a mirror off confirms 'N changes won't be sent' and discards only on confirm", async () => {
    connect('shikimori', 'anilist')
    const w = await mountTab()

    await switchOf(w, 'anilist').trigger('click')
    await flushPromises()
    expect(pendingDialog(w).exists()).toBe(true)
    expect(pendingDialog(w).text()).toContain("3 changes won't be sent")

    // Cancel: the toggle stays on, and only the count call was made.
    await pendingDialog(w).find('[data-action="cancel"]').trigger('click')
    await flushPromises()
    expect(pendingDialog(w).exists()).toBe(false)
    expect(switchOf(w, 'anilist').classes()).toContain('on')
    expect(fake.api.trackerSetMirror).toHaveBeenCalledTimes(1)
    expect(fake.api.trackerSetMirror).toHaveBeenLastCalledWith('anilist', false)

    // Again, then Confirm: one confirm call, after the count call.
    await switchOf(w, 'anilist').trigger('click')
    await flushPromises()
    await pendingDialog(w).find('[data-action="confirm"]').trigger('click')
    await flushPromises()
    expect(fake.api.trackerSetMirror.mock.calls).toEqual([
      ['anilist', false],
      ['anilist', false],
      ['anilist', false, { confirm: true }]
    ])
    expect(switchOf(w, 'anilist').classes()).not.toContain('on')
    expect(fake.api.setSetting).not.toHaveBeenCalled()
  })

  it('the confirm shows at N = 0 too, without the count sentence, and its copy names the primary', async () => {
    connect('shikimori', 'anilist')
    fake.api.trackerSetMirror.mockResolvedValueOnce({ applied: false, pendingMirrorChanges: 0 })
    const w = await mountTab()
    await switchOf(w, 'anilist').trigger('click')
    await flushPromises()

    const dialog = pendingDialog(w)
    expect(dialog.exists()).toBe(true)
    expect(dialog.find('.pending-title').text()).toBe('Stop mirroring to AniList?')
    expect(dialog.text()).toContain('Shikimori')
    expect(dialog.text()).not.toContain("won't be sent")
    expect(dialog.text()).not.toMatch(/all changes/i)
  })

  it("after Confirm the card reports the result's `discarded`, never the dialog's N", async () => {
    connect('shikimori', 'anilist')
    fake.api.trackerSetMirror
      .mockResolvedValueOnce({ applied: false, pendingMirrorChanges: 3 })
      .mockImplementationOnce(async () => {
        fake.main.mirror.anilist = false
        fake.announce()
        // A change queued while the dialog was open.
        return { applied: true, discarded: 4 }
      })
    const w = await mountTab()
    await switchOf(w, 'anilist').trigger('click')
    await flushPromises()
    expect(pendingDialog(w).text()).toContain("3 changes won't be sent")
    await pendingDialog(w).find('[data-action="confirm"]').trigger('click')
    await flushPromises()

    expect(card(w, 'anilist').find('.mirror-discarded').text()).toBe('4 changes discarded')
    expect(card(w, 'anilist').text()).not.toContain('3')
  })

  it('a confirm that discarded nothing reports no count line', async () => {
    connect('shikimori', 'anilist')
    fake.api.trackerSetMirror
      .mockResolvedValueOnce({ applied: false, pendingMirrorChanges: 1 })
      .mockResolvedValueOnce({ applied: true, discarded: 0 })
    const w = await mountTab()
    await switchOf(w, 'anilist').trigger('click')
    await flushPromises()
    await pendingDialog(w).find('[data-action="confirm"]').trigger('click')
    await flushPromises()
    expect(card(w, 'anilist').find('.mirror-discarded').exists()).toBe(false)
  })

  describe('switching it back on', () => {
    async function offThenOn(openReconcile?: (id: TrackerId) => void): Promise<VueWrapper> {
      connect('shikimori', 'anilist')
      fake.main.mirror.anilist = false
      const w = await mountTab()
      if (openReconcile) useTrackersStore().openReconcile = openReconcile
      expect(switchOf(w, 'anilist').classes()).not.toContain('on')
      await switchOf(w, 'anilist').trigger('click')
      await flushPromises()
      expect(fake.api.trackerSetMirror).toHaveBeenCalledWith('anilist', true)
      expect(switchOf(w, 'anilist').classes()).toContain('on')
      return w
    }

    it('with `openReconcile` unset (as shipped), an `offerReconcile` result shows no offer', async () => {
      const w = await offThenOn()
      expect(useTrackersStore().openReconcile).toBeNull()
      expect(w.find('.reconcile-offer-row').exists()).toBe(false)
      expect(w.text()).not.toContain('Review differences')
    })

    it('with `openReconcile` set (standing in for #708): the offer shows; Review calls it', async () => {
      const openReconcile = vi.fn()
      const w = await offThenOn(openReconcile)
      const offer = card(w, 'anilist').find('.reconcile-offer-row')
      expect(offer.text()).toContain('Review differences with Shikimori?')
      await offer.find('[data-action="review"]').trigger('click')
      expect(openReconcile).toHaveBeenCalledTimes(1)
      expect(openReconcile).toHaveBeenCalledWith('anilist')
      expect(card(w, 'anilist').find('.reconcile-offer-row').exists()).toBe(false)
    })

    it('"Not now" dismisses the offer with no call', async () => {
      const openReconcile = vi.fn()
      const w = await offThenOn(openReconcile)
      await card(w, 'anilist').find('[data-action="not-now"]').trigger('click')
      expect(card(w, 'anilist').find('.reconcile-offer-row').exists()).toBe(false)
      expect(openReconcile).not.toHaveBeenCalled()
    })
  })
})

describe('feature sources', () => {
  it('Shikimori + MyAnimeList: calendar and airing are plain Shikimori; chronology, For You and details list both', async () => {
    connect('shikimori', 'mal')
    const w = await mountTab()
    for (const f of ['calendar', 'airing'] as const) {
      expect(featureRow(w, f).find('select').exists()).toBe(false)
      expect(featureRow(w, f).find('.feature-single').text()).toBe('Shikimori')
    }
    for (const f of ['chronology', 'forYou', 'details'] as const) {
      expect(optionsOf(w, f)).toEqual(['Default (Shikimori)', 'Shikimori', 'MyAnimeList'])
    }
    expect(featureRow(w, 'airing').text()).toContain('Auto-download episode counts')
  })

  it('AniList + MyAnimeList: airing never lists MyAnimeList', async () => {
    connect('anilist', 'mal')
    const w = await mountTab()
    expect(featureRow(w, 'airing').find('.feature-single').text()).toBe('AniList')
    expect(featureRow(w, 'airing').text()).not.toContain('MyAnimeList')
    expect(featureRow(w, 'calendar').text()).not.toContain('MyAnimeList')
  })

  it('a disconnected tracker is never listed, even as the stored override, and Default is shown as chosen', async () => {
    connect('shikimori', 'mal')
    fake.main.featureSources = { chronology: 'anilist' }
    const w = await mountTab()
    expect(optionsOf(w, 'chronology')).toEqual(['Default (Shikimori)', 'Shikimori', 'MyAnimeList'])
    expect(featureRow(w, 'chronology').find<HTMLSelectElement>('select').element.value).toBe('')
  })

  it('picking a tracker sets the override; picking Default clears it', async () => {
    connect('shikimori', 'anilist')
    const w = await mountTab()
    const select = featureRow(w, 'details').find('select')
    await select.setValue('anilist')
    await flushPromises()
    expect(fake.api.trackerSetFeatureSource).toHaveBeenLastCalledWith('details', 'anilist')
    expect(featureRow(w, 'details').find<HTMLSelectElement>('select').element.value).toBe('anilist')

    await featureRow(w, 'details').find('select').setValue('')
    await flushPromises()
    expect(fake.api.trackerSetFeatureSource).toHaveBeenLastCalledWith('details', null)
    expect(fake.api.trackerSetFeatureSource).toHaveBeenCalledTimes(2)
    expect(fake.main.featureSources.details).toBeUndefined()
    expect(fake.api.setSetting).not.toHaveBeenCalled()
  })

  it('the Default label follows the primary on a broadcast, without a remount', async () => {
    connect('shikimori', 'anilist')
    const w = await mountTab()
    expect(optionsOf(w, 'chronology')[0]).toBe('Default (Shikimori)')

    fake.main.storedPrimary = 'anilist'
    fake.announce()
    await flushPromises()
    expect(optionsOf(w, 'chronology')[0]).toBe('Default (AniList)')
  })

  it("the Default label ignores that feature's own override", async () => {
    connect('shikimori', 'anilist')
    fake.main.featureSources = { chronology: 'anilist' }
    const w = await mountTab()
    expect(optionsOf(w, 'chronology')[0]).toBe('Default (Shikimori)')
    expect(featureRow(w, 'chronology').find<HTMLSelectElement>('select').element.value).toBe(
      'anilist'
    )
  })
})

describe('the second-tracker flag hides Connect', () => {
  it('off, Shikimori connected: the AniList card has no Connect and says why', async () => {
    connect('shikimori')
    fake.main.secondTrackerEnabled = false
    const w = await mountTab()
    const open = card(w, 'anilist').find('.anilist-open')
    expect(open.exists()).toBe(true)
    expect(open.isVisible()).toBe(false)
    expect(card(w, 'anilist').text()).toContain("Connecting a second tracker isn't available yet")
  })

  it('off, AniList only: the Shikimori card has no Connect', async () => {
    connect('anilist')
    fake.main.secondTrackerEnabled = false
    const w = await mountTab()
    const button = card(w, 'shikimori')
      .findAll('button')
      .find((b) => b.text() === 'Connect Shikimori')
    expect(button?.isVisible() ?? false).toBe(false)
    expect(card(w, 'shikimori').text()).toContain("Connecting a second tracker isn't available yet")
  })

  it('off, nothing connected: both cards keep Connect', async () => {
    fake.main.secondTrackerEnabled = false
    const w = await mountTab()
    const button = card(w, 'shikimori')
      .findAll('button')
      .find((b) => b.text() === 'Connect Shikimori')
    expect(button?.isVisible()).toBe(true)
    expect(w.text()).not.toContain("Connecting a second tracker isn't available yet")
  })

  it('on, Shikimori connected: the AniList card keeps Connect', async () => {
    connect('shikimori')
    const w = await mountTab()
    expect(card(w, 'anilist').find('.anilist-open').isVisible()).toBe(true)
    expect(card(w, 'anilist').text()).not.toContain("isn't available yet")
  })
})
