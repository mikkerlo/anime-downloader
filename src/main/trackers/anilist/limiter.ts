// AniList's host limiter (#703 § 3). AniList allows 30 requests a minute while
// degraded (90 documented) and has a separate burst limiter, so every AniList
// call goes through one module-level queue, whichever sync instance,
// capability or prefetch makes it. `docs/trackers.md` § AniList has the rules.
//
// - Three priority classes: `interactive` (user reads and writes, the drain,
//   `Viewer`, the list refresh) > `reconcile` (T10's paging) > `prefetch`
//   (details, id-map warmup). A queued lower-class request never runs while a
//   higher-class one waits; within a class, FIFO. An id-map lookup takes its
//   caller's class.
// - One request in flight at a time, spaced at least `60 s / limit` apart, the
//   limit seeded at 30 and re-seeded from `X-RateLimit-Limit`.
// - `X-RateLimit-Remaining: 0` and a 429 pause the whole host: a 429 for
//   `Retry-After`, else until `X-RateLimit-Reset`, else a fixed backoff; every
//   wait is clamped to 60 s. The rate-limited request goes back to the front of
//   its class, and is answered as it is after 3 retries.
// - A 403 (the API is down) is answered at once: no retry, no pause.
// - A request whose token was refused marks that token dead: every queued
//   request carrying it is rejected unsent, and so is any later one.
// - A queued request whose signal aborts leaves the queue.

export type AniListPriority = 'interactive' | 'reconcile' | 'prefetch'

export const ANILIST_PRIORITIES: readonly AniListPriority[] = [
  'interactive',
  'reconcile',
  'prefetch'
]

/** The limit until a response says otherwise (AniList's degraded 30/min). */
export const DEFAULT_RATE_LIMIT = 30
/** Every wait derived from a header is clamped here, like Shikimori's `MAX_RETRY_AFTER_S`. */
export const MAX_WAIT_MS = 60_000
/** Retries of a 429, as Shikimori's loop does. */
export const MAX_429_RETRIES = 3
/** A 429 with neither `Retry-After` nor `X-RateLimit-Reset`. */
export const FALLBACK_429_BACKOFF_MS = 10_000
const WINDOW_MS = 60_000

/** What the limiter reads from a sent request's answer. */
export interface LimiterResponse {
  status: number
  headers: { get(name: string): string | null }
  /** The request's token was refused (a 401, or an `Invalid token` error). */
  authRejected?: boolean
}

export interface ScheduleOptions {
  priority: AniListPriority
  /** The token the request carries, if any: a refusal rejects its queued siblings. */
  token?: string | null
  signal?: AbortSignal
}

export interface AniListLimiter {
  /**
   * Queues one request. `send` runs when the request's turn comes and must
   * read the whole answer; the limiter resolves with it (a 429 after the
   * retries and a 403 included) or rejects with what `send` threw.
   */
  schedule<R extends LimiterResponse>(
    opts: ScheduleOptions,
    send: (signal?: AbortSignal) => Promise<R>
  ): Promise<R>
  /** Marks `token` dead: its queued requests reject unsent, and so do later ones. */
  expireToken(token: string): void
  /** The current requests-per-minute limit. */
  limit(): number
  /** Queued requests, not counting the one in flight. */
  pending(): number
}

export interface AniListLimiterDeps {
  now?: () => number
  /** The error a request carrying a dead token rejects with (an `auth`-class error). */
  deadTokenError: () => Error
}

interface Task {
  opts: ScheduleOptions
  send: (signal?: AbortSignal) => Promise<LimiterResponse>
  resolve: (r: LimiterResponse) => void
  reject: (err: unknown) => void
  attempts: number
  onAbort: (() => void) | null
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

const clampWait = (ms: number): number =>
  Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_WAIT_MS) : MAX_WAIT_MS

function intHeader(headers: LimiterResponse['headers'], name: string): number | null {
  const raw = headers.get(name)
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function createAniListLimiter(deps: AniListLimiterDeps): AniListLimiter {
  const now = deps.now ?? Date.now
  const queues: Record<AniListPriority, Task[]> = { interactive: [], reconcile: [], prefetch: [] }
  const dead = new Set<string>()
  let rateLimit = DEFAULT_RATE_LIMIT
  let pausedUntil = 0
  let lastSentAt = Number.NEGATIVE_INFINITY
  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const gapMs = (): number => WINDOW_MS / rateLimit

  function detach(task: Task): void {
    if (task.onAbort) task.opts.signal?.removeEventListener('abort', task.onAbort)
    task.onAbort = null
  }

  function removeQueued(task: Task): boolean {
    const q = queues[task.opts.priority]
    const i = q.indexOf(task)
    if (i === -1) return false
    q.splice(i, 1)
    return true
  }

  function nextTask(): Task | undefined {
    for (const p of ANILIST_PRIORITIES) if (queues[p].length > 0) return queues[p][0]
    return undefined
  }

  function pauseFor(ms: number): void {
    pausedUntil = Math.max(pausedUntil, now() + clampWait(ms))
  }

  function observe(headers: LimiterResponse['headers']): void {
    const limit = intHeader(headers, 'x-ratelimit-limit')
    if (limit !== null && limit > 0) rateLimit = limit
    const remaining = intHeader(headers, 'x-ratelimit-remaining')
    if (remaining !== null && remaining <= 0) {
      const reset = intHeader(headers, 'x-ratelimit-reset')
      pauseFor(reset !== null ? reset * 1000 - now() : MAX_WAIT_MS)
    }
  }

  function retryWait(headers: LimiterResponse['headers']): number {
    const retryAfter = intHeader(headers, 'retry-after')
    if (retryAfter !== null && retryAfter >= 0) return retryAfter * 1000
    const reset = intHeader(headers, 'x-ratelimit-reset')
    if (reset !== null) return reset * 1000 - now()
    return FALLBACK_429_BACKOFF_MS
  }

  function expireToken(token: string): void {
    dead.add(token)
    for (const p of ANILIST_PRIORITIES) {
      const doomed = queues[p].filter((t) => t.opts.token === token)
      if (doomed.length === 0) continue
      queues[p] = queues[p].filter((t) => t.opts.token !== token)
      for (const t of doomed) {
        detach(t)
        t.reject(deps.deadTokenError())
      }
    }
  }

  function pump(): void {
    if (running || timer) return
    const task = nextTask()
    if (!task) return
    const wait = Math.max(pausedUntil - now(), lastSentAt + gapMs() - now(), 0)
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = null
        pump()
      }, wait)
      return
    }
    queues[task.opts.priority].shift()
    void run(task)
  }

  async function run(task: Task): Promise<void> {
    running = true
    lastSentAt = now()
    task.attempts += 1
    let res: LimiterResponse
    try {
      res = await task.send(task.opts.signal)
    } catch (err) {
      running = false
      detach(task)
      task.reject(err)
      pump()
      return
    }
    observe(res.headers)
    if (res.authRejected && task.opts.token) expireToken(task.opts.token)
    if (res.status === 429) {
      // The budget is the host's: every class waits, not just this request.
      pauseFor(retryWait(res.headers))
      if (task.attempts <= MAX_429_RETRIES && !task.opts.signal?.aborted) {
        queues[task.opts.priority].unshift(task)
        running = false
        pump()
        return
      }
    }
    running = false
    detach(task)
    task.resolve(res)
    pump()
  }

  function schedule<R extends LimiterResponse>(
    opts: ScheduleOptions,
    send: (signal?: AbortSignal) => Promise<R>
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(abortReason(opts.signal))
      if (opts.token && dead.has(opts.token)) return reject(deps.deadTokenError())
      const task: Task = {
        opts,
        send,
        resolve: resolve as (r: LimiterResponse) => void,
        reject,
        attempts: 0,
        onAbort: null
      }
      if (opts.signal) {
        const signal = opts.signal
        task.onAbort = () => {
          // Only a queued request leaves here; one in flight aborts its fetch.
          if (removeQueued(task)) {
            detach(task)
            reject(abortReason(signal))
          }
        }
        signal.addEventListener('abort', task.onAbort, { once: true })
      }
      queues[opts.priority].push(task)
      pump()
    })
  }

  return {
    schedule,
    expireToken,
    limit: () => rateLimit,
    pending: () => ANILIST_PRIORITIES.reduce((n, p) => n + queues[p].length, 0)
  }
}
