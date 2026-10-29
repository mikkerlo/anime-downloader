// Step 5 (#592): every item of each available attached Shared Library passes
// S7a (#578)'s `checkItem` (the play-time containment check, existence and the
// manifest's size). Read-only; an unplugged library is "Drive not connected".

import { type PrepareStep, type PrepareStepResult, worstStatus } from '../index'

export interface AttachedIntegrityStepDeps {
  list(): AttachedLibraryInfo[]
  items(libraryId: string): SharedLibraryItem[]
  checkItem(
    libraryId: string,
    item: Pick<SharedLibraryItem, 'path' | 'subtitlePath' | 'size'>
  ): Promise<AttachedItemCheck>
}

export const NO_LIBRARY_REASON = 'No Shared Library attached'
export const DRIVE_NOT_CONNECTED = 'Drive not connected'

const CHECK_TEXT: Record<Exclude<AttachedItemCheck, 'ok'>, string> = {
  missing: 'missing on the drive',
  'wrong-size': "the file's size doesn't match the library",
  escapes: 'its path leads outside the library'
}

export function createAttachedIntegrityStep(deps: AttachedIntegrityStepDeps): PrepareStep {
  return {
    id: 'attached-integrity',
    label: 'Shared Libraries',
    requiresNetwork: false,
    isAvailable: () =>
      deps.list().length > 0
        ? { available: true }
        : { available: false, reason: NO_LIBRARY_REASON },
    async run(ctx): Promise<PrepareStepResult> {
      const libs = deps.list()
      const work = libs.map((lib) => ({
        lib,
        items: lib.available ? deps.items(lib.libraryId) : []
      }))
      const total = work.reduce((n, w) => n + w.items.length, 0)
      const details: PrepareStepResult['details'] = []
      let done = 0
      ctx.progress({ done, total })
      for (const { lib, items } of work) {
        if (ctx.signal.aborted) break
        if (!lib.available) {
          details.push({ text: `${lib.name}: ${DRIVE_NOT_CONNECTED}`, status: 'skipped' })
          continue
        }
        const names = new Map(lib.titles.map((t) => [t.animeId, t.name]))
        let bad = 0
        for (const item of items) {
          if (ctx.signal.aborted) break
          const check = await deps.checkItem(lib.libraryId, item)
          if (check !== 'ok') {
            bad++
            const title = names.get(item.animeId) ?? `#${item.animeId}`
            details.push({
              text: `${lib.name}: ${title} episode ${item.episodeInt} (${item.author}): ${CHECK_TEXT[check]}`,
              status: 'warning',
              animeId: item.animeId
            })
          }
          done++
          ctx.progress({ done, total, message: lib.name })
        }
        if (bad === 0) {
          details.push({ text: `${lib.name}: ${items.length} items ok`, status: 'ok' })
        }
      }
      return { status: worstStatus(details.map((d) => d.status)), details }
    }
  }
}
