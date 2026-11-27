// MyAnimeList's HTTP client (#702): every MAL request, REST and OAuth, goes
// through `request`, so through `fetchWithTimeout` (the offline refusal, the
// timeouts and the network observer) and through one limiter. MAL sits behind
// Akamai and sends no rate-limit headers, so the limiter spaces requests out
// and backs off on a transient answer: a 429, a 5xx, or a 403 whose body says
// "DoS detected". `index.ts` builds one client for the app, shared by the
// sign-in, the refresh, the provider and the card's Test.

import { fetchWithTimeout } from '../../lib/net'
import { scrubErrorBody, summarizeErrorBody } from '../../shikimori'
import { TrackerApiError } from '../errors'

/** The gap between two request starts. */
export const MAL_REQUEST_SPACING_MS = 1000
/** Retries of one request after a transient answer, as Shikimori's 429 loop. */
export const MAL_MAX_RETRIES = 3
export const MAL_BACKOFF_BASE_MS = 2000
export const MAL_BACKOFF_MAX_MS = 60_000
const ERROR_BODY_KEEP_CHARS = 2000

export type MalFormValue = string | number | boolean

export interface MalRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  url: string
  headers?: Record<string, string>
  /** Sent as `application/x-www-form-urlencoded`. */
  form?: Record<string, MalFormValue>
}

export interface MalResponse {
  status: number
  /** The parsed JSON body; null for an empty one (a 204). */
  body: unknown
}

export interface MalClient {
  /** Resolves a 2xx; throws `TrackerApiError` for any other status once retries are spent. */
  request(req: MalRequest): Promise<MalResponse>
}

export interface MalClientDeps {
  spacingMs?: number
  maxRetries?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** Throttling or an outage: worth waiting out, never the request's fault. */
function isTransient(status: number, body: string): boolean {
  if (status === 429) return true
  if (status >= 500 && status < 600) return true
  return status === 403 && body.includes('DoS detected')
}

/** MAL's REST errors say what's wrong in `message` ("Invalid client id"); OAuth's in `error`. */
function summaryOf(raw: string): string {
  try {
    const { message } = JSON.parse(raw) as { message?: unknown }
    if (typeof message === 'string' && message.trim()) return summarizeErrorBody(message)
  } catch {
    // Not JSON: an HTML page from Akamai, or nothing.
  }
  return summarizeErrorBody(raw)
}

export function formBody(form: Record<string, MalFormValue>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(form)) params.set(k, String(v))
  return params.toString()
}

export function createMalClient(deps: MalClientDeps = {}): MalClient {
  const spacingMs = deps.spacingMs ?? MAL_REQUEST_SPACING_MS
  const maxRetries = deps.maxRetries ?? MAL_MAX_RETRIES
  const base = deps.backoffBaseMs ?? MAL_BACKOFF_BASE_MS
  const cap = deps.backoffMaxMs ?? MAL_BACKOFF_MAX_MS
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now

  // The next moment a request may start: spacing after the last start, and
  // pushed further by a backoff, which every later request waits out too.
  let nextStart = 0
  // Requests take their start slot in call order.
  let slot: Promise<void> = Promise.resolve()

  function takeSlot(): Promise<void> {
    const mine = slot.then(async () => {
      const wait = nextStart - now()
      if (wait > 0) await sleep(wait)
      nextStart = now() + spacingMs
    })
    slot = mine.catch(() => {})
    return mine
  }

  async function once(req: MalRequest): Promise<Response> {
    await takeSlot()
    const headers: Record<string, string> = { Accept: 'application/json', ...req.headers }
    let body: string | undefined
    if (req.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = formBody(req.form)
    }
    return fetchWithTimeout(req.url, { method: req.method ?? 'GET', headers, body })
  }

  async function request(req: MalRequest): Promise<MalResponse> {
    for (let attempt = 0; ; attempt++) {
      const response = await once(req)
      if (response.ok) {
        const text = await response.text()
        return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null }
      }
      const raw = await response.text().catch(() => '')
      if (isTransient(response.status, raw)) {
        const delay = Math.min(base * 2 ** attempt, cap)
        nextStart = Math.max(nextStart, now() + delay)
        if (attempt < maxRetries) continue
      }
      const summary = summaryOf(raw)
      throw new TrackerApiError(
        summary
          ? `MyAnimeList API error: ${response.status} (${summary})`
          : `MyAnimeList API error: ${response.status}`,
        'mal',
        response.status,
        scrubErrorBody(raw).slice(0, ERROR_BODY_KEEP_CHARS)
      )
    }
  }

  return { request }
}
