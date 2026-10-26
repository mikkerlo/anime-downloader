// @vitest-environment happy-dom
// Unsynced Shikimori changes on logout and account switch (#588): Disconnect
// asks before discarding them, a Reconnect into another account says they were
// kept, and kept changes stay visible with a way to discard them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ConnectorsTab from '../../../src/renderer/src/components/settings/ConnectorsTab.vue'
import { useShikimoriStore } from '../../../src/renderer/src/stores/shikimori'

const ME = { id: 1, nickname: 'mikkerlo', avatar: '' }
const OTHER = { id: 2, nickname: 'akvasha', avatar: '' }

const queueListeners = new Set<(data: { length: number }) => void>()

enableAutoUnmount(afterEach)

const api = {
  getSetting: vi.fn(async () => ''),
  setSetting: vi.fn(async () => undefined),
  shikimoriGetUser: vi.fn(async () => null),
  shikimoriGetAuthUrl: vi.fn(async () => 'https://shikimori.io/oauth/authorize?x=1'),
  shellOpenExternal: vi.fn(async () => false),
  shikimoriLogout: vi.fn(async () => undefined),
  shikimoriExchangeCode: vi.fn(async () => OTHER),
  shikimoriGetParkedQueues: vi.fn(async (): Promise<ShikiParkedQueueSummary[]> => []),
  shikimoriDiscardParkedQueue: vi.fn(async () => undefined),
  onShikimoriOfflineQueueChanged: vi.fn((cb: (data: { length: number }) => void) => {
    queueListeners.add(cb)
    return () => queueListeners.delete(cb)
  }),
  shikimoriGetSyncStatus: vi.fn(async () => ({
    state: 'idle',
    queueLength: 0,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired: false
  }))
}

const apiProxy = new Proxy(api as unknown as Record<string, unknown>, {
  get: (target, prop) => (prop in target ? target[prop as string] : () => () => {})
})

async function mountTab(opts: { queueLength?: number; sessionExpired?: boolean } = {}) {
  api.shikimoriGetSyncStatus.mockResolvedValue({
    state: 'idle',
    queueLength: opts.queueLength ?? 0,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired: opts.sessionExpired ?? false
  })
  const pinia = createPinia()
  setActivePinia(pinia)
  const shiki = useShikimoriStore()
  shiki.user = ME
  const wrapper = mount(ConnectorsTab, { global: { plugins: [pinia] } })
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
  queueListeners.clear()
  api.shikimoriGetParkedQueues.mockResolvedValue([])
  api.shikimoriLogout.mockResolvedValue(undefined)
  ;(window as unknown as { api: unknown }).api = apiProxy
  setActivePinia(createPinia())
})

describe('ConnectorsTab — Disconnect with unsynced changes', () => {
  it('asks first, naming the count, and Keep parks them', async () => {
    const wrapper = await mountTab({ queueLength: 3 })

    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    expect(api.shikimoriLogout).not.toHaveBeenCalled()
    const modal = wrapper.find('.pending-modal')
    expect(modal.text()).toContain("3 Shikimori changes haven't been synced yet")
    expect(dialogButton(wrapper, 'keep').text()).toBe('Keep for mikkerlo')

    await dialogButton(wrapper, 'keep').trigger('click')
    await flushPromises()

    expect(api.shikimoriLogout).toHaveBeenCalledWith({ pending: 'keep' })
    expect(wrapper.find('.pending-modal').exists()).toBe(false)
  })

  it('Discard drops them', async () => {
    const wrapper = await mountTab({ queueLength: 3 })
    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    await dialogButton(wrapper, 'discard').trigger('click')
    await flushPromises()

    expect(api.shikimoriLogout).toHaveBeenCalledWith({ pending: 'discard' })
  })

  it('Cancel keeps the session and makes no call', async () => {
    const wrapper = await mountTab({ queueLength: 3 })
    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    await dialogButton(wrapper, 'cancel').trigger('click')
    await flushPromises()

    expect(api.shikimoriLogout).not.toHaveBeenCalled()
    expect(wrapper.find('.pending-modal').exists()).toBe(false)
    expect(wrapper.find('.conn-card').text()).toContain('mikkerlo')
  })

  it('with nothing pending, disconnects at once with no dialog', async () => {
    const wrapper = await mountTab({ queueLength: 0 })

    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pending-modal').exists()).toBe(false)
    expect(api.shikimoriLogout).toHaveBeenCalledTimes(1)
  })
})

describe('ConnectorsTab — Reconnect into a different account', () => {
  async function reconnectAsOther(wrapper: VueWrapper): Promise<void> {
    await button(wrapper, 'Reconnect').trigger('click')
    await flushPromises()
    await wrapper.find('input[placeholder="Paste authorization code..."]').setValue('code')
    await button(wrapper, 'Submit').trigger('click')
    await flushPromises()
  }

  it('says the previous account’s changes were kept, and Discard drops that bucket', async () => {
    const wrapper = await mountTab({ sessionExpired: true, queueLength: 2 })
    api.shikimoriGetParkedQueues.mockResolvedValue([
      { ownerId: ME.id, nickname: ME.nickname, count: 2, parkedAt: 1 }
    ])

    await reconnectAsOther(wrapper)

    const modal = wrapper.find('.pending-modal')
    expect(modal.text()).toContain(
      "2 Shikimori changes for mikkerlo haven't been synced yet. They won't be sent to akvasha."
    )
    expect(dialogButton(wrapper, 'cancel').exists()).toBe(false)

    await dialogButton(wrapper, 'discard').trigger('click')
    await flushPromises()

    expect(api.shikimoriDiscardParkedQueue).toHaveBeenCalledWith(ME.id)
  })

  it('opens no dialog when the previous account had nothing kept', async () => {
    const wrapper = await mountTab({ sessionExpired: true })

    await reconnectAsOther(wrapper)

    expect(wrapper.find('.pending-modal').exists()).toBe(false)
  })
})

describe('ConnectorsTab — kept changes', () => {
  it('shows a row for each other owner, and its Discard confirms then drops the bucket', async () => {
    api.shikimoriGetParkedQueues.mockResolvedValue([
      { ownerId: 9, nickname: 'friend', count: 4, parkedAt: 1 },
      { ownerId: ME.id, nickname: ME.nickname, count: 1, parkedAt: 1 }
    ])
    const wrapper = await mountTab()

    const rows = wrapper.findAll('.kept-queue-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain(
      'friend: 4 unsynced changes kept. They sync when friend signs in again.'
    )

    api.shikimoriGetParkedQueues.mockResolvedValue([
      { ownerId: ME.id, nickname: ME.nickname, count: 1, parkedAt: 1 }
    ])
    await rows[0].find('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.pending-modal').text()).toContain('4 Shikimori changes for friend')

    await dialogButton(wrapper, 'discard').trigger('click')
    await flushPromises()

    expect(api.shikimoriDiscardParkedQueue).toHaveBeenCalledWith(9)
    expect(wrapper.findAll('.kept-queue-row')).toHaveLength(0)
  })

  it('shows the unknown-account bucket with Discard only', async () => {
    api.shikimoriGetParkedQueues.mockResolvedValue([
      { ownerId: null, nickname: '', count: 2, parkedAt: 1 }
    ])
    const wrapper = await mountTab()

    const row = wrapper.find('.kept-queue-row')
    expect(row.text()).toContain(
      "2 unsynced changes from an unknown account. They won't sync automatically."
    )
    await row.find('button').trigger('click')
    await flushPromises()
    expect(dialogButton(wrapper, 'keep').exists()).toBe(false)

    await dialogButton(wrapper, 'discard').trigger('click')
    await flushPromises()
    expect(api.shikimoriDiscardParkedQueue).toHaveBeenCalledWith(null)
  })
})

describe('ConnectorsTab — dialog keyboard and failure handling (#588 review)', () => {
  function pressEscape(): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  }

  it('Esc cancels the Disconnect prompt without logging out', async () => {
    const wrapper = await mountTab({ queueLength: 3 })
    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    pressEscape()
    await flushPromises()

    expect(wrapper.find('.pending-modal').exists()).toBe(false)
    expect(api.shikimoriLogout).not.toHaveBeenCalled()
  })

  it('Esc on the switch prompt means Keep: it closes and discards nothing', async () => {
    const wrapper = await mountTab({ sessionExpired: true, queueLength: 2 })
    api.shikimoriGetParkedQueues.mockResolvedValue([
      { ownerId: ME.id, nickname: ME.nickname, count: 2, parkedAt: 1 }
    ])
    await button(wrapper, 'Reconnect').trigger('click')
    await flushPromises()
    await wrapper.find('input[placeholder="Paste authorization code..."]').setValue('code')
    await button(wrapper, 'Submit').trigger('click')
    await flushPromises()
    expect(wrapper.find('.pending-modal').exists()).toBe(true)

    pressEscape()
    await flushPromises()

    expect(wrapper.find('.pending-modal').exists()).toBe(false)
    expect(api.shikimoriDiscardParkedQueue).not.toHaveBeenCalled()
  })

  it('a failed kept-changes load after a successful exchange is not a connect error', async () => {
    const wrapper = await mountTab({ sessionExpired: true })
    await button(wrapper, 'Reconnect').trigger('click')
    await flushPromises()
    api.shikimoriGetParkedQueues.mockRejectedValueOnce(new Error('ipc down'))
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
    const wrapper = await mountTab({ queueLength: 3 })
    api.shikimoriLogout.mockRejectedValueOnce(new Error('logout failed'))
    await button(wrapper, 'Disconnect').trigger('click')
    await flushPromises()

    await dialogButton(wrapper, 'keep').trigger('click')
    await flushPromises()

    expect(wrapper.find('.pending-error').text()).toContain('logout failed')
    expect(wrapper.find('.conn-card').text()).toContain('mikkerlo')
  })

  it('reloads the kept-changes rows when main announces a queue change', async () => {
    const wrapper = await mountTab()
    expect(wrapper.findAll('.kept-queue-row')).toHaveLength(0)

    // A late edit was parked for another account, or the drain consumed one.
    api.shikimoriGetParkedQueues.mockResolvedValue([
      { ownerId: 9, nickname: 'friend', count: 1, parkedAt: 1 }
    ])
    for (const listener of queueListeners) listener({ length: 0 })
    await flushPromises()

    expect(wrapper.findAll('.kept-queue-row')).toHaveLength(1)
    expect(wrapper.find('.kept-queue-row').text()).toContain('friend: 1 unsynced change kept')
  })
})
