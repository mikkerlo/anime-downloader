// @vitest-environment happy-dom
// Session expiry is not a logout (#244): Shikimori rejected the stored refresh
// token, but the account, its caches and the queued updates are all still here.
// The Trackers card therefore keeps its identity and swaps only the chip and
// the primary action — a "Connect Shikimori" empty state would tell the user
// their data is gone. Moved from Connectors with the card (#700).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { markRaw } from 'vue'
import TrackerAccountCard from '../../../src/renderer/src/components/settings/TrackerAccountCard.vue'
import ShikimoriConnectForm from '../../../src/renderer/src/components/settings/ShikimoriConnectForm.vue'
import { createTrackerCardApi } from '../../helpers/tracker-card-api'

const ME = { id: 1, nickname: 'mikkerlo', avatar: '' }

let fake = createTrackerCardApi()

enableAutoUnmount(afterEach)

async function mountCard(
  opts: {
    sessionExpired?: boolean
    queueLength?: number
    legacyQueueLength?: number
    needsSetup?: boolean
    user?: TrackerUser | null
  } = {}
) {
  // The stores pull the account and the sync status on init, so the state has
  // to come from the bridge — assigning it on a store would be overwritten.
  fake.main.user = opts.user === undefined ? ME : opts.user
  fake.main.sessionExpired = opts.sessionExpired ?? false
  fake.main.queueLength = opts.queueLength ?? 0
  fake.main.legacyQueueLength = opts.legacyQueueLength ?? opts.queueLength ?? 0
  fake.main.needsSetup = opts.needsSetup ?? false
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(TrackerAccountCard, {
    props: {
      trackerId: 'shikimori',
      desc: 'Connect your Shikimori account to sync watch progress.',
      // Test-utils makes mount props reactive; a component prop must stay raw.
      connectForm: markRaw(ShikimoriConnectForm)
    },
    global: { plugins: [pinia] },
    // `isVisible()` reads computed styles: the form row is hidden by v-show.
    attachTo: document.body
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  fake = createTrackerCardApi()
  fake.install()
  setActivePinia(createPinia())
})

describe('TrackerAccountCard — expired Shikimori session', () => {
  it('keeps the account card and shows Connected while the session is healthy', async () => {
    const wrapper = await mountCard({ sessionExpired: false })
    expect(wrapper.find('.conn-card').text()).toContain('Connected')
    expect(wrapper.find('.chip.red').exists()).toBe(false)
    expect(wrapper.text()).toContain('Disconnect')
  })

  it('swaps the chip and offers Reconnect instead of Disconnect when expired', async () => {
    const wrapper = await mountCard({ sessionExpired: true })

    const card = wrapper.find('.conn-card')
    expect(card.text()).toContain('mikkerlo')
    expect(card.find('.chip.red').text()).toContain('Session expired')
    expect(card.text()).toContain('Reconnect')
    expect(card.text()).not.toContain('Disconnect')
  })

  it("names the pending update count from the trackers store's per-tracker breakdown", async () => {
    // The facade's `offlineQueueLength` is told 0, so a card reading it would
    // name no count at all.
    const wrapper = await mountCard({ sessionExpired: true, queueLength: 3, legacyQueueLength: 0 })
    expect(wrapper.find('.conn-card').text()).toMatch(/3 pending updates will sync/)
  })

  it('Reconnect runs the normal auth-URL flow and reveals the code form', async () => {
    const wrapper = await mountCard({ sessionExpired: true })
    // Browser did not open — the copyable link + code input must appear.
    fake.api.shellOpenExternal.mockResolvedValueOnce(false)

    await wrapper.find('.conn-card button').trigger('click')
    await flushPromises()

    expect(fake.api.shikimoriGetAuthUrl).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.shikimori-auth').isVisible()).toBe(true)
    expect(wrapper.find('input[placeholder="Paste authorization code..."]').isVisible()).toBe(true)
  })
})

describe('TrackerAccountCard — Needs setup (#700)', () => {
  it('a needsSetup account shows the "Needs setup" chip and no "Connected"', async () => {
    const wrapper = await mountCard({ needsSetup: true })
    const card = wrapper.find('.conn-card')
    expect(card.find('.chip.orange').text()).toBe('Needs setup')
    expect(card.text()).not.toContain('Connected')
  })

  it('a tracker with no account that needs setup still shows the chip', async () => {
    const wrapper = await mountCard({ user: null, needsSetup: true })
    expect(wrapper.find('.conn-card').exists()).toBe(false)
    expect(wrapper.find('.needs-setup-row .chip.orange').text()).toBe('Needs setup')
  })

  it('a Shikimori account in good health shows no "Needs setup" chip', async () => {
    const wrapper = await mountCard()
    expect(wrapper.text()).not.toContain('Needs setup')
  })
})

// Shikimori's connect stays on its own channels for good (#700): only
// `tracker:begin-auth` / `tracker:complete-auth` refuse while offline, and a
// Shikimori-only user can connect offline today.
describe('TrackerAccountCard — Shikimori connect channels', () => {
  it('connects through shikimoriGetAuthUrl / shikimoriExchangeCode, never trackerBeginAuth / trackerCompleteAuth', async () => {
    const wrapper = await mountCard({ user: null })
    fake.signInAs(ME)

    const connect = wrapper.findAll('button').find((b) => b.text() === 'Connect Shikimori')!
    await connect.trigger('click')
    await flushPromises()
    await wrapper.find('input[placeholder="Paste authorization code..."]').setValue('code')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Submit')!
      .trigger('click')
    await flushPromises()

    expect(fake.api.shikimoriGetAuthUrl).toHaveBeenCalledTimes(1)
    expect(fake.api.shikimoriExchangeCode).toHaveBeenCalledWith('code')
    expect(fake.api.trackerBeginAuth).not.toHaveBeenCalled()
    expect(fake.api.trackerCompleteAuth).not.toHaveBeenCalled()
    expect(wrapper.find('.conn-card').text()).toContain('mikkerlo')
  })
})
