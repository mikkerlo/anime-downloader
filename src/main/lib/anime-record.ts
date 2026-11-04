// A title's record for naming it and finding its folder, even when its
// `downloadedAnime` record is gone (#655, #657): `downloadedAnime`, then
// `library`, then the cached details, then `recentAnimeMeta`. Shared by the
// export plan and Prepare for offline's integrity step.

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

/** The names a title's folder can have: `getAnimeName`'s order (romaji, ru, title). */
export function titleNames(anime: AnimeSearchResult | null): string[] {
  if (!anime) return []
  const out: string[] = []
  for (const n of [anime.titles?.romaji, anime.titles?.ru, anime.title]) {
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}
