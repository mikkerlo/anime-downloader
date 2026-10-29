// Copy to this PC jobs (#579), mirrored from main's import service.
//
// One subscription for the app's lifetime (Pinia singleton, disposer
// discarded), seeded from `import:list-jobs`, so the Downloads job card and the
// duplicate prompt show a job started from any view.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useImportStore = defineStore('import', () => {
  const jobs = ref<ImportJobView[]>([])

  const activeJob = computed(
    () =>
      jobs.value.find(
        (j) =>
          j.status === 'running' ||
          j.status === 'held' ||
          j.status === 'waiting-drive' ||
          j.status === 'waiting-duplicate'
      ) ?? null
  )

  /** The job waiting on the duplicate prompt, with its question. */
  const asking = computed(
    () => jobs.value.find((j) => j.status === 'waiting-duplicate' && j.duplicate) ?? null
  )

  /** Episodes registered so far, across jobs: Library reloads when it grows. */
  const itemsDone = computed(() => jobs.value.reduce((n, j) => n + j.itemsDone, 0))

  function upsert(job: ImportJobView): void {
    const i = jobs.value.findIndex((j) => j.jobId === job.jobId)
    if (i < 0) jobs.value = [job, ...jobs.value]
    else jobs.value = jobs.value.map((j, k) => (k === i ? job : j))
  }

  function drop(jobId: string): void {
    jobs.value = jobs.value.filter((j) => j.jobId !== jobId)
  }

  async function refresh(): Promise<void> {
    const list = await window.api.importListJobs()
    // Library and Downloads mount this store; a view's test stub may answer anything.
    jobs.value = Array.isArray(list) ? list : []
  }

  async function start(req: ImportStartRequest): Promise<ImportStartResult> {
    const result = await window.api.importStart(req)
    if (result.ok) upsert(result.job)
    return result
  }

  async function answer(jobId: string, a: ImportDuplicateAnswer): Promise<void> {
    const job = await window.api.importResolveDuplicate(jobId, a)
    if (job) upsert(job)
  }

  async function pause(jobId: string): Promise<void> {
    const job = await window.api.importPause(jobId)
    if (job) upsert(job)
  }

  async function resume(jobId: string): Promise<void> {
    const job = await window.api.importResume(jobId)
    if (job) upsert(job)
  }

  /** Cancels a running job, or dismisses a finished one. */
  async function cancel(jobId: string): Promise<void> {
    const job = await window.api.importCancel(jobId)
    if (job) upsert(job)
    else drop(jobId)
  }

  void window.api.onImportJobUpdated(upsert)
  void refresh().catch(() => {})

  return { jobs, activeJob, asking, itemsDone, refresh, start, answer, pause, resume, cancel }
})
