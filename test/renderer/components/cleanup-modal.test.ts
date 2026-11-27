// @vitest-environment happy-dom
// The cleanup prompt names the primary tracker's rate (#700): a Shikimori
// primary reads today's wording.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import CleanupModal from '../../../src/renderer/src/components/shared/CleanupModal.vue'
import { createTrackerCardApi } from '../../helpers/tracker-card-api'

enableAutoUnmount(afterEach)

async function mountModal(primary: TrackerId | null) {
  const fake = createTrackerCardApi(primary ?? 'shikimori')
  fake.main.user = primary ? { id: 1, nickname: 'me', avatar: null } : null
  Object.assign(fake.api, {
    cleanupGetSize: async () => ({ bytes: 2048, files: 2 }),
    cleanupGetActiveDownloads: async () => ({ active: 0 })
  })
  fake.install()
  const wrapper = mount(CleanupModal, { props: { animeId: 5, animeName: 'Show' } })
  await flushPromises()
  return wrapper
}

beforeEach(() => setActivePinia(createPinia()))

describe('CleanupModal — the kept-rate note', () => {
  it('names Shikimori under a Shikimori primary', async () => {
    const wrapper = await mountModal('shikimori')
    expect(wrapper.find('.cleanup-note').text()).toBe(
      'Watch progress and your Shikimori rate will be kept.'
    )
  })

  it('keeps the Shikimori wording with no account connected', async () => {
    const wrapper = await mountModal(null)
    expect(wrapper.find('.cleanup-note').text()).toBe(
      'Watch progress and your Shikimori rate will be kept.'
    )
  })

  it("names the primary tracker when it isn't Shikimori", async () => {
    const wrapper = await mountModal('anilist')
    expect(wrapper.find('.cleanup-note').text()).toBe(
      'Watch progress and your AniList rate will be kept.'
    )
  })
})
