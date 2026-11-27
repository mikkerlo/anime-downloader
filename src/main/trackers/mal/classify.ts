// MyAnimeList's error classifier (#689), extended by #702 (T6). The table is
// `docs/trackers.md` § The classifiers; the first matching row wins.

import { isNetworkError } from '../../lib/errors'
import { TrackerApiError } from '../errors'
import { MalConfigError, MalSessionChangedError, MalSessionGoneError } from './errors'

export function classifyMalError(err: unknown): TrackerErrorClass {
  // Not the account's failure: the drain retries on its next tick.
  if (err instanceof MalSessionChangedError) return 'network'
  if (isNetworkError(err)) return 'network'
  if (err instanceof MalSessionGoneError) return 'auth'
  if (err instanceof MalConfigError) return 'config'
  if (!(err instanceof TrackerApiError)) return 'item'
  const { status, body } = err
  // The app's client id is wrong or revoked: no request can succeed until the
  // user fixes the setup.
  if (body.includes('invalid_client')) return 'config'
  // A dead refresh token, or a reused code on the exchange. Only the refresh
  // turns it into "Session expired" (`auth.ts`); the exchange's is an attempt error.
  if (body.includes('invalid_grant')) return 'auth'
  if (status === 400 && body.includes('Invalid client id')) return 'config'
  if (status === 403) {
    // Akamai throttling is transient. Any other 403 (`forbidden`, a missing or
    // blocked client header, or a body we don't recognise) is a setup problem.
    return body.includes('DoS detected') ? 'rate-limit' : 'config'
  }
  // MAL sends no rate-limit headers, but a 429 is still transient (#702).
  if (status === 429) return 'rate-limit'
  // `invalid_token`, after the client's one refresh-and-retry.
  if (status === 401) return 'auth'
  if (status >= 500 && status < 600) return 'server'
  return 'item'
}
