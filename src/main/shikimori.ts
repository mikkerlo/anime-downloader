import type { StorageService } from './store/types'

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

export type ShikiUserRateStatus =
  | 'planned'
  | 'watching'
  | 'rewatching'
  | 'completed'
  | 'on_hold'
  | 'dropped'

export interface ShikiUserRate {
  id: number
  score: number
  status: ShikiUserRateStatus
  episodes: number
  rewatches: number
  target_id: number
  target_type: string
}

export interface ShikiAnimeRateEntry {
  id: number
  score: number
  status: ShikiUserRateStatus
  episodes: number
  rewatches: number
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

export async function ensureFreshToken(store: StorageService): Promise<string> {
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

export interface ShikiUserStats {
  // Anime list-breakdown buckets, e.g. { name: 'watching', size: 42 }.
  statuses: { name: string; size: number }[]
  // Score distribution indexed 0..9 for scores 1..10 (0 = "rated 1").
  scores: number[]
}

// GET /api/users/:id returns the full user object including a `stats` block the
// `/whoami` endpoint omits. Parse defensively — the shape varies (anime vs manga
// buckets, missing arrays for fresh accounts).
export async function getUserStats(accessToken: string, userId: number): Promise<ShikiUserStats> {
  const response = await shikiFetch(`/api/users/${userId}`, {
    headers: authHeaders(accessToken)
  })
  const body = (await response.json()) as {
    stats?: {
      statuses?: { anime?: { name?: string; size?: number }[] }
      scores?: { anime?: { name?: string; value?: number }[] }
    }
  }
  const statusList = body.stats?.statuses?.anime ?? []
  const statuses = statusList
    .filter((s) => typeof s?.name === 'string')
    .map((s) => ({ name: s.name as string, size: Number(s.size) || 0 }))

  const scores = new Array<number>(10).fill(0)
  for (const s of body.stats?.scores?.anime ?? []) {
    const idx = Number(s?.name) - 1
    if (idx >= 0 && idx < 10) scores[idx] = Number(s?.value) || 0
  }
  return { statuses, scores }
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
  score: number,
  rewatches: number
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
        score,
        rewatches
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
  score: number,
  rewatches: number
): Promise<ShikiUserRate> {
  const response = await shikiFetch(`/api/v2/user_rates/${rateId}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      user_rate: { episodes, status, score, rewatches }
    })
  })
  return response.json() as Promise<ShikiUserRate>
}

export interface ShikiFriend {
  id: number
  nickname: string
  avatar: string
  lastOnlineAt: string | null
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
  const raw = (await response.json()) as {
    id: number
    nickname: string
    avatar: string
    last_online_at?: string | null
  }[]
  return raw.map((f) => ({
    id: f.id,
    nickname: f.nickname,
    avatar: f.avatar,
    lastOnlineAt: f.last_online_at ?? null
  }))
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

export interface ShikiHistoryEntry {
  id: number
  created_at: string
  description: string
  target?: {
    id: number
    name: string
    russian: string
    image: { original: string; preview: string; x96: string; x48: string }
  } | null
}

export interface ShikiFriendActivity {
  friendId: number
  friendNickname: string
  friendAvatar: string
  malId: number
  animeName: string
  animeImage: string
  description: string
  createdAt: string
}

const FRIENDS_ACTIVITY_TOTAL_LIMIT = 50
const FRIENDS_ACTIVITY_PER_FRIEND_FETCH = 100

async function getFriendHistory(
  accessToken: string,
  friend: ShikiFriend
): Promise<ShikiFriendActivity[]> {
  const params = new URLSearchParams({
    limit: String(FRIENDS_ACTIVITY_PER_FRIEND_FETCH),
    target_type: 'Anime'
  })
  const response = await shikiFetch(`/api/users/${friend.id}/history?${params}`, {
    headers: authHeaders(accessToken)
  })
  const entries = (await response.json()) as ShikiHistoryEntry[]
  const activities: ShikiFriendActivity[] = []
  for (const entry of entries) {
    if (!entry.target) continue
    const img = entry.target.image.preview || entry.target.image.x96 || entry.target.image.original
    activities.push({
      friendId: friend.id,
      friendNickname: friend.nickname,
      friendAvatar: friend.avatar,
      malId: entry.target.id,
      animeName: entry.target.russian || entry.target.name,
      animeImage: img.startsWith('http') ? img : `${BASE_URL}${img}`,
      description: entry.description,
      createdAt: entry.created_at
    })
  }
  return activities
}

export async function getFriendsActivity(
  accessToken: string,
  userId: number
): Promise<ShikiFriendActivity[]> {
  const friends = await getFriends(accessToken, userId)
  if (friends.length === 0) return []

  const CONCURRENCY = 2
  const results: ShikiFriendActivity[] = []

  for (let i = 0; i < friends.length; i += CONCURRENCY) {
    const batch = friends.slice(i, i + CONCURRENCY)
    const histories = await Promise.all(
      batch.map(async (friend) => {
        try {
          return await getFriendHistory(accessToken, friend)
        } catch {
          return [] as ShikiFriendActivity[]
        }
      })
    )
    for (const h of histories) results.push(...h)
  }

  results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return results.slice(0, FRIENDS_ACTIVITY_TOTAL_LIMIT)
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

// A friend is "online" if Shikimori last saw them within this window.
const FRIEND_ONLINE_WINDOW_MS = 5 * 60 * 1000

export interface ShikiFriendWatching {
  malId: number
  // Resolved smotret-anime id for in-app navigation; null when not in catalog.
  animeId: number | null
  title: string
  image: string
  episode: number
  total: number
  status: ShikiUserRateStatus
}

export interface ShikiFriendCard {
  id: number
  nickname: string
  avatar: string
  lastOnlineAt: string | null
  online: boolean
  titles: number
  mean: number
  // Shared rated titles with the signed-in user (approximate "mutual").
  mutual: number
  watching: ShikiFriendWatching | null
}

// Pure aggregation of a single friend's card from their rate list — split out
// from the fetch orchestration so it can be unit-tested without network.
export function buildFriendCard(
  friend: ShikiFriend,
  friendRates: ShikiAnimeRateEntry[],
  ownMalIds: Set<number>,
  now: number = Date.now()
): ShikiFriendCard {
  const online = friend.lastOnlineAt
    ? now - new Date(friend.lastOnlineAt).getTime() < FRIEND_ONLINE_WINDOW_MS
    : false

  const scored = friendRates.filter((r) => r.score > 0)
  const mean = scored.length > 0 ? scored.reduce((s, r) => s + r.score, 0) / scored.length : 0
  const mutual = friendRates.reduce((n, r) => n + (ownMalIds.has(r.anime.id) ? 1 : 0), 0)

  const byRecency = friendRates
    .slice()
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
  const active = byRecency.find((r) => r.status === 'watching' || r.status === 'rewatching')
  const pick = active ?? byRecency.find((r) => r.status === 'completed') ?? null

  let watching: ShikiFriendWatching | null = null
  if (pick) {
    const img = pick.anime.image.preview || pick.anime.image.x96 || pick.anime.image.original || ''
    watching = {
      malId: pick.anime.id,
      animeId: null,
      title: pick.anime.russian || pick.anime.name,
      image: img.startsWith('http') ? img : `${BASE_URL}${img}`,
      episode: pick.episodes,
      total: pick.anime.episodes,
      status: pick.status
    }
  }

  return {
    id: friend.id,
    nickname: friend.nickname,
    avatar: friend.avatar,
    lastOnlineAt: friend.lastOnlineAt,
    online,
    titles: friendRates.length,
    mean,
    mutual,
    watching
  }
}

// Friend list joined with per-friend presence + a compact stat block. Per-friend
// rate fetches run batched (concurrency 2) to respect the rate limit; a failed
// friend degrades to a stat-less card rather than failing the whole list.
export async function getFriendsWithStats(
  accessToken: string,
  userId: number,
  ownMalIds: Set<number>
): Promise<ShikiFriendCard[]> {
  const friends = await getFriends(accessToken, userId)
  if (friends.length === 0) return []

  const CONCURRENCY = 2
  const cards: ShikiFriendCard[] = []
  for (let i = 0; i < friends.length; i += CONCURRENCY) {
    const batch = friends.slice(i, i + CONCURRENCY)
    const built = await Promise.all(
      batch.map(async (friend) => {
        try {
          const rates = await getUserAnimeRates(accessToken, friend.id)
          return buildFriendCard(friend, rates, ownMalIds)
        } catch {
          return buildFriendCard(friend, [], ownMalIds)
        }
      })
    )
    cards.push(...built)
  }
  return cards
}

export interface ShikiAnimeGenre {
  id: number
  name: string
  russian: string
  kind: string
}

export interface ShikiAnimeStudio {
  id: number
  name: string
  filtered_name: string
  real: boolean
  image: string | null
}

export interface ShikiAnimeDetails {
  id: number
  name: string
  russian: string
  kind: string
  description: string | null
  description_html: string | null
  rating: string
  duration: number
  aired_on: string | null
  released_on: string | null
  genres: ShikiAnimeGenre[]
  studios: ShikiAnimeStudio[]
  score: string
  status: string
  episodes: number
  episodes_aired: number
}

export async function getAnimeDetails(
  accessToken: string,
  malId: number
): Promise<ShikiAnimeDetails> {
  const response = await shikiFetch(`/api/animes/${malId}`, {
    headers: authHeaders(accessToken)
  })
  return response.json() as Promise<ShikiAnimeDetails>
}

export interface ShikiFranchiseNode {
  id: number
  date: number | null
  name: string
  image_url: string
  url: string
  year: number | null
  kind: string | null
  weight: number
}

export interface ShikiFranchiseLink {
  id: number
  source_id: number
  target_id: number
  source: number
  target: number
  weight: number
  relation: string
}

export interface ShikiFranchise {
  links: ShikiFranchiseLink[]
  nodes: ShikiFranchiseNode[]
  current_id: number
}

export async function getFranchise(malId: number): Promise<ShikiFranchise> {
  const response = await shikiFetch(`/api/animes/${malId}/franchise`)
  return response.json() as Promise<ShikiFranchise>
}

export interface ShikiCalendarEntry {
  next_episode: number | null
  next_episode_at: string | null
  duration: number | null
  anime: {
    id: number
    name: string
    russian: string
    image: { original: string; preview: string; x96: string; x48: string }
    url: string
    kind: string
    score: string
    status: string
    episodes: number
    episodes_aired: number
    aired_on: string | null
    released_on: string | null
  }
}

export async function getCalendar(): Promise<ShikiCalendarEntry[]> {
  const response = await shikiFetch('/api/calendar')
  return response.json() as Promise<ShikiCalendarEntry[]>
}
