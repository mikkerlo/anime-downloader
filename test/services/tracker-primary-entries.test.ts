// `trackerRates.primaryEntries()` (#698): the primary tracker's rate cache as
// read-side entries, which the Home rail and local search read. Each row goes
// through its codec's `entryOf` with the row itself as `native`; nothing is
// written back. `[]` with no account, and for a primary with no instance.
import { describe, it, expect } from 'vitest'
import { EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { SHIKIMORI_ORIGIN } from '../../src/shared/shikimori'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { createFakeTracker } from '../helpers/fake-tracker'
import { testRateCodec, type TestRow } from '../helpers/test-rate-codec'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import {
  createTrackerSyncService,
  type TrackerSyncService
} from '../../src/main/services/trackers/sync'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import { ANILIST_KEYS } from '../../src/main/trackers/keys'

type Svc = TrackerSyncService<unknown, unknown>

const SHIKI_USER = { id: 7, nickname: 'me', avatar: '' }
const AL_USER = { id: 1, nickname: 'al', avatar: null }

const SHIKI_ROW = {
  rate: {
    id: 51140,
    score: 8,
    status: 'watching',
    episodes: 5,
    rewatches: 0,
    updated_at: '2026-05-01T09:00:00.000Z',
    target_id: 5114
  },
  shikiAnime: {
    id: 5114,
    name: 'Fullmetal Alchemist: Brotherhood',
    russian: 'Стальной алхимик: Братство',
    image: { original: '/o/5114.jpg', preview: '/p/5114.jpg', x96: '/x/5114.jpg', x48: '' },
    kind: 'tv',
    episodes: 64,
    episodes_aired: 64,
    status: 'released'
  },
  smotretAnime: null
}

const AL_ROW: TestRow = {
  malId: 21,
  remoteId: 2100,
  values: { episodes: 1100, status: 'watching', score: 9, rewatches: 0 },
  updated_at: '2026-06-01T00:00:00.000Z'
}

function setup(
  initial: Record<string, unknown>,
  opts: { anilistInstance?: boolean } = {}
): { rates: ReturnType<typeof createTrackerRates>; store: InMemoryStorage } {
  const store = new InMemoryStorage({
    shikimoriUser: null,
    shikimoriUserRates: [SHIKI_ROW],
    shikimoriUpdateQueue: [],
    anilistUser: null,
    anilistUserRates: [AL_ROW],
    anilistUpdateQueue: [],
    trackerPrimary: null,
    ...initial
  })
  const shiki = createShikimoriSyncService({
    store: store as never,
    broadcast: () => {},
    syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
    offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
    rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
    animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
    ratesRefreshedChannel: EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED
  })
  const trackers: { sync: Svc }[] = [{ sync: shiki.tracker as Svc }]
  if (opts.anilistInstance !== false) {
    const anilist = createTrackerSyncService(
      {
        ...createFakeTracker('anilist').provider,
        rateCache: testRateCodec('anilist'),
        isSessionGone: () => false
      } as never,
      ANILIST_KEYS,
      {
        store: store as never,
        broadcast: () => {},
        syncStatusChannel: 'anilist:status',
        offlineQueueChangedChannel: 'anilist:queue',
        rateUpdatedChannel: 'anilist:rate',
        ratesRefreshedChannel: 'anilist:refreshed'
      }
    ) as Svc
    trackers.push({ sync: anilist })
  }
  const fan = createTrackerFanOut({ store: store as never, trackers, log: { warn: () => {} } })
  return { rates: createTrackerRates({ store: store as never, trackers: fan }), store }
}

describe('trackerRates.primaryEntries (#698)', () => {
  it('a Shikimori primary: each cached row through the codec, the row itself as native', () => {
    const { rates, store } = setup({ shikimoriUser: SHIKI_USER })
    const [entry] = rates.primaryEntries()
    expect(entry).toEqual({
      trackerId: 'shikimori',
      malId: 5114,
      remoteId: 51140,
      values: { episodes: 5, status: 'watching', score: 8, rewatches: 0 },
      updatedAt: Date.parse('2026-05-01T09:00:00.000Z'),
      anime: {
        title: 'Стальной алхимик: Братство',
        // The Home rail's pick: the preview, absolute.
        poster: `${SHIKIMORI_ORIGIN}/p/5114.jpg`,
        kind: 'tv',
        episodes: 64,
        episodesAired: 64,
        status: 'released'
      },
      smotretAnime: null,
      native: SHIKI_ROW
    })
    expect(entry.native).toBe((store.get('shikimoriUserRates') as unknown[])[0])
  })

  it('writes nothing back', () => {
    const { rates, store } = setup({ shikimoriUser: SHIKI_USER })
    const before = JSON.stringify(store.get('shikimoriUserRates'))
    rates.primaryEntries()
    expect(JSON.stringify(store.get('shikimoriUserRates'))).toBe(before)
  })

  it('an AniList primary reads the AniList cache', () => {
    const { rates } = setup({
      shikimoriUser: SHIKI_USER,
      anilistUser: AL_USER,
      trackerPrimary: 'anilist'
    })
    const entries = rates.primaryEntries()
    expect(entries.map((e) => [e.trackerId, e.malId, e.values.status, e.native])).toEqual([
      ['anilist', 21, 'watching', AL_ROW]
    ])
  })

  it('AniList alone is the primary', () => {
    const { rates } = setup({ anilistUser: AL_USER })
    expect(rates.primaryEntries().map((e) => e.trackerId)).toEqual(['anilist'])
  })

  it('[] with no account, whatever the caches hold', () => {
    const { rates } = setup({})
    expect(rates.primaryEntries()).toEqual([])
  })

  it('[] for a primary whose instance has not landed', () => {
    const { rates } = setup({ anilistUser: AL_USER }, { anilistInstance: false })
    expect(rates.primaryEntries()).toEqual([])
  })
})
