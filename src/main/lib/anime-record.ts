// A title's record for naming it and finding its folder, even when its
// `downloadedAnime` record is gone (#655, #657): `downloadedAnime`, then
// `library`, then the cached details, then `recentAnimeMeta`. Shared by the
// export plan and Prepare for offline's integrity step. The chain doesn't put
// the cache first on purpose: the export looks for a title's files under the
// name they were downloaded with, which is `downloadedAnime`'s.
//
// `playerRecordFrom` (#660) is the record the player takes its name from: the
// cached details (what offline `GET_ANIME` returns), then the chain. Used by
// the integrity step and Copy to this PC, which check and file under that name.

export function animeRecordFrom(
  store: { get(key: string): unknown },
  id: number
): AnimeSearchResult | null {
  const map = <T>(key: string): Record<string, T> | undefined =>
    store.get(key) as Record<string, T> | undefined
  return (
    map<AnimeSearchResult>('downloadedAnime')?.[id] ??
    map<AnimeSearchResult>('library')?.[id] ??
    map<{ animeDetail?: AnimeSearchResult | null }>('animeCache')?.[id]?.animeDetail ??
    map<AnimeSearchResult>('recentAnimeMeta')?.[id] ??
    null
  )
}

export function playerRecordFrom(
  store: { get(key: string): unknown },
  id: number
): AnimeSearchResult | null {
  const cache = store.get('animeCache') as
    | Record<string, { animeDetail?: AnimeSearchResult | null }>
    | undefined
  return cache?.[id]?.animeDetail ?? animeRecordFrom(store, id)
}

/** The names a title's folder can have: `getAnimeName`'s order (romaji, ru, title). */
export function titleNames(anime: AnimeSearchResult | null): string[] {
  if (!anime) return []
  const out: string[] = []
  for (const n of [anime.titles?.romaji, anime.titles?.ru, anime.title]) {
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}
