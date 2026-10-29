// Owner decision 5's raise (#584 §2), the pure half: guard 1, the forward /
// rewatch split, guard 2 on rewatch raises only, and whole episodes only.
import { describe, it, expect } from 'vitest'
import { computeRaise, wholeEpisode } from '../../../src/main/lib/sync-merge/raise'
import { nextWatchedRate } from '../../../src/main/lib/shikimori-rate'

const flip = (episodeInt: string, at: number) => ({ episodeInt, at, origin: 'pc-claim' })
const watching3 = { episodes: 3, status: 'watching' as const, score: 7, rewatches: 0 }
const completed12 = { episodes: 12, status: 'completed' as const, score: 9, rewatches: 1 }

describe('computeRaise', () => {
  it('a claim PC watched 4–6 on a title at watching, 3: one forward raise to 6', () => {
    const r = computeRaise({
      noBase: false,
      flips: [flip('4', 10), flip('6', 30), flip('5', 20)],
      mergedRate: watching3,
      shikimoriAt: null
    })
    expect(r).toMatchObject({
      kind: 'forward',
      rate: { episodes: 6, status: 'watching', score: 7, rewatches: 0 }
    })
    expect(r!.clock).toEqual({ at: 30, origin: 'pc-claim' })
  })

  it('guard 1: no raise at all with no base, forward or rewatch', () => {
    expect(
      computeRaise({
        noBase: true,
        flips: [flip('6', 30)],
        mergedRate: watching3,
        shikimoriAt: null
      })
    ).toBeNull()
    expect(
      computeRaise({
        noBase: true,
        flips: [flip('1', 30)],
        mergedRate: completed12,
        shikimoriAt: null
      })
    ).toBeNull()
  })

  it('"6.5" alone raises nothing', () => {
    expect(wholeEpisode('6.5')).toBeNull()
    expect(
      computeRaise({
        noBase: false,
        flips: [flip('6.5', 30)],
        mergedRate: watching3,
        shikimoriAt: null
      })
    ).toBeNull()
  })

  it('a forward raise goes through whatever the Shikimori clock (owner answer)', () => {
    const r = computeRaise({
      noBase: false,
      flips: [flip('6', 5)],
      mergedRate: watching3,
      shikimoriAt: 9
    })
    expect(r).toMatchObject({ kind: 'forward', rate: { episodes: 6 } })
  })

  it('a rewatch raise keeps only flips newer than the Shikimori clock (guard 2)', () => {
    expect(
      computeRaise({
        noBase: false,
        flips: [flip('12', 100)],
        mergedRate: completed12,
        shikimoriAt: 105
      })
    ).toBeNull()
    const r = computeRaise({
      noBase: false,
      flips: [flip('1', 200), flip('3', 210), flip('5', 50)],
      mergedRate: completed12,
      shikimoriAt: 105
    })
    // One call, not a fold: rewatching, the highest kept flip, rewatches + 1.
    expect(r).toMatchObject({
      kind: 'rewatch',
      rate: { status: 'rewatching', episodes: 3, rewatches: 2, score: 9 }
    })
  })

  it('with no Shikimori clock every flip of a rewatch passes', () => {
    expect(
      computeRaise({
        noBase: false,
        flips: [flip('2', 1)],
        mergedRate: completed12,
        shikimoriAt: null
      })
    ).toMatchObject({ kind: 'rewatch' })
  })

  it('a raise already on the rate is not repeated (nextWatchedRate returns null)', () => {
    const at6 = { ...watching3, episodes: 6 }
    expect(
      computeRaise({ noBase: false, flips: [flip('6', 30)], mergedRate: at6, shikimoriAt: null })
    ).toBeNull()
  })

  it('a title with no rate starts from S0s no-rate basis', () => {
    expect(
      computeRaise({ noBase: false, flips: [flip('2', 1)], mergedRate: null, shikimoriAt: null })
    ).toMatchObject({
      kind: 'forward',
      rate: { episodes: 2, status: 'watching' }
    })
  })
})

describe('nextWatchedRate moved to lib/shikimori-rate.ts', () => {
  it('is the auto-mark rule', () => {
    expect(nextWatchedRate(completed12, 3)).toEqual({
      episodes: 3,
      status: 'rewatching',
      score: 9,
      rewatches: 2
    })
    expect(nextWatchedRate(watching3, 2)).toBeNull()
  })
})
