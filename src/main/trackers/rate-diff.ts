// The one "which fields of this pair differ?" rule (#705, epic #688). Main
// calls it for `tracker:get-rate`'s `differs` and for "Copy from primary", and
// T10's diff engine (#708) imports it, so the chip, the copy and the reconcile
// review never disagree about what is a difference. Pure: both sides are
// projections in app values (each tracker's cache with its live queue laid
// over it), so a raw score's rounding is already gone.
//
// - Score rounding is not a difference: equal app scores are equal.
// - A score at the AniList user's scale step is not a difference either. On a
//   lossy scale (`POINT_5`, `POINT_3`) AniList stores a written score at the
//   step and the drain adopts the read-back, so the app's 7 can come back as
//   8. The AniList side equals the other side's score taken to that step, in
//   either direction.
// - `rewatches` is compared as-is: the providers' adapters already deliver it
//   in the app's count-at-start semantics.
// - A missing target row differs in every field, a missing source row in none:
//   copying "nothing" would be a delete, which only T10's reconcile offers.

import { RATE_FIELDS } from '../lib/shikimori-queue'
import type { RateValues } from '../lib/shikimori-rate'
import {
  anilistQuantize,
  anilistRawFromAppScore,
  appScoreFromAnilistRaw,
  type AnilistScoreFormat
} from './scores'

/** One side of a pair: a tracker and its projected values, null with no row (cached or queued). */
export interface RateSide {
  trackerId: TrackerId
  values: RateValues | null
}

/** The app score an AniList account on `format` stores for `appScore` and reads back. */
export function anilistStepScore(appScore: number, format: AnilistScoreFormat): number {
  return appScoreFromAnilistRaw(anilistQuantize(anilistRawFromAppScore(appScore), format))
}

function scoresAgree(
  source: { trackerId: TrackerId; score: number },
  target: { trackerId: TrackerId; score: number },
  format: AnilistScoreFormat
): boolean {
  if (source.score === target.score) return true
  if (target.trackerId === 'anilist') return target.score === anilistStepScore(source.score, format)
  if (source.trackerId === 'anilist') return source.score === anilistStepScore(target.score, format)
  return false
}

/**
 * The fields where `target` differs from `source`. `scoreFormat` is the
 * AniList user's, read only when one side is AniList.
 */
export function rateDiff(
  source: RateSide,
  target: RateSide,
  scoreFormat: AnilistScoreFormat
): SyncRateField[] {
  const s = source.values
  const t = target.values
  if (!s) return []
  if (!t) return [...RATE_FIELDS]
  return RATE_FIELDS.filter((f) =>
    f === 'score'
      ? !scoresAgree(
          { trackerId: source.trackerId, score: s.score },
          { trackerId: target.trackerId, score: t.score },
          scoreFormat
        )
      : s[f] !== t[f]
  )
}
