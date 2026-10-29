// @vitest-environment happy-dom
//
// Pre-fetch in the export UI (#577): missing episodes are checkable online
// with a token and disabled otherwise; each shows its estimate or "size
// unknown"; the dialog counts them on the drive and on this PC and sends them
// as `prefetch`; the job card shows where each one is.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ExportDialog from '../../../src/renderer/src/components/shared-library/ExportDialog.vue'
import ExportJobCard from '../../../src/renderer/src/components/shared-library/ExportJobCard.vue'
import ExportTree from '../../../src/renderer/src/components/shared-library/ExportTree.vue'
import {
  nodeKeys,
  prefetchEstimate,
  prefetchKey,
  toPrefetch
} from '../../../src/renderer/src/components/shared-library/export-selection'

const option = (
  translationId: number,
  sizeBytes: number | null,
  author = 'A'
): ExportPrefetchOption => ({
  translationId,
  translationType: 'subRu',
  author,
  height: 720,
  sizeBytes
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
          {
            key: '1:1:11',
            episodeInt: '1',
            label: 'E1',
            state: 'ready',
            size: 1000,
            unmerged: false
          }
        ]
      }
    ],
    notDownloaded: [
      {
        episodeInt: '2',
        label: 'E2',
        options: [option(12, 350 * 1024 * 1024), option(92, null, 'B')],
        unavailable: null
      },
      { episodeInt: '3', label: 'E3', options: [option(13, null)], unavailable: null },
      {
        episodeInt: '4',
        label: 'E4',
        options: [],
        unavailable: 'Open the title once online to refresh'
      }
    ]
  }
]

const PF2 = prefetchKey(1, '2')
const PF3 = prefetchKey(1, '3')

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('pre-fetch selection helpers (#577)', () => {
  it('a title node covers its pre-fetchable episodes only when pre-fetch is on', () => {
    expect(nodeKeys(TITLES[0], false)).toEqual(['1:1:11'])
    expect(nodeKeys(TITLES[0], true)).toEqual(['1:1:11', PF2, PF3])
  })

  it('sends the picked translation (the first by default), and counts unknown sizes apart', () => {
    const selected = new Set([PF2, PF3])
    expect(toPrefetch(TITLES, selected, {})).toEqual([
      { animeId: 1, episodeInt: '2', translationId: 12 },
      { animeId: 1, episodeInt: '3', translationId: 13 }
    ])
    expect(toPrefetch(TITLES, selected, { [PF2]: 92 })[0].translationId).toBe(92)
    expect(prefetchEstimate(TITLES, selected, {})).toEqual({
      items: 2,
      bytes: 350 * 1024 * 1024,
      unknown: 1
    })
    expect(prefetchEstimate(TITLES, selected, { [PF2]: 92 })).toEqual({
      items: 2,
      bytes: 0,
      unknown: 2
    })
  })
})

describe('ExportTree.vue missing episodes (#577)', () => {
  const tree = (prefetch: ExportPrefetchGate, selected = new Set<string>()) =>
    mount(ExportTree, { props: { titles: TITLES, selected, present: [], prefetch } })
  const box = (w: ReturnType<typeof tree>, n: string) =>
    w.find(`[data-testid="tree-prefetch-1-${n}"]`).element as HTMLInputElement
  const row = (w: ReturnType<typeof tree>, n: string) =>
    w.find(`[data-testid="tree-missing-1-${n}"]`)

  it('online with a token: checkable, with the estimate or “size unknown”', async () => {
    const w = tree('ok')
    expect(box(w, '2').disabled).toBe(false)
    expect(row(w, '2').text()).toContain('Will be downloaded first (~350.0 MB)')
    expect(row(w, '3').text()).toContain('Will be downloaded first (size unknown)')
    expect(row(w, '2').find('.cloud').exists()).toBe(true)
    // A stale episode list keeps that one disabled.
    expect(box(w, '4').disabled).toBe(true)
    expect(row(w, '4').text()).toContain('Open the title once online to refresh')
    await w.find('[data-testid="tree-prefetch-1-2"]').trigger('change')
    expect([...(w.emitted('update:selected')![0][0] as Set<string>)]).toEqual([PF2])
  })

  it('offline: disabled, “Needs internet to download”', () => {
    const w = tree('offline')
    expect(box(w, '2').disabled).toBe(true)
    expect(row(w, '2').text()).toContain('Needs internet to download')
  })

  it('without a token: disabled, “API token is required for downloads”', () => {
    const w = tree('no-token')
    expect(box(w, '3').disabled).toBe(true)
    expect(row(w, '3').text()).toContain('API token is required for downloads')
  })

  it('picking another translation updates the estimate', async () => {
    const w = tree('ok', new Set([PF2]))
    const select = w.find('[data-testid="tree-prefetch-tr-1-2"]')
    ;(select.element as HTMLSelectElement).value = '92'
    await select.trigger('change')
    expect(w.emitted('update:choices')![0][0]).toEqual({ [PF2]: 92 })
    await w.setProps({ choices: { [PF2]: 92 } })
    expect(row(w, '2').text()).toContain('size unknown')
  })
})

describe('ExportDialog.vue pre-fetch (#577)', () => {
  let api: Record<string, ReturnType<typeof vi.fn> | (() => () => void)>

  async function open(free: number, localFree: number | null, prefetch: ExportPrefetchGate = 'ok') {
    api = {
      exportPlan: vi.fn(async (req: ExportPlanRequest) => ({
        titles: TITLES,
        merge: { available: false, encoders: [] },
        prefetch,
        localFree,
        preflight: null,
        target: req.target
          ? {
              dir: '/drive',
              root: '/drive/Anime Library',
              kind: 'new',
              libraryName: 'Anime Library',
              blocked: null,
              free,
              present: [],
              presentMerged: []
            }
          : null
      })),
      exportPickTarget: vi.fn(async () => '/drive'),
      exportStart: vi.fn(async () => ({ ok: false, reason: 'refused' })),
      exportListJobs: vi.fn(async () => []),
      onExportJobUpdated: () => () => {}
    }
    ;(window as unknown as { api: unknown }).api = api
    const w = mount(ExportDialog, { props: { animeIds: [1], preselect: true } })
    await flushPromises()
    await w.find('[data-testid="export-pick"]').trigger('click')
    await flushPromises()
    return w
  }

  it('counts the estimate on the drive and on this PC, notes the unknown ones, and sends the pre-fetch', async () => {
    const w = await open(1024 ** 3, 2 * 1024 ** 3)
    await w.find('[data-testid="tree-title-1"]').trigger('change') // partial → all, missing included
    await flushPromises()
    const text = w.text()
    expect(text).toContain('to copy (3 episodes)')
    expect(text).toContain('+ 1 episode of unknown size')
    expect(w.find('[data-testid="export-local-space"]').text().replace(/\s+/g, ' ')).toContain(
      'Downloads first on this PC: ~350.0 MB (2 episodes) · 2.0 GB free · + 1 episode of unknown size'
    )
    expect(w.find('[data-testid="export-prefetch-hint"]').text()).toContain(
      'Cancelling the export doesn’t cancel those downloads.'
    )
    await w.find('[data-testid="export-start"]').trigger('click')
    await flushPromises()
    expect(api.exportStart).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: [{ animeId: 1, translationId: 11, episodeInt: '1' }],
        prefetch: [
          { animeId: 1, episodeInt: '2', translationId: 12 },
          { animeId: 1, episodeInt: '3', translationId: 13 }
        ]
      })
    )
  })

  it('refuses when the downloads don’t fit on this PC', async () => {
    const w = await open(1024 ** 3, 100 * 1024 * 1024)
    await w.find('[data-testid="tree-prefetch-1-2"]').trigger('change')
    await flushPromises()
    expect((w.find('[data-testid="export-start"]').element as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(w.text()).toContain('The episodes to download don’t fit on this PC.')
  })

  it('refuses when the estimate doesn’t fit on the drive', async () => {
    const w = await open(200 * 1024 * 1024, null)
    await w.find('[data-testid="tree-prefetch-1-2"]').trigger('change')
    await flushPromises()
    expect(w.find('[data-testid="export-space-bar"]').classes()).toContain('over')
    expect(w.text()).toContain('The selection doesn’t fit on the drive.')
  })

  it('offline: the missing episodes can’t be picked, so a start sends no pre-fetch', async () => {
    const w = await open(1024 ** 3, null, 'offline')
    expect((w.find('[data-testid="tree-prefetch-1-2"]').element as HTMLInputElement).disabled).toBe(
      true
    )
    await w.find('[data-testid="export-start"]').trigger('click')
    await flushPromises()
    expect(api.exportStart).toHaveBeenCalledWith(
      expect.not.objectContaining({ prefetch: expect.anything() })
    )
  })
})

describe('ExportJobCard.vue pre-fetch (#577)', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      exportListJobs: async () => [],
      onExportJobUpdated: () => () => {}
    }
  })

  const job = (
    prefetch: ExportPrefetchView[],
    over: Partial<ExportJobView> = {}
  ): ExportJobView => ({
    jobId: 'j1',
    libraryId: 'lib',
    libraryName: 'Trip',
    root: '/drive/Trip',
    status: 'running',
    filesDone: 1,
    filesTotal: 1,
    bytesDone: 10,
    bytesTotal: 10,
    current: null,
    failed: [],
    skipped: [],
    missing: 0,
    prefetch,
    note: null,
    error: null,
    createdAt: 1,
    ...over
  })
  const pv = (
    key: string,
    state: ExportPrefetchView['state'],
    more: Partial<ExportPrefetchView> = {}
  ) => ({
    key,
    label: key,
    state,
    percent: 0,
    warning: null,
    ...more
  })

  it('shows each item’s state, and “Waiting for N downloads” when nothing else is left', () => {
    const w = mount(ExportJobCard, {
      props: {
        job: job([
          pv('a', 'downloading', { percent: 42 }),
          pv('b', 'waiting-merge'),
          pv('c', 'waiting-connection'),
          pv('d', 'done')
        ])
      }
    })
    expect(w.find('[data-testid="export-job-waiting-downloads"]').text()).toBe(
      'Waiting for 3 downloads'
    )
    const list = w.find('[data-testid="export-job-prefetch"]')
    expect(list.find('summary').text()).toBe('Downloading 3 episodes before copying')
    expect(w.find('[data-testid="export-prefetch-a"]').text()).toBe('a: Downloading 42%')
    expect(w.find('[data-testid="export-prefetch-b"]').text()).toBe('b: Waiting for merge')
    expect(w.find('[data-testid="export-prefetch-c"]').text()).toBe('c: Waiting for connection')
  })

  it('a copied item’s subtitle warning stays on the card', () => {
    const w = mount(ExportJobCard, {
      props: {
        job: job([pv('a', 'done', { warning: 'Subtitles failed to download' })], {
          status: 'completed'
        })
      }
    })
    expect(w.text()).toContain('a: Subtitles failed to download')
  })
})
