// Rate values and S0's auto-mark raise (#565), shared by the auto-mark in
// `ipc/shikimori.ipc.ts` and the Shared Library merge's owner-decision-5 raise
// (#584), so there is one copy. Pure.

import type { ShikiUserRateStatus } from '../shikimori'

export interface RateValues {
  episodes: number
  status: ShikiUserRateStatus
  score: number
  rewatches: number
}

// The `before` of a title that has no rate yet. The drain creates the rate when
// the server has none; when it has one after all, this won't match it, and
// `shouldApplyOnDrift` decides as for any other stale `before`.
export const NO_RATE_BEFORE: RateValues = {
  episodes: 0,
  status: 'planned',
  score: 0,
  rewatches: 0
}

export function rateValues(rate: {
  episodes: number
  status: ShikiUserRateStatus
  score: number
  rewatches?: number
}): RateValues {
  const { episodes, status, score } = rate
  return { episodes, status, score, rewatches: rate.rewatches ?? 0 }
}

// What "episode `epNum` watched" moves a rate to, or null when it changes
// nothing. A completed title starts a rewatch from `epNum` (the flipped status
// is what stops a second bump); anything else only moves forward.
export function nextWatchedRate(current: RateValues, epNum: number): RateValues | null {
  const { score, rewatches } = current
  if (current.status === 'completed') {
    return { episodes: epNum, status: 'rewatching', score, rewatches: rewatches + 1 }
  }
  if (epNum > current.episodes) return { episodes: epNum, status: 'watching', score, rewatches }
  return null
}
