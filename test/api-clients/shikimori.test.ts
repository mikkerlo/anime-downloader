import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import * as shikimori from '../../src/main/shikimori'
import { InMemoryStorage } from '../helpers/in-memory-storage'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(__dirname, '../fixtures/shikimori', name), 'utf8'))
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

function mockFetchOnce(body: unknown, status = 200): void {
  global.fetch = vi.fn(async () => jsonResponse(body, status))
}

function lastFetchUrl(): string {
  const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1][0] as string
}

/** Doorkeeper's answer to an invalid, expired or revoked refresh token. */
const INVALID_GRANT_BODY = {
  error: 'invalid_grant',
  error_description:
    'The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.'
}

/** A store whose access token expired long ago, so a refresh is forced. */
function expiredCredsStore(extra: Record<string, unknown> = {}): InMemoryStorage {
  return new InMemoryStorage({
    shikimoriCredentials: {
      access_token: 'fake-access-token-stale',
      refresh_token: 'fake-refresh-token-dead',
      created_at: Math.floor(Date.now() / 1000) - 100_000,
      expires_in: 86_400
    },
    ...extra
  })
}

function ensureFresh(store: InMemoryStorage): Promise<string> {
  return shikimori.ensureFreshToken(
    store as unknown as Parameters<typeof shikimori.ensureFreshToken>[0]
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  // The single-flight promise and the expiry listener are module-level state.
  shikimori.__resetRefreshStateForTests()
})

describe('shikimori client — fixture replay', () => {
  describe('getUser', () => {
    it('parses /api/users/whoami into ShikiUser', async () => {
      mockFetchOnce(fixture('whoami.json'))
      const user = await shikimori.getUser('access-token')
      expect(user).toEqual({
        id: 1,
        nickname: 'testuser',
        avatar: 'https://shikimori.one/system/users/x48/1.png'
      })
    })

    it('sends Bearer auth + User-Agent', async () => {
      mockFetchOnce(fixture('whoami.json'))
      await shikimori.getUser('access-token')
      const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer access-token',
        'User-Agent': 'anime-dl'
      })
    })

    it('targets the shikimori.io origin (regression: shikimori.one now 301-redirects and undici strips auth cross-origin)', async () => {
      mockFetchOnce(fixture('whoami.json'))
      await shikimori.getUser('access-token')
      expect(lastFetchUrl()).toMatch(/^https:\/\/shikimori\.io\//)
    })
  })

  describe('getUserStats', () => {
    it('parses the anime status breakdown from the user object stats block', async () => {
      mockFetchOnce(fixture('user-stats.json'))
      const stats = await shikimori.getUserStats('tok', 1)
      expect(stats.statuses).toEqual([
        { name: 'planned', size: 12 },
        { name: 'watching', size: 7 },
        { name: 'completed', size: 41 },
        { name: 'dropped', size: 2 }
      ])
    })

    it('normalizes the score distribution to a 10-slot array indexed 1..10', async () => {
      mockFetchOnce(fixture('user-stats.json'))
      const stats = await shikimori.getUserStats('tok', 1)
      expect(stats.scores).toHaveLength(10)
      expect(stats.scores[9]).toBe(8) // score 10
      expect(stats.scores[7]).toBe(19) // score 8
      expect(stats.scores[5]).toBe(1) // score 6
      expect(stats.scores[0]).toBe(0) // score 1 — absent → 0
    })

    it('hits /api/users/:id', async () => {
      mockFetchOnce(fixture('user-stats.json'))
      await shikimori.getUserStats('tok', 42)
      expect(lastFetchUrl()).toContain('/api/users/42')
    })

    it('tolerates a missing stats block (fresh account)', async () => {
      mockFetchOnce({ id: 1, nickname: 'x', avatar: '' })
      const stats = await shikimori.getUserStats('tok', 1)
      expect(stats.statuses).toEqual([])
      expect(stats.scores).toEqual(new Array(10).fill(0))
    })
  })

  describe('getUserRate', () => {
    it('returns the single hit when the array is non-empty', async () => {
      mockFetchOnce(fixture('user-rates-found.json'))
      const rate = await shikimori.getUserRate('tok', 1, 5114)
      expect(rate).toMatchObject({
        id: 12345,
        episodes: 5,
        status: 'watching',
        target_id: 5114
      })
    })

    it('returns null when the API returns an empty array', async () => {
      mockFetchOnce(fixture('user-rates-empty.json'))
      const rate = await shikimori.getUserRate('tok', 1, 5114)
      expect(rate).toBeNull()
    })

    it('encodes user_id + target_id + target_type=Anime in the URL', async () => {
      mockFetchOnce(fixture('user-rates-empty.json'))
      await shikimori.getUserRate('tok', 42, 9253)
      expect(lastFetchUrl()).toContain('user_id=42')
      expect(lastFetchUrl()).toContain('target_id=9253')
      expect(lastFetchUrl()).toContain('target_type=Anime')
    })
  })

  describe('createUserRate', () => {
    it('POSTs the user_rate envelope and parses the response', async () => {
      mockFetchOnce(fixture('user-rate-created.json'))
      const rate = await shikimori.createUserRate('tok', 1, 5114, 0, 'watching', 0, 0)
      expect(rate).toMatchObject({ id: 99001, status: 'watching', target_id: 5114 })
      const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string)
      expect(body).toEqual({
        user_rate: {
          user_id: 1,
          target_id: 5114,
          target_type: 'Anime',
          episodes: 0,
          status: 'watching',
          score: 0,
          rewatches: 0
        }
      })
    })
  })

  describe('updateUserRate', () => {
    it('PATCHes the rate-id endpoint with the user_rate delta', async () => {
      mockFetchOnce(fixture('user-rate-updated.json'))
      const rate = await shikimori.updateUserRate('tok', 12345, 64, 'completed', 9, 1)
      expect(rate).toMatchObject({ id: 12345, episodes: 64, status: 'completed' })
      const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
      expect(init.method).toBe('PATCH')
      expect(lastFetchUrl()).toContain('/api/v2/user_rates/12345')
      const body = JSON.parse(init.body as string)
      expect(body).toEqual({
        user_rate: { episodes: 64, status: 'completed', score: 9, rewatches: 1 }
      })
    })
  })

  describe('getUserAnimeRates', () => {
    it('parses the array of ShikiAnimeRateEntry preserving the nested anime object', async () => {
      mockFetchOnce(fixture('user-anime-rates.json'))
      const rates = await shikimori.getUserAnimeRates('tok', 1)
      expect(rates.length).toBe(2)
      expect(rates[0]).toMatchObject({
        id: 100001,
        status: 'watching',
        episodes: 5,
        anime: {
          id: 5114,
          name: 'Fullmetal Alchemist: Brotherhood',
          episodes: 64
        }
      })
      expect(rates[0].anime.image.x96).toMatch(/x96/)
    })

    it('passes a status filter via the URL when provided', async () => {
      mockFetchOnce(fixture('user-anime-rates.json'))
      await shikimori.getUserAnimeRates('tok', 1, 'watching')
      expect(lastFetchUrl()).toContain('status=watching')
    })

    it('omits the status filter when not provided', async () => {
      mockFetchOnce(fixture('user-anime-rates.json'))
      await shikimori.getUserAnimeRates('tok', 1)
      expect(lastFetchUrl()).not.toContain('status=')
    })
  })

  describe('getAnimeDetails', () => {
    it('parses genres + studios + score + image-free top-level fields', async () => {
      mockFetchOnce(fixture('anime-details.json'))
      const d = await shikimori.getAnimeDetails('tok', 5114)
      expect(d.id).toBe(5114)
      expect(d.genres.length).toBe(2)
      expect(d.genres[0]).toEqual({ id: 1, name: 'Action', russian: 'Экшен', kind: 'genre' })
      expect(d.studios[0].name).toBe('Bones')
      expect(d.score).toBe('9.10')
      expect(d.description_html).toContain('<p>')
    })
  })

  describe('getFriends', () => {
    it('parses the friends array', async () => {
      mockFetchOnce(fixture('friends.json'))
      const friends = await shikimori.getFriends('tok', 1)
      expect(friends.length).toBe(2)
      expect(friends[0]).toEqual({
        id: 11,
        nickname: 'alice',
        avatar: 'https://shikimori.one/system/users/x48/11.png',
        lastOnlineAt: null
      })
    })

    it('captures last_online_at presence when present', async () => {
      mockFetchOnce(fixture('friends-presence.json'))
      const friends = await shikimori.getFriends('tok', 1)
      expect(friends[0].lastOnlineAt).toBe('2026-05-31T11:59:00Z')
      expect(friends[1].lastOnlineAt).toBeNull()
    })
  })

  describe('buildFriendCard', () => {
    function friendRate(
      malId: number,
      status: string,
      episodes: number,
      score: number,
      updated: string
    ) {
      return {
        id: malId,
        status,
        episodes,
        score,
        rewatches: 0,
        updated_at: updated,
        target_id: malId,
        target_type: 'Anime',
        anime: {
          id: malId,
          name: `Show ${malId}`,
          russian: `Шоу ${malId}`,
          image: { original: '/o.jpg', preview: '/p.jpg', x96: '', x48: '' },
          episodes: 12,
          episodes_aired: 12,
          kind: 'tv',
          score: '8.0',
          status: 'released'
        }
      } as unknown as Parameters<typeof shikimori.buildFriendCard>[1][number]
    }

    const friend = {
      id: 11,
      nickname: 'alice',
      avatar: 'a.png',
      lastOnlineAt: '2026-05-31T11:59:30Z'
    }
    const NOW = new Date('2026-05-31T12:00:00Z').getTime()

    it('derives titles, mean, mutual, online and the current watch', () => {
      const rates = [
        friendRate(1, 'completed', 12, 9, '2026-05-01T00:00:00Z'),
        friendRate(2, 'watching', 4, 0, '2026-05-30T00:00:00Z'),
        friendRate(3, 'planned', 0, 7, '2026-04-01T00:00:00Z')
      ]
      const card = shikimori.buildFriendCard(friend, rates, new Set([2, 99]), NOW)
      expect(card.titles).toBe(3)
      expect(card.mean).toBe(8) // (9 + 7) / 2
      expect(card.mutual).toBe(1) // only malId 2 is shared
      expect(card.online).toBe(true) // last online 30s ago
      // Most-recently-updated watching entry wins.
      expect(card.watching?.malId).toBe(2)
      expect(card.watching?.status).toBe('watching')
      expect(card.watching?.episode).toBe(4)
    })

    it('falls back to the last completed when nothing is in-progress, and marks offline', () => {
      const stale = { ...friend, lastOnlineAt: '2026-05-31T11:00:00Z' } // 1h ago
      const rates = [friendRate(5, 'completed', 24, 10, '2026-05-29T00:00:00Z')]
      const card = shikimori.buildFriendCard(stale, rates, new Set(), NOW)
      expect(card.online).toBe(false)
      expect(card.watching?.status).toBe('completed')
      expect(card.watching?.malId).toBe(5)
    })

    it('handles a friend with no rates (degraded card)', () => {
      const card = shikimori.buildFriendCard(friend, [], new Set(), NOW)
      expect(card.titles).toBe(0)
      expect(card.mean).toBe(0)
      expect(card.mutual).toBe(0)
      expect(card.watching).toBeNull()
    })
  })

  describe('getSimilar', () => {
    it('parses the /similar array into ShikiSimilarAnime entries', async () => {
      mockFetchOnce(fixture('similar.json'))
      const similar = await shikimori.getSimilar('tok', 5114)
      expect(similar.length).toBe(2)
      expect(similar[0]).toMatchObject({
        id: 9253,
        russian: 'Врата Штейна',
        kind: 'tv',
        score: '9.03'
      })
      expect(similar[0].image.preview).toMatch(/preview/)
    })

    it('hits /api/animes/:id/similar with Bearer auth', async () => {
      mockFetchOnce(fixture('similar.json'))
      await shikimori.getSimilar('tok', 5114)
      expect(lastFetchUrl()).toContain('/api/animes/5114/similar')
      const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
      expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' })
    })
  })

  describe('getOngoingRanked', () => {
    it('parses the /api/animes list into ShikiOngoingAnime entries', async () => {
      mockFetchOnce(fixture('ongoing.json'))
      const ongoing = await shikimori.getOngoingRanked('tok', 30)
      expect(ongoing.length).toBe(2)
      expect(ongoing[0]).toMatchObject({
        id: 52991,
        russian: 'Фрирен, провожающая в последний путь',
        kind: 'tv',
        score: '9.09',
        status: 'ongoing'
      })
      expect(ongoing[0].image.preview).toMatch(/preview/)
    })

    it('encodes status=ongoing + order=ranked + limit with Bearer auth', async () => {
      mockFetchOnce(fixture('ongoing.json'))
      await shikimori.getOngoingRanked('tok', 30)
      expect(lastFetchUrl()).toContain('/api/animes?')
      expect(lastFetchUrl()).toContain('status=ongoing')
      expect(lastFetchUrl()).toContain('order=ranked')
      expect(lastFetchUrl()).toContain('limit=30')
      const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
      expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' })
    })
  })

  describe('getFranchise', () => {
    it('parses nodes + links + current_id', async () => {
      mockFetchOnce(fixture('franchise.json'))
      const fr = await shikimori.getFranchise(5114)
      expect(fr.current_id).toBe(5114)
      expect(fr.nodes.length).toBe(2)
      expect(fr.links[0].relation).toBe('sequel')
    })
  })

  describe('getCalendar', () => {
    it('parses next_episode + nested anime image map', async () => {
      mockFetchOnce(fixture('calendar.json'))
      const cal = await shikimori.getCalendar()
      expect(cal.length).toBe(1)
      expect(cal[0].next_episode).toBe(7)
      expect(cal[0].anime.episodes_aired).toBe(6)
    })
  })

  describe('ensureFreshToken', () => {
    it('returns the cached access token when it is still fresh', async () => {
      const future = Math.floor(Date.now() / 1000) - 1000 // created_at in the past
      const store = new InMemoryStorage({
        shikimoriCredentials: {
          access_token: 'cached',
          refresh_token: 'r',
          created_at: future,
          expires_in: 86400
        }
      })
      const token = await shikimori.ensureFreshToken(
        store as unknown as Parameters<typeof shikimori.ensureFreshToken>[0]
      )
      expect(token).toBe('cached')
    })

    it('hits /oauth/token and stores the refreshed credentials when expired', async () => {
      mockFetchOnce(fixture('token-refresh.json'))
      const past = Math.floor(Date.now() / 1000) - 100_000 // long ago
      const store = new InMemoryStorage({
        shikimoriCredentials: {
          access_token: 'old',
          refresh_token: 'r',
          created_at: past,
          expires_in: 1
        }
      })
      const token = await shikimori.ensureFreshToken(
        store as unknown as Parameters<typeof shikimori.ensureFreshToken>[0]
      )
      expect(token).toBe('fake-access-token-replaced')
      const stored = store.get('shikimoriCredentials') as { access_token: string }
      expect(stored.access_token).toBe('fake-access-token-replaced')
    })

    it('throws a typed ShikiAuthError when there are no credentials', async () => {
      const store = new InMemoryStorage({ shikimoriCredentials: null })
      const err = await ensureFresh(store).catch((e: unknown) => e)
      // Was a bare `Error('Not logged in to Shikimori')` surfaced raw to the
      // user via `String(err)` (#244 §4).
      expect(err).toBeInstanceOf(shikimori.ShikiAuthError)
    })

    it('says "not connected", not "session expired", when the user never connected', async () => {
      // Both causes reach the same branch, and the message goes to the UI
      // verbatim through `String(err)`. Keyed on the persisted flag so it does
      // not depend on `SHIKIMORI_LOGOUT` happening to clear the rate cache.
      const store = new InMemoryStorage({ shikimoriCredentials: null })
      const err = await ensureFresh(store).catch((e: unknown) => e)
      expect((err as Error).message).toBe(shikimori.NOT_CONNECTED_MESSAGE)
    })

    it('still says "session expired" once expiry has cleared the credentials', async () => {
      // The repeat-edit path after an expiry: credentials gone, flag set. This
      // is the case the offline queue relies on, so the class must not change.
      const store = new InMemoryStorage({
        shikimoriCredentials: null,
        shikimoriSessionExpired: true
      })
      const err = await ensureFresh(store).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(shikimori.ShikiAuthError)
      expect((err as Error).message).toBe(shikimori.SESSION_EXPIRED_MESSAGE)
    })

    it('does not expire the session, and issues no refresh, while the token is fresh', async () => {
      const fetchSpy = vi.fn()
      global.fetch = fetchSpy as unknown as typeof fetch
      const store = new InMemoryStorage({
        shikimoriCredentials: {
          access_token: 'fake-access-token-live',
          refresh_token: 'fake-refresh-token-live',
          created_at: Math.floor(Date.now() / 1000),
          expires_in: 86_400
        }
      })
      await ensureFresh(store)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(store.get('shikimoriSessionExpired')).toBeFalsy()
    })
  })

  // The reported bug: a dead refresh token 400s forever, the app never notices,
  // and the message says only "Shikimori API error: 400" (#244).
  describe('ensureFreshToken — session expiry', () => {
    it('a 400 invalid_grant refresh throws ShikiAuthError, clears the credentials and persists the flag', async () => {
      mockFetchOnce(INVALID_GRANT_BODY, 400)
      const store = expiredCredsStore()

      const err = await ensureFresh(store).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(shikimori.ShikiAuthError)
      expect(store.get('shikimoriCredentials')).toBeNull()
      expect(store.get('shikimoriSessionExpired')).toBe(true)
    })

    it('keeps the queue, the rate cache and the user — expiry is not a logout', async () => {
      mockFetchOnce(INVALID_GRANT_BODY, 400)
      const store = expiredCredsStore({
        shikimoriUpdateQueue: [{ malId: 1, queuedAt: 1 }],
        shikimoriUserRates: [{ rate: { target_id: 1 } }],
        shikimoriUser: { id: 7, nickname: 'me' }
      })

      await ensureFresh(store).catch(() => undefined)

      expect(store.get('shikimoriUpdateQueue')).toHaveLength(1)
      expect(store.get('shikimoriUserRates')).toHaveLength(1)
      expect(store.get('shikimoriUser')).toMatchObject({ nickname: 'me' })
    })

    it('notifies the session-expired listener once, on the transition only', async () => {
      const onExpired = vi.fn()
      shikimori.setOnSessionExpired(onExpired)

      mockFetchOnce(INVALID_GRANT_BODY, 400)
      const store = expiredCredsStore()
      await ensureFresh(store).catch(() => undefined)
      expect(onExpired).toHaveBeenCalledTimes(1)

      // Second discovery on an already-expired store must not re-broadcast.
      mockFetchOnce(INVALID_GRANT_BODY, 400)
      const again = expiredCredsStore({ shikimoriSessionExpired: true })
      await ensureFresh(again).catch(() => undefined)
      expect(onExpired).toHaveBeenCalledTimes(1)
    })

    it('a non-invalid_grant 400 from /oauth/token propagates untouched and does NOT expire the session', async () => {
      // A Shikimori-side outage must not sign the user out. This is the guard on
      // the whole design (#244, last Risks bullet).
      mockFetchOnce({ error: 'server_error', error_description: 'Backend is down' }, 400)
      const store = expiredCredsStore()

      const err = await ensureFresh(store).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(shikimori.ShikiApiError)
      expect(err).not.toBeInstanceOf(shikimori.ShikiAuthError)
      expect(store.get('shikimoriCredentials')).not.toBeNull()
      expect(store.get('shikimoriSessionExpired')).toBeFalsy()
    })

    it('surfaces invalid_grant in the message instead of a bare status', async () => {
      mockFetchOnce(INVALID_GRANT_BODY, 400)
      const err = (await ensureFresh(expiredCredsStore()).catch(
        (e: unknown) => e
      )) as shikimori.ShikiApiError

      expect(err.body).toContain('invalid_grant')
      expect(err.body).toContain(INVALID_GRANT_BODY.error_description)
    })

    it('a 400 invalid_grant from exchangeCode is a bad auth code, not an expired session', async () => {
      // Same URL, same status, same body — discriminated by call site only.
      mockFetchOnce(INVALID_GRANT_BODY, 400)
      const err = await shikimori.exchangeCode('mistyped').catch((e: unknown) => e)

      expect(err).toBeInstanceOf(shikimori.ShikiApiError)
      expect(err).not.toBeInstanceOf(shikimori.ShikiAuthError)
    })

    it('collapses concurrent refreshes into a single /oauth/token round trip', async () => {
      mockFetchOnce(fixture('token-refresh.json'))
      const store = expiredCredsStore()

      const [a, b] = await Promise.all([ensureFresh(store), ensureFresh(store)])

      expect(a).toBe(b)
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    })

    it('holds the single-flight guard until the rotated credentials are persisted', async () => {
      // Regression: the guard used to be released in `.finally()` on the HTTP
      // call, one microtask before the store write. A caller entering in that
      // window re-POSTed the refresh token the winner had already rotated away
      // — and after #244 that `400 invalid_grant` is a destructive sign-out.
      //
      // `collapses concurrent refreshes` starts both callers in the same tick,
      // which is the one arrival time that was already safe, so this walks the
      // second caller's arrival across the whole window instead of guessing it.
      for (let depth = 0; depth <= 8; depth++) {
        shikimori.__resetRefreshStateForTests()
        const store = expiredCredsStore()

        // Doorkeeper's actual behaviour: /oauth/token rotates the refresh token
        // and rejects any token it has already rotated away.
        let live = 'fake-refresh-token-dead'
        let rotations = 0
        const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
          const sent = (JSON.parse(String(init.body)) as { refresh_token: string }).refresh_token
          if (sent !== live) return jsonResponse(INVALID_GRANT_BODY, 400)
          rotations += 1
          live = `fake-refresh-token-rotated-${rotations}`
          return jsonResponse({
            access_token: `fake-access-token-rotated-${rotations}`,
            refresh_token: live,
            created_at: Math.floor(Date.now() / 1000),
            expires_in: 86_400
          })
        })
        global.fetch = fetchSpy as unknown as typeof fetch

        const first = ensureFresh(store)
        for (let tick = 0; tick < depth; tick++) await Promise.resolve()
        const second = ensureFresh(store)
        const settled = await Promise.allSettled([first, second])

        const label = `second caller entering ${depth} microtask(s) in`
        expect(
          settled.map((r) => r.status),
          label
        ).toEqual(['fulfilled', 'fulfilled'])
        expect(fetchSpy.mock.calls, label).toHaveLength(1)
        expect(store.get('shikimoriSessionExpired'), label).toBeFalsy()
        expect(store.get('shikimoriCredentials'), label).not.toBeNull()
      }
    })

    it('does not write refreshed credentials back into a store a logout just cleared', async () => {
      mockFetchOnce(fixture('token-refresh.json'))
      const store = expiredCredsStore()
      const pending = ensureFresh(store)
      store.set('shikimoriCredentials', null) // user hit Disconnect mid-refresh

      await pending

      expect(store.get('shikimoriCredentials')).toBeNull()
    })
  })

  describe('error handling', () => {
    it('throws ShikiApiError on non-2xx, attaching the status code', async () => {
      mockFetchOnce({ error: 'not found' }, 404)
      await expect(shikimori.getUser('tok')).rejects.toMatchObject({
        name: 'ShikiApiError',
        status: 404
      })
    })

    it('attaches a summarized body so 400s are distinguishable from each other', async () => {
      mockFetchOnce({ error: 'invalid_field', error_description: 'score must be 0..10' }, 422)
      const err = (await shikimori
        .getUser('tok')
        .catch((e: unknown) => e)) as shikimori.ShikiApiError
      expect(err.message).toBe('Shikimori API error: 422 (invalid_field: score must be 0..10)')
    })
  })

  describe('error-body scrubbing', () => {
    it('redacts secret-bearing values in JSON and form-encoded bodies', () => {
      expect(shikimori.scrubErrorBody('{"access_token":"abc123","error":"x"}')).toBe(
        '{"access_token":"[redacted]","error":"x"}'
      )
      expect(shikimori.scrubErrorBody('{"refresh_token":"r1","client_secret":"s1"}')).toBe(
        '{"refresh_token":"[redacted]","client_secret":"[redacted]"}'
      )
      expect(shikimori.scrubErrorBody('grant_type=refresh_token&refresh_token=r1&code=c1')).toBe(
        'grant_type=refresh_token&refresh_token=[redacted]&code=[redacted]'
      )
    })

    it('leaves non-secret keys alone', () => {
      const body = '{"error":"invalid_grant","error_description":"expired"}'
      expect(shikimori.scrubErrorBody(body)).toBe(body)
    })

    it('summarizes an OAuth error as "code: description"', () => {
      expect(
        shikimori.summarizeErrorBody('{"error":"invalid_grant","error_description":"revoked"}')
      ).toBe('invalid_grant: revoked')
    })

    it('keeps the description when truncating, rather than cutting the JSON blind', () => {
      // A head-truncation of the raw JSON would keep only the envelope; the
      // half that tells the user what happened must survive (#244 §4).
      const long = 'x'.repeat(500)
      const summary = shikimori.summarizeErrorBody(
        JSON.stringify({ error: 'invalid_grant', error_description: long, extra: long })
      )
      expect(summary.startsWith('invalid_grant: xxx')).toBe(true)
      expect(summary).toHaveLength(200)
      expect(summary.endsWith('…')).toBe(true)
    })

    it('falls back to a capped raw body when the response is not JSON', () => {
      expect(shikimori.summarizeErrorBody('  <html>Bad   Gateway</html>\n')).toBe(
        '<html>Bad Gateway</html>'
      )
      expect(shikimori.summarizeErrorBody('')).toBe('')
    })
  })
})
