// Shared Library export jobs (#574), mirrored from main's export service.
//
// One subscription for the app's lifetime (Pinia singleton, disposer
// discarded), seeded from `export:list-jobs`, so the Downloads job card shows
// a job started from any view.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useExportStore = defineStore('export', () => {
  const jobs = ref<ExportJobView[]>([])
  /** The last "Locate…" refusal, by job id. */
  const locateErrors = ref<Record<string, string>>({})

  const activeJob = computed(
    () =>
      jobs.value.find(
        (j) => j.status === 'running' || j.status === 'held' || j.status === 'waiting-drive'
      ) ?? null
  )

  function upsert(job: ExportJobView): void {
    const i = jobs.value.findIndex((j) => j.jobId === job.jobId)
    if (i < 0) jobs.value = [job, ...jobs.value]
    else jobs.value = jobs.value.map((j, k) => (k === i ? job : j))
  }

  function drop(jobId: string): void {
    jobs.value = jobs.value.filter((j) => j.jobId !== jobId)
  }

  async function refresh(): Promise<void> {
    jobs.value = await window.api.exportListJobs()
  }

  async function start(req: ExportStartRequest): Promise<ExportStartResult> {
    const result = await window.api.exportStart(req)
    if (result.ok) upsert(result.job)
    return result
  }

  async function pause(jobId: string): Promise<void> {
    const job = await window.api.exportPause(jobId)
    if (job) upsert(job)
  }

  async function resume(jobId: string): Promise<void> {
    const job = await window.api.exportResume(jobId)
    if (job) upsert(job)
  }

  /** Cancels a running job, or dismisses a finished one. */
  async function cancel(jobId: string): Promise<void> {
    const job = await window.api.exportCancel(jobId)
    if (job) upsert(job)
    else drop(jobId)
  }

  async function locate(jobId: string): Promise<void> {
    const r = await window.api.exportLocateTarget(jobId)
    const next = { ...locateErrors.value }
    if (r.ok || r.reason === null) delete next[jobId]
    else next[jobId] = r.reason
    locateErrors.value = next
  }

  void window.api.onExportJobUpdated(upsert)
  void refresh().catch(() => {})

  return { jobs, activeJob, locateErrors, refresh, start, pause, resume, cancel, locate }
})
