// @vitest-environment happy-dom
// Prepare for offline (#592): the store follows the progress events, survives
// the panel being closed and reopened mid-run, and reads "Last prepared" from
// `prepareOfflineLastRun`; the panel renders the steps and links details to
// the title's page.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

type Listener = (run: PrepareOfflineRun) => void

let listeners: Listener[]
let state: PrepareOfflineState
let api: {
  prepareOfflineStart: ReturnType<typeof vi.fn>
  prepareOfflineCancel: ReturnType<typeof vi.fn>
  prepareOfflineGetState: ReturnType<typeof vi.fn>
  onPrepareOfflineProgress: (cb: Listener) => () => void
}

function step(over: Partial<PrepareOfflineStepState>): PrepareOfflineStepState {
  return {
    id: 'metadata',
    label: 'Library metadata',
    state: 'pending',
    done: 0,
    total: 0,
    details: [],
    ...over
  }
}

function run(over: Partial<PrepareOfflineRun> = {}): PrepareOfflineRun {
  return { runId: 'r1', startedAt: 10, finishedAt: null, cancelled: false, steps: [], ...over }
}

function emit(next: PrepareOfflineRun): void {
  for (const l of listeners) l(next)
}

beforeEach(() => {
  listeners = []
  state = { running: false, run: null, lastRun: null }
  api = {
    prepareOfflineStart: vi.fn(async () => ({ runId: 'r1' })),
    prepareOfflineCancel: vi.fn(async () => true),
    prepareOfflineGetState: vi.fn(async () => state),
    onPrepareOfflineProgress: (cb) => {
      listeners.push(cb)
      return () => {}
    }
  }
  ;(window as unknown as { api: unknown }).api = api
  setActivePinia(createPinia())
  vi.resetModules()
})

async function load() {
  const mod = await import('../../src/renderer/src/stores/prepare-offline')
  const store = mod.usePrepareOfflineStore()
  await flushPromises()
  return store
}

describe('usePrepareOfflineStore', () => {
  it('subscribes once and follows the progress events', async () => {
    const store = await load()
    expect(listeners).toHaveLength(1)
    await store.start()
    expect(api.prepareOfflineStart).toHaveBeenCalledTimes(1)
    expect(store.panelOpen).toBe(true)
    expect(store.running).toBe(true)

    emit(run({ steps: [step({ state: 'running', done: 1, total: 3 })] }))
    expect(store.run?.steps[0].done).toBe(1)
    emit(
      run({
        finishedAt: 99,
        steps: [step({ state: 'done', status: 'warning', done: 3, total: 3 })]
      })
    )
    expect(store.running).toBe(false)
    expect(store.lastRun).toEqual({
      finishedAt: 99,
      cancelled: false,
      steps: [{ id: 'metadata', label: 'Library metadata', status: 'warning' }]
    })
  })

  it('survives the panel being closed and reopened mid-run', async () => {
    const store = await load()
    await store.start()
    emit(run({ steps: [step({ state: 'running', done: 1, total: 5 })] }))
    store.closePanel()
    expect(store.panelOpen).toBe(false)
    // Reopened with no event in between: the run is still there.
    store.openPanel()
    expect(store.run?.steps[0].done).toBe(1)
    expect(store.running).toBe(true)
    store.closePanel()
    // Events keep coming while the panel is closed.
    emit(run({ steps: [step({ state: 'running', done: 4, total: 5 })] }))
    store.openPanel()
    expect(store.panelOpen).toBe(true)
    expect(store.run?.steps[0].done).toBe(4)
    expect(store.running).toBe(true)
  })

  it('a run already going when the store is created is picked up from get-state', async () => {
    state = { running: true, run: run({ steps: [step({ state: 'running' })] }), lastRun: null }
    const store = await load()
    expect(store.running).toBe(true)
    expect(store.run?.runId).toBe('r1')
  })

  it('"Last prepared" comes from prepareOfflineLastRun after a restart', async () => {
    state = {
      running: false,
      run: null,
      lastRun: { finishedAt: Date.now() - 3 * 24 * 60 * 60 * 1000, cancelled: false, steps: [] }
    }
    const store = await load()
    expect(store.lastPreparedText).toBe('Last prepared 3 d ago')
  })

  it('never prepared', async () => {
    const store = await load()
    expect(store.lastPreparedText).toBe('Never prepared')
  })

  it('a late event from an older run does not replace the newer one', async () => {
    const store = await load()
    emit(run({ runId: 'r2', startedAt: 20 }))
    emit(run({ runId: 'r1', startedAt: 10 }))
    expect(store.run?.runId).toBe('r2')
  })

  it('a failed start clears running and rethrows', async () => {
    api.prepareOfflineStart.mockRejectedValueOnce(new Error('nope'))
    const store = await load()
    await expect(store.start()).rejects.toThrow('nope')
    expect(store.running).toBe(false)
  })

  it('cancel asks main', async () => {
    const store = await load()
    await store.cancel()
    expect(api.prepareOfflineCancel).toHaveBeenCalledTimes(1)
  })
})

describe('PrepareOfflinePanel', () => {
  it('renders each step, expands details, and a detail with a title opens its page', async () => {
    const store = await load()
    const { default: Panel } =
      await import('../../src/renderer/src/components/settings/PrepareOfflinePanel.vue')
    const { useLibraryStore } = await import('../../src/renderer/src/stores/library')
    const library = useLibraryStore()
    store.openPanel()
    emit(
      run({
        finishedAt: 50,
        steps: [
          step({
            id: 'local-integrity',
            label: 'Downloaded episodes',
            state: 'done',
            status: 'warning',
            details: [
              { text: '1 of 2 episodes ok', status: 'warning' },
              { text: 'Show episode 2: the video file is missing', status: 'warning', animeId: 10 }
            ]
          }),
          step({
            id: 'attached-integrity',
            label: 'Shared Libraries',
            state: 'done',
            status: 'unavailable',
            reason: 'No Shared Library attached'
          })
        ]
      })
    )
    const w = mount(Panel)
    await flushPromises()
    const rows = w.findAll('.po-step')
    expect(rows.map((r) => r.attributes('data-status'))).toEqual(['warning', 'unavailable'])
    expect(rows[0].find('.po-status').text()).toBe('Needs attention')
    expect(rows[1].find('.po-status').text()).toBe('Not available')
    expect(rows[1].find('.po-reason').text()).toBe('No Shared Library attached')

    await rows[0].find('button').trigger('click')
    const link = w.find('.po-details a')
    expect(link.text()).toBe('Show episode 2: the video file is missing')
    await link.trigger('click')
    expect(store.panelOpen).toBe(false)
    expect(library.currentView).toBe('library')
    expect(library.animeByView.library).toBe(10)
  })

  it('Start while idle, Cancel while running', async () => {
    const store = await load()
    const { default: Panel } =
      await import('../../src/renderer/src/components/settings/PrepareOfflinePanel.vue')
    const w = mount(Panel)
    await w.find('[data-testid="prepare-offline-run"]').trigger('click')
    expect(api.prepareOfflineStart).toHaveBeenCalledTimes(1)
    emit(run({ steps: [step({ state: 'running', done: 2, total: 4 })] }))
    await flushPromises()
    expect(w.find('.po-status').text()).toBe('2 / 4')
    await w.find('[data-testid="prepare-offline-cancel"]').trigger('click')
    expect(api.prepareOfflineCancel).toHaveBeenCalledTimes(1)
    expect(store.running).toBe(true)
  })
})
