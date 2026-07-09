// Recommendations engine (#193) — pure, I/O-free ranking logic.
//
// Shikimori has no personalized-recommendation endpoint, so the "what to watch
// next" feed is assembled locally: the IPC router seeds from the user's
// highest-rated titles, fans out `getSimilar` per seed, then hands the merged
// candidate pool to `rankRecommendations` here. Keeping the scoring side-effect
// free makes the ranking unit-testable without mocking `electron` or `fetch`.

import type { ShikiUserRateStatus } from './shikimori'

/** A genre's display name, deduped across the two locales Shikimori exposes. */
export type GenreName = string

/** One of the user's rated entries, reduced to what scoring needs. */
export interface TasteRate {
  malId: number
  status: ShikiUserRateStatus
  score: number
  /** Genres for this rated title, when its detail payload is cached. */
  genres: GenreName[]
}

/** A seed title that surfaced a candidate via Shikimori `/similar`. */
export interface CandidateSeed {
  title: string
  /** The user's 1–10 score for the seed (0 when watched-but-unscored). */
  score: number
}

/** A merged `/similar` result, enriched with cached genres + seed provenance. */
export interface RecommendationCandidate {
  malId: number
  title: string
  posterUrl: string
  kind: string | null
  /** Shikimori community score (0–10), parsed from the API's string field. */
  communityScore: number
  /** Candidate's own genres, when its detail payload is cached locally. */
  genres: GenreName[]
  /** Distinct seed titles that surfaced this candidate (provenance + consensus). */
  seeds: CandidateSeed[]
  /** Sourced from the currently-airing pool (#206). */
  airing?: boolean
}

/** A scored, ranked recommendation (pre smotret-anime resolution). */
export interface RankedRecommendation {
  malId: number
  title: string
  posterUrl: string
  kind: string | null
  communityScore: number
  /** Internal ranking score — exposed for stable sort + debugging. */
  matchScore: number
  /** Genre-affinity term alone — the `splitAiringRow` partition predicate. */
  genreScore: number
  /** Human-readable explanation shown as a chip in the UI. */
  reason: string
  /** Sourced from the currently-airing pool (#206). */
  airing?: boolean
}

/** Aggregated taste signal derived from the user's rate list. */
export interface TasteProfile {
  /** Per-genre affinity: positive = liked, negative = scored-low (disliked). */
  genreWeights: Map<GenreName, number>
  /** Every MAL id already on the user's list (any status) — never recommend. */
  ratedMalIds: Set<number>
  /** Favorite genres (highest positive weight first) for fallback reasons. */
  topGenres: GenreName[]
}

// Scoring weights. Genre affinity is the primary relevance signal; the seed
// score + consensus encode "scores & watch history"; community score is a
// gentle popularity tie-break so niche entries don't outrank equally-relevant
// well-regarded shows.
const W_GENRE = 1
const W_SEED = 0.6
const W_CONSENSUS = 0.8
const W_POPULARITY = 0.25

/**
 * Turn a watched title into a per-genre sentiment. The honest signal is the
 * explicit score — a low score means the user disliked *this title*, whatever
 * its status — so we deliberately do NOT add an extra penalty for `dropped`: a
 * drop is often about a show's quality or pacing, not its genre, and shouldn't
 * drag the genre down on its own. A dropped title only counts against its
 * genres if the user *also* scored it low.
 *
 *  - scored → centered on 6 (7+ positive, ≤5 negative), regardless of status,
 *  - watched but unscored → mildly positive (they kept watching it),
 *  - dropped-unscored / planned / on-hold → neutral.
 */
export function rateSentiment(rate: TasteRate): number {
  if (rate.score > 0) return rate.score - 6
  if (rate.status === 'completed' || rate.status === 'watching' || rate.status === 'rewatching') {
    return 1
  }
  return 0
}

/**
 * Drop entries whose MAL id is already on the user's list. Applied to the
 * *cached* feed on every read so a stale cache can never surface a title the
 * user has since rated/completed — the build-time exclusion alone isn't enough
 * because the cached blob outlives rate changes (#193 follow-up).
 */
export function filterOutRated<T extends { malId: number }>(
  entries: T[],
  ratedMalIds: Set<number>
): T[] {
  return entries.filter((e) => !ratedMalIds.has(e.malId))
}

export function buildTasteProfile(rates: TasteRate[]): TasteProfile {
  const genreWeights = new Map<GenreName, number>()
  const ratedMalIds = new Set<number>()

  for (const rate of rates) {
    ratedMalIds.add(rate.malId)
    const sentiment = rateSentiment(rate)
    if (sentiment === 0) continue
    for (const genre of rate.genres) {
      genreWeights.set(genre, (genreWeights.get(genre) ?? 0) + sentiment)
    }
  }

  const topGenres = [...genreWeights.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)

  return { genreWeights, ratedMalIds, topGenres }
}

function genreScore(genres: GenreName[], taste: TasteProfile): number {
  if (genres.length === 0) return 0
  let sum = 0
  for (const g of genres) sum += taste.genreWeights.get(g) ?? 0
  // Normalize by sqrt(count) so a candidate can't climb the ranking purely by
  // listing many genres (genre-stuffing) while still rewarding broader overlap.
  return sum / Math.sqrt(genres.length)
}

function bestSeed(seeds: CandidateSeed[]): CandidateSeed | null {
  let best: CandidateSeed | null = null
  for (const s of seeds) {
    if (!best || s.score > best.score) best = s
  }
  return best
}

function buildReason(candidate: RecommendationCandidate, taste: TasteProfile): string {
  const seed = bestSeed(candidate.seeds)
  if (seed) return `Because you liked «${seed.title}»`
  const matched = candidate.genres.filter((g) => taste.genreWeights.get(g)! > 0).slice(0, 2)
  if (matched.length > 0) return `Matches your top genres: ${matched.join(', ')}`
  return 'Popular with viewers like you'
}

/**
 * Rank candidates by the weighted blend of genre affinity, seed score +
 * consensus, and community popularity. Titles already on the user's list are
 * excluded. Returns at most `limit` results, highest score first.
 */
export function rankRecommendations(
  candidates: RecommendationCandidate[],
  taste: TasteProfile,
  limit = 60
): RankedRecommendation[] {
  const ranked: RankedRecommendation[] = []

  for (const c of candidates) {
    if (taste.ratedMalIds.has(c.malId)) continue

    const seed = bestSeed(c.seeds)
    const genre = genreScore(c.genres, taste)
    const matchScore =
      W_GENRE * genre +
      W_SEED * (seed ? seed.score : 0) +
      W_CONSENSUS * c.seeds.length +
      W_POPULARITY * c.communityScore

    ranked.push({
      malId: c.malId,
      title: c.title,
      posterUrl: c.posterUrl,
      kind: c.kind,
      communityScore: c.communityScore,
      matchScore,
      genreScore: genre,
      reason: buildReason(c, taste),
      airing: c.airing
    })
  }

  ranked.sort((a, b) => b.matchScore - a.matchScore || b.communityScore - a.communityScore)
  return ranked.slice(0, limit)
}

/**
 * Partition an UNCAPPED ranking into the "Airing now for you" row and the main
 * feed, then cap each section. Must run before any result-limit slice: seedless
 * airing entries cluster at the bottom of a mixed ranking, so a pre-capped list
 * would have already truncated exactly the entries the row exists to surface.
 *
 * Row membership = sourced from the airing pool AND positive genre affinity
 * (`genreScore > 0` — zero means no genre data or no overlap, and the row is
 * personalized, not a popularity chart). An airing entry that fails the gate or
 * overflows the row cap falls through to the main feed like any other
 * candidate; the persisted `airing` flag must then reflect ROW MEMBERSHIP, not
 * pool provenance, or the renderer's flag-based partition would resurrect it.
 */
export function splitAiringRow(
  ranked: RankedRecommendation[],
  airingCap: number,
  mainCap: number
): { airingRow: RankedRecommendation[]; mainFeed: RankedRecommendation[] } {
  const airingRow: RankedRecommendation[] = []
  const mainFeed: RankedRecommendation[] = []
  for (const r of ranked) {
    if (r.airing && r.genreScore > 0 && airingRow.length < airingCap) {
      airingRow.push(r)
    } else if (mainFeed.length < mainCap) {
      mainFeed.push(r)
    }
  }
  return { airingRow, mainFeed }
}
