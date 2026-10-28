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
