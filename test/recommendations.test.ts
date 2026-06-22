import { describe, it, expect } from 'vitest'
import {
  buildTasteProfile,
  filterOutRated,
  rankRecommendations,
  rateSentiment,
  type RecommendationCandidate,
  type TasteRate
} from '../src/main/recommendations'

function candidate(over: Partial<RecommendationCandidate>): RecommendationCandidate {
  return {
    malId: 1,
    title: 'Candidate',
    posterUrl: 'http://img/poster.jpg',
    kind: 'tv',
    communityScore: 7,
    genres: [],
    seeds: [],
    ...over
  }
}

describe('rateSentiment', () => {
  it('does not penalize a dropped-but-unscored title (a drop is not a genre dislike)', () => {
    // The key behavior: dropping without scoring is neutral — the user may have
    // bailed for quality/pacing reasons unrelated to the genre.
    expect(rateSentiment({ malId: 1, status: 'dropped', score: 0, genres: [] })).toBe(0)
  })

  it('uses the explicit score regardless of status (dropped-low negative, dropped-high positive)', () => {
    // If the user *scored* a dropped title, that score is an honest signal.
    expect(rateSentiment({ malId: 1, status: 'dropped', score: 3, genres: [] })).toBeLessThan(0)
    expect(rateSentiment({ malId: 1, status: 'dropped', score: 8, genres: [] })).toBeGreaterThan(0)
  })

  it('centers scored titles on 6 (7+ positive, <=5 negative)', () => {
    expect(rateSentiment({ malId: 1, status: 'completed', score: 9, genres: [] })).toBeGreaterThan(
      0
    )
    expect(rateSentiment({ malId: 1, status: 'completed', score: 3, genres: [] })).toBeLessThan(0)
  })

  it('gives watched-but-unscored a mild positive and planned a neutral', () => {
    expect(rateSentiment({ malId: 1, status: 'watching', score: 0, genres: [] })).toBeGreaterThan(0)
    expect(rateSentiment({ malId: 1, status: 'planned', score: 0, genres: [] })).toBe(0)
  })
})

describe('buildTasteProfile', () => {
  it('weights liked genres positive, scored-low genres negative, and dropped-unscored neutral', () => {
    const rates: TasteRate[] = [
      { malId: 10, status: 'completed', score: 9, genres: ['Drama'] }, // liked → +
      { malId: 11, status: 'completed', score: 3, genres: ['Ecchi'] }, // disliked → -
      { malId: 12, status: 'dropped', score: 0, genres: ['Mecha'] } // dropped, no score → neutral
    ]
    const taste = buildTasteProfile(rates)
    expect(taste.genreWeights.get('Drama')!).toBeGreaterThan(0)
    expect(taste.genreWeights.get('Ecchi')!).toBeLessThan(0)
    // A merely-dropped genre is NOT dragged negative — that's the whole point.
    expect(taste.genreWeights.get('Mecha') ?? 0).toBe(0)
    expect(taste.ratedMalIds.has(10)).toBe(true)
    expect(taste.ratedMalIds.has(12)).toBe(true)
    expect(taste.topGenres).toContain('Drama')
    expect(taste.topGenres).not.toContain('Ecchi')
    expect(taste.topGenres).not.toContain('Mecha')
  })
})

describe('filterOutRated', () => {
  // Regression for the "completed title still recommended" report (#193): the
  // cached feed outlives rate changes, so serving it must re-exclude anything
  // the user has since rated/completed. A stale feed that still lists a now-
  // completed title (its id absent from the build-time exclusion because the
  // cache predates the completion) must be scrubbed on read.
  it('drops entries whose id is now on the user list, even from a stale feed', () => {
    const staleFeed = [
      { malId: 39535, title: 'Mushoku Tensei: Isekai Ittara Honki Dasu' },
      { malId: 200, title: 'Something New' }
    ]
    // The user has since completed Mushoku Tensei (39535).
    const ratedNow = new Set([39535])
    const result = filterOutRated(staleFeed, ratedNow)
    expect(result.map((r) => r.malId)).toEqual([200])
  })

  it('returns the feed unchanged when nothing overlaps', () => {
    const feed = [{ malId: 1 }, { malId: 2 }]
    expect(filterOutRated(feed, new Set([99]))).toEqual(feed)
  })
})

describe('rankRecommendations', () => {
  const taste = buildTasteProfile([
    { malId: 10, status: 'completed', score: 9, genres: ['Drama'] }, // liked → +
    { malId: 11, status: 'completed', score: 3, genres: ['Ecchi'] }, // scored low → -
    { malId: 12, status: 'dropped', score: 0, genres: ['Mecha'] } // dropped, unscored → 0
  ])

  it('penalizes scored-low genres but not merely-dropped ones (behavior difference)', () => {
    // All three candidates are otherwise identical (same community score, no
    // seeds), so only genre affinity differs. Order must be Drama (liked) >
    // Mecha (dropped-unscored, neutral) > Ecchi (scored-low). The Mecha-above-
    // Ecchi gap is the point: a drop alone must NOT push a genre down — that
    // only happens when the user actually scored the title low.
    const dramaPick = candidate({ malId: 100, title: 'Drama Pick', genres: ['Drama'] })
    const ecchiPick = candidate({ malId: 101, title: 'Ecchi Pick', genres: ['Ecchi'] })
    const mechaPick = candidate({ malId: 102, title: 'Mecha Pick', genres: ['Mecha'] })
    const ranked = rankRecommendations([ecchiPick, mechaPick, dramaPick], taste)
    expect(ranked.map((r) => r.malId)).toEqual([100, 102, 101])
  })

  it('excludes titles already on the user list', () => {
    const onList = candidate({ malId: 10, genres: ['Drama'] })
    const fresh = candidate({ malId: 200, genres: ['Drama'] })
    const ranked = rankRecommendations([onList, fresh], taste)
    expect(ranked.map((r) => r.malId)).toEqual([200])
  })

  it('breaks ties between equally-relevant candidates by community score', () => {
    const lower = candidate({ malId: 300, genres: ['Drama'], communityScore: 6 })
    const higher = candidate({ malId: 301, genres: ['Drama'], communityScore: 9 })
    const ranked = rankRecommendations([lower, higher], taste)
    expect(ranked.map((r) => r.malId)).toEqual([301, 300])
  })

  it('attaches a "Because you liked X" reason from the strongest seed', () => {
    const pick = candidate({
      malId: 400,
      genres: ['Drama'],
      seeds: [
        { title: 'Clannad', score: 8 },
        { title: 'Anohana', score: 10 }
      ]
    })
    const ranked = rankRecommendations([pick], taste)
    expect(ranked[0].reason).toBe('Because you liked «Anohana»')
  })

  it('honors the result limit', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      candidate({ malId: 1000 + i, genres: ['Drama'] })
    )
    expect(rankRecommendations(many, taste, 10)).toHaveLength(10)
  })
})
