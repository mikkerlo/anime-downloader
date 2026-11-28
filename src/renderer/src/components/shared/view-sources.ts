// The sidebar "Lists" group's item gates (#707, epic #688). `docs/renderer.md`
// § Sidebar describes the rule.
//
// `VIEW_SOURCES` records which trackers each tracker-backed view can render
// today. The slice that teaches a view another tracker widens its row: T11b
// (#709) widened `calendar` and T12 (#712) `friends`; T11d (#711) widens `forYou`.

import {
  CAPABILITY_MATRIX,
  FEATURE_CAPABILITY,
  type MatrixCapability
} from '@shared/trackers/feature-source'

export type ViewSourceRow = 'calendar' | 'forYou' | 'friends'

export const VIEW_SOURCES: Record<ViewSourceRow, readonly TrackerId[]> = {
  calendar: ['shikimori', 'anilist'],
  forYou: ['shikimori'],
  friends: ['shikimori', 'anilist']
}

// Friends has no feature key: its capability is the matrix's `getFriends` row.
const ROW_CAPABILITY: Record<ViewSourceRow, MatrixCapability> = {
  calendar: FEATURE_CAPABILITY.calendar,
  forYou: FEATURE_CAPABILITY.forYou,
  friends: 'getFriends'
}

/** The connected trackers in `VIEW_SOURCES[row]` and capable in the static matrix, in order. */
export function connectedSources(row: ViewSourceRow, connected: readonly TrackerId[]): TrackerId[] {
  return connected.filter(
    (id) => VIEW_SOURCES[row].includes(id) && CAPABILITY_MATRIX[ROW_CAPABILITY[row]][id] === true
  )
}

/** Some connected tracker is in `VIEW_SOURCES[row]` and capable in the static matrix. */
export function anyConnectedSource(row: ViewSourceRow, connected: readonly TrackerId[]): boolean {
  return connectedSources(row, connected).length > 0
}

/**
 * The gate for a row whose view reads `featureSource(f)`: the resolved source
 * is one the view can render. `null` (no account, or no capable tracker) hides it.
 */
export function resolvedSourceRenders(row: ViewSourceRow, source: TrackerId | null): boolean {
  return source !== null && VIEW_SOURCES[row].includes(source)
}
