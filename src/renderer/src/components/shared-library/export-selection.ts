// Tri-state selection over the export tree (#574). Only `ready` episodes can
// be selected; a node is checked when every ready episode under it is,
// indeterminate when some are, and unchecked when none (or it has none).

export type TriState = 'checked' | 'partial' | 'unchecked'

export function readyKeys(episodes: readonly ExportTreeEpisode[]): string[] {
  return episodes.filter((e) => e.state === 'ready').map((e) => e.key)
}

export function titleKeys(title: ExportTreeTitle): string[] {
  return title.translations.flatMap((t) => readyKeys(t.episodes))
}

export function allKeys(titles: readonly ExportTreeTitle[]): string[] {
  return titles.flatMap(titleKeys)
}

export function stateOf(keys: readonly string[], selected: ReadonlySet<string>): TriState {
  if (keys.length === 0) return 'unchecked'
  const n = keys.filter((k) => selected.has(k)).length
  if (n === 0) return 'unchecked'
  return n === keys.length ? 'checked' : 'partial'
}

/** Clicking a node: a checked node clears, anything else selects all of it. */
export function toggle(keys: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected)
  if (stateOf(keys, selected) === 'checked') for (const k of keys) next.delete(k)
  else for (const k of keys) next.add(k)
  return next
}

/** The ready bytes under a node. */
export function sizeOf(episodes: readonly ExportTreeEpisode[]): number {
  return episodes.reduce((n, e) => n + (e.state === 'ready' ? e.size : 0), 0)
}

export function titleSize(title: ExportTreeTitle): number {
  return title.translations.reduce((n, t) => n + sizeOf(t.episodes), 0)
}

// Pre-fetch (#577): a not-downloaded episode is selected by its own key in the
// same set, `pf:<animeId>:<episodeInt>`, and downloaded in the translation
// picked for it (the first option until the user picks another).

export function prefetchKey(animeId: number, episodeInt: string): string {
  return `pf:${animeId}:${episodeInt}`
}

/** The not-downloaded episodes of `title` that can be pre-fetched, as keys. */
export function prefetchKeys(title: ExportTreeTitle): string[] {
  return title.notDownloaded
    .filter((e) => e.options.length > 0)
    .map((e) => prefetchKey(title.animeId, e.episodeInt))
}

/** A title node's keys: its ready episodes, plus its pre-fetchable ones when pre-fetch is on. */
export function nodeKeys(title: ExportTreeTitle, prefetch: boolean): string[] {
  return prefetch ? [...titleKeys(title), ...prefetchKeys(title)] : titleKeys(title)
}

/** The option picked for a not-downloaded episode: `choices[key]`, else the default (first). */
export function pickedOption(
  e: ExportNotDownloaded,
  key: string,
  choices: Readonly<Record<string, number>>
): ExportPrefetchOption | null {
  const id = choices[key]
  return e.options.find((o) => o.translationId === id) ?? e.options[0] ?? null
}

/** The selected not-downloaded episodes as the IPC `prefetch` list. */
export function toPrefetch(
  titles: readonly ExportTreeTitle[],
  selected: ReadonlySet<string>,
  choices: Readonly<Record<string, number>>
): ExportSelectionItem[] {
  const out: ExportSelectionItem[] = []
  for (const t of titles) {
    for (const e of t.notDownloaded) {
      const key = prefetchKey(t.animeId, e.episodeInt)
      if (!selected.has(key)) continue
      const o = pickedOption(e, key, choices)
      if (o)
        out.push({ animeId: t.animeId, episodeInt: e.episodeInt, translationId: o.translationId })
    }
  }
  return out
}

/** The selected pre-fetch: how many, their estimated bytes, and how many have no estimate. */
export function prefetchEstimate(
  titles: readonly ExportTreeTitle[],
  selected: ReadonlySet<string>,
  choices: Readonly<Record<string, number>>
): { items: number; bytes: number; unknown: number } {
  const out = { items: 0, bytes: 0, unknown: 0 }
  for (const t of titles) {
    for (const e of t.notDownloaded) {
      const key = prefetchKey(t.animeId, e.episodeInt)
      if (!selected.has(key)) continue
      const o = pickedOption(e, key, choices)
      if (!o) continue
      out.items++
      if (o.sizeBytes === null) out.unknown++
      else out.bytes += o.sizeBytes
    }
  }
  return out
}

/** The selected keys as the IPC selection. */
export function toSelection(
  titles: readonly ExportTreeTitle[],
  selected: ReadonlySet<string>
): ExportSelectionItem[] {
  const out: ExportSelectionItem[] = []
  for (const t of titles) {
    for (const tr of t.translations) {
      for (const e of tr.episodes) {
        if (selected.has(e.key)) {
          out.push({
            animeId: t.animeId,
            translationId: tr.translationId,
            episodeInt: e.episodeInt
          })
        }
      }
    }
  }
  return out
}
