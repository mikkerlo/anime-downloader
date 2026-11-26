// The merge runner's wholesale rate refresh (#584): a reverted field with
// nothing to revert to re-reads the whole list. Moved out of `index.ts` (#694)
// so its broadcast is the one `index.ts` hands it (the Shikimori bridge) and a
// test can drive it.

import { EVENT_CHANNELS } from '@shared/ipc/channels'
import * as shikimori from '../../shikimori'
import { buildRateCacheEntries } from '../../lib/shikimori-rate-cache'
import type { AnimeSearchResult } from '../../smotret-api'
import type { StorageService } from '../../store/types'

export interface RunnerRateRefreshDeps {
  store: StorageService
  lookupByMalIds: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
  broadcast: (channel: string, ...args: unknown[]) => void
  log?: Pick<Console, 'warn'>
}

/** Fire-and-forget; the returned promise settles when the refresh did, and never rejects. */
export function createRunnerRateRefresh(deps: RunnerRateRefreshDeps): () => Promise<void> {
  const { store } = deps
  const log = deps.log ?? console
  return () =>
    (async () => {
      const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
      if (!user) return
      const token = await shikimori.ensureFreshToken(store)
      const rows = await shikimori.getUserAnimeRates(token, user.id)
      const malMap = await deps.lookupByMalIds(rows.map((r) => r.anime.id))
      if ((store.get('shikimoriUser') as shikimori.ShikiUser | null)?.id !== user.id) return
      const entries = buildRateCacheEntries(rows, malMap)
      store.set('shikimoriUserRates', entries)
      deps.broadcast(EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED, entries)
    })().catch((err) => log.warn('[sync] the rate refresh failed:', err))
}
