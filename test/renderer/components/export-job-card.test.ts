// @vitest-environment happy-dom
//
// The export job card lists the files skipped as too large for the drive
// (#575), whether preflight skipped them or the copy did at run time.
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ExportJobCard from '../../../src/renderer/src/components/shared-library/ExportJobCard.vue'

function job(over: Partial<ExportJobView>): ExportJobView {
  return {
    jobId: 'j1',
    libraryId: 'lib',
    libraryName: 'Trip',
    root: '/media/u/STICK/Trip',
    status: 'completed',
    filesDone: 1,
    filesTotal: 1,
    bytesDone: 10,
    bytesTotal: 10,
    current: null,
    failed: [],
    skipped: [],
    missing: 0,
    note: null,
    error: null,
    createdAt: 1,
    ...over
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  ;(window as unknown as { api: unknown }).api = {
    exportListJobs: async () => [],
    onExportJobUpdated: () => () => {}
  }
})

describe('ExportJobCard skipped files (#575)', () => {
  it('lists the skipped files', () => {
    const w = mount(ExportJobCard, {
      props: {
        job: job({
          skipped: [
            { key: '7:1:11', label: 'Film — Episode 1', reason: 'too-large-for-filesystem' },
            { key: '8:3:12', label: 'Show — Episode 3', reason: 'too-large-for-filesystem' }
          ]
        })
      }
    })
    const list = w.find('[data-testid="export-job-skipped"]')
    expect(list.find('summary').text()).toBe('2 skipped: too large for this drive')
    expect(list.text()).toContain('Film — Episode 1')
    expect(list.text()).toContain('Show — Episode 3')
  })

  it('no list when nothing was skipped', () => {
    const w = mount(ExportJobCard, { props: { job: job({}) } })
    expect(w.find('[data-testid="export-job-skipped"]').exists()).toBe(false)
  })
})

describe('ExportJobCard merge states (#576)', () => {
  const step = (over: Partial<ExportJobView>): string => {
    const w = mount(ExportJobCard, {
      props: { job: job({ status: 'running', current: 'Show — Episode 1', ...over }) }
    })
    return w.find('[data-testid="export-job-step"]').text()
  }

  it('says what the current file is at: waiting, merging, or copying', () => {
    expect(step({ merge: { phase: 'waiting', percent: 0 } })).toBe(
      'Waiting for a download merge: Show — Episode 1'
    )
    expect(step({ merge: { phase: 'merging', percent: 47 } })).toBe('Merging 47%: Show — Episode 1')
    expect(step({ merge: null })).toBe('Copying: Show — Episode 1')
  })

  it('a held merge shows the player hold', () => {
    const w = mount(ExportJobCard, {
      props: { job: job({ status: 'held', current: 'Show — Episode 1', merge: null }) }
    })
    expect(w.text()).toContain('Paused while the player is open')
  })
})

describe('ExportJobCard With metadata (#586)', () => {
  const phase = (over: Partial<ExportJobView>) =>
    mount(ExportJobCard, { props: { job: job({ mode: 'metadata', ...over }) } })

  it('"Copying", then "Saving watch state", then done', () => {
    const copying = phase({ status: 'running', phase: 'copy', current: 'Show — Episode 1' })
    expect(copying.find('[data-testid="export-job-step"]').text()).toBe('Copying: Show — Episode 1')
    expect(copying.find('[data-testid="export-job-phase"]').exists()).toBe(false)

    const saving = phase({ status: 'running', phase: 'state' })
    expect(saving.find('[data-testid="export-job-phase"]').text()).toBe('Saving watch state')

    const done = phase({ status: 'completed', phase: 'done' })
    expect(done.find('[data-testid="export-job-phase"]').exists()).toBe(false)
    expect(done.text()).toContain('Exported to Trip')
  })

  it('a job killed while saving shows "Saving watch state" after the restart, paused', () => {
    const w = phase({ status: 'paused', phase: 'state' })
    expect(w.find('.waiting').text()).toBe('Paused · Saving watch state')
    expect(w.find('[data-testid="export-job-phase"]').text()).toBe('Saving watch state')
  })
})
