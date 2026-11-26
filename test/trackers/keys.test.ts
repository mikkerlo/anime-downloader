// The per-tracker store key maps (#690) that #691 (T2a)'s sync service takes.
import { describe, it, expect } from 'vitest'
import { ANILIST_KEYS, MYANIMELIST_KEYS, SHIKIMORI_KEYS } from '../../src/main/trackers/keys'
import { PERSISTED_STORE_KEYS } from '../../src/main/store/keys'
import { WRITE_THROUGH_KEYS } from '../../src/main/store/defaults'

describe('tracker key maps', () => {
  it('Shikimori’s map names its existing keys, unchanged', () => {
    expect(SHIKIMORI_KEYS).toEqual({
      credentials: 'shikimoriCredentials',
      user: 'shikimoriUser',
      sessionExpired: 'shikimoriSessionExpired',
      userRates: 'shikimoriUserRates',
      updateQueue: 'shikimoriUpdateQueue',
      parkedQueues: 'shikimoriParkedQueues',
      animeDetails: 'shikimoriAnimeDetails'
    })
  })

  it('AniList’s map adds the id map; MAL’s adds the client config, under myanimelist*', () => {
    expect(ANILIST_KEYS).toEqual({
      credentials: 'anilistCredentials',
      user: 'anilistUser',
      sessionExpired: 'anilistSessionExpired',
      userRates: 'anilistUserRates',
      updateQueue: 'anilistUpdateQueue',
      parkedQueues: 'anilistParkedQueues',
      animeDetails: 'anilistAnimeDetails',
      idMap: 'anilistIdMap'
    })
    expect(MYANIMELIST_KEYS).toEqual({
      credentials: 'myanimelistCredentials',
      user: 'myanimelistUser',
      sessionExpired: 'myanimelistSessionExpired',
      userRates: 'myanimelistUserRates',
      updateQueue: 'myanimelistUpdateQueue',
      parkedQueues: 'myanimelistParkedQueues',
      animeDetails: 'myanimelistAnimeDetails',
      clientConfig: 'myanimelistClientConfig'
    })
  })

  it('every key in every map is persisted, and each map’s queue, parked queues and credentials are write-through', () => {
    const persisted = new Set<string>(PERSISTED_STORE_KEYS)
    const writeThrough = new Set<string>(WRITE_THROUGH_KEYS)
    for (const map of [SHIKIMORI_KEYS, ANILIST_KEYS, MYANIMELIST_KEYS]) {
      for (const key of Object.values(map)) expect(persisted.has(key), key).toBe(true)
      for (const key of [map.updateQueue, map.parkedQueues, map.credentials])
        expect(writeThrough.has(key), key).toBe(true)
    }
  })

  it('write-through: Shikimori’s four, the six tracker keys and the MAL secret, not the MAL client config', () => {
    expect([...WRITE_THROUGH_KEYS]).toEqual([
      'shikimoriUpdateQueue',
      'shikimoriParkedQueues',
      'token',
      'shikimoriCredentials',
      'anilistUpdateQueue',
      'anilistParkedQueues',
      'anilistCredentials',
      'myanimelistUpdateQueue',
      'myanimelistParkedQueues',
      'myanimelistCredentials',
      'myanimelistClientSecret'
    ])
  })
})
