// AniList's GraphQL transport (#703 § 2): one POST per query or mutation to
// `anilistOrigin()`, through the host limiter and `fetchWithTimeout`, so the
// offline refusal, the timeouts and the network observer apply. Every answer
// is checked for `errors`, a 200 included: any entry fails the call with an
// `AniListApiError` that carries the HTTP status and `errors[0].status`.
//
// The token never reaches a log line: an error carries only the scrubbed,
// truncated response body, and AniList's error bodies don't echo the request.

import { anilistOrigin } from '../../lib/api-bases'
import { fetchWithTimeout } from '../../lib/net'
import { hasUnauthorizedError, isInvalidTokenBody } from './classify'
import { AniListApiError } from './errors'
import {
  createAniListLimiter,
  type AniListLimiter,
  type AniListPriority,
  type LimiterResponse
} from './limiter'

/** The registered client ("anime-dl"). The implicit grant needs no secret, and none exists. */
export const ANILIST_CLIENT_ID = '57991'
export const ANILIST_AUTHORIZE_URL = `https://anilist.co/api/v2/oauth/authorize?client_id=${ANILIST_CLIENT_ID}&response_type=token`

const ERROR_BODY_MAX_CHARS = 500

/** A request's options: its priority class, its token (user calls only), its abort. */
export interface AniListRequestOptions {
  priority: AniListPriority
  token?: string | null
  signal?: AbortSignal
  /**
   * Whether a refusal of `token` reports `onTokenRejected` (the session-expiry
   * path). Off for the sign-in's `Viewer` check of a pasted token, which is no
   * stored session's.
   */
  reportRejection?: boolean
}

export interface AniListClient {
  request<T>(
    query: string,
    variables: Record<string, unknown>,
    opts: AniListRequestOptions
  ): Promise<T>
}

export interface AniListClientDeps {
  limiter?: AniListLimiter
  origin?: () => string
  /** A request's token was refused: `provider.ts`'s session expiry. */
  onTokenRejected?: (token: string) => void
}

interface SentResponse extends LimiterResponse {
  text: string
  parsed: { data?: unknown; errors?: unknown } | null
}

/** Redacts anything token-shaped, then caps the length. */
export function scrubAnilistBody(body: string): string {
  const scrubbed = body
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/("access_?token"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted]')
  return scrubbed.length <= ERROR_BODY_MAX_CHARS
    ? scrubbed
    : `${scrubbed.slice(0, ERROR_BODY_MAX_CHARS - 1)}…`
}

function parse(text: string): SentResponse['parsed'] {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' ? (value as SentResponse['parsed']) : null
  } catch {
    return null
  }
}

function firstError(parsed: SentResponse['parsed']): {
  message: string | null
  status: number | null
} {
  const errors = parsed?.errors
  const first = Array.isArray(errors)
    ? (errors[0] as { message?: unknown; status?: unknown })
    : null
  return {
    message: typeof first?.message === 'string' ? first.message : null,
    status: typeof first?.status === 'number' ? first.status : null
  }
}

/** The dead-token rejection: an unsent request that would only have earned another 401. */
export function deadTokenError(): AniListApiError {
  return new AniListApiError(
    'AniList rejected the token — sign in again in Settings → Trackers',
    401,
    '',
    401
  )
}

/** The host's one limiter: every AniList call, from any instance or capability, shares it. */
export const anilistLimiter: AniListLimiter = createAniListLimiter({ deadTokenError })

export function createAniListClient(deps: AniListClientDeps = {}): AniListClient {
  const limiter = deps.limiter ?? anilistLimiter
  const origin = deps.origin ?? anilistOrigin

  async function request<T>(
    query: string,
    variables: Record<string, unknown>,
    opts: AniListRequestOptions
  ): Promise<T> {
    const token = opts.token ?? null
    const res = await limiter.schedule<SentResponse>(
      { priority: opts.priority, token, signal: opts.signal },
      async (signal) => {
        const response = await fetchWithTimeout(origin(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ query, variables }),
          signal
        })
        const text = await response.text().catch(() => '')
        const parsed = parse(text)
        const authRejected =
          token !== null &&
          (response.status === 401 ||
            (parsed?.errors !== undefined &&
              (hasUnauthorizedError(text) || isInvalidTokenBody(text))))
        return { status: response.status, headers: response.headers, authRejected, text, parsed }
      }
    )
    const ok = res.status >= 200 && res.status < 300
    const hasErrors =
      Array.isArray(res.parsed?.errors) && (res.parsed!.errors as unknown[]).length > 0
    if (ok && !hasErrors && res.parsed) return res.parsed.data as T
    if (res.authRejected && token && opts.reportRejection !== false) deps.onTokenRejected?.(token)
    const { message, status } = firstError(res.parsed)
    throw new AniListApiError(
      `AniList API error: ${res.status}${message ? ` — ${message}` : ''}`,
      res.status,
      scrubAnilistBody(res.text),
      status
    )
  }

  return { request }
}
