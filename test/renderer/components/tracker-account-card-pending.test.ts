// @vitest-environment happy-dom
// Unsynced Shikimori changes on logout and account switch (#588): Disconnect
// asks before discarding them, a Reconnect into another account says they were
// kept, and kept changes stay visible with a way to discard them. Moved from
// Connectors with the card (#700), onto the `tracker:*` logout and parked-queue
// channels, whose bucket `ownerId` is a string.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { markRaw } from 'vue'
import TrackerAccountCard from '../../../src/renderer/src/components/settings/TrackerAccountCard.vue'
import ShikimoriConnectForm from '../../../src/renderer/src/components/settings/ShikimoriConnectForm.vue'
import { useShikimoriStore } from '../../../src/renderer/src/stores/shikimori'
import { createTrackerCardApi } from '../../helpers/tracker-card-api'

const ME = { id: 1, nickname: 'mikkerlo', avatar: '' }
const OTHER = { id: 2, nickname: 'akvasha', avatar: '' }

enableAutoUnmount(afterEach)

let fake = createTrackerCardApi()

function parked(
  ownerId: string | null,
  nickname: string,
  count: number
): TrackerParkedQueueSummary {
  return { trackerId: 'shikimori', ownerId, nickname, count, parkedAt: 1 }
}

async function mountCard(opts: { queueLength?: number; sessionExpired?: boolean } = {}) {
  fake.main.user = ME
  fake.main.queueLength = opts.queueLength ?? 0
  fake.main.legacyQueueLength = opts.queueLength ?? 0
  fake.main.sessionExpired = opts.sessionExpired ?? false
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(TrackerAccountCard, {
    props: {
      trackerId: 'shikimori',
      desc: 'Connect your Shikimori account to sync watch progress.',
      connectForm: markRaw(ShikimoriConnectForm)
    },
    global: { plugins: [pinia] }
  })
  await flushPromises()
  return wrapper
}

function button(wrapper: VueWrapper, text: string) {
  const found = wrapper.findAll('button').find((b) => b.text().trim() === text)
  if (!found) throw new Error(`no "${text}" button`)
  return found
}

function dialogButton(wrapper: VueWrapper, action: 'keep' | 'discard' | 'cancel') {
  return wrapper.find(`.pending-modal [data-action="${action}"]`)
}

beforeEach(() => {
  vi.clearAllMocks()
  fake = createTrackerCardApi()
  fake.signInAs(OTHER)
  fake.install()
  setActivePinia(createPinia())
})

describe('TrackerAccountCard — Disconnect with unsynced changes', () => {
  it('asks first, naming the count, and Keep parks them', async () => {
    const wrapper = await mountCard({ queueLength: 3 })

    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    expect(fake.api.trackerLogout).not.toHaveBeenCalled()
    const modal = wrapper.find('.pending-modal')
    expect(modal.text()).toContain("3 Shikimori changes haven't been synced yet")
    expect(dialogButton(wrapper, 'keep').text()).toBe('Keep for mikkerlo')

    await dialogButton(wrapper, 'keep').trigger('click')
    await flushPromises()

    expect(fake.api.trackerLogout).toHaveBeenCalledWith('shikimori', { pending: 'keep' })
    expect(wrapper.find('.pending-modal').exists()).toBe(false)
  })

  it('Discard drops them', async () => {
    const wrapper = await mountCard({ queueLength: 3 })
    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    await dialogButton(wrapper, 'discard').trigger('click')
    await flushPromises()

    expect(fake.api.trackerLogout).toHaveBeenCalledWith('shikimori', { pending: 'discard' })
  })

  it('Cancel keeps the session and makes no call', async () => {
    const wrapper = await mountCard({ queueLength: 3 })
    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    await dialogButton(wrapper, 'cancel').trigger('click')
    await flushPromises()

    expect(fake.api.trackerLogout).not.toHaveBeenCalled()
    expect(wrapper.find('.pending-modal').exists()).toBe(false)
    expect(wrapper.find('.conn-card').text()).toContain('mikkerlo')
  })

  it('with nothing pending, disconnects at once with no dialog', async () => {
    const wrapper = await mountCard({ queueLength: 0 })

    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pending-modal').exists()).toBe(false)
    expect(fake.api.trackerLogout).toHaveBeenCalledTimes(1)
    expect(fake.api.trackerLogout).toHaveBeenCalledWith('shikimori', undefined)
  })
})

// `useShikimoriStore().user` isn't derived from the accounts broadcast (#697):
// the card refreshes it, or every facade reader stays signed in.
describe('TrackerAccountCard — the Shikimori facade user', () => {
  it.each([
    ['Keep', 3, 'keep'],
    ['Discard', 3, 'discard'],
    ['plain Disconnect', 0, null]
  ] as const)('is null after %s', async (_name, queueLength, action) => {
    const wrapper = await mountCard({ queueLength })
    const shiki = useShikimoriStore()
    expect(shiki.user).toEqual(ME)

    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()
    if (action) {
      await dialogButton(wrapper, action).trigger('click')
      await flushPromises()
    }

    expect(fake.api.trackerLogout).toHaveBeenCalledTimes(1)
    expect(shiki.user).toBeNull()
    expect(shiki.loggedIn).toBe(false)
    expect(wrapper.find('.conn-card').exists()).toBe(false)
  })

  it('holds the new user after a connect', async () => {
    const wrapper = await mountCard({ sessionExpired: true })
    const shiki = useShikimoriStore()
    expect(shiki.user).toEqual(ME)

    await button(wrapper, 'Reconnect').trigger('click')
    await flushPromises()
    await wrapper.find('input[placeholder="Paste authorization code..."]').setValue('code')
    await button(wrapper, 'Submit').trigger('click')
    await flushPromises()

    expect(shiki.user).toEqual(OTHER)
  })
})

describe('TrackerAccountCard — Reconnect into a different account', () => {
  async function reconnectAsOther(wrapper: VueWrapper): Promise<void> {
    await button(wrapper, 'Reconnect').trigger('click')
    await flushPromises()
    await wrapper.find('input[placeholder="Paste authorization code..."]').setValue('code')
    await button(wrapper, 'Submit').trigger('click')
    await flushPromises()
  }

  it('says the previous account’s changes were kept, and Discard drops that bucket', async () => {
    const wrapper = await mountCard({ sessionExpired: true, queueLength: 2 })
    fake.api.trackerGetParkedQueues.mockResolvedValue([parked(String(ME.id), ME.nickname, 2)])

    await reconnectAsOther(wrapper)

    const modal = wrapper.find('.pending-modal')
    expect(modal.text()).toContain(
      "2 Shikimori changes for mikkerlo haven't been synced yet. They won't be sent to akvasha."
    )
    expect(dialogButton(wrapper, 'cancel').exists()).toBe(false)

    await dialogButton(wrapper, 'discard').trigger('click')
    await flushPromises()

    expect(fake.api.trackerDiscardParkedQueue).toHaveBeenCalledWith('shikimori', String(ME.id))
  })

  it('opens no dialog when the previous account had nothing kept', async () => {
    const wrapper = await mountCard({ sessionExpired: true })

    await reconnectAsOther(wrapper)

    expect(wrapper.find('.pending-modal').exists()).toBe(false)
  })
})

describe('TrackerAccountCard — kept changes', () => {
  it('shows a row for each other owner, and its Discard confirms then drops the bucket', async () => {
    fake.api.trackerGetParkedQueues.mockResolvedValue([
      parked('9', 'friend', 4),
      parked(String(ME.id), ME.nickname, 1)
    ])
    const wrapper = await mountCard()

    const rows = wrapper.findAll('.kept-queue-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain(
      'friend: 4 unsynced changes kept. They sync when friend signs in again.'
    )

    fake.api.trackerGetParkedQueues.mockResolvedValue([parked(String(ME.id), ME.nickname, 1)])
    await rows[0].find('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.pending-modal').text()).toContain('4 Shikimori changes for friend')

    await dialogButton(wrapper, 'discard').trigger('click')
    await flushPromises()

    expect(fake.api.trackerDiscardParkedQueue).toHaveBeenCalledWith('shikimori', '9')
    expect(wrapper.findAll('.kept-queue-row')).toHaveLength(0)
  })

  it('shows the unknown-account bucket with Discard only', async () => {
    fake.api.trackerGetParkedQueues.mockResolvedValue([parked(null, '', 2)])
    const wrapper = await mountCard()

    const row = wrapper.find('.kept-queue-row')
    expect(row.text()).toContain(
      "2 unsynced changes from an unknown account. They won't sync automatically."
    )
    await row.find('button').trigger('click')
    await flushPromises()
    expect(dialogButton(wrapper, 'keep').exists()).toBe(false)

    await dialogButton(wrapper, 'discard').trigger('click')
    await flushPromises()
    expect(fake.api.trackerDiscardParkedQueue).toHaveBeenCalledWith('shikimori', null)
  })
})

describe('TrackerAccountCard — dialog keyboard and failure handling (#588 review)', () => {
  function pressEscape(): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  }

  it('Esc cancels the Disconnect prompt without logging out', async () => {
    const wrapper = await mountCard({ queueLength: 3 })
    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    pressEscape()
    await flushPromises()

    expect(wrapper.find('.pending-modal').exists()).toBe(false)
    expect(fake.api.trackerLogout).not.toHaveBeenCalled()
  })

  it('Esc on the switch prompt means Keep: it closes and discards nothing', async () => {
    const wrapper = await mountCard({ sessionExpired: true, queueLength: 2 })
    fake.api.trackerGetParkedQueues.mockResolvedValue([parked(String(ME.id), ME.nickname, 2)])
    await button(wrapper, 'Reconnect').trigger('click')
    await flushPromises()
    await wrapper.find('input[placeholder="Paste authorization code..."]').setValue('code')
    await button(wrapper, 'Submit').trigger('click')
    await flushPromises()
    expect(wrapper.find('.pending-modal').exists()).toBe(true)

    pressEscape()
    await flushPromises()

    expect(wrapper.find('.pending-modal').exists()).toBe(false)
    expect(fake.api.trackerDiscardParkedQueue).not.toHaveBeenCalled()
  })

  it('a failed kept-changes load after a successful exchange is not a connect error', async () => {
    const wrapper = await mountCard({ sessionExpired: true })
    await button(wrapper, 'Reconnect').trigger('click')
    await flushPromises()
    fake.api.trackerGetParkedQueues.mockRejectedValueOnce(new Error('ipc down'))
    await wrapper.find('input[placeholder="Paste authorization code..."]').setValue('code')
    await button(wrapper, 'Submit').trigger('click')
    await flushPromises()
    expect(wrapper.find('.conn-card').text()).toContain('akvasha')

    // The auth row is hidden once connected; reopening it shows any error
    // the exchange recorded.
    await button(wrapper, 'Reconnect').trigger('click')
    await flushPromises()
    expect(wrapper.find('.shikimori-auth').exists()).toBe(true)
    expect(wrapper.find('.inline-result.bad').exists()).toBe(false)
  })

  it('a failed logout from the prompt is shown, not left unhandled', async () => {
    const wrapper = await mountCard({ queueLength: 3 })
    fake.api.trackerLogout.mockRejectedValueOnce(new Error('logout failed'))
    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    await dialogButton(wrapper, 'keep').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pending-error').text()).toContain('logout failed')
    expect(wrapper.find('.conn-card').text()).toContain('mikkerlo')
  })

  it('reloads the kept-changes rows when main announces a queue change', async () => {
    const wrapper = await mountCard()
    expect(wrapper.findAll('.kept-queue-row')).toHaveLength(0)

    // A late edit was parked for another account, or the drain consumed one.
    fake.api.trackerGetParkedQueues.mockResolvedValue([parked('9', 'friend', 1)])
    fake.emitQueueChanged('shikimori')
    await flushPromises()

    expect(wrapper.findAll('.kept-queue-row')).toHaveLength(1)
    expect(wrapper.find('.kept-queue-row').text()).toContain('friend: 1 unsynced change kept')
  })
})

// Main double-emits Shikimori's queue change (#694); the card listens to the
// `tracker:*` twin alone, filtered to its tracker.
describe('TrackerAccountCard — the queue-changed subscription', () => {
  it('a double-emitted Shikimori queue change reloads the rows once', async () => {
    await mountCard()
    fake.api.trackerGetParkedQueues.mockClear()

    // Main's order: the `shikimori:*` event, then its `tracker:*` twin.
    fake.emitShikimoriQueueChanged()
    fake.emitQueueChanged('shikimori')
    await flushPromises()

    expect(fake.api.onShikimoriOfflineQueueChanged).not.toHaveBeenCalled()
    expect(fake.api.trackerGetParkedQueues).toHaveBeenCalledTimes(1)
  })

  it('reloads once per event for its tracker, and not at all for another tracker', async () => {
    await mountCard()
    fake.api.trackerGetParkedQueues.mockClear()

    fake.emitQueueChanged('anilist')
    await flushPromises()
    expect(fake.api.trackerGetParkedQueues).not.toHaveBeenCalled()

    fake.emitQueueChanged('shikimori')
    await flushPromises()
    expect(fake.api.trackerGetParkedQueues).toHaveBeenCalledTimes(1)
    expect(fake.api.trackerGetParkedQueues).toHaveBeenCalledWith('shikimori')
  })
})
