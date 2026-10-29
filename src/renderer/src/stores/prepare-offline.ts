// Prepare for offline (#592), mirrored from main's PrepareOfflineService.
//
// One subscription for the app's lifetime (Pinia singleton), seeded from
// `prepare-offline:get-state`, so the panel can be closed and reopened while a
// run goes on and still shows where it is.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { formatAgo } from '../utils'

export const STATUS_TEXT: Record<PrepareOfflineStatus | 'unavailable', string> = {
  ok: 'Ready',
  warning: 'Needs attention',
  failed: 'Failed',
  skipped: 'Skipped',
  unavailable: 'Not available'
}

export const usePrepareOfflineStore = defineStore('prepare-offline', () => {
  const run = ref<PrepareOfflineRun | null>(null)
  const lastRun = ref<PrepareOfflineLastRun | null>(null)
  const running = ref(false)
  const panelOpen = ref(false)

  function apply(next: PrepareOfflineRun): void {
    // An older run's late event never replaces a newer one.
    if (run.value && next.runId !== run.value.runId && next.startedAt < run.value.startedAt) return
    run.value = next
    running.value = next.finishedAt === null
    if (next.finishedAt !== null) {
      lastRun.value = {
        finishedAt: next.finishedAt,
        cancelled: next.cancelled,
        steps: next.steps.map((s) => ({ id: s.id, label: s.label, status: s.status ?? 'skipped' }))
      }
    }
  }

  async function refresh(): Promise<void> {
    const state = await window.api.prepareOfflineGetState()
    // A progress event that arrived meanwhile is newer than this answer.
    if (run.value) return
    lastRun.value = state.lastRun
    running.value = state.running
    run.value = state.run
  }

  async function start(): Promise<void> {
    panelOpen.value = true
    running.value = true
    try {
      await window.api.prepareOfflineStart()
    } catch (err) {
      running.value = false
      throw err
    }
  }

  async function cancel(): Promise<void> {
    await window.api.prepareOfflineCancel()
  }

  function openPanel(): void {
    panelOpen.value = true
  }

  function closePanel(): void {
    panelOpen.value = false
  }

  const lastPreparedText = computed(() =>
    lastRun.value ? `Last prepared ${formatAgo(lastRun.value.finishedAt)}` : 'Never prepared'
  )

  void window.api.onPrepareOfflineProgress((next) => apply(next))
  void refresh().catch(() => {})

  return {
    run,
    lastRun,
    running,
    panelOpen,
    lastPreparedText,
    refresh,
    start,
    cancel,
    openPanel,
    closePanel
  }
})
