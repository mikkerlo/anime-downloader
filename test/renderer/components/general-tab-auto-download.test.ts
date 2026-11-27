// @vitest-environment happy-dom
// Settings > General > Auto-download (#706): a MAL-only account sees the
// airing hint and a disabled "Run now"; Shikimori, AniList and no account see
// the group as before.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import GeneralTab from '../../../src/renderer/src/components/settings/GeneralTab.vue'
import { offlineApi } from '../../helpers/offline-api'
import { trackerAccounts, type AccountSpec } from '../../helpers/tracker-accounts'

function installApi(accounts: AccountSpec): void {
  const api: Record<string, unknown> = {
    ...offlineApi().api,
    appVersion: vi.fn().mockResolvedValue('6.11.0'),
    getSetting: vi.fn().mockResolvedValue(null),
    autoDlGetEnabled: vi.fn().mockResolvedValue(true),
    autoDlListSubscriptions: vi.fn().mockResolvedValue([]),
    autoDlGetStatus: vi.fn().mockResolvedValue({ lastResult: null, locked: false, enabled: true }),
    onAutoDlTickResult: vi.fn(() => () => {}),
    trackerListAccounts: vi.fn().mockResolvedValue(trackerAccounts(accounts))
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get: (t, p: string) => (p in t ? t[p] : () => () => {})
  })
}

async function mountTab() {
  const w = mount(GeneralTab)
  await flushPromises()
  return {
    w,
    hint: () => w.find('[data-testid="auto-dl-airing-hint"]'),
    runNow: () => w.find('[data-testid="auto-dl-run-now"]')
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('GeneralTab — Auto-download (#706)', () => {
  it('MAL-only: the hint under the switch, and Run now disabled', async () => {
    installApi({ mal: 'active' })
    const { w, hint, runNow } = await mountTab()
    expect(hint().text()).toBe(
      'MyAnimeList has no airing data — connect AniList or Shikimori to auto-download'
    )
    expect(runNow().attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it.each<[string, AccountSpec]>([
    ['Shikimori', { shikimori: 'active' }],
    ['AniList', { anilist: 'active' }],
    ['MAL with AniList', { anilist: 'active', mal: 'active' }],
    ['no account', {}]
  ])('%s: no hint, Run now enabled', async (_name, accounts) => {
    installApi(accounts)
    const { w, hint, runNow } = await mountTab()
    expect(hint().exists()).toBe(false)
    expect(runNow().attributes('disabled')).toBeUndefined()
    w.unmount()
  })
})
