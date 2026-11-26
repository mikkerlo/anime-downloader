// The per-class policy table (#689). `docs/trackers.md` carries the same
// table, and T2a's drain implements it.
import { describe, it, expect } from 'vitest'
import {
  SERVER_ERROR_DROP_AFTER_MS,
  TRACKER_ERROR_CLASSES,
  TRACKER_ERROR_POLICY,
  TrackerApiError
} from '../../src/main/trackers/errors'

describe('TRACKER_ERROR_POLICY', () => {
  it.each([
    ['network', { drain: 'abort', entry: 'keep', needsSetup: false }],
    ['auth', { drain: 'abort', entry: 'keep', needsSetup: false }],
    ['rate-limit', { drain: 'abort', entry: 'keep', needsSetup: false }],
    ['server', { drain: 'continue', entry: 'drop-after-24h', needsSetup: false }],
    ['item', { drain: 'continue', entry: 'drop', needsSetup: false }],
    ['config', { drain: 'abort', entry: 'keep', needsSetup: true }]
  ] as const)('%s', (cls, policy) => {
    expect(TRACKER_ERROR_POLICY[cls]).toEqual(policy)
  })

  it('covers exactly the six classes', () => {
    expect(Object.keys(TRACKER_ERROR_POLICY).sort()).toEqual([...TRACKER_ERROR_CLASSES].sort())
    expect(TRACKER_ERROR_CLASSES).toHaveLength(6)
  })

  it('item is the only class that drops on the first error', () => {
    const dropsNow = TRACKER_ERROR_CLASSES.filter((c) => TRACKER_ERROR_POLICY[c].entry === 'drop')
    expect(dropsNow).toEqual(['item'])
  })

  it('a server error keeps its item for 24 hours', () => {
    expect(SERVER_ERROR_DROP_AFTER_MS).toBe(24 * 60 * 60 * 1000)
  })
})

describe('TrackerApiError', () => {
  it('carries the tracker, the status and the body', () => {
    const err = new TrackerApiError('MAL API error: 403', 'mal', 403, 'forbidden')
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({ name: 'TrackerApiError', trackerId: 'mal', status: 403 })
    expect(err.body).toBe('forbidden')
    expect(new TrackerApiError('x', 'anilist', 500).body).toBe('')
  })
})
