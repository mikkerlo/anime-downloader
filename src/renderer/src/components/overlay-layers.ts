// The stacking order of full-screen overlays that open over each other.
// Prepare for offline's panel (#592) offers Review (#585), so the review sheet
// sits above it.
export const LAYER = {
  prepareOfflinePanel: 9000,
  reviewSheet: 9100
} as const
