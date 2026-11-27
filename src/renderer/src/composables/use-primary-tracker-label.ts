// The primary tracker's display name, for copy about the tracker a change
// goes to first (#700): the offline queue note, the cleanup prompt. With no
// primary yet (no account, or before the accounts load) it is Shikimori's,
// the wording these strings had before other trackers existed.

import { computed, type ComputedRef } from 'vue'
import { TRACKER_LABELS } from '@shared/trackers/labels'
import { useTrackersStore } from '../stores/trackers'

export function usePrimaryTrackerLabel(): ComputedRef<string> {
  const trackers = useTrackersStore()
  return computed(() => TRACKER_LABELS[trackers.primary ?? 'shikimori'])
}
