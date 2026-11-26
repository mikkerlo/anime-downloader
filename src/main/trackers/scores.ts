// Score and status mapping between the app and each tracker (#689).
//
// The app's vocabulary is canonical: a score is an integer 0–10 and a status is
// one of Shikimori's six (`RateValues`, `lib/shikimori-rate.ts`). Shikimori
// needs no mapping. AniList and MyAnimeList map to and from it here.

import type { RateValues } from '../lib/shikimori-rate'

type AppStatus = RateValues['status']

export const APP_STATUSES: readonly AppStatus[] = [
  'planned',
  'watching',
  'rewatching',
  'completed',
  'on_hold',
  'dropped'
]

// ---- AniList scores ---------------------------------------------------------

/** The user's AniList score format. The API's `scoreRaw` is always the 100-point scale. */
export type AnilistScoreFormat =
  | 'POINT_100'
  | 'POINT_10_DECIMAL'
  | 'POINT_10'
  | 'POINT_5'
  | 'POINT_3'

export const ANILIST_SCORE_FORMATS: readonly AnilistScoreFormat[] = [
  'POINT_100',
  'POINT_10_DECIMAL',
  'POINT_10',
  'POINT_5',
  'POINT_3'
]

const clampApp = (n: number): number => Math.min(10, Math.max(0, Math.round(n)))

/** The `scoreRaw` the app writes for an app score: `appScore * 10`. */
export function anilistRawFromAppScore(appScore: number): number {
  return clampApp(appScore) * 10
}

/**
 * The app score (0–10) a stored `scoreRaw` reads as. A positive raw never
 * reads as 0, which means "no score": a `POINT_100` 1–4 reads as 1.
 */
export function appScoreFromAnilistRaw(raw: number): number {
  return raw > 0 ? Math.max(1, clampApp(raw / 10)) : 0
}

/**
 * The value a raw score lands on in a format's own scale, still on the
 * 100-point scale: `POINT_10` keeps tens, `POINT_5` twenties, and `POINT_3`
 * its three faces (35, 60, 85). T7 confirms the steps against captured
 * fixtures.
 */
export function anilistQuantize(raw: number, format: AnilistScoreFormat): number {
  switch (format) {
    case 'POINT_100':
    case 'POINT_10_DECIMAL':
      return Math.round(raw)
    case 'POINT_10':
      return Math.round(raw / 10) * 10
    case 'POINT_5':
      return Math.round(raw / 20) * 20
    case 'POINT_3':
      if (raw <= 0) return 0
      if (raw <= 35) return 35
      if (raw <= 60) return 60
      return 85
  }
}

/**
 * Whether an app score still matches a stored raw score under `format`, so
 * rounding never counts as a change or as a reconcile diff. True when the raw
 * score reads as that app score (a `POINT_100` 85 read as 9 and left at 9), or
 * when writing the app score would land on the same value in the user's
 * format.
 */
export function anilistScoreUnchanged(
  appScore: number,
  storedRaw: number,
  format: AnilistScoreFormat
): boolean {
  if (appScoreFromAnilistRaw(storedRaw) === appScore) return true
  return (
    anilistQuantize(anilistRawFromAppScore(appScore), format) === anilistQuantize(storedRaw, format)
  )
}

/** The raw score to store: the stored one when the app score still matches it. */
export function anilistRawToStore(
  appScore: number,
  storedRaw: number | null,
  format: AnilistScoreFormat
): number {
  if (storedRaw !== null && anilistScoreUnchanged(appScore, storedRaw, format)) return storedRaw
  return anilistRawFromAppScore(appScore)
}

// ---- Statuses ---------------------------------------------------------------

export type AnilistStatus =
  | 'CURRENT'
  | 'PLANNING'
  | 'COMPLETED'
  | 'DROPPED'
  | 'PAUSED'
  | 'REPEATING'

const ANILIST_TO_APP: Record<AnilistStatus, AppStatus> = {
  CURRENT: 'watching',
  PLANNING: 'planned',
  COMPLETED: 'completed',
  DROPPED: 'dropped',
  PAUSED: 'on_hold',
  REPEATING: 'rewatching'
}

const APP_TO_ANILIST: Record<AppStatus, AnilistStatus> = {
  watching: 'CURRENT',
  planned: 'PLANNING',
  completed: 'COMPLETED',
  dropped: 'DROPPED',
  on_hold: 'PAUSED',
  rewatching: 'REPEATING'
}

export function appStatusFromAnilist(status: AnilistStatus): AppStatus {
  return ANILIST_TO_APP[status]
}

export function anilistStatusFromApp(status: AppStatus): AnilistStatus {
  return APP_TO_ANILIST[status]
}

export type MalStatus = 'watching' | 'completed' | 'on_hold' | 'dropped' | 'plan_to_watch'

/** MAL's status pair: a rewatch is `watching` with `is_rewatching`. */
export interface MalStatusPair {
  status: MalStatus
  is_rewatching: boolean
}

const MAL_TO_APP: Record<MalStatus, AppStatus> = {
  watching: 'watching',
  completed: 'completed',
  on_hold: 'on_hold',
  dropped: 'dropped',
  plan_to_watch: 'planned'
}

export function appStatusFromMal(pair: MalStatusPair): AppStatus {
  return pair.is_rewatching ? 'rewatching' : MAL_TO_APP[pair.status]
}

export function malStatusFromApp(status: AppStatus): MalStatusPair {
  if (status === 'rewatching') return { status: 'watching', is_rewatching: true }
  const mal = (Object.keys(MAL_TO_APP) as MalStatus[]).find((m) => MAL_TO_APP[m] === status)!
  return { status: mal, is_rewatching: false }
}
