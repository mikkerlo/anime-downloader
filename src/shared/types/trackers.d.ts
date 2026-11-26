// Shared domain types — list trackers (epic #688, #689).
// Ambient globals (see anime.d.ts header), so the renderer can name them later
// without an import. This is the only definition of `TrackerId`,
// `TrackerUser` and `TrackerErrorClass`; `src/main/trackers/types.ts` uses
// these global names and declares no copy.

// The trackers the app knows, in code. On a Shared Library drive the owner's
// provider is an open string, so this union never validates drive data.
type TrackerId = 'shikimori' | 'anilist' | 'mal'

// The signed-in account a tracker reports. `avatar` is null when the tracker
// has no picture; the sidebar chip falls back to the nickname's initial.
interface TrackerUser {
  id: number
  nickname: string
  avatar: string | null
}

// What a tracker error means to its callers. `docs/trackers.md` holds the
// policy each class implies (`TRACKER_ERROR_POLICY`).
type TrackerErrorClass = 'network' | 'auth' | 'config' | 'rate-limit' | 'server' | 'item'
