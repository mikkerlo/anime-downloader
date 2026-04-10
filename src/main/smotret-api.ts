const API_BASE = 'https://smotret-anime.ru/api'
const USER_AGENT = 'smotret-anime-dl'

export interface AnimeSearchResult {
  id: number
  title: string
  titles: { ru?: string; romaji?: string; ja?: string }
  posterUrlSmall: string
  numberOfEpisodes: number
  type: string
  typeTitle: string
  year: number
  season: string
}

export interface AnimeDetail extends AnimeSearchResult {
  posterUrl: string
  descriptions: { source: string; value: string }[]
  episodes: EpisodeSummary[]
  genres: { id: number; title: string }[]
  myAnimeListId?: number
}

export interface EpisodeSummary {
  id: number
  episodeFull: string
  episodeInt: string
  episodeType: string
  isActive: number
}

export interface EpisodeDetail {
  id: number
  episodeFull: string
  episodeInt: string
  episodeType: string
  translations: Translation[]
}

export interface Translation {
  id: number
  type: string
  typeKind: string
  typeLang: string
  authorsSummary: string
  isActive: number
  width: number
  height: number
  duration: string
}

export interface EmbedData {
  download: { height: number; url: string }[]
  stream: { height: number; urls: string[] }[]
  subtitlesUrl: string | null
}

export class SmotretApi {
  private getToken: () => string

  constructor(getToken: () => string) {
    this.getToken = getToken
  }

  private async request(path: string): Promise<unknown> {
    const token = this.getToken()
    const url = token
      ? `${API_BASE}${path}${path.includes('?') ? '&' : '?'}access_token=${token}`
      : `${API_BASE}${path}`

    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT }
    })

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`)
    }

    return response.json()
  }

  async searchAnime(query: string): Promise<{ data: AnimeSearchResult[] }> {
    return this.request(
      `/series/?query=${encodeURIComponent(query)}&fields=id,title,posterUrlSmall,numberOfEpisodes,type,typeTitle,year,season,titles`
    ) as Promise<{ data: AnimeSearchResult[] }>
  }

  async getAnime(id: number): Promise<{ data: AnimeDetail }> {
    return this.request(`/series/${id}`) as Promise<{ data: AnimeDetail }>
  }

  async getEpisode(id: number): Promise<{ data: EpisodeDetail }> {
    return this.request(`/episodes/${id}`) as Promise<{ data: EpisodeDetail }>
  }

  async getEmbed(translationId: number): Promise<EmbedData> {
    const json = await this.request(`/translations/embed/${translationId}`) as { data: EmbedData }
    return json.data
  }

  getSubtitlesUrl(translationId: number): string {
    const token = this.getToken()
    return `https://smotret-anime.ru/translations/ass/${translationId}?download=1`
      + (token ? `&access_token=${token}` : '')
  }

  getFallbackVideoUrl(translationId: number, height: number): string {
    const token = this.getToken()
    return `https://smotret-anime.ru/translations/mp4/${translationId}?format=mp4&height=${height}`
      + (token ? `&access_token=${token}` : '')
  }

  async fetchSubtitleContent(translationId: number): Promise<string | null> {
    const url = this.getSubtitlesUrl(translationId)
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      if (response.ok) return response.text()
      return null
    } catch {
      return null
    }
  }

  async fetchPoster(posterUrl: string): Promise<Buffer | null> {
    if (!posterUrl) return null
    try {
      const response = await fetch(posterUrl, { headers: { 'User-Agent': USER_AGENT } })
      if (!response.ok || !response.body) return null
      return Buffer.from(await response.arrayBuffer())
    } catch {
      return null
    }
  }

  async validateToken(): Promise<{ valid: boolean; error?: string }> {
    const token = this.getToken()
    if (!token) return { valid: false, error: 'No token configured' }
    try {
      const response = await fetch(
        `${API_BASE}/translations/embed/4336179?access_token=${token}`,
        { headers: { 'User-Agent': USER_AGENT } }
      )
      const json = await response.json() as { error?: { code: number; message: string }; data?: unknown }
      if (json.error?.code === 403) return { valid: false, error: 'Invalid token' }
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async lookupByMalIds(malIds: number[]): Promise<(AnimeSearchResult & { myAnimeListId?: number })[]> {
    const BATCH_SIZE = 50
    const results: (AnimeSearchResult & { myAnimeListId?: number })[] = []
    for (let i = 0; i < malIds.length; i += BATCH_SIZE) {
      const batch = malIds.slice(i, i + BATCH_SIZE)
      const params = batch.map((id) => `myAnimeListId[]=${id}`).join('&')
      const fields = 'id,title,titles,posterUrlSmall,numberOfEpisodes,type,typeTitle,year,season,myAnimeListId'
      const response = (await this.request(`/series/?${params}&fields=${fields}`)) as {
        data: (AnimeSearchResult & { myAnimeListId?: number })[]
      }
      results.push(...response.data)
    }
    return results
  }
}
