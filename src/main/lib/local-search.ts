// Offline local search over the titles this PC has (#571): starred, downloaded,
// and every `animeCache` entry with a detail (which, after #570, includes
// continue-watching titles), plus the titles of every available attached
// Shared Library (#583). Pure: the handler hands in one store snapshot per
// query. Titles that are only on the Shikimori list are not in the corpus; the
// rates only annotate corpus titles with `listStatus`, joined by MAL id.

export const MIN_QUERY_CODE_POINTS = 2

interface StoredRateRow {
  rate?: { status?: ShikiUserRateStatus; target_id?: number }
  shikiAnime?: { id?: number }
}

/**
 * One available attached library's title snapshot, as
 * `AttachedLibraryService.availableSnapshots()` returns it. Read from a drive,
 * so every field is checked here before use.
 */
export interface AttachedSnapshot {
  libraryId: string
  name: string
  titles: { animeId: number; name: string; meta: SharedLibraryMeta | null }[]
}

export interface LocalSearchSnapshot {
  library?: Record<string, AnimeSearchResult | undefined>
  downloadedAnime?: Record<string, AnimeSearchResult | undefined>
  animeCache?: Record<string, { animeDetail?: AnimeDetail } | undefined>
  shikimoriUserRates?: StoredRateRow[]
  shikimoriAnimeDetails?: Record<string, { details?: { status?: string } } | undefined>
  /** A `watchProgress` entry in the last 90 days (#570's recent-watch index). */
  isRecentlyWatched: (animeId: number) => boolean
  /** Available attached libraries only (#583): an unplugged one is left out by the caller. */
  attached?: AttachedSnapshot[]
}

/** `anime-poster://shared/<libraryId>/<animeId>`: that library's snapshot poster (#583). */
export function sharedPosterUrl(libraryId: string, animeId: number): string {
  return `anime-poster://shared/${libraryId}/${animeId}`
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

/** One attached library's copy of a title, already checked. */
interface AttachedTitle {
  source: Extract<LocalSource, { kind: 'shared' }>
  anime: AnimeSearchResult
  /** Every title string the snapshot holds, for matching. */
  names: string[]
  genres: string[]
  malId?: number
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v : undefined
const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined
const positiveId = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined

function titlesOf(v: unknown): AnimeSearchResult['titles'] {
  if (!isRecord(v)) return {}
  const out: AnimeSearchResult['titles'] = {}
  for (const k of ['ru', 'romaji', 'ja'] as const) {
    const t = text(v[k])
    if (t !== undefined) out[k] = t
  }
  return out
}

/**
 * A drive's snapshot entry as a corpus title, or null when it has no title to
 * show. It reads the way the Shared Libraries tab does: the snapshot's search
 * record when there is one, else the manifest name and `meta.titles`.
 */
function attachedTitle(
  libraryId: string,
  libraryName: string,
  raw: unknown
): { animeId: number; title: AttachedTitle } | null {
  if (!isRecord(raw)) return null
  const animeId = positiveId(raw.animeId)
  if (animeId === undefined) return null
  const meta = isRecord(raw.meta) ? raw.meta : {}
  const sr = isRecord(meta.searchResult) ? meta.searchResult : null
  const name = text(raw.name)
  const title = text(sr?.title) ?? name
  if (title === undefined) return null
  const metaTitles = isRecord(meta.titles) ? meta.titles : {}
  const names = [
    title,
    name,
    ...Object.values(titlesOf(sr?.titles)),
    ...Object.values(titlesOf(metaTitles)),
    text(metaTitles.en)
  ].filter((t): t is string => t !== undefined)
  const genres = (Array.isArray(meta.genres) ? meta.genres : [])
    .map((g) => (isRecord(g) ? text(g.title) : undefined))
    .filter((t): t is string => t !== undefined)
  const episodes = Array.isArray(meta.episodes) ? meta.episodes.length : 0
  const malId = positiveId(meta.malId)
  return {
    animeId,
    title: {
      source: { kind: 'shared', libraryId, libraryName },
      anime: {
        id: animeId,
        title,
        titles: sr ? titlesOf(sr.titles) : titlesOf(metaTitles),
        // The drive's poster URL is untrusted: the card reads this library's snapshot poster.
        posterUrlSmall: sharedPosterUrl(libraryId, animeId),
        numberOfEpisodes: count(sr?.numberOfEpisodes) ?? episodes,
        type: text(sr?.type) ?? text(meta.type) ?? '',
        typeTitle: text(sr?.typeTitle) ?? '',
        year: count(sr?.year) ?? count(meta.year) ?? 0,
        season: text(sr?.season) ?? ''
      },
      names,
      genres,
      ...(malId !== undefined ? { malId } : {})
    }
  }
}

/** Each title's copies across the available libraries, by anime id; a bad entry is skipped. */
function attachedById(libraries: unknown): Map<number, AttachedTitle[]> {
  const out = new Map<number, AttachedTitle[]>()
  for (const lib of Array.isArray(libraries) ? libraries : []) {
    const libraryId = isRecord(lib) ? text(lib.libraryId) : undefined
    if (!isRecord(lib) || libraryId === undefined || !Array.isArray(lib.titles)) continue
    const libraryName = typeof lib.name === 'string' ? lib.name : ''
    for (const raw of lib.titles) {
      const hit = attachedTitle(libraryId, libraryName, raw)
      if (!hit) continue
      const list = out.get(hit.animeId) ?? []
      if (list.some((t) => t.source.libraryId === libraryId)) continue
      list.push(hit.title)
      out.set(hit.animeId, list)
    }
  }
  return out
}

export function buildCorpus(snapshot: LocalSearchSnapshot): LocalCorpusEntry[] {
  const library = snapshot.library ?? {}
  const downloaded = snapshot.downloadedAnime ?? {}
  const cache = snapshot.animeCache ?? {}
  const attached = attachedById(snapshot.attached)
  const statusByMal = new Map<number, ShikiUserRateStatus>()
  for (const row of snapshot.shikimoriUserRates ?? []) {
    const malId = malIdOf(row)
    if (malId !== undefined && row.rate?.status) statusByMal.set(malId, row.rate.status)
  }

  const ids = new Set<string>([
    ...Object.keys(library),
    ...Object.keys(downloaded),
    ...Object.keys(cache).filter((id) => cache[id]?.animeDetail),
    ...[...attached.keys()].map(String)
  ])
  const corpus: LocalCorpusEntry[] = []
  for (const key of ids) {
    const animeId = Number(key)
    if (!Number.isInteger(animeId) || animeId <= 0) continue
    const detail = cache[key]?.animeDetail
    const drives = attached.get(animeId) ?? []
    const local = detail ?? library[key] ?? downloaded[key]
    // A title on this PC reads from its local record; one only on a drive, from the first drive.
    const base = local && typeof local.title === 'string' ? local : drives[0]?.anime
    if (!base) continue

    const localSources: LocalSource[] = []
    if (library[key]) localSources.push({ kind: 'starred' })
    if (downloaded[key]) localSources.push({ kind: 'downloaded' })
    if (snapshot.isRecentlyWatched(animeId)) localSources.push({ kind: 'watching' })
    for (const d of drives) localSources.push(d.source)

    const genres = (detail ? (detail.genres ?? []) : [])
      .map((g) => g?.title)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
    if (!detail) genres.push(...(drives.find((d) => d.genres.length > 0)?.genres ?? []))
    const malId = detail?.myAnimeListId ?? drives.find((d) => d.malId !== undefined)?.malId
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
      titleFields: toFields([
        base.title,
        titles.ru,
        titles.romaji,
        titles.ja,
        ...drives.flatMap((d) => d.names)
      ]),
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
