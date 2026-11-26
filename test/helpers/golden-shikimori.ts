// The Shikimori the 6.0.21 golden session (#689) signs in to: user A's rates
// are `fake-shikimori.ts`'s `server`, user B has none. Like `fake-shikimori.ts`
// it imports nothing from `src/`, so a `vi.mock` factory can load it:
//   vi.mock('../../src/main/shikimori', async (orig) => ({
//     ...(await orig()), ...(await import('../helpers/golden-shikimori')).goldenApi }))
//
// Every call checks `net.offline` first and fails the way the offline gate
// does (`ANIME_DL_OFFLINE`), as `shikiFetch` would under Work offline.
import { vi } from 'vitest'
import { fakeApi, server } from './fake-shikimori'

export const USER_A = { id: 4242, nickname: 'golden-a', avatar: '/system/users/x160/4242.png' }
export const USER_B = { id: 777, nickname: 'golden-b', avatar: '/system/users/x160/777.png' }

/** Only the `fake-access-token` / `fake-refresh-token` stand-ins (`fixtures-anonymization.test.ts`). */
export const credsFor = (user: { id: number }, createdAt: number) => ({
  access_token: `fake-access-token-${user.id}`,
  refresh_token: `fake-refresh-token-${user.id}`,
  token_type: 'Bearer',
  expires_in: 86_400,
  created_at: Math.floor(createdAt / 1000)
})

export const net = { offline: false, codes: {} as Record<string, { id: number }> }

/** `/api/animes/:id` answers: `episodes_aired` is what the auto-download tick reads. */
export const details = new Map<number, { name: string; episodes: number; episodes_aired: number }>()

function gate(): void {
  if (net.offline) {
    throw Object.assign(new Error('Offline: network access is turned off'), {
      name: 'OfflineError',
      code: 'ANIME_DL_OFFLINE'
    })
  }
}

const isA = (userId: number): boolean => userId === USER_A.id
const tokenOfA = `fake-access-token-${USER_A.id}`

export const goldenApi = {
  exchangeCode: vi.fn(async (code: string) => {
    gate()
    const user = net.codes[code]
    if (!user) throw new Error(`golden: unknown code ${code}`)
    return credsFor(user, Date.now())
  }),
  getUser: vi.fn(async (token: string) => {
    gate()
    return token === tokenOfA ? USER_A : USER_B
  }),
  // Tokens never expire within the session, so no refresh is ever made.
  ensureFreshToken: vi.fn(async (store: { get(key: string): unknown }) => {
    const creds = store.get('shikimoriCredentials') as { access_token: string } | null
    if (!creds) throw new Error('golden: not signed in')
    return creds.access_token
  }),
  getUserRate: vi.fn(async (token: string, userId: number, malId: number) => {
    gate()
    return isA(userId) ? fakeApi.getUserRate(token, userId, malId) : null
  }),
  createUserRate: vi.fn(async (...a: Parameters<typeof fakeApi.createUserRate>) => {
    gate()
    if (!isA(a[1])) throw new Error('golden: B never writes')
    return fakeApi.createUserRate(...a)
  }),
  updateUserRate: vi.fn(async (...a: Parameters<typeof fakeApi.updateUserRate>) => {
    gate()
    if (a[0] !== tokenOfA) throw new Error('golden: B never writes')
    return fakeApi.updateUserRate(...a)
  }),
  getUserAnimeRates: vi.fn(async (_token: string, userId: number) => {
    gate()
    if (!isA(userId)) return []
    return fakeApi.getUserAnimeRates()
  }),
  getAnimeDetails: vi.fn(async (_token: string, malId: number) => {
    gate()
    const d = details.get(malId)
    if (!d) throw Object.assign(new Error(`Shikimori API error: 404`), { status: 404 })
    return { id: malId, russian: '', genres: [], ...d }
  })
}

export function resetGolden(): void {
  server.reset()
  details.clear()
  net.offline = false
  net.codes = {}
  for (const fn of Object.values(goldenApi)) fn.mockClear()
}

export { server }
