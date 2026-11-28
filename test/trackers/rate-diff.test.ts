// The shared difference rule (#705): `rateDiff(source, target, scoreFormat)`,
// which `tracker:get-rate`'s `differs`, "Copy from primary" and T10's diff
// (#708) all call. Both sides are projections in app values, so an AniList
// side is written here as the app score its raw score reads as.
import { describe, it, expect } from 'vitest'
import { anilistStepScore, rateDiff, type RateSide } from '../../src/main/trackers/rate-diff'
import {
  ANILIST_SCORE_FORMATS,
  appScoreFromAnilistRaw,
  type AnilistScoreFormat
} from '../../src/main/trackers/scores'
import type { RateValues } from '../../src/main/lib/shikimori-rate'

const rv = (over: Partial<RateValues> = {}): RateValues => ({
  episodes: 9,
  status: 'watching',
  score: 8,
  rewatches: 0,
  ...over
})

const side = (trackerId: TrackerId, values: RateValues | null): RateSide => ({ trackerId, values })

describe('rateDiff: scores', () => {
  /** A raw score per format that only rounds to the app score beside it. */
  const ROUNDING: [AnilistScoreFormat, number, number][] = [
    ['POINT_100', 84, 8],
    ['POINT_10_DECIMAL', 76, 8],
    ['POINT_10', 80, 8],
    ['POINT_5', 80, 8],
    ['POINT_3', 85, 9]
  ]

  it.each(ROUNDING)(
    '%s: an AniList raw %i against the app %i is no difference, either way round',
    (format, raw, app) => {
      const al = side('anilist', rv({ score: appScoreFromAnilistRaw(raw) }))
      const shiki = side('shikimori', rv({ score: app }))
      expect(rateDiff(shiki, al, format)).toEqual([])
      expect(rateDiff(al, shiki, format)).toEqual([])
    }
  )

  it('every format is covered by a rounding row', () => {
    expect(ROUNDING.map(([f]) => f)).toEqual([...ANILIST_SCORE_FORMATS])
  })

  it('a real score change is a difference', () => {
    expect(
      rateDiff(side('shikimori', rv({ score: 8 })), side('mal', rv({ score: 6 })), 'POINT_10')
    ).toEqual(['score'])
    // POINT_100 86 reads as 9: not the 8 beside it.
    expect(
      rateDiff(
        side('shikimori', rv({ score: 8 })),
        side('anilist', rv({ score: appScoreFromAnilistRaw(86) })),
        'POINT_100'
      )
    ).toEqual(['score'])
  })

  it('without an AniList side there is no step rule: Shikimori 7 against MAL 8 differs', () => {
    expect(
      rateDiff(side('shikimori', rv({ score: 7 })), side('mal', rv({ score: 8 })), 'POINT_5')
    ).toEqual(['score'])
  })

  describe('the lossy-scale read-back (POINT_5, POINT_3)', () => {
    /** The app 7 as each format stores it, and a stored score one step away. */
    const STEPS: [AnilistScoreFormat, number, number][] = [
      // 70 → 80 (4 stars) → 8; one step down is 60 → 6.
      ['POINT_5', 8, 6],
      // 70 → 85 (the top face) → 9; one step down is 60 → 6.
      ['POINT_3', 9, 6]
    ]

    it.each(STEPS)('%s: the step mapping is what the rows below assume', (format, atStep) => {
      expect(anilistStepScore(7, format)).toBe(atStep)
    })

    it.each(STEPS)(
      '%s: a primary 7 against the AniList score 7 takes at the step is no difference',
      (format, atStep) => {
        const primary = side('shikimori', rv({ score: 7 }))
        expect(rateDiff(primary, side('anilist', rv({ score: atStep })), format)).toEqual([])
      }
    )

    it.each(STEPS)(
      '%s: an AniList primary at the step against a mirror at 7 is no difference',
      (format, atStep) => {
        const primary = side('anilist', rv({ score: atStep }))
        expect(rateDiff(primary, side('mal', rv({ score: 7 })), format)).toEqual([])
      }
    )

    it.each(STEPS)(
      '%s: an AniList score one step away is a difference, either way round',
      (format, _atStep, oneAway) => {
        const al = side('anilist', rv({ score: oneAway }))
        const shiki = side('shikimori', rv({ score: 7 }))
        expect(rateDiff(shiki, al, format)).toEqual(['score'])
        expect(rateDiff(al, shiki, format)).toEqual(['score'])
      }
    )
  })
})

describe('rateDiff: status, episodes and rewatches', () => {
  it.each([
    ['status', { status: 'completed' }],
    ['episodes', { episodes: 12 }],
    ['rewatches', { rewatches: 2 }]
  ] as const)('%s produces exactly its own field', (field, over) => {
    expect(rateDiff(side('shikimori', rv()), side('anilist', rv(over)), 'POINT_10')).toEqual([
      field
    ])
  })

  it('every field at once, in RATE_FIELDS order', () => {
    expect(
      rateDiff(
        side('shikimori', rv()),
        side('mal', { episodes: 1, status: 'dropped', score: 2, rewatches: 3 }),
        'POINT_10'
      )
    ).toEqual(['episodes', 'status', 'score', 'rewatches'])
  })

  it('rewatches are compared as-is: a rewatching pair with equal counts is no difference', () => {
    const a = rv({ status: 'rewatching', rewatches: 1 })
    expect(rateDiff(side('shikimori', a), side('anilist', { ...a }), 'POINT_10')).toEqual([])
    expect(rateDiff(side('anilist', a), side('mal', { ...a }), 'POINT_10')).toEqual([])
  })

  it('rewatches are compared as-is: a rewatching pair with different counts differs', () => {
    const a = rv({ status: 'rewatching', rewatches: 1 })
    expect(
      rateDiff(side('shikimori', a), side('anilist', { ...a, rewatches: 2 }), 'POINT_10')
    ).toEqual(['rewatches'])
  })

  it('takes no provider semantics: three arguments, the third only the AniList scale', () => {
    expect(rateDiff.length).toBe(3)
  })
})

describe('rateDiff: one-sided pairs', () => {
  it('a missing target row against a primary row differs in every field', () => {
    expect(rateDiff(side('shikimori', rv()), side('anilist', null), 'POINT_10')).toEqual([
      'episodes',
      'status',
      'score',
      'rewatches'
    ])
  })

  it('including a planned/0/0/0 primary, which a field-by-field compare with NO_RATE_BEFORE misses', () => {
    const planned: RateValues = { episodes: 0, status: 'planned', score: 0, rewatches: 0 }
    expect(rateDiff(side('shikimori', planned), side('mal', null), 'POINT_10')).toEqual([
      'episodes',
      'status',
      'score',
      'rewatches'
    ])
  })

  it('a missing primary row against a present mirror row is no difference (one-directional)', () => {
    expect(rateDiff(side('shikimori', null), side('anilist', rv()), 'POINT_10')).toEqual([])
  })

  it('no row on either side is no difference', () => {
    expect(rateDiff(side('shikimori', null), side('anilist', null), 'POINT_10')).toEqual([])
  })
})
