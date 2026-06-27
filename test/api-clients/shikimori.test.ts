import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import * as shikimori from '../../src/main/shikimori'
import { InMemoryStorage } from '../helpers/in-memory-storage'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(__dirname, '../fixtures/shikimori', name), 'utf8'))
}

function mockFetchOnce(body: unknown, status = 200): void {
  global.fetch = vi.fn(
    async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body)
      }) as unknown as Response
  )
}

function lastFetchUrl(): string {
  const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1][0] as string
}

beforeEach(() => {
  vi.restoreAllMocks()
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

    it('throws if not logged in', async () => {
      const store = new InMemoryStorage({ shikimoriCredentials: null })
      await expect(
        shikimori.ensureFreshToken(
          store as unknown as Parameters<typeof shikimori.ensureFreshToken>[0]
        )
      ).rejects.toThrow(/Not logged in/)
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
  })
})
