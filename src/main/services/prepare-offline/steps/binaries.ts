// Step 1 (#592): ffmpeg + ffprobe through `ensureFfmpeg`, fpcalc through
// `ensureFpcalc`, then `-version` on each. A binary that fails it is deleted
// and downloaded once more; a second failure is `failed`, never a loop.
//
// The repair deletes only while nothing uses the binaries (a merge or another
// ffmpeg task, the player, skip analysis), checked immediately before the
// delete and before either ffmpeg file is touched: `ensureFfmpeg` downloads
// both components again, so a healthy ffmpeg is replaced too.

import type { BinaryCheck } from '../../../ffmpeg-binaries'
import { errorText, worstStatus, type PrepareStep, type PrepareStepResult } from '../index'

export interface BinariesStepDeps {
  ensureFfmpeg(): Promise<string>
  ensureFpcalc(): Promise<string>
  /** Where the binaries live once installed. */
  paths(): { ffmpeg: string; ffprobe: string; fpcalc: string }
  exists(p: string): boolean
  verify(p: string): Promise<BinaryCheck>
  remove(p: string): Promise<void>
  /** `clearFfmpegPaths`, as `FFMPEG_DELETE` does, so nothing spawns a path that's gone. */
  clearFfmpegPaths(): void
  /** `ffmpegStatus.refresh()`: what auto-merge reads. */
  refreshFfmpegStatus(): Promise<unknown>
  /** `downloadManager.ffmpegUser()`. */
  ffmpegUser(): 'merge' | 'task' | null
  isPlayerOpen(): boolean
  isSkipAnalysisRunning(): boolean
}

type Name = 'ffmpeg' | 'ffprobe' | 'fpcalc'

const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

/** Who is using the binaries now, for the deferred message; null when idle. */
export function binaryUsers(deps: BinariesStepDeps): string[] {
  const users: string[] = []
  const ffmpeg = deps.ffmpegUser()
  if (ffmpeg === 'merge') users.push('a merge')
  if (ffmpeg === 'task') users.push('Fix metadata or chapter injection')
  if (deps.isPlayerOpen()) users.push('the player')
  if (deps.isSkipAnalysisRunning()) users.push('skip analysis')
  return users
}

export function deferredText(names: Name[], users: string[]): string {
  return (
    `${names.join(' and ')} failed ${names.length > 1 ? 'their' : 'its'} check but ` +
    `${names.length > 1 ? 'are' : 'is'} in use (${users.join(' / ')}). Close it, or wait for it ` +
    'to finish, and run Prepare for offline again.'
  )
}

export function createBinariesStep(deps: BinariesStepDeps): PrepareStep {
  return {
    id: 'binaries',
    label: 'ffmpeg, ffprobe and fpcalc',
    // A download is needed only for a missing or broken binary; the step
    // checks the offline state itself when it gets there.
    requiresNetwork: false,
    isAvailable: () => ({ available: true }),
    async run(ctx): Promise<PrepareStepResult> {
      const details: PrepareStepResult['details'] = []
      const groups: { names: Name[]; ensure: () => Promise<string>; ffmpeg: boolean }[] = [
        { names: ['ffmpeg', 'ffprobe'], ensure: deps.ensureFfmpeg, ffmpeg: true },
        { names: ['fpcalc'], ensure: deps.ensureFpcalc, ffmpeg: false }
      ]
      let done = 0
      for (const group of groups) {
        if (ctx.signal.aborted) break
        ctx.progress({ done, total: 3, message: `Checking ${group.names.join(' and ')}` })
        const paths = deps.paths()
        const pathOf = (n: Name): string => paths[n]

        try {
          await group.ensure()
        } catch (err) {
          const text = errorText(err)
          const unsupported = /unsupported platform/.test(text)
          details.push({ text, status: unsupported ? 'warning' : 'failed' })
          done += group.names.length
          continue
        }
        const missing = group.names.filter((n) => !deps.exists(pathOf(n)))
        if (missing.length > 0) {
          details.push({
            text: ctx.isOffline()
              ? `${missing.join(' and ')}: offline, connect to install`
              : `${missing.join(' and ')} could not be installed`,
            status: ctx.isOffline() ? 'skipped' : 'failed'
          })
          done += group.names.length
          continue
        }

        const failing: { name: Name; error: string }[] = []
        for (const n of group.names) {
          const check = await deps.verify(pathOf(n))
          if (!check.ok) failing.push({ name: n, error: check.error })
        }
        if (failing.length === 0) {
          for (const n of group.names) details.push({ text: `${n}: ok`, status: 'ok' })
          done += group.names.length
          continue
        }
        const names = failing.map((f) => f.name)
        if (ctx.isOffline()) {
          details.push({
            text: `${names.join(' and ')} failed the check; connect and run Prepare for offline again to repair it`,
            status: 'warning'
          })
          done += group.names.length
          continue
        }
        // Immediately before the delete, not once per step.
        const users = binaryUsers(deps)
        if (users.length > 0) {
          details.push({ text: deferredText(names, users), status: 'warning' })
          done += group.names.length
          continue
        }
        let deferred = false
        let removed = false
        for (const n of names) {
          try {
            await deps.remove(pathOf(n))
            removed = true
          } catch (err) {
            if (BUSY_CODES.has((err as NodeJS.ErrnoException)?.code ?? '')) {
              details.push({ text: deferredText([n], ['another program']), status: 'warning' })
              deferred = true
              break
            }
            throw err
          }
        }
        // A refused delete leaves the files, and the paths, as they were.
        if (group.ffmpeg && removed) deps.clearFfmpegPaths()
        if (deferred) {
          done += group.names.length
          continue
        }
        try {
          await group.ensure()
        } catch (err) {
          details.push({ text: errorText(err), status: 'failed' })
          done += group.names.length
          continue
        }
        for (const n of group.names) {
          const check = deps.exists(pathOf(n))
            ? await deps.verify(pathOf(n))
            : ({ ok: false, error: 'not installed' } as BinaryCheck)
          details.push(
            check.ok
              ? { text: `${n}: ok${names.includes(n) ? ' (downloaded again)' : ''}`, status: 'ok' }
              : {
                  text: `${n} failed its check after a fresh download: ${check.error}`,
                  status: 'failed'
                }
          )
        }
        done += group.names.length
      }
      // After any install or repair, and after an install the online kick-off
      // made since boot: what auto-merge reads follows the files now.
      await deps.refreshFfmpegStatus()
      ctx.progress({ done, total: 3 })
      return { status: worstStatus(details.map((d) => d.status)), details }
    }
  }
}
