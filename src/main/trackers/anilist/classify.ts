// AniList's error classifier (#689), extended by #703 (T7) to the slice's § 7
// table. `docs/trackers.md` § The classifiers has the rows.
//
// AniList's GraphQL endpoint can answer 200 and still carry `errors`, so the
// body is always checked and `errors[0].status` decides when it is there. An
// `Invalid token` message is `auth` whatever its status: a revoked token
// answers HTTP 400 with `errors[0] = {status: 400, message: "Invalid token"}`
// (observed 2026-11-27, #734), so a status-only read would drop every queued
// entry one at a time. The truncated-paste shape is still unverified.

import { isNetworkError } from '../../lib/errors'
import { TrackerApiError } from '../errors'

const ERRORS_STATUS_RE = /"errors"\s*:\s*\[\s*\{[^\]]*?"status"\s*:\s*(\d{3})/
const INVALID_TOKEN_RE = /invalid token/i

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

/** Every `errors[].message` of a GraphQL error body; a truncated body yields its raw text. */
function graphqlErrorMessages(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { errors?: { message?: unknown }[] }
    const errors = Array.isArray(parsed?.errors) ? parsed.errors : []
    return errors.map((e) => (typeof e?.message === 'string' ? e.message : ''))
  } catch {
    return [body]
  }
}

/** Whether a GraphQL error body says the token was refused: an `Invalid token` message. */
export function isInvalidTokenBody(body: string): boolean {
  return graphqlErrorMessages(body).some((m) => INVALID_TOKEN_RE.test(m))
}

/** Whether any `errors[].status` of a GraphQL error body is 401. */
export function hasUnauthorizedError(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { errors?: { status?: unknown }[] }
    return (Array.isArray(parsed?.errors) ? parsed.errors : []).some((e) => e?.status === 401)
  } catch {
    return graphqlErrorStatus(body) === 401
  }
}

export function classifyAnilistError(err: unknown): TrackerErrorClass {
  if (isNetworkError(err)) return 'network'
  if (!(err instanceof TrackerApiError)) return 'item'
  const status = graphqlErrorStatus(err.body) ?? err.status
  if (err.status === 401 || status === 401 || hasUnauthorizedError(err.body)) return 'auth'
  if (isInvalidTokenBody(err.body)) return 'auth'
  // AniList answers 403 when the API is down: every request fails, so the
  // drain aborts and keeps the queue instead of dropping it after 24 h.
  if (status === 403 || status === 429) return 'rate-limit'
  if (status >= 500 && status < 600) return 'server'
  return 'item'
}
