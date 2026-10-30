// Step 3 (#592): details, episode lists and posters for S2 (#570)'s whole
// cache scope (starred, downloaded, watched in the last 90 days). Two titles
// at a time; a failed title is a `warning` detail, not a failure of the step.
// A title's progress tick comes after its poster is on disk.

import type { AnimeDetail, EpisodeDetail } from '../../../smotret-api'
import { errorText, type PrepareStep, type PrepareStepResult } from '../index'

export interface MetadataStepDeps {
  /** Every title id the cache scope's predicate accepts. */
  cachableIds(): number[]
  getAnime(id: number): Promise<{ data: AnimeDetail }>
  getEpisodesBatch(episodeIds: number[]): Promise<{ data: EpisodeDetail[] }>
  refreshAnimeDetail(id: number, detail: AnimeDetail): Promise<{ posterOk: boolean }>
  updateEpisodes(id: number, details: EpisodeDetail[]): void
  concurrency?: number
}

export const METADATA_CONCURRENCY = 2

/**
 * S2 (#570)'s cache scope as a list: every title the three stores the
 * predicate reads know about, kept when `isCachable` accepts it.
 */
export function cachableIdsFrom(
  store: { get(key: string): unknown },
  isCachable: (id: number) => boolean
): number[] {
  const ids = new Set<number>()
  for (const key of ['downloadedAnime', 'library', 'watchProgress']) {
    for (const k of Object.keys((store.get(key) as object | undefined) ?? {})) {
      const id = Number(k.split(':')[0])
      if (Number.isSafeInteger(id) && id > 0) ids.add(id)
    }
  }
  return [...ids].filter((id) => isCachable(id))
}

function nameOf(detail: AnimeDetail | null, id: number): string {
  return detail?.titles?.romaji || detail?.title || `#${id}`
}

export function createMetadataStep(deps: MetadataStepDeps): PrepareStep {
  return {
    id: 'metadata',
    label: 'Library metadata',
    requiresNetwork: true,
    isAvailable: () => ({ available: true }),
    async run(ctx): Promise<PrepareStepResult> {
      const ids = deps.cachableIds()
      const details: PrepareStepResult['details'] = []
      let done = 0
      let refreshed = 0
      ctx.progress({ done, total: ids.length })

      async function one(id: number): Promise<void> {
        let detail: AnimeDetail | null = null
        try {
          detail = (await deps.getAnime(id)).data
          const { posterOk } = await deps.refreshAnimeDetail(id, detail)
          const episodeIds = (detail.episodes ?? []).map((e) => e.id)
          if (episodeIds.length > 0) {
            const episodes = await deps.getEpisodesBatch(episodeIds)
            deps.updateEpisodes(id, episodes.data)
          }
          if (posterOk) refreshed++
          else {
            details.push({
              text: `${nameOf(detail, id)}: the poster didn't download`,
              status: 'warning',
              animeId: id
            })
          }
        } catch (err) {
          details.push({
            text: `${nameOf(detail, id)}: ${errorText(err)}`,
            status: 'warning',
            animeId: id
          })
        }
        done++
        ctx.progress({ done, total: ids.length, message: nameOf(detail, id) })
      }

      const queue = [...ids]
      const workers = Array.from(
        { length: Math.min(deps.concurrency ?? METADATA_CONCURRENCY, queue.length) },
        async () => {
          while (queue.length > 0 && !ctx.signal.aborted) {
            await one(queue.shift()!)
          }
        }
      )
      await Promise.all(workers)
      details.unshift({
        text: `${refreshed} of ${ids.length} ${ids.length === 1 ? 'title' : 'titles'} up to date`,
        status: refreshed === ids.length ? 'ok' : 'warning'
      })
      return { status: refreshed === ids.length ? 'ok' : 'warning', details }
    }
  }
}
