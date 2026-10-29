// Doc builders for the merge engine tests (#584).

export const F = <T>(value: T, at = 100, origin = 'pc-a'): SyncField<T> => ({ value, at, origin })

export function doc(
  titles: Record<string, SyncTitleState> = {},
  extra: Partial<SyncDoc> = {}
): SyncDoc {
  return {
    stateVersion: 1,
    stateMinor: 0,
    installId: 'pc-a',
    titles,
    priorityOrder: { value: [], at: 0, origin: 'legacy' },
    tombstones: {},
    ...extra
  }
}

export function rate(
  v: Partial<{ episodes: number; status: string; score: number; rewatches: number }> = {},
  at = 100,
  origin = 'pc-a',
  malId = 1
): SyncRateState {
  return {
    malId,
    episodes: F(v.episodes ?? 0, at, origin),
    status: F(v.status ?? 'watching', at, origin),
    score: F(v.score ?? 0, at, origin),
    rewatches: F(v.rewatches ?? 0, at, origin)
  }
}

export function watch(
  watched: boolean,
  at = 100,
  position = 0,
  origin = 'pc-a',
  watchedAt: number | null = watched ? at : null
): SyncWatchEntry {
  return {
    position: F({ position, duration: 1440 }, at, origin),
    watched: F(watched, at, origin),
    watchedAt
  }
}
