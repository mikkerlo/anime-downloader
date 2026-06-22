import { describe, it, expect } from 'vitest'
import {
  buildTasteProfile,
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
  it('treats a dropped title as a strong negative regardless of score', () => {
    expect(rateSentiment({ malId: 1, status: 'dropped', score: 0, genres: [] })).toBeLessThan(0)
    // Even a dropped title the user scored highly still suppresses its genres.
    expect(rateSentiment({ malId: 1, status: 'dropped', score: 9, genres: [] })).toBeLessThan(0)
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
  it('accumulates positive weight for liked genres and negative for dropped ones', () => {
    const rates: TasteRate[] = [
      { malId: 10, status: 'completed', score: 9, genres: ['Drama'] },
      { malId: 11, status: 'dropped', score: 0, genres: ['Ecchi'] }
    ]
    const taste = buildTasteProfile(rates)
    expect(taste.genreWeights.get('Drama')!).toBeGreaterThan(0)
    expect(taste.genreWeights.get('Ecchi')!).toBeLessThan(0)
    expect(taste.ratedMalIds.has(10)).toBe(true)
    expect(taste.ratedMalIds.has(11)).toBe(true)
    expect(taste.topGenres).toContain('Drama')
    expect(taste.topGenres).not.toContain('Ecchi')
  })
})

describe('rankRecommendations', () => {
  const taste = buildTasteProfile([
    { malId: 10, status: 'completed', score: 9, genres: ['Drama'] },
    { malId: 11, status: 'dropped', score: 0, genres: ['Ecchi'] }
  ])

  it('penalizes candidates whose genres match a dropped title (behavior difference)', () => {
    // Both candidates are otherwise identical — same community score, no seeds —
    // so only the genre affinity differs. The Drama candidate must outrank the
    // Ecchi one; this fails if dropped titles do NOT contribute negative weight.
    const dramaPick = candidate({ malId: 100, title: 'Drama Pick', genres: ['Drama'] })
    const ecchiPick = candidate({ malId: 101, title: 'Ecchi Pick', genres: ['Ecchi'] })
    const ranked = rankRecommendations([ecchiPick, dramaPick], taste)
    expect(ranked.map((r) => r.malId)).toEqual([100, 101])
    expect(ranked[0].matchScore).toBeGreaterThan(ranked[1].matchScore)
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
