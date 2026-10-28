// @vitest-environment happy-dom
//
// App.vue now creates `useSharedLibrariesStore` at startup (#581), for the
// found-on-a-drive toast. Its window-focus ffmpeg re-check (`ffmpeg -version`,
// a spawn in main) runs only while a library is attached. A file of its own:
// every store instance keeps its window listener for the page's lifetime.
import { it, expect, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useSharedLibrariesStore } from '../../src/renderer/src/stores/shared-libraries'

it('re-checks ffmpeg on window focus only while a library is attached', async () => {
  setActivePinia(createPinia())
  let list: AttachedLibraryInfo[] = []
  const ffmpegCheck = vi.fn().mockResolvedValue({ available: true })
  ;(window as unknown as { api: unknown }).api = {
    sharedLibraryList: vi.fn().mockImplementation(async () => list),
    ffmpegCheck,
    onSharedLibrariesChanged: () => () => {},
    onSharedLibraryFound: () => () => {}
  }
  const store = useSharedLibrariesStore()
  await flushPromises()
  expect(ffmpegCheck).toHaveBeenCalledTimes(1)
  window.dispatchEvent(new Event('focus'))
  expect(ffmpegCheck).toHaveBeenCalledTimes(1)

  list = [{ libraryId: 'a', titles: [] } as unknown as AttachedLibraryInfo]
  await store.refresh()
  window.dispatchEvent(new Event('focus'))
  expect(ffmpegCheck).toHaveBeenCalledTimes(2)
})
