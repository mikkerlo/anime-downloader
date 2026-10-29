// @vitest-environment happy-dom
//
// The copy-to-this-PC job card in Downloads (#579): "Copying from <library> —
// 5 / 12", the waiting states, and the kept and failed lists.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ImportJobCard from '../../../src/renderer/src/components/shared-library/ImportJobCard.vue'

function job(over: Partial<ImportJobView> = {}): ImportJobView {
  return {
    jobId: 'j',
    libraryId: 'lib',
    libraryName: 'Trip',
    destination: 'hot',
    status: 'running',
    itemsDone: 5,
    itemsTotal: 12,
    bytesDone: 50,
    bytesTotal: 120,
    current: 'Alpha — E6',
    duplicate: null,
    failed: [],
    kept: [],
    note: null,
    error: null,
    createdAt: 1,
    ...over
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  ;(window as unknown as { api: unknown }).api = {
    importListJobs: vi.fn(async () => []),
    importPause: vi.fn(async () => null),
    onImportJobUpdated: () => () => {}
  }
})

describe('ImportJobCard', () => {
  it('says what it copies from, and how far it is', () => {
    const w = mount(ImportJobCard, { props: { job: job() } })
    expect(w.find('[data-testid="import-job-headline"]').text()).toBe('Copying from Trip — 5 / 12')
    expect(w.text()).toContain('Copying: Alpha — E6')
  })

  it.each([
    ['held', 'Paused while the player is open'],
    ['waiting-drive', "Waiting for drive 'Trip'"],
    ['waiting-duplicate', 'Waiting for your answer: this PC already has an episode']
  ] as const)('%s', (status, text) => {
    const w = mount(ImportJobCard, { props: { job: job({ status }) } })
    expect(w.find('.waiting').text()).toBe(text)
  })

  it('finished: Dismiss, with the kept and failed items', async () => {
    const w = mount(ImportJobCard, {
      props: {
        job: job({
          status: 'completed',
          itemsDone: 10,
          kept: [{ key: 'k', label: 'Alpha — E1', reason: 'Kept this PC’s file' }],
          failed: [{ key: 'f', label: 'Alpha — E2', reason: 'the file is missing on the drive' }]
        })
      }
    })
    expect(w.find('[data-testid="import-job-headline"]').text()).toBe('Copied from Trip — 10 / 12')
    expect(w.find('[data-testid="import-job-kept"]').text()).toContain('Alpha — E1')
    expect(w.text()).toContain('Alpha — E2: the file is missing on the drive')
    expect(w.findAll('button').map((b) => b.text())).toEqual(['Dismiss'])
  })

  it('Pause asks main', async () => {
    const w = mount(ImportJobCard, { props: { job: job() } })
    await w.find('button').trigger('click')
    expect(
      (window as unknown as { api: { importPause: ReturnType<typeof vi.fn> } }).api.importPause
    ).toHaveBeenCalledWith('j')
  })
})
