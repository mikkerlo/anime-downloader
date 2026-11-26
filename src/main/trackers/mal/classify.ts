// MyAnimeList's error classifier (#689), from #702 (T6), which extends it in
// place against captured fixtures.

import { isNetworkError } from '../../lib/errors'
import { TrackerApiError } from '../errors'

export function classifyMalError(err: unknown): TrackerErrorClass {
  if (isNetworkError(err)) return 'network'
  if (!(err instanceof TrackerApiError)) return 'item'
  const { status, body } = err
  // The app's client id is wrong or revoked: no request can succeed until the
  // user fixes the setup.
  if (body.includes('invalid_client')) return 'config'
  if (status === 400 && body.includes('Invalid client id')) return 'config'
  if (status === 403) {
    // Akamai throttling is transient. Any other 403 (`forbidden`, a missing or
    // blocked client header, or a body we don't recognise) is a setup problem.
    return body.includes('DoS detected') ? 'rate-limit' : 'config'
  }
  // `invalid_token`, after T6's refresh retry.
  if (status === 401) return 'auth'
  if (status >= 500 && status < 600) return 'server'
  return 'item'
}
