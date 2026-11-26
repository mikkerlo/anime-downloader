// The Shikimori adapter's characterization (#689): each member calls the same
// `shikimori.ts` function with the same positional arguments as today's call
// sites, taken from the session it is given, and never from the store.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import ratesFixture from '../fixtures/shikimori/user-anime-rates.json'

const api = {
  ensureFreshToken: vi.fn(),
  getUser: vi.fn(),
  getUserRate: vi.fn(),
  createUserRate: vi.fn(),
  updateUserRate: vi.fn(),
  getUserAnimeRates: vi.fn()
}

vi.mock('../../src/main/shikimori', async (orig) => ({
  ...(await orig<typeof import('../../src/main/shikimori')>()),
  ensureFreshToken: (...a: unknown[]) => api.ensureFreshToken(...a),
  getUser: (...a: unknown[]) => api.getUser(...a),
  getUserRate: (...a: unknown[]) => api.getUserRate(...a),
  createUserRate: (...a: unknown[]) => api.createUserRate(...a),
  updateUserRate: (...a: unknown[]) => api.updateUserRate(...a),
  getUserAnimeRates: (...a: unknown[]) => api.getUserAnimeRates(...a)
}))

import {
  ShikiApiError,
  ShikiAuthError,
  type ShikiAnimeRateEntry,
  type ShikiUserRate
} from '../../src/main/shikimori'
import { buildRateCacheEntries } from '../../src/main/lib/shikimori-rate-cache'
import {
  createShikimoriProvider,
  parseUpdatedAt,
  shikimoriRateCache
} from '../../src/main/trackers/shikimori.provider'
import { TRACKER_CAPABILITIES } from '../../src/main/trackers/types'

const A = { id: 1, nickname: 'alice', avatar: '/a.png' }
const B = { id: 2, nickname: 'bob', avatar: '/b.png' }
const credsFor = (token: string) => ({
  access_token: token,
  refresh_token: `fake-refresh-token-${token}`,
  created_at: 0,
  expires_in: 86_400
})

const ROWS = ratesFixture as ShikiAnimeRateEntry[]
const SMOTRET = { 5114: { id: 501, title: 'FMA' } } as unknown as Record<number, AnimeSearchResult>

function rate(id: number, malId: number, episodes = 3): ShikiUserRate {
  return {
    id,
    target_id: malId,
    target_type: 'Anime',
    episodes,
    status: 'watching',
    score: 7,
    rewatches: 1
  }
}

let store: InMemoryStorage
let lookupByMalIds: ReturnType<typeof vi.fn>

function provider() {
  return createShikimoriProvider({ store: store as never, lookupByMalIds: lookupByMalIds as never })
}

function signIn(user: typeof A, token: string): void {
  store.set('shikimoriUser', user)
  store.set('shikimoriCredentials', credsFor(token))
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  store = new InMemoryStorage({ shikimoriUser: null, shikimoriCredentials: null })
  signIn(A, 'token-a')
  // As in production: the token is whatever the store holds right now.
  api.ensureFreshToken.mockImplementation(async (s: InMemoryStorage) => {
    const creds = s.get('shikimoriCredentials') as { access_token: string } | null
    if (!creds) throw new ShikiAuthError('Not connected')
    return creds.access_token
  })
  lookupByMalIds = vi.fn(async () => SMOTRET)
})

describe('auth()', () => {
  it('returns the token and the signed-in user id', async () => {
    await expect(provider().auth()).resolves.toEqual({ token: 'token-a', userId: A.id })
    expect(api.ensureFreshToken).toHaveBeenCalledWith(store)
  })

  it('reads the user before awaiting the refresh', async () => {
    let release!: (token: string) => void
    api.ensureFreshToken.mockReturnValueOnce(new Promise<string>((res) => (release = res)))
    const pending = provider().auth()
    // A switch lands while the refresh is in flight.
    signIn(B, 'token-b')
    release('token-a')
    await expect(pending).resolves.toEqual({ token: 'token-a', userId: A.id })
  })

  it('throws exactly what the refresh throws', async () => {
    const err = new ShikiAuthError('expired', 400)
    api.ensureFreshToken.mockRejectedValueOnce(err)
    await expect(provider().auth()).rejects.toBe(err)
  })

  it('with no user, throws after the refresh as the rate refresh does today', async () => {
    store.set('shikimoriUser', null)
    await expect(provider().auth()).rejects.toThrow('Not logged in to Shikimori')
    expect(api.ensureFreshToken).toHaveBeenCalledTimes(1)
  })
})

describe('data members', () => {
  const session = { token: 'token-a', userId: A.id }

  it('getUser(token) → getUser(token)', async () => {
    api.getUser.mockResolvedValueOnce(A)
    await expect(provider().getUser('token-x')).resolves.toBe(A)
    expect(api.getUser.mock.calls).toEqual([['token-x']])
  })

  it('getEntry → getUserRate(token, userId, malId), with the rate as native', async () => {
    const r = rate(900, 5114)
    api.getUserRate.mockResolvedValueOnce(r)
    const entry = await provider().getEntry(session, { malId: 5114, remoteId: null })
    expect(api.getUserRate.mock.calls).toEqual([['token-a', A.id, 5114]])
    expect(entry).toEqual({
      trackerId: 'shikimori',
      malId: 5114,
      remoteId: 900,
      values: { episodes: 3, status: 'watching', score: 7, rewatches: 1 },
      native: r
    })
    expect(entry!.native).toBe(r)
  })

  it('getEntry → null when there is no rate', async () => {
    api.getUserRate.mockResolvedValueOnce(null)
    await expect(provider().getEntry(session, { malId: 1, remoteId: null })).resolves.toBeNull()
  })

  it('upsertEntry on an existing rate sends all four values whatever changedFields says', async () => {
    api.updateUserRate.mockResolvedValueOnce(rate(900, 5114, 4))
    const values = { episodes: 4, status: 'rewatching' as const, score: 9, rewatches: 2 }
    const entry = await provider().upsertEntry(session, { malId: 5114, remoteId: 900 }, values, [
      'episodes'
    ])
    expect(api.updateUserRate.mock.calls).toEqual([['token-a', 900, 4, 'rewatching', 9, 2]])
    expect(api.createUserRate).not.toHaveBeenCalled()
    expect(entry).toMatchObject({ remoteId: 900, malId: 5114 })
  })

  it('upsertEntry with no remote id creates the rate for the session user', async () => {
    api.createUserRate.mockResolvedValueOnce(rate(901, 9253, 1))
    const values = { episodes: 1, status: 'watching' as const, score: 0, rewatches: 0 }
    await provider().upsertEntry(session, { malId: 9253, remoteId: null }, values, ['episodes'])
    expect(api.createUserRate.mock.calls).toEqual([['token-a', A.id, 9253, 1, 'watching', 0, 0]])
    expect(api.updateUserRate).not.toHaveBeenCalled()
  })

  it('propagates API errors untouched', async () => {
    const err = new ShikiApiError('Shikimori API error: 503', 503)
    api.getUserRate.mockRejectedValueOnce(err)
    await expect(provider().getEntry(session, { malId: 1, remoteId: null })).rejects.toBe(err)
  })

  it('classifyError is the Shikimori classifier', () => {
    const p = provider()
    expect(p.classifyError(new ShikiAuthError('expired', 400))).toBe('auth')
    expect(p.classifyError(new ShikiApiError('x', 500))).toBe('server')
    expect(p.classifyError(new TypeError('fetch failed'))).toBe('network')
  })

  it('is the shikimori provider and implements getAiringInfo only (#706)', () => {
    const p = provider()
    expect(p.id).toBe('shikimori')
    expect(Object.keys(p.capabilities).sort()).toEqual([...TRACKER_CAPABILITIES].sort())
    expect(Object.entries(p.capabilities).filter(([, v]) => v)).toEqual([['getAiringInfo', true]])
    expect(p.deleteEntry).toBeUndefined()
  })
})

// The auto-downloader's read before #706, moved behind the adapter unchanged.
describe('getAiringInfo', () => {
  const HOUR = 60 * 60 * 1000
  const cached = (aired: number | null, total: number | null, ageMs: number) => ({
    9: { details: { episodes_aired: aired, episodes: total }, fetchedAt: Date.now() - ageMs }
  })

  function withRefresh(returns: Partial<ShikiAnimeDetails> | null) {
    const refreshDetails = vi.fn(async () => returns as ShikiAnimeDetails | null)
    return {
      p: createShikimoriProvider({ store: store as never, refreshDetails }),
      refreshDetails
    }
  }

  it('a cache entry younger than 6 h answers with no refresh', async () => {
    store.set('shikimoriAnimeDetails', cached(5, 12, 5 * HOUR))
    const { p, refreshDetails } = withRefresh({ episodes_aired: 9, episodes: 12 })
    expect(await p.getAiringInfo!(9)).toEqual({ episodesAired: 5, episodes: 12 })
    expect(refreshDetails).not.toHaveBeenCalled()
  })

  it('an entry older than 6 h, or none, refreshes inline', async () => {
    store.set('shikimoriAnimeDetails', cached(5, 12, 7 * HOUR))
    const { p, refreshDetails } = withRefresh({ episodes_aired: 9, episodes: 12 })
    expect(await p.getAiringInfo!(9)).toEqual({ episodesAired: 9, episodes: 12 })
    store.set('shikimoriAnimeDetails', {})
    expect(await p.getAiringInfo!(9)).toEqual({ episodesAired: 9, episodes: 12 })
    expect(refreshDetails).toHaveBeenCalledTimes(2)
  })

  it('a failed refresh keeps the stale entry; with no entry it is null', async () => {
    store.set('shikimoriAnimeDetails', cached(5, null, 7 * HOUR))
    const { p } = withRefresh(null)
    expect(await p.getAiringInfo!(9)).toEqual({ episodesAired: 5, episodes: 0 })
    store.set('shikimoriAnimeDetails', {})
    expect(await p.getAiringInfo!(9)).toBeNull()
  })

  it('missing counts read as 0, as the tick read them', async () => {
    store.set('shikimoriAnimeDetails', cached(null, null, 0))
    expect(await provider().getAiringInfo!(9)).toEqual({ episodesAired: 0, episodes: 0 })
  })

  it('without refreshDetails the read is cache-only', async () => {
    store.set('shikimoriAnimeDetails', cached(5, 12, 7 * HOUR))
    expect(await provider().getAiringInfo!(9)).toEqual({ episodesAired: 5, episodes: 12 })
  })
})

describe('the session is pinned', () => {
  it('after an account switch, members called with A’s session still send A’s token and id', async () => {
    const p = provider()
    const sessionA = await p.auth()
    signIn(B, 'token-b')
    api.getUserRate.mockResolvedValue(rate(900, 5114))
    api.updateUserRate.mockResolvedValue(rate(900, 5114))
    api.createUserRate.mockResolvedValue(rate(901, 9253))
    api.getUserAnimeRates.mockResolvedValue([])
    const values = { episodes: 4, status: 'watching' as const, score: 7, rewatches: 0 }

    await p.getEntry(sessionA, { malId: 5114, remoteId: null })
    await p.upsertEntry(sessionA, { malId: 5114, remoteId: 900 }, values, ['episodes'])
    await p.upsertEntry(sessionA, { malId: 9253, remoteId: null }, values, ['episodes'])
    await p.listEntries(sessionA)

    expect(api.getUserRate.mock.calls).toEqual([['token-a', A.id, 5114]])
    expect(api.updateUserRate.mock.calls[0][0]).toBe('token-a')
    expect(api.createUserRate.mock.calls[0].slice(0, 2)).toEqual(['token-a', A.id])
    expect(api.getUserAnimeRates.mock.calls).toEqual([['token-a', A.id, undefined]])
    // Only auth() refreshed; no data member touched the token store.
    expect(api.ensureFreshToken).toHaveBeenCalledTimes(1)
  })
})

describe('listEntries', () => {
  const session = { token: 'token-a', userId: A.id }

  it('calls getUserAnimeRates(token, userId, status) and joins smotret by MAL id', async () => {
    api.getUserAnimeRates.mockResolvedValueOnce(ROWS)
    const entries = await provider().listEntries(session, { status: 'watching' })
    expect(api.getUserAnimeRates.mock.calls).toEqual([['token-a', A.id, 'watching']])
    expect(lookupByMalIds.mock.calls).toEqual([[[5114, 9253]]])
    expect(entries.map((e) => e.smotretAnime)).toEqual([SMOTRET[5114], null])
  })

  it('maps each row, with the row itself as native', async () => {
    api.getUserAnimeRates.mockResolvedValueOnce(ROWS)
    const [fma] = await provider().listEntries(session)
    expect(fma).toEqual({
      trackerId: 'shikimori',
      malId: 5114,
      remoteId: 100001,
      values: { episodes: 5, status: 'watching', score: 8, rewatches: 0 },
      updatedAt: Date.parse('2026-05-01T12:00:00.000+03:00'),
      anime: {
        title: 'Стальной алхимик: Братство',
        poster: '/system/animes/original/5114.jpg',
        kind: 'tv',
        episodes: 64,
        episodesAired: 64,
        status: 'released'
      },
      smotretAnime: SMOTRET[5114],
      native: ROWS[0]
    })
    expect(fma.native).toBe(ROWS[0])
  })

  it('the title is russian, or name when russian is empty', async () => {
    const noRussian = { ...ROWS[1], anime: { ...ROWS[1].anime, russian: '' } }
    api.getUserAnimeRates.mockResolvedValueOnce([ROWS[0], noRussian])
    const entries = await provider().listEntries(session)
    expect(entries.map((e) => e.anime.title)).toEqual(['Стальной алхимик: Братство', 'Steins;Gate'])
    expect(entries[1].native.anime.name).toBe('Steins;Gate')
  })

  it('updatedAt is ms, and null for a missing or unparseable timestamp (never NaN)', async () => {
    const missing = { ...ROWS[0], updated_at: undefined as unknown as string }
    const garbage = { ...ROWS[1], updated_at: 'not a date' }
    api.getUserAnimeRates.mockResolvedValueOnce([ROWS[0], missing, garbage])
    const entries = await provider().listEntries(session)
    expect(entries.map((e) => e.updatedAt)).toEqual([Date.parse(ROWS[0].updated_at), null, null])
    expect(parseUpdatedAt(null)).toBeNull()
  })

  it('without a lookup, smotretAnime is null', async () => {
    api.getUserAnimeRates.mockResolvedValueOnce(ROWS)
    const p = createShikimoriProvider({ store: store as never })
    expect((await p.listEntries(session)).map((e) => e.smotretAnime)).toEqual([null, null])
  })

  it('the codec input is lossless: the rate cache built from native equals today’s', async () => {
    api.getUserAnimeRates.mockResolvedValueOnce(ROWS)
    const entries = await provider().listEntries(session)
    expect(
      buildRateCacheEntries(
        entries.map((e) => e.native),
        SMOTRET
      )
    ).toEqual(buildRateCacheEntries(ROWS, SMOTRET))
  })
})

// T2a's codec (#691): what the generic sync service writes into `shikimoriUserRates`.
describe('the rate-cache codec', () => {
  const session = { token: 'token-a', userId: A.id }

  it('builds exactly today’s cache bytes from the listed entries, key order included', async () => {
    api.getUserAnimeRates.mockResolvedValueOnce(ROWS)
    const p = provider()
    const rows = p.rateCache.fromEntries(await p.listEntries(session))
    expect(JSON.stringify(rows)).toBe(JSON.stringify(buildRateCacheEntries(ROWS, SMOTRET)))
  })

  it('matches a row by target_id for a patch, and falls back to shikiAnime.id for keepQueued', () => {
    const noTarget = { rate: { id: 1, score: 0, status: 'watching' }, shikiAnime: { id: 77 } }
    const rows = [noTarget, { rate: { id: 2, target_id: 5114 }, shikiAnime: { id: 5114 } }]
    expect(shikimoriRateCache.indexOf(rows as never, 77)).toBe(-1)
    expect(shikimoriRateCache.indexOf(rows as never, 5114)).toBe(1)
    expect(shikimoriRateCache.malIdOf(noTarget as never)).toBe(77)
  })

  it('patch lays the values over the row, sets the id only when given, and keeps key order', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 1) })
    try {
      const [row] = buildRateCacheEntries([ROWS[0]], SMOTRET)
      const values = { episodes: 9, status: 'completed' as const, score: 10, rewatches: 1 }
      const settled = shikimoriRateCache.patch(row, values, 555)
      expect(settled.rate).toEqual({
        ...row.rate,
        id: 555,
        ...values,
        updated_at: '2026-11-01T00:00:00.000Z'
      })
      expect(Object.keys(settled.rate)).toEqual(Object.keys(row.rate))
      expect(settled.shikiAnime).toBe(row.shikiAnime)
      expect(shikimoriRateCache.patch(row, values).rate.id).toBe(row.rate.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the session is gone only for a ShikiAuthError, not for a 403 from the refresh', () => {
    const p = provider()
    expect(p.isSessionGone(new ShikiAuthError('expired', 400))).toBe(true)
    expect(p.isSessionGone(new ShikiApiError('Shikimori API error: 403', 403))).toBe(false)
    expect(p.isSessionGone(new TypeError('fetch failed'))).toBe(false)
  })
})
