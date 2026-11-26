// Score and status mapping (#689). The app score is an integer 0–10
// (`lib/shikimori-rate.ts:13`), so a raw AniList score is only round-tripped
// under the unchanged predicate: the stored raw is kept while the app score
// still matches it.
import { describe, it, expect } from 'vitest'
import {
  ANILIST_SCORE_FORMATS,
  APP_STATUSES,
  anilistQuantize,
  anilistRawFromAppScore,
  anilistRawToStore,
  anilistScoreUnchanged,
  anilistStatusFromApp,
  appScoreFromAnilistRaw,
  appStatusFromAnilist,
  appStatusFromMal,
  malStatusFromApp,
  type AnilistScoreFormat,
  type AnilistStatus,
  type MalStatusPair
} from '../../src/main/trackers/scores'

/** Every raw score a user can hold under each format. */
const RAWS: Record<AnilistScoreFormat, number[]> = {
  POINT_100: Array.from({ length: 101 }, (_, i) => i),
  POINT_10_DECIMAL: Array.from({ length: 101 }, (_, i) => i),
  POINT_10: Array.from({ length: 11 }, (_, i) => i * 10),
  POINT_5: Array.from({ length: 6 }, (_, i) => i * 20),
  POINT_3: [0, 35, 60, 85]
}

describe('AniList scores', () => {
  it('writes scoreRaw as appScore * 10', () => {
    for (let s = 0; s <= 10; s++) expect(anilistRawFromAppScore(s)).toBe(s * 10)
  })

  it('reads a raw score as the nearest app score', () => {
    expect(appScoreFromAnilistRaw(0)).toBe(0)
    expect(appScoreFromAnilistRaw(84)).toBe(8)
    expect(appScoreFromAnilistRaw(85)).toBe(9)
    expect(appScoreFromAnilistRaw(100)).toBe(10)
  })

  it('a low raw score (POINT_100 1–4, POINT_10_DECIMAL 0.1–0.4) reads as 1, never as "no score"', () => {
    for (const raw of [1, 3, 4]) expect(appScoreFromAnilistRaw(raw), `raw ${raw}`).toBe(1)
    expect(appScoreFromAnilistRaw(5)).toBe(1)
    expect(appScoreFromAnilistRaw(0)).toBe(0)
  })

  it('clearing a raw 3 writes 0', () => {
    expect(anilistScoreUnchanged(0, 3, 'POINT_100')).toBe(false)
    expect(anilistRawToStore(0, 3, 'POINT_100')).toBe(0)
    expect(anilistRawToStore(0, 3, 'POINT_10_DECIMAL')).toBe(0)
  })

  it('clearing a stale low raw under a coarse format writes 0 (POINT_10 raw 3, POINT_5 raw 1–9)', () => {
    expect(anilistScoreUnchanged(0, 3, 'POINT_10')).toBe(false)
    expect(anilistRawToStore(0, 3, 'POINT_10')).toBe(0)
    for (let raw = 1; raw <= 9; raw++) {
      expect(anilistScoreUnchanged(0, raw, 'POINT_5'), `raw ${raw}`).toBe(false)
      expect(anilistRawToStore(0, raw, 'POINT_5'), `raw ${raw}`).toBe(0)
    }
  })

  it.each(ANILIST_SCORE_FORMATS)('setting a score from 0 is always a change (%s)', (format) => {
    for (let s = 1; s <= 10; s++) {
      expect(anilistScoreUnchanged(s, 0, format), `app ${s}`).toBe(false)
      expect(anilistRawToStore(s, 0, format), `app ${s}`).toBe(s * 10)
    }
  })

  describe.each(ANILIST_SCORE_FORMATS)('%s', (format) => {
    it.each(APP_STATUSES)(
      'the round trip is the identity under the unchanged predicate (%s)',
      (status) => {
        for (const raw of RAWS[format]) {
          const app = appScoreFromAnilistRaw(raw)
          expect(anilistScoreUnchanged(app, raw, format), `raw ${raw}`).toBe(true)
          expect(anilistRawToStore(app, raw, format), `raw ${raw}`).toBe(raw)
          expect(appStatusFromAnilist(anilistStatusFromApp(status))).toBe(status)
        }
      }
    )

    it('an app score the format can tell apart is a change', () => {
      const raw = RAWS[format].at(-1)!
      expect(anilistScoreUnchanged(0, raw, format)).toBe(false)
      expect(anilistRawToStore(0, raw, format)).toBe(0)
    })

    it('a title with no stored score takes appScore * 10', () => {
      expect(anilistRawToStore(7, null, format)).toBe(70)
    })

    it('writing an app score and reading it back gives the same app score', () => {
      for (let s = 0; s <= 10; s++) {
        expect(appScoreFromAnilistRaw(anilistRawFromAppScore(s))).toBe(s)
      }
    })
  })

  it('a POINT_100 85 read as an app score and left unchanged keeps the stored 85', () => {
    const app = appScoreFromAnilistRaw(85)
    expect(app).toBe(9)
    expect(anilistScoreUnchanged(app, 85, 'POINT_100')).toBe(true)
    expect(anilistRawToStore(app, 85, 'POINT_100')).toBe(85)
    // A real edit replaces it.
    expect(anilistScoreUnchanged(8, 85, 'POINT_100')).toBe(false)
    expect(anilistRawToStore(8, 85, 'POINT_100')).toBe(80)
  })

  it('a POINT_10_DECIMAL 8.5 is kept while the app score stays 9', () => {
    expect(anilistRawToStore(9, 85, 'POINT_10_DECIMAL')).toBe(85)
  })

  it('rounding inside a coarse format is not a change', () => {
    // A POINT_5 user at 4 stars (80): app 7 would land on 4 stars too (70 → 80).
    expect(anilistQuantize(70, 'POINT_5')).toBe(80)
    expect(anilistScoreUnchanged(7, 80, 'POINT_5')).toBe(true)
    expect(anilistScoreUnchanged(5, 80, 'POINT_5')).toBe(false)
    // POINT_3's faces: 5 and 6 both land on :| (60).
    expect(anilistScoreUnchanged(5, 60, 'POINT_3')).toBe(true)
    expect(anilistScoreUnchanged(9, 60, 'POINT_3')).toBe(false)
  })
})

describe('status tables', () => {
  it.each<[AnilistStatus, string]>([
    ['CURRENT', 'watching'],
    ['PLANNING', 'planned'],
    ['COMPLETED', 'completed'],
    ['DROPPED', 'dropped'],
    ['PAUSED', 'on_hold'],
    ['REPEATING', 'rewatching']
  ])('AniList %s ↔ %s', (anilist, app) => {
    expect(appStatusFromAnilist(anilist)).toBe(app)
    expect(anilistStatusFromApp(app as never)).toBe(anilist)
  })

  it.each<[MalStatusPair, string]>([
    [{ status: 'watching', is_rewatching: false }, 'watching'],
    [{ status: 'watching', is_rewatching: true }, 'rewatching'],
    [{ status: 'completed', is_rewatching: false }, 'completed'],
    [{ status: 'on_hold', is_rewatching: false }, 'on_hold'],
    [{ status: 'dropped', is_rewatching: false }, 'dropped'],
    [{ status: 'plan_to_watch', is_rewatching: false }, 'planned']
  ])('MAL %o ↔ %s', (mal, app) => {
    expect(appStatusFromMal(mal)).toBe(app)
    expect(malStatusFromApp(app as never)).toEqual(mal)
  })

  it('every app status round-trips through both tables', () => {
    for (const s of APP_STATUSES) {
      expect(appStatusFromAnilist(anilistStatusFromApp(s))).toBe(s)
      expect(appStatusFromMal(malStatusFromApp(s))).toBe(s)
    }
  })
})
