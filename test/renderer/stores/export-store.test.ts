// The export jobs store (#574): seeded from `export:list-jobs`, kept live by
// `export:job-updated`, and Cancel on a finished job dismisses it.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useExportStore } from '../../../src/renderer/src/stores/export'

function job(id: string, status: ExportJobStatus = 'running'): ExportJobView {
  return {
    jobId: id,
    libraryId: 'lib',
    libraryName: 'Trip',
    root: '/media/u/STICK/Trip',
    status,
    filesDone: 1,
    filesTotal: 4,
    bytesDone: 10,
    bytesTotal: 40,
    current: null,
    failed: [],
    missing: 0,
    note: null,
    error: null,
    createdAt: 1
  }
}

let listeners: ((j: ExportJobView) => void)[]
let api: Record<string, ReturnType<typeof vi.fn> | ((cb: (j: ExportJobView) => void) => () => void)>

beforeEach(() => {
  setActivePinia(createPinia())
  listeners = []
  api = {
    exportListJobs: vi.fn(async () => [job('a', 'paused')]),
    exportStart: vi.fn(async () => ({ ok: true, job: job('b') })),
    exportPause: vi.fn(async (id: string) => job(id, 'paused')),
    exportResume: vi.fn(async (id: string) => job(id, 'running')),
    exportCancel: vi.fn(async (id: string) => (id === 'done' ? null : job(id, 'cancelled'))),
    exportLocateTarget: vi.fn(async () => ({ ok: false, reason: "This folder doesn't hold it" })),
    onExportJobUpdated: (cb: (j: ExportJobView) => void) => {
      listeners.push(cb)
      return () => {}
    }
  }
  ;(globalThis as { window?: { api: unknown } }).window = { api }
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('export store (#574)', () => {
  it('seeds from the list and applies broadcasts', async () => {
    const store = useExportStore()
    await flush()
    expect(store.jobs.map((j) => j.status)).toEqual(['paused'])
    expect(store.activeJob).toBeNull()
    listeners[0](job('a', 'held'))
    expect(store.jobs[0].status).toBe('held')
    expect(store.activeJob?.jobId).toBe('a')
    listeners[0](job('c', 'waiting-drive'))
    expect(store.jobs.map((j) => j.jobId)).toEqual(['c', 'a'])
  })

  it('start, pause, resume and cancel update the list; cancel on a finished job dismisses it', async () => {
    const store = useExportStore()
    await flush()
    const r = await store.start({ selection: [], target: '/t', name: 'Trip' })
    expect(r.ok).toBe(true)
    expect(store.jobs.map((j) => j.jobId)).toEqual(['b', 'a'])
    await store.pause('b')
    expect(store.jobs[0].status).toBe('paused')
    await store.resume('b')
    expect(store.jobs[0].status).toBe('running')
    await store.cancel('b')
    expect(store.jobs[0].status).toBe('cancelled')
    listeners[0](job('done', 'completed'))
    await store.cancel('done')
    expect(store.jobs.map((j) => j.jobId)).toEqual(['b', 'a'])
  })

  it('a refused start leaves the list alone', async () => {
    ;(api.exportStart as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: 'no'
    })
    const store = useExportStore()
    await flush()
    expect(await store.start({ selection: [], target: '/t', name: 'x' })).toEqual({
      ok: false,
      reason: 'no'
    })
    expect(store.jobs).toHaveLength(1)
  })

  it('records a Locate… refusal, and clears it on success or a cancelled picker', async () => {
    const store = useExportStore()
    await flush()
    await store.locate('a')
    expect(store.locateErrors.a).toBe("This folder doesn't hold it")
    ;(api.exportLocateTarget as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: null
    })
    await store.locate('a')
    expect(store.locateErrors.a).toBeUndefined()
  })
})
