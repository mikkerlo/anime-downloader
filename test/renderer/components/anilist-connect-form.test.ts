// @vitest-environment happy-dom
// The AniList card (#703): its connect body (Open AniList, the token paste,
// the Viewer result), the expiry warning from two weeks before the token's
// `exp`, and the new-tracker-cards flag that hides the card.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TrackersTab from '../../../src/renderer/src/components/settings/TrackersTab.vue'
import AniListConnectForm from '../../../src/renderer/src/components/settings/AniListConnectForm.vue'
import { EXPIRY_WARNING_MS } from '../../../src/renderer/src/components/settings/session-expiry'
import { createTrackerCardApi } from '../../helpers/tracker-card-api'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'

const ALICE = { id: 5001, nickname: 'alice', avatar: null }
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0)

enableAutoUnmount(afterEach)

let fake = createTrackerCardApi('anilist')

beforeEach(() => {
  vi.clearAllMocks()
  fake = createTrackerCardApi('anilist')
  fake.main.newTrackerCardsEnabled = true
  fake.install()
  setActivePinia(createPinia())
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
})

const anilistCard = (wrapper: ReturnType<typeof mount>) =>
  wrapper.find('.tracker-account-card[data-tracker-id="anilist"]')

describe('the connect body', () => {
  function mountForm(
    complete = vi.fn(async (signIn: () => Promise<TrackerUser>) => void (await signIn()))
  ) {
    return { wrapper: mount(AniListConnectForm, { props: { complete } }), complete }
  }

  it('Open AniList calls trackerBeginAuth(anilist), and the paste field and hint show at once', async () => {
    fake.api.trackerBeginAuth.mockImplementation(() => new Promise(() => {}))
    const { wrapper } = mountForm()
    expect(wrapper.find('.anilist-token').exists()).toBe(false)
    await wrapper.find('.anilist-open').trigger('click')
    await flushPromises()
    expect(fake.api.trackerBeginAuth).toHaveBeenCalledWith('anilist')
    expect(wrapper.find('.anilist-token').exists()).toBe(true)
    expect(wrapper.text()).toContain(
      'AniList shows a long token after you authorize. Copy all of it.'
    )
  })

  it('a pasted token is submitted trimmed, and the Viewer result shows', async () => {
    fake.api.trackerBeginAuth.mockImplementation(() => new Promise(() => {}))
    fake.api.trackerCompleteAuth.mockResolvedValue({
      status: 'connected',
      account: {
        trackerId: 'anilist',
        user: ALICE,
        hasCredentials: true,
        sessionExpired: false,
        needsSetup: false,
        credentialState: 'ok'
      }
    })
    const { wrapper, complete } = mountForm()
    await wrapper.find('.anilist-open').trigger('click')
    await wrapper.find('.anilist-token').setValue('  eyJ.token.sig \n')
    await wrapper.find('.anilist-submit').trigger('click')
    await flushPromises()
    expect(fake.api.trackerCompleteAuth).toHaveBeenCalledWith('anilist', 'eyJ.token.sig')
    expect(complete).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.connected-as').text()).toBe('Connected as alice')
  })

  it('a rejected token shows the rejection and keeps the paste field', async () => {
    fake.api.trackerBeginAuth.mockImplementation(() => new Promise(() => {}))
    fake.api.trackerCompleteAuth.mockResolvedValue({
      status: 'error',
      kind: 'auth',
      message: "That token wasn't accepted"
    })
    const { wrapper } = mountForm()
    await wrapper.find('.anilist-open').trigger('click')
    await wrapper.find('.anilist-token').setValue('truncated')
    await wrapper.find('.anilist-submit').trigger('click')
    await flushPromises()
    expect(wrapper.find('.connect-error').text()).toBe("That token wasn't accepted")
    expect(wrapper.find('.anilist-token').exists()).toBe(true)
  })

  it('a browser that can’t be opened shows the link to copy', async () => {
    fake.api.trackerBeginAuth.mockResolvedValue({
      status: 'open-failed',
      authorizeUrl: 'https://anilist.co/api/v2/oauth/authorize?client_id=57991&response_type=token'
    })
    const { wrapper } = mountForm()
    await wrapper.find('.anilist-open').trigger('click')
    await flushPromises()
    expect(wrapper.find('.anilist-url').text()).toBe(
      'https://anilist.co/api/v2/oauth/authorize?client_id=57991&response_type=token'
    )
    expect(wrapper.find('.anilist-token').exists()).toBe(true)
  })

  it('offline: says so, and no paste field', async () => {
    fake.api.trackerBeginAuth.mockResolvedValue({ status: 'offline' })
    const { wrapper } = mountForm()
    await wrapper.find('.anilist-open').trigger('click')
    await flushPromises()
    expect(wrapper.find('.connect-error').text()).toMatch(/offline/)
    expect(wrapper.find('.anilist-token').exists()).toBe(false)
  })
})

describe('the expiry warning', () => {
  async function cardAt(expiresAt: number) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    fake.main.user = ALICE
    fake.main.sessionExpiresAt = expiresAt
    const wrapper = mount(TrackersTab)
    await flushPromises()
    return anilistCard(wrapper)
  }

  it('appears exactly from expiresAt − 14 days', async () => {
    const card = await cardAt(NOW + EXPIRY_WARNING_MS)
    expect(card.find('.expiry-chip').exists()).toBe(true)
    expect(card.find('.expiry-chip').text()).toMatch(/^Expires /)
    expect(card.find('.expiry-warning').text()).toMatch(
      /^Your AniList sign-in expires on .+\. Sign in again to keep syncing\.$/
    )
    expect(card.find('.sign-in-again').exists()).toBe(true)
  })

  it('not a millisecond before', async () => {
    const card = await cardAt(NOW + EXPIRY_WARNING_MS + 1)
    expect(card.find('.expiry-chip').exists()).toBe(false)
    expect(card.find('.sign-in-again').exists()).toBe(false)
    expect(card.text()).toContain('Connected')
  })

  it('a card left open crosses the threshold, then the end date, without a new payload', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const expiresAt = NOW + EXPIRY_WARNING_MS + 30_000
    vi.setSystemTime(NOW)
    fake.main.user = ALICE
    fake.main.sessionExpiresAt = expiresAt
    const wrapper = mount(TrackersTab)
    await flushPromises()
    const card = anilistCard(wrapper)
    expect(card.find('.expiry-chip').exists()).toBe(false)
    vi.advanceTimersByTime(60_000)
    await flushPromises()
    expect(card.find('.expiry-chip').text()).toMatch(/^Expires /)
    expect(card.find('.expiry-warning').text()).toMatch(/sign-in expires on/)
    vi.setSystemTime(expiresAt)
    vi.advanceTimersByTime(60_000)
    await flushPromises()
    expect(card.find('.expiry-chip').text()).toMatch(/^Expired /)
    expect(card.find('.expiry-warning').text()).toMatch(
      /^Your AniList sign-in expired on .+\. Sign in again to keep syncing\.$/
    )
    expect(fake.api.trackerListAccounts).toHaveBeenCalledTimes(1)
  })

  it('Sign in again runs the same flow and shows the paste field', async () => {
    fake.api.trackerBeginAuth.mockImplementation(() => new Promise(() => {}))
    const card = await cardAt(NOW + 1000)
    await card.find('.sign-in-again').trigger('click')
    await flushPromises()
    expect(fake.api.trackerBeginAuth).toHaveBeenCalledWith('anilist')
    expect(card.find('.anilist-token').isVisible()).toBe(true)
  })
})

describe('the sidebar’s deep link (T4c: navigateToSettingsTab(trackers, anilist))', () => {
  const scrolled = () =>
    (HTMLElement.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.contexts.map(
      (el) => (el as HTMLElement).dataset.trackerId
    )

  it('first mount: the AniList card is the target, once the accounts payload shows it', async () => {
    fake.main.user = ALICE
    fake.main.sessionExpired = true
    // The accounts read lands after the tab mounted, as an IPC round trip does.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const read = fake.api.trackerListAccounts.getMockImplementation()!
    fake.api.trackerListAccounts.mockImplementation(async () => {
      await gate
      return read()
    })
    const library = useLibraryStore()
    library.navigateToSettingsTab('trackers', 'anilist')
    library.consumePendingSettingsTab()
    mount(TrackersTab)
    await flushPromises()
    expect(scrolled()).toEqual([])
    release()
    await flushPromises()
    expect(scrolled()).toEqual(['anilist'])
    expect(library.pendingSettingsTrackerId).toBeNull()
  })

  it('already alive: a second deep link scrolls the AniList card again', async () => {
    const library = useLibraryStore()
    mount(TrackersTab)
    await flushPromises()
    library.navigateToSettingsTab('trackers', 'anilist')
    library.consumePendingSettingsTab()
    await flushPromises()
    expect(scrolled()).toEqual(['anilist'])
  })
})

describe('the new-tracker-cards flag', () => {
  it('off: the AniList card isn’t rendered', async () => {
    fake.main.newTrackerCardsEnabled = false
    const wrapper = mount(TrackersTab)
    await flushPromises()
    expect(anilistCard(wrapper).exists()).toBe(false)
    expect(wrapper.findAll('.tracker-account-card')).toHaveLength(1)
  })

  it('on: the AniList card renders after the Shikimori one, with Open AniList', async () => {
    const wrapper = mount(TrackersTab)
    await flushPromises()
    const cards = wrapper.findAll('.tracker-account-card')
    // MyAnimeList's card (#702) shares the flag and follows AniList's.
    expect(cards.map((c) => c.attributes('data-tracker-id'))).toEqual([
      'shikimori',
      'anilist',
      'mal'
    ])
    expect(anilistCard(wrapper).find('.set-group-head h3').text()).toBe('AniList')
    expect(anilistCard(wrapper).find('.anilist-open').text()).toBe('Open AniList')
    expect(wrapper.text()).not.toMatch(/AniList Downloader/)
  })
})
