// @vitest-environment happy-dom
// The MyAnimeList card in Settings → Trackers (#702): its connect body
// (`MalConnectForm.vue`) inside the generic `TrackerAccountCard`, behind the
// new-tracker-cards flag. The guided setup, the client ID and write-only
// secret, Test, Connect, the loopback wait and the `port-busy` fallback.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TrackersTab from '../../../src/renderer/src/components/settings/TrackersTab.vue'
import { useLibraryStore } from '../../../src/renderer/src/stores/library'
import { createTrackerCardApi } from '../../helpers/tracker-card-api'

enableAutoUnmount(afterEach)

let fake = createTrackerCardApi('mal')
const writeText = vi.fn(async (_text: string) => {})

beforeEach(() => {
  vi.clearAllMocks()
  fake = createTrackerCardApi('mal')
  fake.main.newTrackerCardsEnabled = true
  fake.install()
  setActivePinia(createPinia())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

async function mountTab(): Promise<VueWrapper> {
  const wrapper = mount(TrackersTab, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

const card = (w: VueWrapper) => w.find('[data-tracker-id="mal"]')
const byTest = (w: VueWrapper, id: string) => w.find(`[data-testid="${id}"]`)

async function saveClientId(w: VueWrapper, id = 'cid-123'): Promise<void> {
  await byTest(w, 'mal-client-id').setValue(id)
  await byTest(w, 'mal-save').trigger('click')
  await flushPromises()
}

describe('the MAL card and the flag', () => {
  it('with the flag off, the card isn’t rendered', async () => {
    fake.main.newTrackerCardsEnabled = false
    const w = await mountTab()
    expect(card(w).exists()).toBe(false)
    expect(w.findAll('.tracker-account-card')).toHaveLength(1)
  })

  it('with the flag on, it renders after Shikimori’s and AniList’s with the setup steps open', async () => {
    const w = await mountTab()
    const ids = w.findAll('.tracker-account-card').map((c) => c.attributes('data-tracker-id'))
    expect(ids).toEqual(['shikimori', 'anilist', 'mal'])
    const steps = byTest(w, 'mal-setup-steps')
    expect(steps.exists()).toBe(true)
    // The redirect URL comes from main, with its port.
    expect(steps.text()).toContain('http://localhost:41753/callback')
    expect(steps.text()).toContain('other')
    expect(steps.text()).toContain('https://github.com/mikkerlo/anime-downloader')
  })
})

// T4c's sidebar button and popover rows call `navigateToSettingsTab('trackers', 'mal')`.
describe('the MAL card is the deep link’s target', () => {
  const scrollIntoView = vi.fn()
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = scrollIntoView
  })
  const scrolledTo = () =>
    scrollIntoView.mock.contexts.map((el) => (el as HTMLElement).dataset.trackerId)

  it('first mount, before the accounts payload landed: the MAL card scrolls into view once it renders', async () => {
    const library = useLibraryStore()
    library.navigateToSettingsTab('trackers', 'mal')
    library.consumePendingSettingsTab()
    await mountTab()
    expect(scrolledTo()).toEqual(['mal'])
    expect(library.pendingSettingsTrackerId).toBeNull()
  })

  it('already alive: a second link to MAL scrolls it again', async () => {
    const library = useLibraryStore()
    await mountTab()
    library.navigateToSettingsTab('trackers', 'mal')
    library.consumePendingSettingsTab()
    await flushPromises()
    expect(scrolledTo()).toEqual(['mal'])
  })

  it('with the flag off there is no MAL card, so the link scrolls nowhere', async () => {
    fake.main.newTrackerCardsEnabled = false
    const library = useLibraryStore()
    library.navigateToSettingsTab('trackers', 'mal')
    library.consumePendingSettingsTab()
    await mountTab()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})

describe('the client ID', () => {
  it('Connect stays disabled until a client ID is saved, and re-disables if it is cleared', async () => {
    const w = await mountTab()
    const connect = () => byTest(w, 'mal-connect')
    expect(connect().attributes('disabled')).toBeDefined()
    await byTest(w, 'mal-client-id').setValue('cid-123')
    // Typed but not saved yet.
    expect(connect().attributes('disabled')).toBeDefined()
    await byTest(w, 'mal-save').trigger('click')
    await flushPromises()
    expect(fake.api.trackerSetClientConfig).toHaveBeenCalledWith('mal', { clientId: 'cid-123' })
    expect(connect().attributes('disabled')).toBeUndefined()
    await byTest(w, 'mal-client-id').setValue('')
    expect(connect().attributes('disabled')).toBeDefined()
  })

  it('the secret is write-only: sent on save, never read back; hasSecret drives "A secret is saved"', async () => {
    const w = await mountTab()
    await byTest(w, 'mal-client-id').setValue('cid-123')
    expect(byTest(w, 'mal-secret').attributes('type')).toBe('password')
    await byTest(w, 'mal-secret').setValue('s3cret')
    await byTest(w, 'mal-save').trigger('click')
    await flushPromises()
    expect(fake.api.trackerSetClientConfig).toHaveBeenCalledWith('mal', {
      clientId: 'cid-123',
      secret: 's3cret'
    })
    expect(byTest(w, 'mal-secret-saved').text()).toBe('A secret is saved')
    expect(byTest(w, 'mal-secret').exists()).toBe(false)
    // Nothing main answers with carries a secret.
    const replies = await Promise.all([
      ...fake.api.trackerGetClientConfig.mock.results.map((r) => r.value),
      ...fake.api.trackerSetClientConfig.mock.results.map((r) => r.value)
    ])
    for (const reply of replies) expect(reply).not.toHaveProperty('secret')
    expect(w.html()).not.toContain('s3cret')

    await byTest(w, 'mal-remove-secret').trigger('click')
    await flushPromises()
    expect(fake.api.trackerSetClientConfig).toHaveBeenLastCalledWith('mal', {
      clientId: 'cid-123',
      secret: null
    })
  })

  it.each([
    [{ ok: true }, 'Client ID works'],
    [
      { ok: false, kind: 'config', message: 'MyAnimeList rejected this client ID.' },
      'MyAnimeList rejected this client ID.'
    ],
    [
      { ok: false, kind: 'network', message: 'Couldn’t reach MyAnimeList.' },
      'Couldn’t reach MyAnimeList.'
    ]
  ] as const)('Test shows %j as “%s”', async (result, text) => {
    fake.api.trackerTestClientConfig.mockResolvedValue(result as TrackerTestClientConfigResult)
    const w = await mountTab()
    await saveClientId(w)
    await byTest(w, 'mal-test').trigger('click')
    await flushPromises()
    expect(fake.api.trackerTestClientConfig).toHaveBeenCalledWith('mal')
    expect(byTest(w, 'mal-test-result').text()).toBe(text)
  })
})

describe('signing in', () => {
  it('the waiting state offers Cancel and the paste field', async () => {
    fake.api.trackerBeginAuth.mockImplementation(() => new Promise(() => {}))
    const w = await mountTab()
    await saveClientId(w)
    await byTest(w, 'mal-connect').trigger('click')
    await flushPromises()
    expect(fake.api.trackerBeginAuth).toHaveBeenCalledWith('mal')
    expect(byTest(w, 'mal-auth').text()).toContain('Waiting for MyAnimeList in your browser')
    expect(byTest(w, 'mal-paste').exists()).toBe(true)
    await byTest(w, 'mal-cancel').trigger('click')
    await flushPromises()
    expect(fake.api.trackerCancelAuth).toHaveBeenCalledWith('mal')
    expect(byTest(w, 'mal-auth').exists()).toBe(false)
  })

  it('port-busy: the warning names the port, nothing opens until Open anyway, then once; Copy link copies it', async () => {
    const authorizeUrl = 'https://myanimelist.net/v1/oauth2/authorize?state=s'
    fake.api.trackerBeginAuth.mockResolvedValue({ status: 'port-busy', authorizeUrl })
    const w = await mountTab()
    await saveClientId(w)
    await byTest(w, 'mal-connect').trigger('click')
    await flushPromises()
    expect(byTest(w, 'mal-port-busy').text()).toContain('port 41753')
    expect(byTest(w, 'mal-paste').exists()).toBe(true)
    expect(fake.api.shellOpenExternal).not.toHaveBeenCalled()
    await byTest(w, 'mal-open-anyway').trigger('click')
    expect(fake.api.shellOpenExternal).toHaveBeenCalledTimes(1)
    expect(fake.api.shellOpenExternal).toHaveBeenCalledWith(authorizeUrl)
    await byTest(w, 'mal-copy-link').trigger('click')
    expect(writeText).toHaveBeenCalledWith(authorizeUrl)
  })

  it('port-busy: pasting the redirect address completes through tracker:complete-auth', async () => {
    fake.api.trackerBeginAuth.mockResolvedValue({ status: 'port-busy', authorizeUrl: 'https://x/' })
    const user = { id: 9, nickname: 'malfan', avatar: null }
    fake.api.trackerCompleteAuth.mockImplementation(async () => {
      fake.main.user = user
      fake.announceAccounts()
      return { status: 'connected', account: { trackerId: 'mal', user } as TrackerAccount }
    })
    const w = await mountTab()
    await saveClientId(w)
    await byTest(w, 'mal-connect').trigger('click')
    await flushPromises()
    const pasted = 'http://localhost:41753/callback?code=c&state=s'
    await byTest(w, 'mal-paste').setValue(pasted)
    await byTest(w, 'mal-paste-submit').trigger('click')
    await flushPromises()
    expect(fake.api.trackerCompleteAuth).toHaveBeenCalledWith('mal', pasted)
    expect(card(w).find('.conn-card').text()).toContain('malfan')
  })

  it('a refused sign-in shows main’s message', async () => {
    fake.api.trackerBeginAuth.mockResolvedValue({
      status: 'error',
      kind: 'auth',
      message: 'The MyAnimeList sign-in timed out. Press Connect again.'
    })
    const w = await mountTab()
    await saveClientId(w)
    await byTest(w, 'mal-connect').trigger('click')
    await flushPromises()
    expect(byTest(w, 'mal-error').text()).toContain('timed out')
    expect(byTest(w, 'mal-connect').attributes('disabled')).toBeUndefined()
  })
})
