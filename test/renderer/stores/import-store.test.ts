// The copy-to-this-PC jobs store (#579): seeded from `import:list-jobs`, kept
// live by `import:job-updated`; the duplicate prompt reads `asking`, Library
// reloads on `itemsDone`, and Cancel on a finished job dismisses it.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useImportStore } from '../../../src/renderer/src/stores/import'

function job(id: string, status: ImportJobStatus = 'running', over: Partial<ImportJobView> = {}) {
  const view: ImportJobView = {
    jobId: id,
    libraryId: 'lib',
    libraryName: 'Trip',
    destination: 'hot',
    status,
    itemsDone: 1,
    itemsTotal: 4,
    bytesDone: 10,
    bytesTotal: 40,
    current: null,
    duplicate: null,
    failed: [],
    kept: [],
    note: null,
    error: null,
    createdAt: 1,
    ...over
  }
  return view
}

const PROMPT: ImportDuplicatePrompt = {
  key: '1:1:11',
  label: 'Alpha — E1',
  localSize: 612,
  driveSize: 668,
  canKeepBoth: false,
  canReplace: true
}

let listeners: ((j: ImportJobView) => void)[]
let api: Record<string, ReturnType<typeof vi.fn> | ((cb: (j: ImportJobView) => void) => () => void)>

beforeEach(() => {
  setActivePinia(createPinia())
  listeners = []
  api = {
    importListJobs: vi.fn(async () => [job('a', 'paused')]),
    importStart: vi.fn(async () => ({ ok: true, job: job('b') })),
    importPause: vi.fn(async (id: string) => job(id, 'paused')),
    importResume: vi.fn(async (id: string) => job(id, 'running')),
    importCancel: vi.fn(async (id: string) => (id === 'done' ? null : job(id, 'cancelled'))),
    importResolveDuplicate: vi.fn(async (id: string) => job(id, 'running', { itemsDone: 2 })),
    onImportJobUpdated: (cb: (j: ImportJobView) => void) => {
      listeners.push(cb)
      return () => {}
    }
  }
  ;(globalThis as { window?: { api: unknown } }).window = { api }
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('import store (#579)', () => {
  it('seeds from the list and applies broadcasts; a duplicate question is `asking`', async () => {
    const store = useImportStore()
    await flush()
    expect(store.jobs.map((j) => j.status)).toEqual(['paused'])
    expect(store.activeJob).toBeNull()
    expect(store.asking).toBeNull()
    listeners[0](job('a', 'waiting-duplicate', { duplicate: PROMPT }))
    expect(store.activeJob?.jobId).toBe('a')
    expect(store.asking?.duplicate).toEqual(PROMPT)
    listeners[0](job('c', 'held', { itemsDone: 3 }))
    expect(store.jobs.map((j) => j.jobId)).toEqual(['c', 'a'])
    expect(store.itemsDone).toBe(4)
  })

  it('answer sends the choice and applies the job it gets back', async () => {
    const store = useImportStore()
    await flush()
    listeners[0](job('a', 'waiting-duplicate', { duplicate: PROMPT }))
    await store.answer('a', { choice: 'replace', applyToAll: true })
    expect(api.importResolveDuplicate).toHaveBeenCalledWith('a', {
      choice: 'replace',
      applyToAll: true
    })
    expect(store.asking).toBeNull()
    expect(store.jobs[0].itemsDone).toBe(2)
  })

  it('start, pause, resume and cancel update the list; cancel on a finished job dismisses it', async () => {
    const store = useImportStore()
    await flush()
    const r = await store.start({ libraryId: 'lib', selection: [], destination: 'hot' })
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
    ;(api.importStart as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: 'no'
    })
    const store = useImportStore()
    await flush()
    expect(await store.start({ libraryId: 'lib', selection: [], destination: 'cold' })).toEqual({
      ok: false,
      reason: 'no'
    })
    expect(store.jobs).toHaveLength(1)
  })
})
