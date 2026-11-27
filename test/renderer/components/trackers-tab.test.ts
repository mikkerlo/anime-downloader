// @vitest-environment happy-dom
// Settings → Trackers (#700): the Shikimori account card moved here from
// Connectors, which keeps only the Anime 365 token. A Shikimori-only user sees
// one card and nothing else, and the "Session expired" / "Sign in again" deep
// links scroll to it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ConnectorsTab from '../../../src/renderer/src/components/settings/ConnectorsTab.vue'
import TrackersTab from '../../../src/renderer/src/components/settings/TrackersTab.vue'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'
import { useShikimoriStore } from '../../../src/renderer/src/stores/shikimori'
import { createTrackerCardApi } from '../../helpers/tracker-card-api'

const ME = { id: 1, nickname: 'mikkerlo', avatar: '' }

enableAutoUnmount(afterEach)

let fake = createTrackerCardApi()
const scrollIntoView = vi.fn()

function scrolledTo(): (string | undefined)[] {
  return scrollIntoView.mock.contexts.map((el) => (el as HTMLElement).dataset.trackerId)
}

beforeEach(() => {
  vi.clearAllMocks()
  fake = createTrackerCardApi()
  fake.main.user = ME
  fake.install()
  setActivePinia(createPinia())
  HTMLElement.prototype.scrollIntoView = scrollIntoView
})

describe('Settings → Trackers holds the Shikimori card', () => {
  it('the Shikimori card renders in Trackers and not in Connectors', async () => {
    // Signed in: the identity card renders only with a user, and the Anime
    // 365 group never uses one.
    useShikimoriStore().user = ME
    const connectors = mount(ConnectorsTab)
    await flushPromises()
    expect(connectors.find('.conn-card').exists()).toBe(false)
    expect(connectors.text()).not.toContain('Connect Shikimori')
    expect(connectors.text()).not.toContain('Shikimori')
    expect(connectors.find('#token-input').exists()).toBe(true)

    const trackers = mount(TrackersTab)
    await flushPromises()
    expect(trackers.find('.conn-card').text()).toContain('mikkerlo')
    expect(trackers.find('.conn-card').text()).toContain('Connected')
  })

  it('a Shikimori-only user sees exactly one card and no primary, mirror or source controls', async () => {
    const wrapper = mount(TrackersTab)
    await flushPromises()

    expect(wrapper.findAll('.tracker-account-card')).toHaveLength(1)
    expect(wrapper.findAll('.set-group')).toHaveLength(1)
    expect(wrapper.find('.set-group-head h3').text()).toBe('Shikimori')
    expect(wrapper.find('input[type="radio"]').exists()).toBe(false)
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.find('.switch').exists()).toBe(false)
  })

  it('a user with no account sees the one Shikimori card with its Connect button', async () => {
    fake.main.user = null
    const wrapper = mount(TrackersTab, { attachTo: document.body })
    await flushPromises()

    expect(wrapper.findAll('.tracker-account-card')).toHaveLength(1)
    expect(wrapper.find('.conn-card').exists()).toBe(false)
    const connect = wrapper.findAll('button').find((b) => b.text() === 'Connect Shikimori')
    expect(connect?.isVisible()).toBe(true)
    expect(wrapper.find('input[type="radio"]').exists()).toBe(false)
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.find('.switch').exists()).toBe(false)
  })
})

describe('Settings → Trackers deep links', () => {
  it('first mount: a parked trackerId scrolls that card into view and is consumed', async () => {
    const library = useLibraryStore()
    library.navigateToSettingsTab('trackers', 'shikimori')
    library.consumePendingSettingsTab() // the shell's half

    mount(TrackersTab)
    await flushPromises()

    expect(scrolledTo()).toEqual(['shikimori'])
    expect(library.pendingSettingsTrackerId).toBeNull()
  })

  it('already alive (keep-alive): a second deep link scrolls the card again and is consumed', async () => {
    const library = useLibraryStore()
    library.navigateToSettingsTab('trackers', 'shikimori')
    library.consumePendingSettingsTab()
    mount(TrackersTab)
    await flushPromises()
    expect(scrolledTo()).toEqual(['shikimori'])

    library.navigateToSettingsTab('trackers', 'shikimori')
    library.consumePendingSettingsTab()
    await flushPromises()

    expect(scrolledTo()).toEqual(['shikimori', 'shikimori'])
    expect(library.pendingSettingsTrackerId).toBeNull()
  })

  it('opening the tab with no tracker named scrolls nowhere', async () => {
    mount(TrackersTab)
    await flushPromises()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})

// The Shikimori calls used to gate `loaded` (#700): it now turns true right
// after the token read, and the hydration write must still not be saved back.
describe("ConnectorsTab — the token autosave's loaded gate", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not autosave the hydrated token, autosaves an edit, and calls no Shikimori channel', async () => {
    fake.api.getSetting.mockResolvedValue('stored-token')
    const wrapper = mount(ConnectorsTab)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2000)

    const input = wrapper.find<HTMLInputElement>('#token-input')
    expect(input.element.value).toBe('stored-token')
    expect(fake.api.setSetting).not.toHaveBeenCalled()

    await input.setValue('  edited-token ')
    await vi.advanceTimersByTimeAsync(800)

    expect(fake.api.setSetting).toHaveBeenCalledTimes(1)
    expect(fake.api.setSetting).toHaveBeenCalledWith('token', 'edited-token')
    expect(fake.api.shikimoriGetUser).not.toHaveBeenCalled()
    expect(fake.api.trackerGetParkedQueues).not.toHaveBeenCalled()
    expect(fake.api.trackerListAccounts).not.toHaveBeenCalled()
  })
})
