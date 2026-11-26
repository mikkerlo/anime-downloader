// How the stored primary is read (#696 § 0), in one place: the stored
// `trackerPrimary` if that tracker is connected (`<provider>User` set), else
// the first connected tracker in `shikimori`, `anilist`, `mal` order, else
// null. The account lifecycle answers with it (`trackerLifecycle.primary()`),
// and `index.ts` hands the fan-out that same getter, so the accounts state and
// the writes can't disagree about which tracker is primary.
//
// `connectedAccounts` is the same "connected" rule as a list, for the Shared
// Library's owner checks (#714).

import { TRACKER_IDS } from '../services/trackers/rates'
import { TRACKER_KEYS } from './keys'

/** What these read: a `StorageService`, or the export's narrower store. */
type StoreReader = { get(key: string): unknown }

/** The stored `trackerPrimary` when it names a known tracker, connected or not. */
export function storedPrimary(store: StoreReader): TrackerId | null {
  const stored = store.get('trackerPrimary') as TrackerId | null | undefined
  return stored && TRACKER_IDS.includes(stored) ? stored : null
}

export function isConnected(store: StoreReader, id: TrackerId): boolean {
  return store.get(TRACKER_KEYS[id].user) != null
}

export function resolvePrimary(store: StoreReader): TrackerId | null {
  const stored = storedPrimary(store)
  if (stored && isConnected(store, stored)) return stored
  return TRACKER_IDS.find((id) => isConnected(store, id)) ?? null
}

/** A connected account, as a Shared Library owner check names it (#714). */
export interface ConnectedAccount {
  provider: TrackerId
  /** The account's id as a decimal string, as a v2 owner's `userId`. */
  userId: string
  nickname: string
}

/**
 * Every connected account in `shikimori`, `anilist`, `mal` order, read fresh
 * on every call: `<provider>User` set with an id, an expired session included
 * (credentials don't count).
 */
export function connectedAccounts(store: StoreReader): ConnectedAccount[] {
  const out: ConnectedAccount[] = []
  for (const provider of TRACKER_IDS) {
    const u = store.get(TRACKER_KEYS[provider].user) as
      | { id?: unknown; nickname?: unknown }
      | null
      | undefined
    if (typeof u?.id !== 'number') continue
    out.push({
      provider,
      userId: String(u.id),
      nickname: typeof u.nickname === 'string' ? u.nickname : ''
    })
  }
  return out
}
