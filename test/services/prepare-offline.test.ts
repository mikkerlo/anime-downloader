// Prepare for offline (#592): the runner over fake steps, step 6's
// `SyncRunResult` mapping, the binaries step (repair, the busy gate) and the
// Shikimori rates step (drain first, the `keepQueued` refresh).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const ensureFreshToken = vi.fn()
const getUserAnimeRates = vi.fn()

vi.mock('../../src/main/shikimori', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/shikimori')>(
    '../../src/main/shikimori'
  )
  return {
    ...actual,
    ensureFreshToken: (...a: unknown[]) => ensureFreshToken(...a),
    getUserAnimeRates: (...a: unknown[]) => getUserAnimeRates(...a)
  }
})

import {
  createPrepareOfflineService,
  OFFLINE_REASON,
  CANCELLED_REASON,
  worstStatus,
  type PrepareStep,
  type PrepareStepContext
} from '../../src/main/services/prepare-offline'
import {
  createLibrarySyncStep,
  syncDetails,
  syncLine
} from '../../src/main/services/prepare-offline/steps/library-sync'
import {
  createBinariesStep,
  type BinariesStepDeps
} from '../../src/main/services/prepare-offline/steps/binaries'
import { createShikimoriRatesStep } from '../../src/main/services/prepare-offline/steps/shikimori-rates'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import type { BinaryCheck } from '../../src/main/ffmpeg-binaries'
import { createFfmpegStatus } from '../../src/main/lib/ffmpeg-status'

const PROGRESS = 'prepare-offline:progress'

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function service(opts: { offline?: boolean; store?: InMemoryStorage } = {}) {
  const store = opts.store ?? new InMemoryStorage({ prepareOfflineLastRun: null })
  const broadcast = vi.fn()
  let offline = opts.offline ?? false
  const svc = createPrepareOfflineService({
    store,
    isOffline: () => offline,
    broadcast,
    progressChannel: PROGRESS,
    now: () => 5_000,
    makeId: (() => {
      let n = 0
      return () => `run-${++n}`
    })(),
    log: { error: vi.fn() }
  })
  return {
    svc,
    store,
    broadcast,
    setOffline: (v: boolean) => (offline = v)
  }
}

function fakeStep(
  id: PrepareStep['id'],
  over: Partial<PrepareStep> = {},
  log: string[] = []
): PrepareStep & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => {
    log.push(`start ${id}`)
    await Promise.resolve()
    log.push(`end ${id}`)
    return { status: 'ok' as const, details: [] }
  })
  return {
    id,
    label: id,
    requiresNetwork: false,
    isAvailable: () => ({ available: true }),
    run,
    ...over
  } as PrepareStep & { run: ReturnType<typeof vi.fn> }
}

describe('the runner', () => {
  it('runs the steps in order, one at a time; a second Start returns the running id', async () => {
    const { svc } = service()
    const log: string[] = []
    svc.registerStep(fakeStep('binaries', {}, log))
    svc.registerStep(fakeStep('metadata', {}, log))
    svc.registerStep(fakeStep('local-integrity', {}, log))
    const first = svc.start()
    expect(svc.start()).toEqual(first)
    await svc.idle()
    expect(log).toEqual([
      'start binaries',
      'end binaries',
      'start metadata',
      'end metadata',
      'start local-integrity',
      'end local-integrity'
    ])
    const state = svc.getState()
    expect(state.running).toBe(false)
    expect(state.run?.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok'])
    expect(svc.start().runId).not.toBe(first.runId)
    await svc.idle()
  })

  it('Cancel aborts the current step at its next check and marks the rest skipped', async () => {
    const { svc } = service()
    const gate = deferred()
    let sawAbort = false
    svc.registerStep(
      fakeStep('metadata', {
        run: vi.fn(async (ctx: PrepareStepContext) => {
          await gate.promise
          sawAbort = ctx.signal.aborted
          return { status: 'ok' as const, details: [] }
        })
      })
    )
    const next = fakeStep('local-integrity')
    svc.registerStep(next)
    svc.start()
    await vi.waitFor(() => expect(svc.getState().run?.steps[0].state).toBe('running'))
    expect(svc.cancel()).toBe(true)
    gate.resolve()
    await svc.idle()
    expect(sawAbort).toBe(true)
    expect(next.run).not.toHaveBeenCalled()
    const { run, lastRun } = svc.getState()
    expect(run?.cancelled).toBe(true)
    expect(run?.steps.map((s) => [s.status, s.reason])).toEqual([
      ['skipped', CANCELLED_REASON],
      ['skipped', CANCELLED_REASON]
    ])
    expect(lastRun?.cancelled).toBe(true)
    expect(svc.cancel()).toBe(false)
  })

  it('offline, every requiresNetwork step is skipped with the reason; the local steps still run', async () => {
    const { svc } = service({ offline: true })
    const net = fakeStep('metadata', { requiresNetwork: true })
    const local = fakeStep('local-integrity')
    svc.registerStep(net)
    svc.registerStep(local)
    svc.start()
    await svc.idle()
    expect(net.run).not.toHaveBeenCalled()
    expect(local.run).toHaveBeenCalledTimes(1)
    expect(svc.getState().run?.steps.map((s) => [s.status, s.reason])).toEqual([
      ['skipped', OFFLINE_REASON],
      ['ok', undefined]
    ])
  })

  it('a step whose isAvailable() is false is "Not available" with its reason, and never runs', async () => {
    const { svc } = service()
    const step = fakeStep('attached-integrity', {
      isAvailable: () => ({ available: false, reason: 'No Shared Library attached' })
    })
    svc.registerStep(step)
    svc.start()
    await svc.idle()
    expect(step.run).not.toHaveBeenCalled()
    const s = svc.getState().run!.steps[0]
    expect([s.status, s.reason]).toEqual(['unavailable', 'No Shared Library attached'])
  })

  it('a step that throws is failed, and the next steps still run', async () => {
    const { svc } = service()
    svc.registerStep(
      fakeStep('binaries', {
        run: vi.fn(async () => {
          throw new Error('boom')
        })
      })
    )
    const after = fakeStep('metadata')
    svc.registerStep(after)
    svc.start()
    await svc.idle()
    expect(after.run).toHaveBeenCalledTimes(1)
    const steps = svc.getState().run!.steps
    expect(steps[0].status).toBe('failed')
    expect(steps[0].details).toEqual([{ text: 'boom', status: 'failed' }])
    expect(steps[1].status).toBe('ok')
  })

  it('broadcasts progress and each finished step, and stores the last run without details', async () => {
    const { svc, broadcast, store } = service()
    svc.registerStep(
      fakeStep('metadata', {
        run: vi.fn(async (ctx: PrepareStepContext) => {
          ctx.progress({ done: 1, total: 2, message: 'one' })
          return {
            status: 'warning' as const,
            details: [{ text: 'x', status: 'warning' as const }]
          }
        })
      })
    )
    svc.start()
    await svc.idle()
    const runs = broadcast.mock.calls.filter((c) => c[0] === PROGRESS).map((c) => c[1])
    expect(runs.some((r) => r.steps[0].done === 1 && r.steps[0].total === 2)).toBe(true)
    expect(runs.at(-1).finishedAt).toBe(5_000)
    expect(runs.at(-1).steps[0].status).toBe('warning')
    expect(store.get('prepareOfflineLastRun')).toEqual({
      finishedAt: 5_000,
      cancelled: false,
      steps: [{ id: 'metadata', label: 'metadata', status: 'warning' }]
    })
  })

  it('offline, step 6 still calls runAll("prepare") once', async () => {
    const { svc } = service({ offline: true })
    const runAll = vi.fn(
      async (): Promise<SyncRunResult> => ({
        runId: 'r',
        trigger: 'prepare',
        libraries: []
      })
    )
    svc.registerStep(
      createLibrarySyncStep({ list: () => [{ libraryId: 'L', name: 'Lib' } as never], runAll })
    )
    svc.start()
    await svc.idle()
    expect(runAll).toHaveBeenCalledTimes(1)
    expect(runAll).toHaveBeenCalledWith('prepare')
    expect(svc.getState().run!.steps[0].status).toBe('ok')
  })

  it('worstStatus orders failed > warning > skipped > ok', () => {
    expect(worstStatus([])).toBe('ok')
    expect(worstStatus(['ok', 'skipped'])).toBe('skipped')
    expect(worstStatus(['skipped', 'warning', 'ok'])).toBe('warning')
    expect(worstStatus(['warning', 'failed'])).toBe('failed')
  })
})

describe('step 6: SyncRunResult → summary lines', () => {
  function lib(over: Partial<SyncLibraryResult>): SyncLibraryResult {
    return {
      libraryId: 'L',
      drive: 'ok',
      shikimori: 'ok',
      counts: { applied: 0, conflicts: 0, clamped: 0 },
      waitingMalIds: [],
      rewatchesSuperseded: 0,
      ...over
    }
  }

  const ROWS: [string, Partial<SyncLibraryResult>, string | null, PrepareOfflineStatus | null][] = [
    ['ok / ok', {}, 'Lib: Drive synced; Shikimori updated', 'ok'],
    [
      'skipped:unavailable, Shikimori ok',
      { drive: 'skipped', driveReason: 'unavailable' },
      'Lib: Drive not connected; Shikimori updated',
      'skipped'
    ],
    [
      'skipped:read-only',
      { drive: 'skipped', driveReason: 'read-only' },
      'Lib: Read-only on this computer; changes kept here; Shikimori updated',
      'skipped'
    ],
    [
      'claim PC offline → ok (skipped:claim)',
      { shikimori: 'skipped', shikimoriReason: 'claim' },
      'Lib: Drive synced; Shikimori push needs a logged-in owner',
      'ok'
    ],
    [
      'skipped:foreign on both sides → no line',
      {
        drive: 'skipped',
        driveReason: 'foreign',
        shikimori: 'skipped',
        shikimoriReason: 'foreign'
      },
      null,
      null
    ],
    [
      'videos-only → no line',
      {
        drive: 'skipped',
        driveReason: 'videos-only',
        shikimori: 'skipped',
        shikimoriReason: 'foreign'
      },
      null,
      null
    ],
    [
      'error:write-failed-read-only',
      { drive: 'error', driveReason: 'write-failed-read-only' },
      'Lib: The drive refused the write; now read-only, changes kept here; Shikimori updated',
      'warning'
    ],
    [
      'error:io',
      { drive: 'error', driveReason: 'io' },
      "Lib: Couldn't write to the drive (full or I/O error); changes kept here; Shikimori updated",
      'failed'
    ],
    [
      'error:unreadable',
      { drive: 'error', driveReason: 'unreadable' },
      'Lib: Library state is unreadable; plug it into the PC that last wrote it; Shikimori updated',
      'failed'
    ],
    [
      'Shikimori skipped:offline',
      { shikimori: 'skipped', shikimoriReason: 'offline' },
      'Lib: Drive synced; Shikimori push waits until online',
      'ok'
    ],
    [
      'Shikimori skipped:logged-out',
      { shikimori: 'skipped', shikimoriReason: 'logged-out' },
      'Lib: Drive synced; Shikimori push needs a logged-in owner',
      'ok'
    ],
    [
      'Shikimori error:auth',
      { shikimori: 'error', shikimoriReason: 'auth' },
      'Lib: Drive synced; Shikimori session expired; log in to push',
      'warning'
    ],
    [
      'Shikimori error:network',
      { shikimori: 'error', shikimoriReason: 'network' },
      'Lib: Drive synced; Shikimori push was interrupted; it resumes when online',
      'warning'
    ],
    [
      'Shikimori error:api',
      { shikimori: 'error', shikimoriReason: 'api' },
      'Lib: Drive synced; Shikimori rejected the update',
      'warning'
    ],
    [
      'ok with waitingMalIds',
      { waitingMalIds: [1, 2] },
      'Lib: Drive synced; Shikimori updated, 2 titles wait for your queued edits',
      'ok'
    ],
    [
      'counts.conflicts > 0',
      { counts: { applied: 3, conflicts: 2, clamped: 0 } },
      'Lib: Drive synced, 2 need review; Shikimori updated',
      'warning'
    ],
    [
      'an unknown reason falls back to the generic text, as a warning',
      {
        drive: 'error',
        driveReason: 'new-thing' as never,
        shikimori: 'error',
        shikimoriReason: 'other' as never
      },
      'Lib: Drive: new-thing; Shikimori: other',
      'warning'
    ]
  ]

  it.each(ROWS)('%s', (_name, over, text, status) => {
    const line = syncLine(lib(over), 'Lib')
    if (text === null) {
      expect(line).toBeNull()
      return
    }
    expect(line).toEqual({ text, status })
  })

  it('the step is the worst line; not-yours libraries are only counted; superseded rewatches add a detail', async () => {
    const result: SyncRunResult = {
      runId: 'r',
      trigger: 'prepare',
      libraries: [
        lib({ libraryId: 'A', shikimori: 'skipped', shikimoriReason: 'offline' }),
        lib({ libraryId: 'B', drive: 'error', driveReason: 'io', rewatchesSuperseded: 2 }),
        lib({ libraryId: 'C', drive: 'skipped', driveReason: 'foreign' }),
        lib({ libraryId: 'D', drive: 'skipped', driveReason: 'videos-only' })
      ]
    }
    const names = new Map([
      ['A', 'Alpha'],
      ['B', 'Beta']
    ])
    expect(syncDetails(result, names)).toEqual([
      { text: 'Alpha: Drive synced; Shikimori push waits until online', status: 'ok' },
      {
        text: "Beta: Couldn't write to the drive (full or I/O error); changes kept here; Shikimori updated",
        status: 'failed'
      },
      { text: '2 rewatch raises superseded by Shikimori', status: 'ok' },
      { text: '2 libraries skipped: not yours', status: 'ok' }
    ])
    const step = createLibrarySyncStep({ list: () => [], runAll: async () => result })
    const out = await step.run(ctxFor())
    expect(out.status).toBe('failed')
  })

  it('a claim PC that is offline gets an ok step', async () => {
    const step = createLibrarySyncStep({
      list: () => [{ libraryId: 'L', name: 'Lib' } as never],
      runAll: async () => ({
        runId: 'r',
        trigger: 'prepare',
        libraries: [lib({ libraryId: 'L', shikimori: 'skipped', shikimoriReason: 'claim' })]
      })
    })
    const out = await step.run(ctxFor({ offline: true }))
    expect(out).toEqual({
      status: 'ok',
      details: [{ text: 'Lib: Drive synced; Shikimori push needs a logged-in owner', status: 'ok' }]
    })
  })
})

function ctxFor(opts: { offline?: boolean; signal?: AbortSignal } = {}): PrepareStepContext & {
  ticks: { done: number; total: number; message?: string }[]
} {
  const ticks: { done: number; total: number; message?: string }[] = []
  return {
    signal: opts.signal ?? new AbortController().signal,
    isOffline: () => opts.offline ?? false,
    progress: (p) => ticks.push(p),
    ticks
  }
}

// --- Step 1: binaries -------------------------------------------------------------

interface Rig {
  deps: BinariesStepDeps
  files: Map<string, 'good' | 'bad'>
  events: string[]
  ffmpegPath: { value: string }
  busy: { ffmpeg: 'merge' | 'task' | null; player: boolean; skip: boolean }
  /** What a download installs: 'good', or 'bad' for a still-broken binary. */
  downloads: { ffmpeg: 'good' | 'bad'; ffprobe: 'good' | 'bad'; fpcalc: 'good' | 'bad' }
}

const P = { ffmpeg: '/ff/ffmpeg', ffprobe: '/ff/ffprobe', fpcalc: '/fp/fpcalc' }

function binariesRig(
  initial: Partial<Record<'ffmpeg' | 'ffprobe' | 'fpcalc', 'good' | 'bad'>>
): Rig {
  const files = new Map<string, 'good' | 'bad'>()
  for (const [n, v] of Object.entries(initial)) files.set(P[n as keyof typeof P], v!)
  const events: string[] = []
  const ffmpegPath = { value: files.has(P.ffmpeg) ? P.ffmpeg : '' }
  const busy: Rig['busy'] = { ffmpeg: null, player: false, skip: false }
  const downloads: Rig['downloads'] = { ffmpeg: 'good', ffprobe: 'good', fpcalc: 'good' }
  const deps: BinariesStepDeps = {
    // Like the real ones: only a missing file downloads.
    ensureFfmpeg: vi.fn(async () => {
      if (files.has(P.ffmpeg) && files.has(P.ffprobe)) {
        ffmpegPath.value = P.ffmpeg
        return P.ffmpeg
      }
      events.push(`download ffmpeg+ffprobe (path=${JSON.stringify(ffmpegPath.value)})`)
      files.set(P.ffmpeg, downloads.ffmpeg)
      files.set(P.ffprobe, downloads.ffprobe)
      ffmpegPath.value = P.ffmpeg
      return P.ffmpeg
    }),
    ensureFpcalc: vi.fn(async () => {
      if (files.has(P.fpcalc)) return P.fpcalc
      events.push('download fpcalc')
      files.set(P.fpcalc, downloads.fpcalc)
      return P.fpcalc
    }),
    paths: () => ({ ...P }),
    exists: (p) => files.has(p),
    verify: vi.fn(
      async (p: string): Promise<BinaryCheck> =>
        files.get(p) === 'good'
          ? { ok: true, version: 'v' }
          : { ok: false, error: 'exec format error' }
    ),
    remove: vi.fn(async (p: string) => {
      events.push(`delete ${p}`)
      files.delete(p)
    }),
    clearFfmpegPaths: vi.fn(() => {
      events.push('clearFfmpegPaths')
      ffmpegPath.value = ''
    }),
    refreshFfmpegStatus: vi.fn(async () => {
      events.push('refresh')
    }),
    ffmpegUser: () => busy.ffmpeg,
    isPlayerOpen: () => busy.player,
    isSkipAnalysisRunning: () => busy.skip
  }
  return { deps, files, events, ffmpegPath, busy, downloads }
}

describe('step 1: binaries', () => {
  it('all present and passing: ok, nothing downloaded or deleted, status refreshed', async () => {
    const r = binariesRig({ ffmpeg: 'good', ffprobe: 'good', fpcalc: 'good' })
    const out = await createBinariesStep(r.deps).run(ctxFor())
    expect(out.status).toBe('ok')
    expect(r.events).toEqual(['refresh'])
  })

  it('a binary that exists but fails -version is deleted, downloaded once more, then verified', async () => {
    // Main's `ensureFfmpeg` accepts any existing file: nothing here would run.
    const r = binariesRig({ ffmpeg: 'good', ffprobe: 'bad', fpcalc: 'good' })
    const out = await createBinariesStep(r.deps).run(ctxFor())
    expect(r.events).toEqual([
      `delete ${P.ffprobe}`,
      'clearFfmpegPaths',
      'download ffmpeg+ffprobe (path="")',
      'refresh'
    ])
    expect(r.files.get(P.ffprobe)).toBe('good')
    expect(out.status).toBe('ok')
    expect(out.details).toContainEqual({ text: 'ffprobe: ok (downloaded again)', status: 'ok' })
  })

  it('after a delete, clearFfmpegPaths() has run before the re-download starts', async () => {
    const r = binariesRig({ ffmpeg: 'bad', ffprobe: 'good', fpcalc: 'good' })
    await createBinariesStep(r.deps).run(ctxFor())
    // The download saw an empty `getFfmpegPath()`.
    expect(r.events).toContain('download ffmpeg+ffprobe (path="")')
    expect(r.events.indexOf('clearFfmpegPaths')).toBeLessThan(
      r.events.indexOf('download ffmpeg+ffprobe (path="")')
    )
  })

  it('a second failure is failed, with no download loop', async () => {
    const r = binariesRig({ ffmpeg: 'good', ffprobe: 'good', fpcalc: 'bad' })
    r.downloads.fpcalc = 'bad'
    const out = await createBinariesStep(r.deps).run(ctxFor())
    expect(r.events.filter((e) => e.startsWith('download'))).toEqual(['download fpcalc'])
    expect(r.deps.ensureFpcalc).toHaveBeenCalledTimes(2)
    expect(out.status).toBe('failed')
    expect(out.details).toContainEqual({
      text: 'fpcalc failed its check after a fresh download: exec format error',
      status: 'failed'
    })
  })

  it('a missing binary is installed; offline it is skipped with the reason', async () => {
    const online = binariesRig({ fpcalc: 'good' })
    const out = await createBinariesStep(online.deps).run(ctxFor())
    expect(online.events).toEqual(['download ffmpeg+ffprobe (path="")', 'refresh'])
    expect(out.status).toBe('ok')

    const off = binariesRig({ fpcalc: 'good' })
    off.deps.ensureFfmpeg = vi.fn(async () => '')
    const offOut = await createBinariesStep(off.deps).run(ctxFor({ offline: true }))
    expect(offOut.details).toContainEqual({
      text: 'ffmpeg and ffprobe: offline, connect to install',
      status: 'skipped'
    })
  })

  describe('the repair gate', () => {
    const BUSY: [string, (r: Rig) => void, string][] = [
      ['a merge (the mutex / isFfmpegBusy)', (r) => (r.busy.ffmpeg = 'merge'), 'a merge'],
      [
        'DOWNLOAD_FIX_METADATA or DOWNLOAD_INJECT_CHAPTERS (the busy counter)',
        (r) => (r.busy.ffmpeg = 'task'),
        'Fix metadata or chapter injection'
      ],
      ['the player open', (r) => (r.busy.player = true), 'the player'],
      ['a skip analysis running', (r) => (r.busy.skip = true), 'skip analysis']
    ]

    it.each(BUSY)(
      '%s: nothing is deleted or downloaded; a deferred warning names it',
      async (_n, set, who) => {
        const r = binariesRig({ ffmpeg: 'bad', ffprobe: 'good', fpcalc: 'good' })
        set(r)
        const out = await createBinariesStep(r.deps).run(ctxFor())
        expect(r.events).toEqual(['refresh'])
        expect(r.deps.remove).not.toHaveBeenCalled()
        expect(out.status).toBe('warning')
        expect(out.details).toContainEqual({
          text: `ffmpeg failed its check but is in use (${who}). Close it, or wait for it to finish, and run Prepare for offline again.`,
          status: 'warning'
        })
      }
    )

    it('only ffprobe failing while ffmpeg is busy: neither file is touched', async () => {
      const r = binariesRig({ ffmpeg: 'good', ffprobe: 'bad', fpcalc: 'good' })
      r.busy.ffmpeg = 'merge'
      await createBinariesStep(r.deps).run(ctxFor())
      expect(r.deps.remove).not.toHaveBeenCalled()
      expect(r.files.get(P.ffmpeg)).toBe('good')
      expect(r.files.get(P.ffprobe)).toBe('bad')
    })

    it('fpcalc failing while skip analysis runs is deferred too', async () => {
      const r = binariesRig({ ffmpeg: 'good', ffprobe: 'good', fpcalc: 'bad' })
      r.busy.skip = true
      const out = await createBinariesStep(r.deps).run(ctxFor())
      expect(r.deps.remove).not.toHaveBeenCalled()
      expect(out.status).toBe('warning')
    })

    it('with everything idle, the repair runs', async () => {
      const r = binariesRig({ ffmpeg: 'bad', ffprobe: 'good', fpcalc: 'good' })
      await createBinariesStep(r.deps).run(ctxFor())
      expect(r.deps.remove).toHaveBeenCalledWith(P.ffmpeg)
      expect(r.files.get(P.ffmpeg)).toBe('good')
    })

    it('a Windows EBUSY on the delete is the same deferred warning, never a crash', async () => {
      const r = binariesRig({ ffmpeg: 'bad', ffprobe: 'good', fpcalc: 'good' })
      r.deps.remove = vi.fn(async () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      })
      const out = await createBinariesStep(r.deps).run(ctxFor())
      expect(out.status).toBe('warning')
      expect(out.details[0].text).toMatch(/^ffmpeg failed its check but is in use/)
      expect(r.events.some((e) => e.startsWith('download'))).toBe(false)
      // Nothing was removed, so the paths stay as they were (review r4416922524).
      expect(r.events).not.toContain('clearFfmpegPaths')
    })

    it.each(['EBUSY', 'EPERM', 'EACCES'])(
      'a refused delete (%s) of a broken ffprobe keeps a healthy ffmpeg available',
      async (code) => {
        const r = binariesRig({ ffmpeg: 'good', ffprobe: 'bad', fpcalc: 'good' })
        r.deps.remove = vi.fn(async () => {
          throw Object.assign(new Error('refused'), { code })
        })
        // What auto-merge reads: available while `getFfmpegPath()` names a file.
        const status = createFfmpegStatus(async () => ({ available: r.ffmpegPath.value !== '' }))
        await status.refresh()
        r.deps.refreshFfmpegStatus = () => status.refresh()

        const out = await createBinariesStep(r.deps).run(ctxFor())
        expect(out.status).toBe('warning')
        expect(r.files.get(P.ffmpeg)).toBe('good')
        expect(r.files.get(P.ffprobe)).toBe('bad')
        expect(r.ffmpegPath.value).toBe(P.ffmpeg)
        expect((await status.get()).available).toBe(true)
      }
    )

    it('a delete that removed a file before a later one was refused still clears the paths', async () => {
      const r = binariesRig({ ffmpeg: 'bad', ffprobe: 'bad', fpcalc: 'good' })
      const remove = r.deps.remove
      r.deps.remove = vi.fn(async (p: string) => {
        if (p === P.ffprobe) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        await remove(p)
      })
      await createBinariesStep(r.deps).run(ctxFor())
      expect(r.files.has(P.ffmpeg)).toBe(false)
      expect(r.events).toContain('clearFfmpegPaths')
      expect(r.ffmpegPath.value).toBe('')
    })

    it('offline, a failing binary is reported, not deleted', async () => {
      const r = binariesRig({ ffmpeg: 'bad', ffprobe: 'good', fpcalc: 'good' })
      const out = await createBinariesStep(r.deps).run(ctxFor({ offline: true }))
      expect(r.deps.remove).not.toHaveBeenCalled()
      expect(out.status).toBe('warning')
    })
  })
})

// --- Step 2: Shikimori rates -----------------------------------------------------------

function serverRow(malId: number, score: number) {
  return {
    id: 900 + malId,
    score,
    status: 'watching',
    episodes: 1,
    rewatches: 0,
    updated_at: '2026-01-01T00:00:00Z',
    anime: { id: malId, name: `A${malId}` }
  }
}

function cached(malId: number, score: number) {
  return {
    rate: {
      id: 900 + malId,
      target_id: malId,
      score,
      status: 'watching',
      episodes: 1,
      rewatches: 0,
      updated_at: '2026-01-02T00:00:00Z'
    },
    shikiAnime: { id: malId, name: `A${malId}` },
    smotretAnime: null
  }
}

function queuedEdit(malId: number, score: number, queuedAt: number) {
  return {
    malId,
    rateId: 900 + malId,
    before: { episodes: 1, status: 'watching', score: 6, rewatches: 0 },
    after: { episodes: 1, status: 'watching', score, rewatches: 0 },
    queuedAt
  }
}

const scoreOf = (store: InMemoryStorage, malId: number): number | undefined =>
  (store.get('shikimoriUserRates') as ReturnType<typeof cached>[]).find(
    (e) => e.rate.target_id === malId
  )?.rate.score

describe('step 2: Shikimori rates', () => {
  let store: InMemoryStorage
  let broadcast: ReturnType<typeof vi.fn>
  let sync: ReturnType<typeof createShikimoriSyncService>

  beforeEach(() => {
    ensureFreshToken.mockReset().mockResolvedValue('tok')
    getUserAnimeRates.mockReset()
    store = new InMemoryStorage({
      shikimoriUser: { id: 7, nickname: 'me' },
      shikimoriCredentials: null,
      shikimoriUserRates: [],
      shikimoriUpdateQueue: [],
      shikimoriRecommendations: [{ id: 1 }],
      shikimoriAnimeDetails: {}
    })
    broadcast = vi.fn()
    sync = createShikimoriSyncService({
      store,
      broadcast,
      syncStatusChannel: 's',
      offlineQueueChangedChannel: 'q',
      rateUpdatedChannel: 'r',
      animeDetailsUpdatedChannel: 'd',
      lookupByMalIds: async () => ({}),
      ratesRefreshedChannel: EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED
    })
  })

  function step(drain: () => Promise<void>) {
    return createShikimoriRatesStep({
      isLoggedIn: () => store.get('shikimoriUser') !== null,
      drain,
      refreshRates: (o) => sync.refreshRates(o),
      prefetchShikimoriDetails: async () => {},
      abortPrefetch: () => {}
    })
  }

  it('logged out: skipped with "Not logged in"', async () => {
    store.set('shikimoriUser', null)
    const out = await step(async () => {}).run(ctxFor())
    expect(out).toEqual({
      status: 'skipped',
      details: [{ text: 'Not logged in', status: 'skipped' }]
    })
  })

  it('drains the queue before the refresh: a seeded queued edit is sent, not overwritten', async () => {
    // X has a queued edit to 7 (cached optimistically); the server still has 6
    // until the drain sends it.
    store.set('shikimoriUserRates', [cached(1, 7)])
    store.set('shikimoriUpdateQueue', [queuedEdit(1, 7, 10)])
    let server = 6
    const order: string[] = []
    getUserAnimeRates.mockImplementation(async () => {
      order.push('refresh')
      return [serverRow(1, server)]
    })
    const drain = async (): Promise<void> => {
      order.push('drain')
      server = 7
      store.set('shikimoriUpdateQueue', [])
    }
    const out = await step(drain).run(ctxFor())
    expect(order).toEqual(['drain', 'refresh'])
    expect(scoreOf(store, 1)).toBe(7)
    expect(out.status).toBe('ok')
    expect(out.details).toEqual([{ text: '1 rates refreshed', status: 'ok' }])
  })

  it('a partial drain keeps the edits it could not send (X), and Y takes the server value', async () => {
    store.set('shikimoriUserRates', [cached(1, 7), cached(2, 8)])
    store.set('shikimoriUpdateQueue', [queuedEdit(2, 8, 10), queuedEdit(1, 7, 11)])
    // The stub drain applies Y, then stops on a network error for X.
    const drain = async (): Promise<void> => {
      store.set('shikimoriUpdateQueue', [queuedEdit(1, 7, 11)])
    }
    getUserAnimeRates.mockResolvedValue([serverRow(1, 6), serverRow(2, 8)])
    const out = await step(drain).run(ctxFor())
    expect(scoreOf(store, 1)).toBe(7)
    expect(scoreOf(store, 2)).toBe(8)
    expect((store.get('shikimoriUpdateQueue') as { malId: number }[]).map((q) => q.malId)).toEqual([
      1
    ])
    expect(out.status).toBe('warning')
    expect(out.details).toContainEqual({ text: '1 edit still waiting to sync', status: 'warning' })
  })

  it('a queued add the server does not know yet keeps its cached entry', async () => {
    store.set('shikimoriUserRates', [cached(3, 9)])
    store.set('shikimoriUpdateQueue', [{ ...queuedEdit(3, 9, 10), rateId: null }])
    getUserAnimeRates.mockResolvedValue([serverRow(1, 6)])
    await step(async () => {}).run(ctxFor())
    expect(scoreOf(store, 3)).toBe(9)
    expect(scoreOf(store, 1)).toBe(6)
  })

  it('an edit queued while the request is in flight is kept: the queue is read at the write', async () => {
    store.set('shikimoriUserRates', [cached(4, 6)])
    const held = deferred<unknown[]>()
    getUserAnimeRates.mockReturnValue(held.promise)
    const running = step(async () => {}).run(ctxFor())
    await vi.waitFor(() => expect(getUserAnimeRates).toHaveBeenCalled())
    // The user edits W while the list is in flight.
    store.set('shikimoriUserRates', [cached(4, 9)])
    store.set('shikimoriUpdateQueue', [queuedEdit(4, 9, 20)])
    held.resolve([serverRow(4, 6)])
    await running
    expect(scoreOf(store, 4)).toBe(9)
  })

  it('refreshRates invalidates the calendar and the recs and broadcasts the entries, from the step', async () => {
    sync.setCachedCalendar([], 7)
    getUserAnimeRates.mockResolvedValue([serverRow(1, 6)])
    await step(async () => {}).run(ctxFor())
    expect(sync.getCachedCalendar()?.invalidated).toBe(true)
    expect(store.get('shikimoriRecommendations')).toEqual([])
    const sent = broadcast.mock.calls.filter(
      (c) => c[0] === EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED
    )
    expect(sent).toHaveLength(1)
    expect(sent[0][1]).toEqual([
      expect.objectContaining({ rate: expect.objectContaining({ target_id: 1, score: 6 }) })
    ])
  })
})
