import type { AnimeSearchResult, AnimeDetail, EpisodeSummary } from '../smotret-api'
import type { AnimeCacheEntry } from '../services/anime-cache'

const SHIKI_BASE = 'https://shikimori.one'
const RESUME_POSITION_GATE_SECONDS = 5
const RESUME_COMPLETION_GATE = 0.95
const MAX_ENTRIES = 24

export interface WatchProgressEntry {
  position: number
  duration: number
  updatedAt: number
  watched?: boolean
}

export interface CachedShikiRate {
  rate: {
    target_id: number
    episodes: number
    status: string
    updated_at?: string
  }
  shikiAnime?: {
    id: number
    name?: string
    russian?: string
    image?: { preview?: string; x96?: string; original?: string }
    episodes_aired?: number
  }
  smotretAnime?: AnimeSearchResult | null
}

export interface ContinueWatchingInputs {
  watchProgress: Record<string, WatchProgressEntry>
  rates: CachedShikiRate[]
  library: Record<string, AnimeSearchResult>
  downloaded: Record<string, AnimeSearchResult>
  recent: Record<string, AnimeSearchResult>
  malMap: Record<string, AnimeSearchResult>
  cache: Record<string, AnimeCacheEntry>
}

export interface ContinueWatchingEntry {
  kind: 'resume' | 'next'
  animeId: number
  animeName: string
  posterUrl: string
  episodeInt: string
  episodeLabel: string
  position?: number
  duration?: number
  updatedAt: number
  malId?: number
}

export interface ContinueWatchingDraftEntry extends ContinueWatchingEntry {
  shikiPosterFallback?: string
  shikiNameFallback?: string
}

export interface ContinueWatchingDraft {
  entries: ContinueWatchingDraftEntry[]
  unresolvedIds: number[]
}

function isContentEpisode(ep: EpisodeSummary): boolean {
  // smotret-anime's episode list sometimes leads with a `preview`/trailer entry
  // that shares `episodeInt` with the real episode (e.g. smotret id 34496);
  // AnimeDetailView filters these out — mirror it here so labels say
  // "Episode 1" instead of "Трейлер".
  return ep.episodeType !== 'preview'
}

function localResolve(
  animeId: number,
  state: ContinueWatchingInputs,
  malId?: number
): AnimeSearchResult | null {
  const idKey = String(animeId)
  return (
    state.library[idKey] ||
    state.downloaded[idKey] ||
    state.recent[idKey] ||
    (malId ? state.malMap[String(malId)] : null) ||
    null
  )
}

function entryToNamePoster(
  entry: AnimeSearchResult | null,
  fallbackName?: string
): { name: string; poster: string } {
  if (!entry) return { name: fallbackName || '', poster: '' }
  return {
    name: entry.titles?.ru || entry.titles?.romaji || entry.title || '',
    poster: entry.posterUrlSmall || ''
  }
}

function episodeLabelFor(
  animeId: number,
  episodeInt: string,
  cache: Record<string, AnimeCacheEntry>
): string {
  const entry = cache[String(animeId)]
  const ep = entry?.animeDetail?.episodes?.find(
    (e) => e.episodeInt === episodeInt && isContentEpisode(e)
  )
  return ep?.episodeFull || `Episode ${episodeInt}`
}

/**
 * Pure first pass: collapse `watchProgress` + `shikimoriUserRates` into the
 * draft list of resume and next-episode entries the Home view shows. Returns
 * `unresolvedIds` for the caller to fetch via `smotretApi.getAnime` before
 * calling {@link finalizeContinueWatchingEntries}.
 *
 * Lifted from `HOME_GET_CONTINUE_WATCHING` in `src/main/index.ts` as the
 * Phase 2 → Phase 3 deferred continue-watching extraction (epic #84, #102).
 */
export function buildContinueWatchingEntries(state: ContinueWatchingInputs): ContinueWatchingDraft {
  const entries: ContinueWatchingDraftEntry[] = []
  const resumeKeys = new Set<string>()

  // Collapse to the most-recently-updated unfinished episode per anime.
  const bestByAnime = new Map<
    number,
    { episodeInt: string; position: number; duration: number; updatedAt: number }
  >()
  for (const [key, val] of Object.entries(state.watchProgress)) {
    if (val.watched) continue
    if (!val.duration || val.duration <= 0) continue
    if (!val.position || val.position <= RESUME_POSITION_GATE_SECONDS) continue
    if (val.position / val.duration >= RESUME_COMPLETION_GATE) continue
    const sep = key.indexOf(':')
    if (sep < 0) continue
    const animeId = Number(key.slice(0, sep))
    const episodeInt = key.slice(sep + 1)
    if (!animeId || !episodeInt) continue
    const prev = bestByAnime.get(animeId)
    if (!prev || val.updatedAt > prev.updatedAt) {
      bestByAnime.set(animeId, {
        episodeInt,
        position: val.position,
        duration: val.duration,
        updatedAt: val.updatedAt
      })
    }
  }

  for (const [animeId, val] of bestByAnime) {
    const { name, poster } = entryToNamePoster(localResolve(animeId, state))
    resumeKeys.add(`${animeId}`)
    entries.push({
      kind: 'resume',
      animeId,
      animeName: name,
      posterUrl: poster,
      episodeInt: val.episodeInt,
      episodeLabel: episodeLabelFor(animeId, val.episodeInt, state.cache),
      position: val.position,
      duration: val.duration,
      updatedAt: val.updatedAt
    })
  }

  // Map smotret-anime id -> Shikimori rate.updated_at (ms). Used to override
  // Resume rows' sort key with the Shikimori clock so the Home view orders
  // entries the same way as the Shikimori "To Watch" tab.
  const rateUpdatedByAnimeId = new Map<number, number>()
  const statusByAnimeId = new Map<number, string>()
  for (const r of state.rates) {
    const animeId =
      r.smotretAnime?.id ??
      (r.rate.target_id ? state.malMap[String(r.rate.target_id)]?.id : undefined)
    if (!animeId) continue
    statusByAnimeId.set(animeId, r.rate.status)
    if (!r.rate.updated_at) continue
    const ms = Date.parse(r.rate.updated_at)
    if (Number.isFinite(ms)) rateUpdatedByAnimeId.set(animeId, ms)
  }
  for (const e of entries) {
    if (e.kind !== 'resume') continue
    const ms = rateUpdatedByAnimeId.get(e.animeId)
    if (ms) e.updatedAt = ms
  }

  // Hide stale "Resume" rows when Shikimori says the show is completed —
  // their watch is done, lingering local progress shouldn't drag them back
  // into Continue Watching.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind !== 'resume') continue
    if (statusByAnimeId.get(e.animeId) === 'completed') {
      entries.splice(i, 1)
      resumeKeys.delete(String(e.animeId))
    }
  }

  for (const r of state.rates) {
    const status = r.rate.status
    if (status !== 'watching' && status !== 'rewatching') continue
    const malId = r.rate.target_id
    const watched = r.rate.episodes
    const aired = r.shikiAnime?.episodes_aired ?? 0
    const next = watched + 1
    if (aired > 0 && next > aired) continue
    const smotret = r.smotretAnime || (malId ? state.malMap[String(malId)] : null)
    const animeId = smotret?.id ?? 0
    if (animeId && resumeKeys.has(String(animeId))) continue
    const fallbackName = r.shikiAnime?.russian || r.shikiAnime?.name || ''
    const resolved = entryToNamePoster(
      animeId ? localResolve(animeId, state, malId) : null,
      fallbackName
    )
    let poster = resolved.poster
    if (!poster && r.shikiAnime?.image) {
      const img =
        r.shikiAnime.image.preview || r.shikiAnime.image.x96 || r.shikiAnime.image.original || ''
      poster = img && (img.startsWith('http') ? img : `${SHIKI_BASE}${img}`)
    }
    const updatedAt = r.rate.updated_at ? Date.parse(r.rate.updated_at) || Date.now() : Date.now()
    entries.push({
      kind: 'next',
      animeId,
      animeName: resolved.name,
      posterUrl: poster,
      episodeInt: String(next),
      episodeLabel: animeId
        ? episodeLabelFor(animeId, String(next), state.cache)
        : `Episode ${next}`,
      updatedAt,
      malId,
      shikiPosterFallback: poster,
      shikiNameFallback: fallbackName
    })
  }

  // Lazy resolve any rows where we still don't have a name + poster locally.
  // Typical case: anime the user only streamed (no library/downloadedAnime/animeCache entry).
  const unresolvedIds = Array.from(
    new Set(
      entries
        .filter((e) => {
          if (!e.animeId) return false
          // recentAnimeMeta is the freshest source (set on every get-anime
          // call). If we already have it, skip the fetch.
          if (state.recent[String(e.animeId)]) return false
          if (!e.animeName) return true
          if (!e.posterUrl) return true
          // Poster is only the Shikimori fallback (which can be a 'missing'
          // placeholder when smotret-anime's bulk lookup didn't return one).
          // The detail endpoint usually does — so try.
          if (e.shikiPosterFallback && e.posterUrl === e.shikiPosterFallback) return true
          return false
        })
        .map((e) => e.animeId)
    )
  )

  return { entries, unresolvedIds }
}

/**
 * Pure second pass: apply the metadata fetched for `unresolvedIds`, strip the
 * Shikimori fallback fields, drop rows that are still nameless, sort by
 * `updatedAt` desc, and cap at 24 rows.
 */
export function finalizeContinueWatchingEntries(
  draft: ContinueWatchingDraftEntry[],
  fetched: Record<number, AnimeDetail | null>
): ContinueWatchingEntry[] {
  for (const e of draft) {
    if (!e.animeId) continue
    const meta = fetched[e.animeId]
    if (!meta) continue
    if (!e.animeName) {
      e.animeName =
        meta.titles?.ru || meta.titles?.romaji || meta.title || e.shikiNameFallback || ''
    }
    // Always prefer a smotret-anime poster when we have one — it overrides
    // the (potentially broken) Shikimori fallback.
    const fetchedPoster = meta.posterUrlSmall || meta.posterUrl
    if (fetchedPoster) {
      e.posterUrl = fetchedPoster
    } else if (!e.posterUrl) {
      e.posterUrl = e.shikiPosterFallback || ''
    }
    if (e.episodeLabel.startsWith('Episode ')) {
      const ep = meta.episodes?.find((ep) => ep.episodeInt === e.episodeInt && isContentEpisode(ep))
      if (ep?.episodeFull) e.episodeLabel = ep.episodeFull
    }
  }

  return draft
    .map(({ shikiPosterFallback: _p, shikiNameFallback: _n, ...rest }) => rest)
    .filter((e) => e.animeId && e.animeName)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ENTRIES)
}
