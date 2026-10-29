// Owner decision 5 (#584 §2, "The raise"): episodes a library flips to
// watched raise the Shikimori count on the owner's logged-in PC, with the same
// `nextWatchedRate` S0's auto-mark uses. Pure.
//
// - Guard 1: no raise at all on a merge with no base (every watched flag is
//   "new" there, so a fresh watch can't be told from history).
// - A forward raise (`episodes` up, `watching`) always goes through.
// - A rewatch raise (the merged rate is `completed`) keeps only the flips newer
//   than the rate's Shikimori clock (guard 2); it stays unconfirmed until
//   Shikimori accepts it.
// - One call with the highest flipped episode, never a fold.

import { NO_RATE_BEFORE, nextWatchedRate, type RateValues } from '../shikimori-rate'

export interface WatchFlip {
  episodeInt: string
  at: number
  origin: string
}

export interface Raise {
  kind: 'forward' | 'rewatch'
  rate: RateValues
  /** The highest flipped episode's `watched` clock. */
  clock: SyncClock
  flips: WatchFlip[]
}

/** Whole-number `episodeInt`s only: `"12.5"` never maps to `rate.episodes` (S4's global rule). */
export function wholeEpisode(episodeInt: string): number | null {
  if (!/^\d+$/.test(episodeInt)) return null
  const n = Number(episodeInt)
  return n > 0 && Number.isSafeInteger(n) ? n : null
}

export function computeRaise(input: {
  noBase: boolean
  flips: WatchFlip[]
  mergedRate: RateValues | null
  /** The latest Shikimori clock of the rate (cached `serverUpdatedAt`, or an `origin: 'shikimori'` field clock). */
  shikimoriAt: number | null
}): Raise | null {
  if (input.noBase) return null
  const flips = input.flips.filter((f) => wholeEpisode(f.episodeInt) !== null)
  if (flips.length === 0) return null
  const basis = input.mergedRate ?? NO_RATE_BEFORE
  const kind = basis.status === 'completed' ? 'rewatch' : 'forward'
  const kept =
    kind === 'rewatch' && input.shikimoriAt !== null
      ? flips.filter((f) => f.at > input.shikimoriAt!)
      : flips
  if (kept.length === 0) return null
  const top = kept.reduce((m, f) =>
    wholeEpisode(f.episodeInt)! > wholeEpisode(m.episodeInt)! ? f : m
  )
  const rate = nextWatchedRate(basis, wholeEpisode(top.episodeInt)!)
  if (!rate) return null
  return { kind, rate, clock: { at: top.at, origin: top.origin }, flips: kept }
}
