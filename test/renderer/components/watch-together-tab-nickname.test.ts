// @vitest-environment happy-dom
// The Watch Together tab seeds an empty username from the primary tracker's
// nickname, and its hint names that tracker (#699).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WatchTogetherTab from '../../../src/renderer/src/components/settings/WatchTogetherTab.vue'
import { useTrackersStore } from '../../../src/renderer/src/stores/trackers'

function accountsState(
  connected: Partial<Record<TrackerId, string>>,
  primary: TrackerId | null
): TrackerAccountsState {
  return {
    accounts: (['shikimori', 'anilist', 'mal'] as TrackerId[]).map((trackerId) => ({
      trackerId,
      user: connected[trackerId] ? { id: 1, nickname: connected[trackerId], avatar: null } : null,
      hasCredentials: !!connected[trackerId],
      sessionExpired: false,
      needsSetup: false,
      credentialState: connected[trackerId] ? 'ok' : 'none'
    })),
    primary,
    mirror: {},
    featureSources: {},
    newTrackerCardsEnabled: false
  }
}

const api = {
  getSetting: vi.fn(async (): Promise<Record<string, unknown> | null> => ({ lastRoom: 'r' })),
  setSetting: vi.fn(async (_key: string, _value: unknown) => undefined),
  syncplayHasPassword: vi.fn(async () => false),
  trackerListAccounts: vi.fn(async () => accountsState({}, null)),
  trackerGetRates: vi.fn(async (id: TrackerId) => ({
    trackerId: id,
    entries: [],
    queuedAfter: {}
  })),
  trackerGetSyncStatus: vi.fn(async () => ({
    state: 'idle',
    queueLength: 0,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired: false,
    needsSetup: false
  }))
}

const apiProxy = new Proxy(api as unknown as Record<string, unknown>, {
  get: (target, prop) => (prop in target ? target[prop as string] : () => () => {})
})

const USERNAME_DESC_SELECTOR = '.set-row'

async function mountTab(): Promise<ReturnType<typeof mount>> {
  const pinia = createPinia()
  setActivePinia(pinia)
  // The store's first accounts pull lands before the tab mounts, as it does
  // in the app, where the sidebar builds the store at launch.
  useTrackersStore()
  await flushPromises()
  const wrapper = mount(WatchTogetherTab, { global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

function usernameHint(wrapper: ReturnType<typeof mount>): string {
  const row = wrapper.findAll(USERNAME_DESC_SELECTOR).find((r) => r.find('#sp-user').exists())
  expect(row, 'the Username row').toBeDefined()
  return row!.text()
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getSetting.mockResolvedValue({ lastRoom: 'r' })
  api.trackerListAccounts.mockResolvedValue(accountsState({}, null))
  ;(window as unknown as { api: unknown }).api = apiProxy
})

describe('WatchTogetherTab default nickname (#699)', () => {
  it("a Shikimori primary seeds the username and keeps today's hint", async () => {
    api.trackerListAccounts.mockResolvedValue(accountsState({ shikimori: 'mikkerlo' }, 'shikimori'))
    const wrapper = await mountTab()
    expect((wrapper.find('#sp-user').element as HTMLInputElement).value).toBe('mikkerlo')
    expect(usernameHint(wrapper)).toContain(
      'Shown to other room members. Defaults to your Shikimori nickname if signed in.'
    )
  })

  it('without Shikimori: an AniList primary seeds the username and names AniList', async () => {
    api.trackerListAccounts.mockResolvedValue(accountsState({ anilist: 'ani-fan' }, 'anilist'))
    const wrapper = await mountTab()
    expect((wrapper.find('#sp-user').element as HTMLInputElement).value).toBe('ani-fan')
    expect(usernameHint(wrapper)).toContain('Defaults to your AniList nickname if signed in.')
  })

  it('without Shikimori: a set username is never overwritten', async () => {
    api.getSetting.mockResolvedValue({ lastRoom: 'r', username: 'me' })
    api.trackerListAccounts.mockResolvedValue(accountsState({ anilist: 'ani-fan' }, 'anilist'))
    const wrapper = await mountTab()
    expect((wrapper.find('#sp-user').element as HTMLInputElement).value).toBe('me')
  })

  it('with no account the username stays empty and the hint reads generically', async () => {
    const wrapper = await mountTab()
    expect((wrapper.find('#sp-user').element as HTMLInputElement).value).toBe('')
    expect(usernameHint(wrapper)).toContain('Defaults to your tracker nickname if signed in.')
  })
})
