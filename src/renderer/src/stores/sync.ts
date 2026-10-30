// The merge's results for the user (#585): the toast after a run, the held
// conflicts behind the review sheet and the badges, and pages of the
// read-only sync history. There is no undo.
//
// One `sync:run-finished` subscription for the app's lifetime (App.vue creates
// the store); it is dropped when the store's scope is disposed.

import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useSharedLibrariesStore } from './shared-libraries'

export const TOAST_MS = 8000

export interface SyncToastState {
  libraryIds: string[]
  applied: number
  // Whether a run in this toast found conflicts; the count shown is the review sheet's.
  conflicts: boolean
  manual: boolean
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function libraryList(names: string[]): string {
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.length} libraries`
}

/** The toast's line, or null when there is nothing to say. */
export function toastText(t: SyncToastState, names: string[], needInput: number): string | null {
  if (t.conflicts && needInput > 0) {
    return `Synced with ${libraryList(names)}: ${plural(t.applied, 'update', 'updates')}, ${needInput} need${needInput === 1 ? 's' : ''} your input`
  }
  if (t.applied > 0) {
    return `Synced with ${libraryList(names)}: ${plural(t.applied, 'update', 'updates')}`
  }
  return t.manual ? 'Everything is up to date' : null
}

export const useSyncStore = defineStore('sync', () => {
  const conflicts = ref<SyncConflictItem[]>([])
  const toast = ref<SyncToastState | null>(null)
  const lastRuns = ref<SyncRunResult[]>([])
  const reviewOpen = ref(false)
  const history = ref<{
    libraryId: string | null
    entries: SyncHistoryEntry[]
    nextBefore: number | null
    loading: boolean
  } | null>(null)
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  const shared = useSharedLibrariesStore()

  const conflictCount = computed(() => conflicts.value.length)

  function libraryName(libraryId: string): string {
    return shared.libraries.find((l) => l.libraryId === libraryId)?.name ?? 'Shared Library'
  }

  const toastLine = computed(() =>
    toast.value
      ? toastText(toast.value, toast.value.libraryIds.map(libraryName), conflicts.value.length)
      : null
  )

  async function loadConflicts(): Promise<void> {
    const list = await window.api.syncListConflicts()
    conflicts.value = Array.isArray(list) ? list : []
  }

  function dismissToast(): void {
    toast.value = null
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = null
  }

  /** One run's result into the toast; runs arriving while it shows coalesce into it. */
  async function onRunFinished(result: SyncRunResult): Promise<void> {
    if (!result || !Array.isArray(result.libraries)) return
    lastRuns.value = [result, ...lastRuns.value].slice(0, 10)
    const synced = result.libraries.filter((l) => l.drive === 'ok' || l.shikimori === 'ok')
    const applied = result.libraries.reduce((n, l) => n + l.counts.applied, 0)
    const found = result.libraries.some((l) => l.counts.conflicts > 0)
    await loadConflicts().catch(() => {})
    if (synced.length === 0 && applied === 0 && !found) return
    const manual = result.trigger === 'manual'
    if (applied === 0 && !found && !manual && !toast.value) return
    const prev = toast.value
    toast.value = {
      libraryIds: [...new Set([...(prev?.libraryIds ?? []), ...synced.map((l) => l.libraryId)])],
      applied: (prev?.applied ?? 0) + applied,
      conflicts: (prev?.conflicts ?? false) || found,
      manual: (prev?.manual ?? false) || manual
    }
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(dismissToast, TOAST_MS)
  }

  function openReview(): void {
    dismissToast()
    reviewOpen.value = true
    void loadConflicts().catch(() => {})
  }

  function closeReview(): void {
    reviewOpen.value = false
  }

  /** Applies the choices; resolved rows leave the list (and the badges). */
  async function resolve(choices: Record<string, SyncConflictChoice>): Promise<SyncResolveResult> {
    // Plain data across IPC: a picked choice is a reactive proxy, which can't be cloned.
    const plain = JSON.parse(JSON.stringify(choices)) as Record<string, SyncConflictChoice>
    const ids = Object.keys(plain)
    const res = await window.api.syncResolve(ids, plain)
    const gone = new Set(res?.resolved ?? [])
    conflicts.value = conflicts.value.filter((c) => !gone.has(c.id))
    await loadConflicts().catch(() => {})
    void shared.refreshSyncStatus().catch(() => {})
    return res
  }

  async function openHistory(libraryId: string | null = null): Promise<void> {
    dismissToast()
    history.value = { libraryId, entries: [], nextBefore: null, loading: true }
    await loadMoreHistory(true)
  }

  async function loadMoreHistory(first = false): Promise<void> {
    const h = history.value
    if (!h || (!first && h.nextBefore === null)) return
    h.loading = true
    try {
      const page = await window.api.syncListHistory({
        ...(first ? {} : { before: h.nextBefore! }),
        ...(h.libraryId ? { libraryId: h.libraryId } : {})
      })
      if (history.value !== h) return
      h.entries = [...h.entries, ...(page?.entries ?? [])]
      h.nextBefore = page?.nextBefore ?? null
    } finally {
      h.loading = false
    }
  }

  function closeHistory(): void {
    history.value = null
  }

  const unsubRun = window.api.onSyncRunFinished((r) => void onRunFinished(r))
  // Forget drops a library's party from the held conflicts: re-read on every list change.
  watch(
    () => shared.libraries,
    () => void loadConflicts().catch(() => {})
  )
  onScopeDispose(() => {
    unsubRun?.()
    if (toastTimer) clearTimeout(toastTimer)
  })
  void loadConflicts().catch(() => {})

  return {
    conflicts,
    conflictCount,
    toast,
    toastLine,
    lastRuns,
    reviewOpen,
    history,
    loadConflicts,
    onRunFinished,
    dismissToast,
    openReview,
    closeReview,
    resolve,
    openHistory,
    loadMoreHistory,
    closeHistory,
    libraryName
  }
})
