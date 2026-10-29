// Prepare for offline (#592): one action that runs an ordered list of steps,
// one at a time, single-flight and cancellable, and ends with a summary.
//
// A step whose `isAvailable()` says no is reported "Not available" with its
// reason and never runs. While offline, every `requiresNetwork` step is
// skipped and the local ones still run. One step throwing is recorded as
// `failed`; the next steps still run.

import { randomUUID } from 'crypto'
import type { StorageService } from '../../store/types'

export interface PrepareStepContext {
  /** Aborted by Cancel; a step checks it between units of work. */
  signal: AbortSignal
  progress(p: { done: number; total: number; message?: string }): void
  isOffline(): boolean
}

export interface PrepareStepResult {
  status: PrepareOfflineStatus
  details: PrepareOfflineDetail[]
}

export interface PrepareStep {
  id: PrepareOfflineStepId
  label: string
  requiresNetwork: boolean
  isAvailable(): { available: true } | { available: false; reason: string }
  run(ctx: PrepareStepContext): Promise<PrepareStepResult>
}

export interface PrepareOfflineServiceDeps {
  store: Pick<StorageService, 'get' | 'set'>
  isOffline(): boolean
  broadcast(channel: string, ...args: unknown[]): void
  progressChannel: string
  now?: () => number
  makeId?: () => string
  log?: Pick<Console, 'error'>
}

export interface PrepareOfflineService {
  registerStep(step: PrepareStep): void
  /** Starts a run, or returns the running one's id (single flight). */
  start(): { runId: string }
  /** Aborts the running step at its next check; the rest are skipped. */
  cancel(): boolean
  getState(): PrepareOfflineState
  /** Resolves when the current run (if any) has finished. */
  idle(): Promise<void>
}

export const OFFLINE_REASON = 'Offline: connect to run this step'
export const CANCELLED_REASON = 'Cancelled'

const RANK: Record<PrepareOfflineStatus, number> = { ok: 0, skipped: 1, warning: 2, failed: 3 }

/** The worse of the statuses (`failed` > `warning` > `skipped` > `ok`); `ok` when empty. */
export function worstStatus(statuses: PrepareOfflineStatus[]): PrepareOfflineStatus {
  return statuses.reduce<PrepareOfflineStatus>((w, s) => (RANK[s] > RANK[w] ? s : w), 'ok')
}

export function createPrepareOfflineService(
  deps: PrepareOfflineServiceDeps
): PrepareOfflineService {
  const now = deps.now ?? Date.now
  const makeId = deps.makeId ?? randomUUID
  const log = deps.log ?? console
  const steps: PrepareStep[] = []
  let run: PrepareOfflineRun | null = null
  let running: Promise<void> | null = null
  let controller: AbortController | null = null

  function emit(): void {
    if (run) deps.broadcast(deps.progressChannel, structuredClone(run))
  }

  function lastRun(): PrepareOfflineLastRun | null {
    return (deps.store.get('prepareOfflineLastRun') as PrepareOfflineLastRun | null) ?? null
  }

  async function runStep(
    step: PrepareStep,
    state: PrepareOfflineStepState,
    signal: AbortSignal
  ): Promise<void> {
    const finish = (
      status: PrepareOfflineStepState['status'],
      extra: Partial<PrepareOfflineStepState> = {}
    ): void => {
      Object.assign(state, { state: 'done', status }, extra)
      emit()
    }
    if (signal.aborted) return finish('skipped', { reason: CANCELLED_REASON })
    let availability: ReturnType<PrepareStep['isAvailable']>
    try {
      availability = step.isAvailable()
    } catch (err) {
      availability = { available: false, reason: errorText(err) }
    }
    if (!availability.available) return finish('unavailable', { reason: availability.reason })
    if (step.requiresNetwork && deps.isOffline()) {
      return finish('skipped', { reason: OFFLINE_REASON })
    }
    state.state = 'running'
    emit()
    const ctx: PrepareStepContext = {
      signal,
      isOffline: deps.isOffline,
      progress: ({ done, total, message }) => {
        state.done = done
        state.total = total
        state.message = message
        emit()
      }
    }
    try {
      const result = await step.run(ctx)
      if (signal.aborted) {
        return finish('skipped', { reason: CANCELLED_REASON, details: result.details })
      }
      finish(result.status, { details: result.details })
    } catch (err) {
      if (signal.aborted) return finish('skipped', { reason: CANCELLED_REASON })
      log.error(`[prepare-offline] step ${step.id} failed:`, err)
      finish('failed', { details: [{ text: errorText(err), status: 'failed' }] })
    }
  }

  async function execute(current: PrepareOfflineRun, signal: AbortSignal): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      await runStep(steps[i], current.steps[i], signal)
    }
    current.finishedAt = now()
    current.cancelled = signal.aborted
    deps.store.set('prepareOfflineLastRun', {
      finishedAt: current.finishedAt,
      cancelled: current.cancelled,
      steps: current.steps.map((s) => ({
        id: s.id,
        label: s.label,
        status: s.status ?? 'skipped'
      }))
    } satisfies PrepareOfflineLastRun)
    emit()
  }

  return {
    registerStep(step) {
      if (steps.some((s) => s.id === step.id)) throw new Error(`step ${step.id} already registered`)
      steps.push(step)
    },
    start() {
      if (running && run) return { runId: run.runId }
      controller = new AbortController()
      const current: PrepareOfflineRun = {
        runId: makeId(),
        startedAt: now(),
        finishedAt: null,
        cancelled: false,
        steps: steps.map((s) => ({
          id: s.id,
          label: s.label,
          state: 'pending',
          done: 0,
          total: 0,
          details: []
        }))
      }
      run = current
      emit()
      running = execute(current, controller.signal)
        .catch((err) => log.error('[prepare-offline] run failed:', err))
        .finally(() => {
          running = null
          controller = null
        })
      return { runId: current.runId }
    },
    cancel() {
      if (!running || !controller) return false
      controller.abort()
      return true
    },
    getState() {
      return {
        running: running !== null,
        run: run ? structuredClone(run) : null,
        lastRun: lastRun()
      }
    },
    async idle() {
      await running
    }
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
