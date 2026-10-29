// @vitest-environment happy-dom
//
// The sync store (#585): held conflicts and resolve, the toast after a run
// (coalesced, a manual run's "Everything is up to date", nothing for an
// automatic run with nothing to report), and its one subscription.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { TOAST_MS, toastText, useSyncStore } from '../../../src/renderer/src/stores/sync'

function conflict(id: string, over: Partial<SyncConflictItem> = {}): SyncConflictItem {
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
    libraries: [],
    options: [
      { choice: { kind: 'party', party: 'local' }, value: 8 },
      { choice: { kind: 'party', party: 'shikimori' }, value: 9 }
    ],
    rewatchQuestion: false,
    ...over
  }
}

function lib(libraryId: string, over: Partial<SyncLibraryResult> = {}): SyncLibraryResult {
  return {
    libraryId,
    drive: 'ok',
    shikimori: 'ok',
    counts: { applied: 0, conflicts: 0, clamped: 0 },
    waitingMalIds: [],
    rewatchesSuperseded: 0,
    ...over
  }
}

const run = (trigger: SyncTrigger, libraries: SyncLibraryResult[]): SyncRunResult => ({
  runId: 'r',
  trigger,
  libraries
})

let held: SyncConflictItem[]
// Every `sync:run-finished` subscriber (the shared-libraries store has one too).
let subs: { cb: (r: SyncRunResult) => void; unsub: ReturnType<typeof vi.fn> }[]
const runFinished = (r: SyncRunResult): void => subs.forEach((s) => s.cb(r))
let api: Record<string, unknown>

beforeEach(() => {
  setActivePinia(createPinia())
  held = []
  subs = []
  api = {
    syncListConflicts: vi.fn(async () => held),
    syncResolve: vi.fn(async (ids: string[]) => {
      held = held.filter((c) => !ids.includes(c.id))
      return { resolved: ids, failed: [], notes: [] }
    }),
    onSyncRunFinished: (cb: (r: SyncRunResult) => void) => {
      const unsub = vi.fn()
      subs.push({ cb, unsub })
      return unsub
    },
    sharedLibraryList: vi.fn(async () => [
      { libraryId: 'a', name: 'Drive' },
      { libraryId: 'b', name: 'Stick' }
    ])
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get: (target, prop, recv) => (prop in target ? Reflect.get(target, prop, recv) : () => () => {})
  })
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

describe('conflicts', () => {
  it('load on start, and resolve removes the resolved rows (the badge count drops)', async () => {
    held = [conflict('c1'), conflict('c2')]
    const s = useSyncStore()
    await settle()
    expect(s.conflictCount).toBe(2)
    const res = await s.resolve({ c1: { kind: 'party', party: 'local' } })
    expect(api.syncResolve).toHaveBeenCalledWith(['c1'], { c1: { kind: 'party', party: 'local' } })
    expect(res.resolved).toEqual(['c1'])
    expect(s.conflicts.map((c) => c.id)).toEqual(['c2'])
    expect(s.conflictCount).toBe(1)
  })

  it('sends plain choices: a picked choice is reactive, and IPC cannot clone a proxy', async () => {
    held = [conflict('c1')]
    const s = useSyncStore()
    await settle()
    const picked = reactive<Record<string, SyncConflictChoice>>({
      c1: { kind: 'party', party: 'local' }
    })
    expect(() => structuredClone(picked.c1)).toThrow()
    await s.resolve({ c1: picked.c1 })
    const [, sent] = (api.syncResolve as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(structuredClone(sent)).toEqual({ c1: { kind: 'party', party: 'local' } })
  })
})

describe('the toast', () => {
  it('coalesces two runs into one toast, naming both libraries, with Review for the held conflicts', async () => {
    const s = useSyncStore()
    await settle()
    runFinished(run('plug', [lib('a', { counts: { applied: 2, conflicts: 0, clamped: 0 } })]))
    await settle()
    held = [conflict('c1')]
    runFinished(run('plug', [lib('b', { counts: { applied: 1, conflicts: 1, clamped: 0 } })]))
    await settle()
    expect(s.toast).toEqual({ libraryIds: ['a', 'b'], applied: 3, conflicts: true, manual: false })
    expect(s.toastLine).toBe('Synced with Drive and Stick: 3 updates, 1 needs your input')
    vi.advanceTimersByTime(TOAST_MS)
    expect(s.toast).toBeNull()
  })

  it('a manual run with nothing to do says "Everything is up to date"; an automatic one shows nothing', async () => {
    const s = useSyncStore()
    await settle()
    runFinished(run('plug', [lib('a')]))
    await settle()
    expect(s.toast).toBeNull()
    runFinished(run('manual', [lib('a')]))
    await settle()
    expect(s.toastLine).toBe('Everything is up to date')
  })

  it('updates only say "N updates" (Details)', () => {
    expect(
      toastText({ libraryIds: ['a'], applied: 1, conflicts: false, manual: false }, ['Drive'], 0)
    ).toBe('Synced with Drive: 1 update')
    expect(
      toastText(
        { libraryIds: ['a', 'b', 'c'], applied: 4, conflicts: true, manual: true },
        ['A', 'B', 'C'],
        2
      )
    ).toBe('Synced with 3 libraries: 4 updates, 2 need your input')
  })
})

describe('the subscription', () => {
  it('subscribes once and unsubscribes on teardown', async () => {
    const s = useSyncStore()
    const before = subs.length
    useSyncStore()
    await settle()
    expect(subs.length).toBe(before)
    // Its own subscription is the last one (the shared-libraries store it reads subscribes first).
    const own = subs.at(-1)!
    expect(own.unsub).not.toHaveBeenCalled()
    s.$dispose()
    expect(own.unsub).toHaveBeenCalledTimes(1)
  })
})
