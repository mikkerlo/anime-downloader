// Shikimori's error classifier (#689). It mirrors the 6.x drain's branches in
// their order, which the generic drain now applies through the class
// (`services/trackers/sync.ts:521-569`); the first matching row wins. It never
// returns `config`.

import * as shikimori from '../shikimori'
import { isNetworkError } from '../lib/errors'

export function classifyShikimoriError(err: unknown): TrackerErrorClass {
  // False for every `ShikiApiError`, even one whose `cause` carries a network code.
  if (isNetworkError(err)) return 'network'
  // A dead session, whatever its status: `ensureFreshToken` re-throws the
  // refresh's own status, and an `invalid_grant` expiry is a 400. The class is
  // discriminated by call site, never by status (its doc comment above
  // `src/main/shikimori.ts:89`), so it is checked ahead of the status rows.
  if (err instanceof shikimori.ShikiAuthError) return 'auth'
  if (err instanceof shikimori.ShikiApiError) {
    if (err.status === 401 || err.status === 403) return 'auth'
    if (err.status === 429) return 'rate-limit'
    if (err.status >= 500 && err.status < 600) return 'server'
  }
  return 'item'
}
