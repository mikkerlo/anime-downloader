import type Store from 'electron-store'

const CLIENT_ID = 'wlhQeTkDVSMFmXqvtDJqPG_ZhWEUnG8iI4YG9nadvLU'
const CLIENT_SECRET = 'r_lIMZbmFWZmVgP9pC9-9XaS0e96lwduMOegZ3YREfM'
const BASE_URL = 'https://shikimori.one'
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob'
const USER_AGENT = 'anime-dl'

export interface ShikiCredentials {
  access_token: string
  refresh_token: string
  created_at: number
  expires_in: number
}

export interface ShikiUser {
  id: number
  nickname: string
  avatar: string
}

export type ShikiUserRateStatus = 'planned' | 'watching' | 'rewatching' | 'completed' | 'on_hold' | 'dropped'

export interface ShikiUserRate {
  id: number
  score: number
  status: ShikiUserRateStatus
  episodes: number
  target_id: number
  target_type: string
}

export interface ShikiAnimeRateEntry {
  id: number
  score: number
  status: ShikiUserRateStatus
  episodes: number
  updated_at: string
  target_id: number
  target_type: string
  anime: {
    id: number
    name: string
    russian: string
    image: { original: string; preview: string; x96: string; x48: string }
    episodes: number
    episodes_aired: number
    kind: string
    score: string
    status: string
  }
}

export class ShikiApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = 'ShikiApiError'
  }
}

export function getAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'user_rates'
  })
  return `${BASE_URL}/oauth/authorize?${params}`
}

async function shikiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      ...options.headers
    }
  })

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') || '1')
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
    return shikiFetch(path, options)
  }

  if (!response.ok) {
    throw new ShikiApiError(`Shikimori API error: ${response.status}`, response.status)
  }

  return response
}

export async function exchangeCode(code: string): Promise<ShikiCredentials> {
  const response = await shikiFetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI
    })
  })
  return response.json() as Promise<ShikiCredentials>
}

async function refreshToken(token: string): Promise<ShikiCredentials> {
  const response = await shikiFetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: token
    })
  })
  return response.json() as Promise<ShikiCredentials>
}

export async function ensureFreshToken(store: Store): Promise<string> {
  const creds = store.get('shikimoriCredentials') as ShikiCredentials | null
  if (!creds) throw new Error('Not logged in to Shikimori')

  const expiresAt = (creds.created_at + creds.expires_in) * 1000
  if (Date.now() < expiresAt - 60_000) {
    return creds.access_token
  }

  const newCreds = await refreshToken(creds.refresh_token)
  store.set('shikimoriCredentials', newCreds)
  return newCreds.access_token
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  }
}

export async function getUser(accessToken: string): Promise<ShikiUser> {
  const response = await shikiFetch('/api/users/whoami', {
    headers: authHeaders(accessToken)
  })
  return response.json() as Promise<ShikiUser>
}

export async function getUserRate(
  accessToken: string,
  userId: number,
  malId: number
): Promise<ShikiUserRate | null> {
  const response = await shikiFetch(
    `/api/v2/user_rates?user_id=${userId}&target_id=${malId}&target_type=Anime`,
    { headers: authHeaders(accessToken) }
  )
  const rates = (await response.json()) as ShikiUserRate[]
  return rates.length > 0 ? rates[0] : null
}

export async function createUserRate(
  accessToken: string,
  userId: number,
  malId: number,
  episodes: number,
  status: ShikiUserRateStatus,
  score: number
): Promise<ShikiUserRate> {
  const response = await shikiFetch('/api/v2/user_rates', {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      user_rate: {
        user_id: userId,
        target_id: malId,
        target_type: 'Anime',
        episodes,
        status,
        score
      }
    })
  })
  return response.json() as Promise<ShikiUserRate>
}

export async function updateUserRate(
  accessToken: string,
  rateId: number,
  episodes: number,
  status: ShikiUserRateStatus,
  score: number
): Promise<ShikiUserRate> {
  const response = await shikiFetch(`/api/v2/user_rates/${rateId}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      user_rate: { episodes, status, score }
    })
  })
  return response.json() as Promise<ShikiUserRate>
}

export interface ShikiFriend {
  id: number
  nickname: string
  avatar: string
}

export interface ShikiFriendRate {
  nickname: string
  avatar: string
  status: ShikiUserRateStatus
  score: number
  episodes: number
}

export async function getFriends(accessToken: string, userId: number): Promise<ShikiFriend[]> {
  const response = await shikiFetch(`/api/users/${userId}/friends?limit=100`, {
    headers: authHeaders(accessToken)
  })
  return response.json() as Promise<ShikiFriend[]>
}

async function getFriendRateForAnime(
  accessToken: string,
  friend: ShikiFriend,
  malId: number
): Promise<ShikiFriendRate | null> {
  const params = new URLSearchParams({ limit: '5000', censored: 'true' })
  const response = await shikiFetch(`/api/users/${friend.id}/anime_rates?${params}`, {
    headers: authHeaders(accessToken)
  })
  const rates = (await response.json()) as ShikiAnimeRateEntry[]
  const rate = rates.find((r) => r.anime.id === malId)
  if (!rate) return null
  return {
    nickname: friend.nickname,
    avatar: friend.avatar,
    status: rate.status,
    score: rate.score,
    episodes: rate.episodes
  }
}

export async function getFriendsRatesForAnime(
  accessToken: string,
  userId: number,
  malId: number
): Promise<ShikiFriendRate[]> {
  const friends = await getFriends(accessToken, userId)
  if (friends.length === 0) return []

  const CONCURRENCY = 2
  const results: ShikiFriendRate[] = []

  for (let i = 0; i < friends.length; i += CONCURRENCY) {
    const batch = friends.slice(i, i + CONCURRENCY)
    const rates = await Promise.all(
      batch.map(async (friend) => {
        try {
          return await getFriendRateForAnime(accessToken, friend, malId)
        } catch {
          return null
        }
      })
    )
    for (const r of rates) {
      if (r) results.push(r)
    }
  }

  return results
}

export async function getUserAnimeRates(
  accessToken: string,
  userId: number,
  status?: ShikiUserRateStatus
): Promise<ShikiAnimeRateEntry[]> {
  const params = new URLSearchParams({ limit: '5000', censored: 'true' })
  if (status) params.set('status', status)
  const response = await shikiFetch(`/api/users/${userId}/anime_rates?${params}`, {
    headers: authHeaders(accessToken)
  })
  return response.json() as Promise<ShikiAnimeRateEntry[]>
}
