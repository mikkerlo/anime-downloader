// @vitest-environment happy-dom
//
// Copy to this PC / Import all (#579): the dialog preselects every ready
// episode, lists the unsafe items greyed with their reason, offers Cold only
// when its folder is there, blocks a selection that doesn't fit, and starts
// with the selection and the destination. The duplicate prompt shows both
// sizes and sends the answer with "Apply to all remaining".
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ImportDialog from '../../../src/renderer/src/components/shared-library/ImportDialog.vue'
import DuplicatePrompt from '../../../src/renderer/src/components/shared-library/DuplicatePrompt.vue'
import { useImportStore } from '../../../src/renderer/src/stores/import'

const episode = (key: string, size: number, state: 'ready' | 'missing' = 'ready') => ({
  key,
  episodeInt: key.split(':')[1],
  label: `E${key.split(':')[1]}`,
  state,
  size,
  unmerged: false
})

const TITLES: ExportTreeTitle[] = [
  {
    animeId: 1,
    name: 'Alpha',
    translations: [
      {
        translationId: 11,
        author: 'A',
        translationType: 'subRu',
        quality: 720,
        episodes: [
          episode('1:1:11', 1000),
          episode('1:2:11', 3000),
          episode('1:3:11', 0, 'missing')
        ]
      }
    ],
    notDownloaded: []
  }
]

function plan(over: Partial<ImportPlan> = {}): ImportPlan {
  return {
    libraryId: 'lib',
    libraryName: 'Trip',
    titles: TITLES,
    rejected: [
      { key: '2:1:21', label: '.. — E1', reason: 'Can’t copy: unsafe name in the library' }
    ],
    hot: { dir: '/home/u/anime', free: 1_000_000 },
    cold: null,
    coldUnavailable: 'Cold storage isn’t set up (Settings → Storage).',
    error: null,
    ...over
  }
}

let api: Record<string, ReturnType<typeof vi.fn> | (() => () => void)>

function stubApi(p: ImportPlan): void {
  api = {
    importPlan: vi.fn(async () => p),
    importStart: vi.fn(async () => ({ ok: false, reason: 'refused by main' })),
    importListJobs: vi.fn(async () => []),
    importResolveDuplicate: vi.fn(async () => null),
    onImportJobUpdated: () => () => {}
  }
  ;(window as unknown as { api: unknown }).api = api
}

async function open(p: ImportPlan, animeIds: number[] | null = [1]) {
  stubApi(p)
  const w = mount(ImportDialog, { props: { libraryId: 'lib', animeIds } })
  await flushPromises()
  return w
}

beforeEach(() => setActivePinia(createPinia()))

describe('ImportDialog', () => {
  it('preselects every ready episode and lists the unsafe ones with the reason', async () => {
    const w = await open(plan())
    expect(api.importPlan).toHaveBeenCalledWith({ libraryId: 'lib', animeIds: [1] })
    expect(w.text()).toContain('Copy to this PC')
    expect(w.text()).toContain('Missing on the drive')
    const space = w.find('.space-text').text()
    expect(space).toContain('2 episodes')
    const rejected = w.find('[data-testid="import-rejected"]')
    expect(rejected.text()).toContain('.. — E1')
    expect(rejected.text()).toContain('Can’t copy: unsafe name in the library')
  })

  it('Import all asks for every title', async () => {
    const w = await open(plan(), null)
    expect(api.importPlan).toHaveBeenCalledWith({ libraryId: 'lib', animeIds: null })
    expect(w.find('.import-title').text()).toContain('Import all')
  })

  it('Cold is disabled while its folder is missing, and enabled when it is there', async () => {
    const off = await open(plan())
    const cold = off.find('[data-testid="import-dest-cold"]')
    expect((cold.element as HTMLInputElement).disabled).toBe(true)
    const on = await open(plan({ cold: { dir: '/cold', free: 5000 }, coldUnavailable: null }))
    expect((on.find('[data-testid="import-dest-cold"]').element as HTMLInputElement).disabled).toBe(
      false
    )
  })

  it('a selection that doesn’t fit blocks Copy', async () => {
    const w = await open(plan({ hot: { dir: '/home/u/anime', free: 3000 } }))
    expect(w.find('[data-testid="import-space-bar"]').classes()).toContain('over')
    expect(w.find('[data-testid="import-start"]').attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('doesn’t fit on this PC')
  })

  it('starts with the selection and the destination, and shows a refusal', async () => {
    const w = await open(plan({ cold: { dir: '/cold', free: 1_000_000 }, coldUnavailable: null }))
    await w.find('[data-testid="import-dest-cold"]').setValue(true)
    await w.find('[data-testid="import-start"]').trigger('click')
    await flushPromises()
    expect(api.importStart).toHaveBeenCalledWith({
      libraryId: 'lib',
      selection: [
        { animeId: 1, translationId: 11, episodeInt: '1' },
        { animeId: 1, translationId: 11, episodeInt: '2' }
      ],
      destination: 'cold'
    })
    expect(w.find('.error').text()).toBe('refused by main')
  })

  it('an unplugged drive: the plan’s error, nothing to start', async () => {
    const w = await open(
      plan({ titles: [], rejected: [], error: "Connect the drive with 'Trip' first." })
    )
    expect(w.text()).toContain("Connect the drive with 'Trip' first.")
    expect(w.find('[data-testid="import-start"]').attributes('disabled')).toBeDefined()
  })
})

describe('DuplicatePrompt', () => {
  function asking(dup: Partial<ImportDuplicatePrompt>): ImportJobView {
    return {
      jobId: 'j',
      libraryId: 'lib',
      libraryName: 'Trip',
      destination: 'hot',
      status: 'waiting-duplicate',
      itemsDone: 0,
      itemsTotal: 2,
      bytesDone: 0,
      bytesTotal: 10,
      current: null,
      duplicate: {
        key: '1:1:11',
        label: 'Alpha — E1',
        localSize: 612 * 1024 * 1024,
        driveSize: 668 * 1024 * 1024,
        canKeepBoth: false,
        canReplace: true,
        ...dup
      },
      failed: [],
      kept: [],
      note: null,
      error: null,
      createdAt: 1
    }
  }

  async function prompt(dup: Partial<ImportDuplicatePrompt> = {}) {
    stubApi(plan())
    const store = useImportStore()
    await flushPromises()
    store.jobs = [asking(dup)]
    const w = mount(DuplicatePrompt)
    await flushPromises()
    return w
  }

  it('shows both sizes; Keep both only for another translation', async () => {
    const w = await prompt()
    expect(w.find('[data-testid="duplicate-keep"]').text()).toBe('Keep this PC’s file (612.0 MB)')
    expect(w.find('[data-testid="duplicate-replace"]').text()).toBe(
      'Replace with the drive’s (668.0 MB)'
    )
    expect(w.find('[data-testid="duplicate-keep-both"]').exists()).toBe(false)
    const other = await prompt({ canKeepBoth: true })
    expect(other.find('[data-testid="duplicate-keep-both"]').exists()).toBe(true)
  })

  it('Replace is off while this PC’s file is still downloading or merging', async () => {
    const w = await prompt({ canReplace: false })
    expect(w.find('[data-testid="duplicate-replace"]').attributes('disabled')).toBeDefined()
  })

  it('sends the answer with "Apply to all remaining"', async () => {
    const w = await prompt()
    await w.find('[data-testid="duplicate-apply-all"]').setValue(true)
    await w.find('[data-testid="duplicate-keep"]').trigger('click')
    await flushPromises()
    expect(api.importResolveDuplicate).toHaveBeenCalledWith('j', {
      choice: 'keep',
      applyToAll: true
    })
  })
})
