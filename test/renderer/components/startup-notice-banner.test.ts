// @vitest-environment happy-dom
// The startup notice (#648): what main reports when config.json didn't parse
// and the store came up from the last-known-good copy or the defaults.
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import StartupNoticeBanner from '../../../src/renderer/src/components/shared/StartupNoticeBanner.vue'

const CORRUPT = '/home/u/.config/anime-dl-app/config.corrupt-20261031-120000.json'

function install(notice: StartupNotice | null): { fileShowInFolder: ReturnType<typeof vi.fn> } {
  const api = {
    getStartupNotice: vi.fn().mockResolvedValue(notice),
    fileShowInFolder: vi.fn().mockResolvedValue(undefined)
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

async function mountBanner(notice: StartupNotice | null): Promise<{
  wrapper: ReturnType<typeof mount>
  api: { fileShowInFolder: ReturnType<typeof vi.fn> }
}> {
  const api = install(notice)
  const wrapper = mount(StartupNoticeBanner)
  await flushPromises()
  return { wrapper, api }
}

describe('StartupNoticeBanner (#648)', () => {
  it('renders nothing when there is no notice', async () => {
    const { wrapper } = await mountBanner(null)
    expect(wrapper.find('[data-testid="startup-notice"]').exists()).toBe(false)
  })

  it('config-restored: says the saved copy was loaded, when, and names the kept file', async () => {
    const backupSavedAt = new Date(2026, 9, 30, 21, 15, 0).getTime()
    const { wrapper } = await mountBanner({
      kind: 'config-restored',
      corruptPath: CORRUPT,
      backupSavedAt
    })
    const text = wrapper.find('[data-testid="startup-notice"]').text()
    expect(text).toContain(
      "Anime DL couldn't read its settings file, so it loaded the copy saved when the app last started"
    )
    expect(text).toContain(`(${new Date(backupSavedAt).toLocaleString()})`)
    expect(text).toContain('Changes since then were lost.')
    expect(text).toContain('The unreadable file was kept as config.corrupt-20261031-120000.json.')
    expect(text).not.toContain('default settings')
  })

  it('config-reset: says defaults were used and names the kept file', async () => {
    const { wrapper } = await mountBanner({
      kind: 'config-reset',
      corruptPath:
        'C:\\Users\\u\\AppData\\Roaming\\anime-dl-app\\config.corrupt-20261031-120000.json'
    })
    const text = wrapper.find('[data-testid="startup-notice"]').text()
    expect(text).toContain(
      "Anime DL couldn't read its settings file and started with default settings."
    )
    expect(text).toContain('sign in to Shikimori again and re-open your Shared Libraries')
    expect(text).toContain('The unreadable file was kept as config.corrupt-20261031-120000.json.')
    expect(text).not.toContain('Changes since then were lost.')
  })

  it('Show file reveals the kept file; Dismiss hides the banner', async () => {
    const { wrapper, api } = await mountBanner({ kind: 'config-reset', corruptPath: CORRUPT })

    await wrapper.find('[data-testid="startup-notice-show"]').trigger('click')
    expect(api.fileShowInFolder).toHaveBeenCalledWith(CORRUPT)
    expect(wrapper.find('[data-testid="startup-notice"]').exists()).toBe(true)

    await wrapper.find('[data-testid="startup-notice-dismiss"]').trigger('click')
    expect(wrapper.find('[data-testid="startup-notice"]').exists()).toBe(false)
  })
})
