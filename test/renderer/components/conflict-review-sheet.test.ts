// @vitest-environment happy-dom
//
// The review sheet, the toast and the history (#585): four columns with the
// uninvolved parties greyed, the Shikimori-side row, "Apply all suggested",
// the rewatch question, and a read-only history with no undo.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ConflictReviewSheet from '../../../src/renderer/src/components/sync/ConflictReviewSheet.vue'
import SyncHistory from '../../../src/renderer/src/components/sync/SyncHistory.vue'
import SyncToast from '../../../src/renderer/src/components/sync/SyncToast.vue'
import { useSyncStore } from '../../../src/renderer/src/stores/sync'

// A sheet left mounted keeps its window Escape listener, which would take a later test's Escape.
enableAutoUnmount(afterEach)

const LIB = 'lib-a'
const party = (p: string): SyncConflictChoice => ({ kind: 'party', party: p })

function item(id: string, over: Partial<SyncConflictItem> = {}): SyncConflictItem {
  return {
    id,
    ownerScope: 1,
    animeId: '101',
    fieldPath: 'rate.score',
    parties: { local: 8, shikimori: 9 },
    bases: { shikimori: 7 },
    at: {},
    suggestion: 'shikimori',
    reason: 'changed on both sides, to different values',
    firstSeenRunId: 'r',
    lastSeenRunId: 'r',
    title: { name: 'Frieren', poster: null, episodes: 28 },
    libraries: [{ libraryId: LIB, name: 'Drive', involved: false, available: true }],
    options: [
      { choice: party('local'), value: 8 },
      { choice: party('shikimori'), value: 9 }
    ],
    rewatchQuestion: false,
    ...over
  }
}

let held: SyncConflictItem[]
let api: Record<string, ReturnType<typeof vi.fn> | unknown>

function stubApi(over: Record<string, unknown> = {}): void {
  api = {
    syncListConflicts: vi.fn(async () => held),
    syncResolve: vi.fn(async (ids: string[]) => {
      held = held.filter((c) => !ids.includes(c.id))
      return { resolved: ids, failed: [], notes: [] }
    }),
    ...over
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  held = []
  stubApi()
})

async function mountSheet() {
  const w = mount(ConflictReviewSheet)
  await useSyncStore().loadConflicts()
  await flushPromises()
  return w
}

const cols = (row: ReturnType<ReturnType<typeof mount>['find']>) =>
  ['col-before', 'col-local', 'col-library', 'col-shikimori'].map((t) => {
    const c = row.find(`[data-testid="${t}"]`)
    const parts = [c.find('.col-head'), ...c.findAll('.col-value')].map((x) => x.text())
    return [parts.join(' '), c.attributes('data-involved')]
  })

describe('the review sheet', () => {
  it('a three-party row renders four columns, every party involved; Before shows both bases, labelled, when they differ', async () => {
    held = [
      item('c1', {
        parties: { local: 6, [`library:${LIB}`]: 8, shikimori: 9 },
        bases: { [`library:${LIB}`]: 7, shikimori: 5 },
        libraries: [{ libraryId: LIB, name: 'Drive', involved: true, available: true }]
      })
    ]
    const w = await mountSheet()
    expect(w.find('[data-testid="review-title"]').text()).toBe('Needs your input (1)')
    expect(w.find('[data-testid="conflict-title"]').text()).toContain('Frieren')
    expect(cols(w.find('[data-testid="conflict-row"]'))).toEqual([
      ['Before Drive: ★ 7 Shikimori: ★ 5', 'true'],
      ['This PC ★ 6', 'true'],
      ['Shared Library ★ 8', 'true'],
      ['Shikimori ★ 9', 'true']
    ])
  })

  it('the Shikimori-side row: the Shikimori column active, the Shared Library greyed and equal to This PC', async () => {
    held = [item('c1')]
    const w = await mountSheet()
    const row = w.find('[data-testid="conflict-row"]')
    expect(cols(row)).toEqual([
      ['Before ★ 7', 'true'],
      ['This PC ★ 8', 'true'],
      ['Shared Library ★ 8', 'false'],
      ['Shikimori ★ 9', 'true']
    ])
    expect(row.find('[data-testid="col-library"]').classes()).toContain('uninvolved')
    expect(row.findAll('[data-testid="conflict-choice"]').map((c) => c.text())).toEqual([
      'Keep mine · ★ 8',
      'Keep theirs (Shikimori) · ★ 9newest'
    ])
  })

  it('a library-only row greys Shikimori; no library at all greys the Shared Library column', async () => {
    held = [
      item('c1', {
        fieldPath: 'rate.episodes',
        parties: { local: 6, [`library:${LIB}`]: 3 },
        bases: { [`library:${LIB}`]: 4 },
        libraries: [{ libraryId: LIB, name: 'Drive', involved: true, available: true }],
        options: [
          { choice: party('local'), value: 6 },
          { choice: party(`library:${LIB}`), value: 3 },
          { choice: { kind: 'combine' }, value: 6 }
        ],
        suggestion: null
      }),
      item('c2', {
        animeId: '102',
        libraries: [],
        title: { name: 'Dandadan', poster: null, episodes: null }
      })
    ]
    const w = await mountSheet()
    const [a, b] = w.findAll('[data-testid="conflict-row"]')
    expect(cols(a)).toEqual([
      ['Before 4 / 28', 'true'],
      ['This PC 6 / 28', 'true'],
      ['Shared Library 3 / 28', 'true'],
      ['Shikimori —', 'false']
    ])
    expect(a.findAll('[data-testid="conflict-choice"]').map((c) => c.text())).toEqual([
      'Keep mine · 6 / 28',
      'Keep theirs (Drive) · 3 / 28',
      'Combine · 6 / 28'
    ])
    expect(cols(b)[2]).toEqual(['Shared Library —', 'false'])
  })

  it('"Apply all suggested" resolves each row with its suggestion and leaves the rows without one, saying how many', async () => {
    held = [
      item('c1'),
      item('c2', {
        fieldPath: 'rate.status',
        suggestion: 'local',
        parties: { local: 'completed', shikimori: 'watching' }
      }),
      item('c3', { fieldPath: 'rate.episodes', suggestion: null }),
      item('c4', {
        fieldPath: 'rate.rewatches',
        suggestion: null,
        rewatchQuestion: true,
        parties: { local: 3, shikimori: 3 },
        options: [
          { choice: { kind: 'rewatches', count: 1 }, value: 3 },
          { choice: { kind: 'rewatches', count: 2 }, value: 4 }
        ]
      })
    ]
    const w = await mountSheet()
    await w.find('[data-testid="apply-suggested"]').trigger('click')
    await flushPromises()
    expect(api.syncResolve).toHaveBeenCalledWith(['c1', 'c2'], {
      c1: party('shikimori'),
      c2: party('local')
    })
    expect(w.find('[data-testid="review-message"]').text()).toBe('2 rows need a choice')
    expect(w.find('[data-testid="review-title"]').text()).toBe('Needs your input (2)')
  })

  it('the rewatch question renders One / Two with no suggestion, and Apply sends the pick', async () => {
    held = [
      item('c4', {
        fieldPath: 'rate.rewatches',
        suggestion: null,
        rewatchQuestion: true,
        parties: { local: 3, shikimori: 3 },
        bases: { shikimori: 2 },
        options: [
          { choice: { kind: 'rewatches', count: 1 }, value: 3 },
          { choice: { kind: 'rewatches', count: 2 }, value: 4 }
        ]
      })
    ]
    const w = await mountSheet()
    expect(w.find('[data-testid="rewatch-question"]').text()).toBe('Was this one rewatch or two?')
    const choices = w.findAll('[data-testid="conflict-choice"]')
    expect(choices.map((c) => c.text())).toEqual(['One · 3', 'Two · 4'])
    expect(w.find('[data-testid="suggested"]').exists()).toBe(false)
    expect(w.find('[data-testid="apply-picked"]').attributes('disabled')).toBeDefined()
    await choices[1].find('input').setValue(true)
    await w.find('[data-testid="apply-picked"]').trigger('click')
    await flushPromises()
    expect(api.syncResolve).toHaveBeenCalledWith(['c4'], { c4: { kind: 'rewatches', count: 2 } })
    expect(w.find('[data-testid="review-empty"]').exists()).toBe(true)
  })

  it('never says undo', async () => {
    held = [item('c1')]
    const w = await mountSheet()
    expect(w.text()).not.toMatch(/undo/i)
    expect(w.text()).toContain('You can change any of these later from the title page')
  })
})

describe('while Apply runs (review of #637)', () => {
  it('Escape and a backdrop click keep the sheet open, so the result notes are shown', async () => {
    held = [item('c1')]
    let finish!: (r: SyncResolveResult) => void
    stubApi({
      syncResolve: vi.fn(() => new Promise<SyncResolveResult>((res) => (finish = res)))
    })
    const sync = useSyncStore()
    sync.reviewOpen = true
    const w = mount(ConflictReviewSheet, { attachTo: document.body })
    await sync.loadConflicts()
    await flushPromises()
    await w.find('[data-testid="apply-suggested"]').trigger('click')
    await flushPromises()

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await w.find('[data-testid="conflict-review-backdrop"]').trigger('click')
    expect(sync.reviewOpen).toBe(true)

    finish({
      resolved: ['c1'],
      failed: [],
      notes: [{ id: 'c1', text: "Drive isn't connected. It gets this choice on its next sync." }]
    })
    await flushPromises()
    expect(sync.reviewOpen).toBe(true)
    expect(w.findAll('[data-testid="review-note"]').map((n) => n.text())).toEqual([
      "Drive isn't connected. It gets this choice on its next sync."
    ])
    // Once it's done, Escape closes it as before.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(sync.reviewOpen).toBe(false)
  })
})

describe('the toast', () => {
  it('Review opens the review sheet', async () => {
    held = [item('c1')]
    const w = mount(SyncToast)
    const s = useSyncStore()
    await s.onRunFinished({
      runId: 'r',
      trigger: 'manual',
      libraries: [
        {
          libraryId: LIB,
          drive: 'ok',
          shikimori: 'ok',
          counts: { applied: 0, conflicts: 1, clamped: 0 },
          waitingMalIds: [],
          rewatchesSuperseded: 0
        }
      ]
    })
    await flushPromises()
    expect(w.find('[data-testid="sync-toast-text"]').text()).toBe(
      'Synced with Shared Library: 0 updates, 1 needs your input'
    )
    await w.find('[data-testid="sync-toast-review"]').trigger('click')
    expect(s.reviewOpen).toBe(true)
    expect(s.toast).toBeNull()
  })
})

describe('the history', () => {
  const entry = (key: string, at: number, details: string[] = []): SyncHistoryEntry => ({
    key,
    kind: 'run',
    at,
    trigger: 'plug',
    libraries: [{ libraryId: LIB, name: 'Drive' }],
    summary: `Drive connected: ${key}`,
    details
  })

  it('pages with Show older and expands an entry; no undo control is rendered', async () => {
    const pages: SyncHistoryPage[] = [
      {
        entries: [
          entry('a', 3000, ['Frieren: Ep 5 position 12:30 → 18:02 from Drive']),
          entry('b', 2000)
        ],
        nextBefore: 2000
      },
      { entries: [entry('c', 1000)], nextBefore: null }
    ]
    const listHistory = vi.fn(async () => pages.shift()!)
    stubApi({ syncListHistory: listHistory })
    const w = mount(SyncHistory)
    await useSyncStore().openHistory(LIB)
    await flushPromises()
    expect(listHistory).toHaveBeenCalledWith({ libraryId: LIB })
    expect(w.findAll('[data-testid="history-entry"]')).toHaveLength(2)
    expect(w.find('[data-testid="history-details"]').exists()).toBe(false)
    await w.findAll('[data-testid="history-expand"]')[0].trigger('click')
    expect(w.find('[data-testid="history-details"]').text()).toBe(
      'Frieren: Ep 5 position 12:30 → 18:02 from Drive'
    )
    await w.find('[data-testid="history-more"]').trigger('click')
    await flushPromises()
    expect(listHistory).toHaveBeenLastCalledWith({ before: 2000, libraryId: LIB })
    expect(
      w.findAll('[data-testid="history-entry"]').map((e) => e.attributes('data-kind'))
    ).toEqual(['run', 'run', 'run'])
    expect(w.find('[data-testid="history-more"]').exists()).toBe(false)
    // Read-only: the only buttons are the expanders and Close.
    const buttons = w.findAll('button').map((b) => b.text())
    expect(buttons.filter((t) => t !== 'Close' && !t.includes('Drive connected'))).toEqual([])
    expect(w.text()).not.toMatch(/undo|revert/i)
  })
})
