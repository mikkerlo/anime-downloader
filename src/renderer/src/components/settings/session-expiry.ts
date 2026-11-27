// The sign-in expiry warning (#703): AniList's token lasts a year with no
// refresh, so the card warns from two weeks before it ends. Without it,
// mirrors would start failing silently after a year.

export const EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1000

/** True from `expiresAt − 14 days` on; never without an expiry. */
export function isExpiringSoon(expiresAt: number | undefined | null, now: number): boolean {
  return typeof expiresAt === 'number' && now >= expiresAt - EXPIRY_WARNING_MS
}

export function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}
