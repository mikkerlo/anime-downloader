// @vitest-environment happy-dom
//
// App.vue now creates `useSharedLibrariesStore` at startup (#581), for the
// found-on-a-drive toast. Its `ffmpeg:check` (`ffmpeg -version`, a spawn in
// main) runs only on a PC with a library attached: the first check waits for a
// `refresh()` that lists one, and the window-focus re-check runs only while one
// is. A file of its own: every store instance keeps its window listener for
// the page's lifetime.
import { it, expect, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useSharedLibrariesStore } from '../../src/renderer/src/stores/shared-libraries'

it('checks ffmpeg at startup and on window focus only while a library is attached', async () => {
  setActivePinia(createPinia())
  let list: AttachedLibraryInfo[] = []
  const ffmpegCheck = vi.fn().mockResolvedValue({ available: false })
  ;(window as unknown as { api: unknown }).api = {
    sharedLibraryList: vi.fn().mockImplementation(async () => list),
    ffmpegCheck,
    onSharedLibrariesChanged: () => () => {},
    onSharedLibraryFound: () => () => {},
    syncGetStatus: async () => ({ running: [], libraries: {} }),
    onSyncRunFinished: () => () => {}
  }
  const store = useSharedLibrariesStore()
  await flushPromises()
  // No library: no spawn at startup, none on focus.
  expect(ffmpegCheck).not.toHaveBeenCalled()
  window.dispatchEvent(new Event('focus'))
  expect(ffmpegCheck).not.toHaveBeenCalled()
  expect(store.ffmpegAvailable).toBe(true)

  // The first refresh that lists one checks once, so the banner is right at once.
  list = [{ libraryId: 'a', titles: [] } as unknown as AttachedLibraryInfo]
  await store.refresh()
  await flushPromises()
  expect(ffmpegCheck).toHaveBeenCalledTimes(1)
  expect(store.ffmpegAvailable).toBe(false)
  await store.refresh()
  expect(ffmpegCheck).toHaveBeenCalledTimes(1)
  window.dispatchEvent(new Event('focus'))
  expect(ffmpegCheck).toHaveBeenCalledTimes(2)
})

it('a PC that starts with a library attached checks once, after the first refresh', async () => {
  setActivePinia(createPinia())
  const ffmpegCheck = vi.fn().mockResolvedValue({ available: true })
  const order: string[] = []
  ;(window as unknown as { api: unknown }).api = {
    sharedLibraryList: vi.fn().mockImplementation(async () => {
      order.push('list')
      return [{ libraryId: 'a', titles: [] }]
    }),
    ffmpegCheck: vi.fn().mockImplementation(async () => {
      order.push('ffmpeg')
      return ffmpegCheck()
    }),
    onSharedLibrariesChanged: () => () => {},
    onSharedLibraryFound: () => () => {},
    syncGetStatus: async () => ({ running: [], libraries: {} }),
    onSyncRunFinished: () => () => {}
  }
  useSharedLibrariesStore()
  await flushPromises()
  expect(order).toEqual(['list', 'ffmpeg'])
})
