// Offline local search over the titles this PC has (#571): starred, downloaded,
// and every `animeCache` entry with a detail (which, after #570, includes
// continue-watching titles). Pure: the handler hands in one store snapshot per
// query. Titles that are only on the Shikimori list are not in the corpus; the
// rates only annotate corpus titles with `listStatus`, joined by MAL id.

export const MIN_QUERY_CODE_POINTS = 2

interface StoredRateRow {
  rate?: { status?: ShikiUserRateStatus; target_id?: number }
  shikiAnime?: { id?: number }
}

export interface LocalSearchSnapshot {
  library?: Record<string, AnimeSearchResult | undefined>
  downloadedAnime?: Record<string, AnimeSearchResult | undefined>
  animeCache?: Record<string, { animeDetail?: AnimeDetail } | undefined>
  shikimoriUserRates?: StoredRateRow[]
  shikimoriAnimeDetails?: Record<string, { details?: { status?: string } } | undefined>
  /** A `watchProgress` entry in the last 90 days (#570's recent-watch index). */
  isRecentlyWatched: (animeId: number) => boolean
}

interface Field {
  text: string
  /** Code-unit offsets where a word starts. */
  starts: number[]
}

export interface LocalCorpusEntry {
  anime: AnimeSearchResult
  localSources: LocalSource[]
  listStatus?: ShikiUserRateStatus
  airingStatus?: string
  genres: string[]
  titleFields: Field[]
  genreFields: Field[]
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u

/**
 * Case-, width- and diacritic-insensitive. Dropping the diaeresis is what folds
 * `ё` to `е`; `й` keeps its breve, and marks outside the combining block
 * (Japanese dakuten) survive the NFC round trip.
 */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/(?<!и)\u{306}|[\u{300}-\u{305}\u{307}-\u{36f}]/gu, '')
    .normalize('NFC')
}

function toField(raw: string): Field | null {
  const text = normalize(raw).trim()
  if (!text) return null
  const starts: number[] = []
  let prevWord = false
  let i = 0
  for (const ch of text) {
    const word = WORD_CHAR.test(ch)
    if (word && !prevWord) starts.push(i)
    prevWord = word
    i += ch.length
  }
  return { text, starts }
}

function toFields(raws: (string | undefined)[]): Field[] {
  const seen = new Set<string>()
  const out: Field[] = []
  for (const raw of raws) {
    if (typeof raw !== 'string') continue
    const field = toField(raw)
    if (!field || seen.has(field.text)) continue
    seen.add(field.text)
    out.push(field)
  }
  return out
}

function project(a: AnimeSearchResult): AnimeSearchResult {
  return {
    id: a.id,
    title: a.title,
    titles: a.titles ?? {},
    posterUrlSmall: a.posterUrlSmall,
    numberOfEpisodes: a.numberOfEpisodes,
    type: a.type,
    typeTitle: a.typeTitle,
    year: a.year,
    season: a.season
  }
}

function malIdOf(row: StoredRateRow): number | undefined {
  const id = row.rate?.target_id ?? row.shikiAnime?.id
  return typeof id === 'number' && Number.isFinite(id) && id > 0 ? id : undefined
}

export function buildCorpus(snapshot: LocalSearchSnapshot): LocalCorpusEntry[] {
  const library = snapshot.library ?? {}
  const downloaded = snapshot.downloadedAnime ?? {}
  const cache = snapshot.animeCache ?? {}
  const statusByMal = new Map<number, ShikiUserRateStatus>()
  for (const row of snapshot.shikimoriUserRates ?? []) {
    const malId = malIdOf(row)
    if (malId !== undefined && row.rate?.status) statusByMal.set(malId, row.rate.status)
  }

  const ids = new Set<string>([
    ...Object.keys(library),
    ...Object.keys(downloaded),
    ...Object.keys(cache).filter((id) => cache[id]?.animeDetail)
  ])
  const corpus: LocalCorpusEntry[] = []
  for (const key of ids) {
    const animeId = Number(key)
    if (!Number.isInteger(animeId) || animeId <= 0) continue
    const detail = cache[key]?.animeDetail
    const base = detail ?? library[key] ?? downloaded[key]
    if (!base || typeof base.title !== 'string') continue

    const localSources: LocalSource[] = []
    if (library[key]) localSources.push({ kind: 'starred' })
    if (downloaded[key]) localSources.push({ kind: 'downloaded' })
    if (snapshot.isRecentlyWatched(animeId)) localSources.push({ kind: 'watching' })

    const genres = (detail?.genres ?? [])
      .map((g) => g?.title)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
    const malId = detail?.myAnimeListId
    const listStatus = malId !== undefined ? statusByMal.get(malId) : undefined
    const airingStatus =
      malId !== undefined
        ? snapshot.shikimoriAnimeDetails?.[String(malId)]?.details?.status
        : undefined
    const titles = base.titles ?? {}

    corpus.push({
      anime: { ...project(base), id: animeId },
      localSources,
      ...(listStatus ? { listStatus } : {}),
      ...(airingStatus ? { airingStatus } : {}),
      genres,
      titleFields: toFields([base.title, titles.ru, titles.romaji, titles.ja]),
      genreFields: toFields(genres)
    })
  }
  return corpus
}

const TIER_EXACT = 3
const TIER_PREFIX = 2
const TIER_SUBSTRING = 1

function hasPrefix(field: Field, token: string): boolean {
  return field.starts.some((i) => field.text.startsWith(token, i))
}

function matchTier(entry: LocalCorpusEntry, tokens: string[], whole: string): number {
  const fields = [...entry.titleFields, ...entry.genreFields]
  if (entry.titleFields.some((f) => f.text.replace(/\s+/g, ' ') === whole)) return TIER_EXACT
  if (tokens.every((t) => fields.some((f) => hasPrefix(f, t)))) return TIER_PREFIX
  if (tokens.length === 1 && fields.some((f) => f.text.includes(tokens[0]))) return TIER_SUBSTRING
  return 0
}

function score(entry: LocalCorpusEntry, tier: number): number {
  let s = tier * 10
  if (entry.localSources.some((src) => src.kind === 'watching')) s += 1
  if (entry.listStatus === 'watching' || entry.listStatus === 'rewatching') s += 1
  return s
}

export function searchLocal(
  corpus: LocalCorpusEntry[],
  query: string,
  filters: LocalSearchFilters = {}
): LocalSearchResult[] {
  const trimmed = typeof query === 'string' ? query.trim() : ''
  if ([...trimmed].length < MIN_QUERY_CODE_POINTS) return []
  const tokens = trimmed
    .split(/\s+/)
    .map(normalize)
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return []
  const whole = tokens.join(' ')

  const hits: { entry: LocalCorpusEntry; score: number }[] = []
  for (const entry of corpus) {
    if (filters.genre && !entry.genres.includes(filters.genre)) continue
    if (filters.status && entry.listStatus !== filters.status) continue
    const tier = matchTier(entry, tokens, whole)
    if (tier > 0) hits.push({ entry, score: score(entry, tier) })
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.anime.title.localeCompare(b.entry.anime.title) ||
      a.entry.anime.id - b.entry.anime.id
  )
  return hits.map(({ entry }) => ({
    ...entry.anime,
    localSources: entry.localSources,
    ...(entry.listStatus ? { listStatus: entry.listStatus } : {}),
    genres: entry.genres,
    ...(entry.airingStatus ? { airingStatus: entry.airingStatus } : {})
  }))
}
