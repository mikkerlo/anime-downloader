// @vitest-environment happy-dom
//
// Prepare for offline's sync finds conflicts (#585 review of #637): the toast
// after that run sits under the panel's backdrop, so the library step offers
// Review itself, its count is the sheet's (and the toast's), and the sheet
// opens above the panel.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import PrepareOfflinePanel from '../../../src/renderer/src/components/settings/PrepareOfflinePanel.vue'
import ConflictReviewSheet from '../../../src/renderer/src/components/sync/ConflictReviewSheet.vue'
import { usePrepareOfflineStore } from '../../../src/renderer/src/stores/prepare-offline'
import { toastText, useSyncStore } from '../../../src/renderer/src/stores/sync'

const LIB = 'lib-a'

function item(id: string, fieldPath: SyncConflictFieldPath): SyncConflictItem {
  return {
    id,
    ownerScope: 1,
    animeId: '101',
    fieldPath,
    // Held by both legs: one row in the sheet.
    parties: { local: 6, [`library:${LIB}`]: 8, shikimori: 9 },
    bases: { [`library:${LIB}`]: 7, shikimori: 7 },
    at: {},
    suggestion: null,
    reason: 'changed on both sides, to different values',
    firstSeenRunId: 'r',
    lastSeenRunId: 'r',
    title: { name: 'Frieren', poster: null, episodes: 28 },
    libraries: [{ libraryId: LIB, name: 'Drive', involved: true, available: true }],
    options: [
      { choice: { kind: 'party', party: 'local' }, value: 6 },
      { choice: { kind: 'party', party: `library:${LIB}` }, value: 8 }
    ],
    rewatchQuestion: false
  }
}

function run(): PrepareOfflineRun {
  return {
    runId: 'p1',
    startedAt: 1,
    finishedAt: 2,
    cancelled: false,
    steps: [
      {
        id: 'library-sync',
        label: 'Sync owned or claimed libraries',
        state: 'done',
        status: 'warning',
        done: 1,
        total: 1,
        details: [
          { text: 'Drive: Drive synced, 1 need review; Shikimori updated', status: 'warning' }
        ]
      }
    ]
  }
}

let held: SyncConflictItem[]

beforeEach(() => {
  setActivePinia(createPinia())
  held = [item('c1', 'rate.score')]
  const api: Record<string, unknown> = {
    syncListConflicts: vi.fn(async () => held),
    prepareOfflineGetState: vi.fn(async () => ({ running: false, run: null, lastRun: null }))
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
})

// App.vue's order: the review sheet is mounted before the panel.
const Host = defineComponent({
  setup() {
    const { reviewOpen } = storeToRefs(useSyncStore())
    return () => [reviewOpen.value ? h(ConflictReviewSheet) : null, h(PrepareOfflinePanel)]
  }
})

describe('Prepare for offline finds conflicts', () => {
  it("the library step's Review (the sheet's count, as in the toast) opens the sheet above the panel", async () => {
    const prepare = usePrepareOfflineStore()
    prepare.run = run()
    prepare.panelOpen = true
    const sync = useSyncStore()
    const w = mount(Host, { attachTo: document.body })
    await sync.loadConflicts()
    await flushPromises()

    const review = w.find('[data-testid="prepare-offline-review"]')
    expect(review.text()).toBe('Review (1)')
    // The toast's count for the same run is the same 1.
    expect(
      toastText({ libraryIds: [LIB], applied: 0, conflicts: true, manual: false }, ['Drive'], 1)
    ).toContain('1 needs your input')

    await review.trigger('click')
    await flushPromises()
    expect(sync.reviewOpen).toBe(true)
    const sheet = w.find('[data-testid="conflict-review-backdrop"]')
    expect(sheet.exists()).toBe(true)
    expect(w.find('[data-testid="review-title"]').text()).toBe('Needs your input (1)')
    // Mounted before the panel, so it must stack higher to be on top.
    const panel = w.find('.po-backdrop')
    expect(Number((sheet.element as HTMLElement).style.zIndex)).toBeGreaterThan(
      Number((panel.element as HTMLElement).style.zIndex)
    )
    w.unmount()
  })

  it('no Review while nothing is held', async () => {
    held = []
    const prepare = usePrepareOfflineStore()
    prepare.run = run()
    prepare.panelOpen = true
    const w = mount(Host)
    await useSyncStore().loadConflicts()
    await flushPromises()
    expect(w.find('[data-testid="prepare-offline-review"]').exists()).toBe(false)
  })
})
