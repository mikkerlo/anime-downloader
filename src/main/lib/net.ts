// The only way the main process reaches the network over HTTP (#567). A guard
// test (`test/net-adoption-guard.test.ts`) fails on any bare `fetch` elsewhere
// in `src/main`.
//
// Two deadlines: `connectMs` until the response headers arrive, and `idleMs`
// with no body bytes while the consumer is waiting for some. The idle timer is
// armed per read, so it measures a stalled transfer, not total time, and never
// fires on a body nobody reads. Both reject with `TimeoutError`.
//
// No imports from `errors.ts` or the offline service: `errors.ts` imports
// `shikimori.ts`, which imports this file. The service plugs in through
// `setOfflineCheck` and `setNetworkObserver`; until it does, nothing is
// refused and nothing is reported.

export const DEFAULT_CONNECT_MS = 15_000
export const DEFAULT_IDLE_MS = 30_000

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

export const OFFLINE_ERROR_CODE = 'ANIME_DL_OFFLINE'

export class OfflineError extends Error {
  readonly code = OFFLINE_ERROR_CODE
  constructor(message = 'Offline: network access is turned off') {
    super(message)
    this.name = 'OfflineError'
  }
}

export interface NetworkObserver {
  onFailure(err: unknown, url: string): void
  onSuccess(url: string): void
}

export interface FetchWithTimeoutInit extends RequestInit {
  connectMs?: number
  idleMs?: number
  /** Reserved for the offline probe; the guard test rejects it anywhere else. */
  bypassOffline?: boolean
}

let offlineCheck: () => boolean = () => false
let observer: NetworkObserver | null = null

export function setOfflineCheck(check: (() => boolean) | null): void {
  offlineCheck = check ?? (() => false)
}

export function setNetworkObserver(next: NetworkObserver | null): void {
  observer = next
}

function urlOf(input: string | URL): string {
  return typeof input === 'string' ? input : input.href
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

function rejectOnAbort(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort = (): void => {}
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(abortReason(signal))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  promise.catch(() => {})
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) }
}

export async function fetchWithTimeout(
  input: string | URL,
  init: FetchWithTimeoutInit = {}
): Promise<Response> {
  const {
    connectMs = DEFAULT_CONNECT_MS,
    idleMs = DEFAULT_IDLE_MS,
    bypassOffline = false,
    signal: callerSignal,
    ...rest
  } = init
  if (!bypassOffline && offlineCheck()) throw new OfflineError()

  const url = urlOf(input)
  const internal = new AbortController()
  const signal = callerSignal ? AbortSignal.any([callerSignal, internal.signal]) : internal.signal
  const callerAborted = (): boolean => Boolean(callerSignal?.aborted)
  const fail = (err: unknown): unknown => {
    if (!callerAborted()) observer?.onFailure(err, url)
    return err
  }

  const connectTimer = setTimeout(
    () => internal.abort(new TimeoutError(`No response within ${connectMs} ms: ${url}`)),
    connectMs
  )
  const aborted = rejectOnAbort(signal)

  let response: Response
  try {
    const request = globalThis.fetch(input, { ...rest, signal })
    request.catch(() => {})
    response = await Promise.race([request, aborted.promise])
  } catch (err) {
    throw fail(err)
  } finally {
    clearTimeout(connectTimer)
    aborted.dispose()
  }
  observer?.onSuccess(url)

  if (!(response.body instanceof ReadableStream)) return response
  return withIdleTimeout(response, response.body, idleMs, url, internal, signal, fail)
}

function withIdleTimeout(
  response: Response,
  source: ReadableStream<Uint8Array>,
  idleMs: number,
  url: string,
  internal: AbortController,
  signal: AbortSignal,
  fail: (err: unknown) => unknown
): Response {
  const reader = source.getReader()
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const idleTimer = setTimeout(
          () => internal.abort(new TimeoutError(`No data for ${idleMs} ms: ${url}`)),
          idleMs
        )
        const aborted = rejectOnAbort(signal)
        try {
          const read = reader.read()
          read.catch(() => {})
          const { done, value } = await Promise.race([read, aborted.promise])
          if (done) controller.close()
          else controller.enqueue(value)
        } catch (err) {
          fail(err)
          reader.cancel(err).catch(() => {})
          throw err
        } finally {
          clearTimeout(idleTimer)
          aborted.dispose()
        }
      },
      cancel(reason) {
        return reader.cancel(reason)
      }
    },
    { highWaterMark: 0 }
  )
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
  Object.defineProperty(wrapped, 'url', { value: response.url })
  Object.defineProperty(wrapped, 'redirected', { value: response.redirected })
  return wrapped
}
