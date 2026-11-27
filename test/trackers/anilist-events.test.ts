// AniList's broadcast bridge (#703) and the new-tracker-cards flag. The AniList
// instance emits `tracker:*` only: the bridge shapes the generic sync
// service's raw payloads into the `tracker:*` ones, and passes every other
// channel through untouched.
import { describe, it, expect, vi } from 'vitest'
import { createAniListEventBridge } from '../../src/main/trackers/anilist/events'
import { newTrackerCardsEnabled } from '../../src/main/trackers/flags'
import type { AniListCachedRow } from '../../src/main/trackers/anilist/provider'

const CH = {
  rateUpdated: 'tracker:rate-updated',
  ratesRefreshed: 'tracker:rates-refreshed',
  syncStatus: 'tracker:sync-status',
  offlineQueueChanged: 'tracker:offline-queue-changed'
}

const row = { entry: { id: 9001 }, smotretAnime: null } as unknown as AniListCachedRow

function bridge() {
  const out = vi.fn()
  const warn = vi.fn()
  const send = createAniListEventBridge({
    broadcast: out,
    channels: CH,
    rateCache: { entryOf: (r) => ({ malId: 1, remoteId: r.entry.id }) as never },
    needsSetup: () => false,
    queuedAfter: () => ({ 1: { episodes: 2, status: 'watching', score: 0, rewatches: 0 } }),
    log: { warn }
  })
  return { out, warn, send }
}

describe('createAniListEventBridge', () => {
  it('shapes the four tracker:* payloads, with trackerId anilist and no raw', () => {
    const { out, send } = bridge()
    send(CH.rateUpdated, row)
    send(CH.ratesRefreshed, [row])
    send(CH.syncStatus, { state: 'idle', queueLength: 1 })
    send(CH.offlineQueueChanged, { length: 1 })
    expect(out.mock.calls).toEqual([
      [CH.rateUpdated, { trackerId: 'anilist', entry: { malId: 1, remoteId: 9001 } }],
      [CH.ratesRefreshed, { trackerId: 'anilist', entries: [{ malId: 1, remoteId: 9001 }] }],
      [
        CH.syncStatus,
        { trackerId: 'anilist', status: { state: 'idle', queueLength: 1, needsSetup: false } }
      ],
      [
        CH.offlineQueueChanged,
        {
          trackerId: 'anilist',
          length: 1,
          queuedAfter: { 1: { episodes: 2, status: 'watching', score: 0, rewatches: 0 } }
        }
      ]
    ])
  })

  it('passes any other channel through, and a payload it can’t shape is logged, not thrown', () => {
    const { out, warn, send } = bridge()
    send('other', 1, 2)
    expect(out).toHaveBeenCalledWith('other', 1, 2)
    expect(() => send(CH.ratesRefreshed, null)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(out).toHaveBeenCalledTimes(1)
  })
})

describe('newTrackerCardsEnabled', () => {
  it('is on in an unpackaged build and off in a packaged one', () => {
    expect(newTrackerCardsEnabled(false)).toBe(true)
    expect(newTrackerCardsEnabled(true)).toBe(false)
  })
})
