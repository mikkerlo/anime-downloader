// AniList's error classifier (#689), from the epic's auth table. #703 (T7)
// extends it in place against captured fixtures.
//
// AniList's GraphQL endpoint can answer 200 and still carry `errors`, so the
// body is always checked and `errors[0].status` decides when it is there.

import { isNetworkError } from '../../lib/errors'
import { TrackerApiError } from '../errors'

const ERRORS_STATUS_RE = /"errors"\s*:\s*\[\s*\{[^\]]*?"status"\s*:\s*(\d{3})/

/** `errors[0].status` of a GraphQL error body, or null. Tolerates a truncated body. */
export function graphqlErrorStatus(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { errors?: { status?: unknown }[] }
    const status = parsed?.errors?.[0]?.status
    return typeof status === 'number' ? status : null
  } catch {
    const m = ERRORS_STATUS_RE.exec(body)
    return m ? Number(m[1]) : null
  }
}

export function classifyAnilistError(err: unknown): TrackerErrorClass {
  if (isNetworkError(err)) return 'network'
  if (!(err instanceof TrackerApiError)) return 'item'
  const status = graphqlErrorStatus(err.body) ?? err.status
  if (err.status === 401 || status === 401) return 'auth'
  // AniList answers 403 when the API is down: every request fails, so the
  // drain aborts and keeps the queue instead of dropping it after 24 h.
  if (status === 403 || status === 429) return 'rate-limit'
  if (status >= 500 && status < 600) return 'server'
  return 'item'
}
