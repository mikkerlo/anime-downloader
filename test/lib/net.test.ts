import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import {
  DEFAULT_CONNECT_MS,
  DEFAULT_IDLE_MS,
  OfflineError,
  TimeoutError,
  fetchWithTimeout,
  setNetworkObserver,
  setOfflineCheck
} from '../../src/main/lib/net'
import { isNetworkError } from '../../src/main/lib/errors'

const URL_A = 'https://example.test/a'

/** A fetch that never answers and ignores its signal, like a black-holed SYN. */
function hungFetch(): Mock {
  return vi.fn(() => new Promise<Response>(() => {}))
}

function okFetch(): Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>> {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'))
}

/** A body that sends `first`, then stalls until `release()` is called. */
function stallingBody(first: string): {
  stream: ReadableStream<Uint8Array>
  push: (text: string) => void
  close: () => void
} {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
      c.enqueue(new TextEncoder().encode(first))
    }
  })
  return {
    stream,
    push: (text) => ctrl.enqueue(new TextEncoder().encode(text)),
    close: () => ctrl.close()
  }
}

function observerSpy(): { onFailure: Mock; onSuccess: Mock } {
  const spy = { onFailure: vi.fn(), onSuccess: vi.fn() }
  setNetworkObserver(spy)
  return spy
}

/** Settles `p` into a tagged result so a fake-timer test can poll it. */
function track<T>(p: Promise<T>): {
  state: () => 'pending' | 'resolved' | 'rejected'
  error: () => unknown
  value: () => T | undefined
} {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending'
  let error: unknown
  let value: T | undefined
  p.then(
    (v) => {
      state = 'resolved'
      value = v
    },
    (e) => {
      state = 'rejected'
      error = e
    }
  )
  return { state: () => state, error: () => error, value: () => value }
}

let realFetch: typeof globalThis.fetch

beforeEach(() => {
  realFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  setOfflineCheck(null)
  setNetworkObserver(null)
  vi.useRealTimers()
})

describe('fetchWithTimeout — connect/headers deadline', () => {
  it('rejects a hung fetch with TimeoutError at the default 15 s deadline, not before', async () => {
    vi.useFakeTimers()
    const fetchStub = hungFetch()
    globalThis.fetch = fetchStub
    const result = track(fetchWithTimeout(URL_A))

    await vi.advanceTimersByTimeAsync(DEFAULT_CONNECT_MS - 1)
    expect(result.state()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(result.state()).toBe('rejected')
    expect(result.error()).toBeInstanceOf(TimeoutError)
    expect((result.error() as Error).name).toBe('TimeoutError')
    expect(isNetworkError(result.error())).toBe(true)
    expect(DEFAULT_CONNECT_MS).toBe(15_000)
  })

  it('aborts the signal it handed to fetch when the deadline passes', async () => {
    vi.useFakeTimers()
    const fetchStub = hungFetch()
    globalThis.fetch = fetchStub
    const result = track(fetchWithTimeout(URL_A, { connectMs: 1000 }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(result.state()).toBe('rejected')
    const signal = (fetchStub.mock.calls[0][1] as RequestInit).signal as AbortSignal
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe(result.error())
  })

  it('clears the deadline once headers arrive', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn(async () => new Response('ok'))
    const res = await fetchWithTimeout(URL_A, { connectMs: 1000 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await res.text()).toBe('ok')
  })
})

describe('fetchWithTimeout — body idle deadline', () => {
  it('rejects a body that stops sending at the default 30 s idle deadline', async () => {
    vi.useFakeTimers()
    const body = stallingBody('head')
    globalThis.fetch = vi.fn(async () => new Response(body.stream))
    const res = await fetchWithTimeout(URL_A)
    const text = track(res.text())

    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_MS - 1)
    expect(text.state()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(text.state()).toBe('rejected')
    expect(text.error()).toBeInstanceOf(TimeoutError)
    expect(DEFAULT_IDLE_MS).toBe(30_000)
  })

  it('measures bytes stopped, not total time: a slow body that keeps sending completes', async () => {
    vi.useFakeTimers()
    const body = stallingBody('a')
    globalThis.fetch = vi.fn(async () => new Response(body.stream))
    const res = await fetchWithTimeout(URL_A, { idleMs: 1000 })
    const text = track(res.text())
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(900)
      body.push('a')
    }
    body.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(text.state()).toBe('resolved')
    expect(text.value()).toBe('a'.repeat(11))
  })

  it('never fires on a body nobody reads', async () => {
    vi.useFakeTimers()
    const spy = observerSpy()
    const silent = new ReadableStream<Uint8Array>()
    globalThis.fetch = vi.fn(async () => new Response(silent))
    const res = await fetchWithTimeout(URL_A, { idleMs: 1000 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spy.onFailure).not.toHaveBeenCalled()
    expect(res.bodyUsed).toBe(false)
    const text = track(res.text())
    await vi.advanceTimersByTimeAsync(1000)
    expect(text.error()).toBeInstanceOf(TimeoutError)
  })

  it('keeps status, headers and url on the wrapped response', async () => {
    const original = new Response('x', {
      status: 206,
      statusText: 'Partial Content',
      headers: { 'content-range': 'bytes 0-0/1' }
    })
    Object.defineProperty(original, 'url', { value: URL_A })
    globalThis.fetch = vi.fn(async () => original)
    const res = await fetchWithTimeout(URL_A)
    expect(res.status).toBe(206)
    expect(res.statusText).toBe('Partial Content')
    expect(res.headers.get('content-range')).toBe('bytes 0-0/1')
    expect(res.url).toBe(URL_A)
    expect(await res.text()).toBe('x')
  })

  it('returns a response without a stream body untouched', async () => {
    const plain = { ok: true, status: 200, body: null } as unknown as Response
    globalThis.fetch = vi.fn(async () => plain)
    expect(await fetchWithTimeout(URL_A)).toBe(plain)
  })
})

describe('fetchWithTimeout — caller abort', () => {
  it('rejects with AbortError when the caller aborts before headers', async () => {
    const spy = observerSpy()
    globalThis.fetch = hungFetch()
    const ac = new AbortController()
    const p = fetchWithTimeout(URL_A, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(spy.onFailure).not.toHaveBeenCalled()
  })

  it('rejects the body read with AbortError when the caller aborts mid-body', async () => {
    const spy = observerSpy()
    const body = stallingBody('head')
    globalThis.fetch = vi.fn(async () => new Response(body.stream))
    const ac = new AbortController()
    const res = await fetchWithTimeout(URL_A, { signal: ac.signal })
    const text = res.text()
    ac.abort()
    await expect(text).rejects.toMatchObject({ name: 'AbortError' })
    expect(spy.onFailure).not.toHaveBeenCalled()
  })

  it('forwards a signal that follows the caller’s, and only the RequestInit fields', async () => {
    const fetchStub = okFetch()
    globalThis.fetch = fetchStub
    const ac = new AbortController()
    await fetchWithTimeout(URL_A, {
      method: 'POST',
      headers: { 'X-A': '1' },
      redirect: 'follow',
      signal: ac.signal,
      connectMs: 5,
      idleMs: 5
    })
    const init = fetchStub.mock.calls[0][1] as Record<string, unknown>
    expect(init).toMatchObject({ method: 'POST', headers: { 'X-A': '1' }, redirect: 'follow' })
    expect(Object.keys(init).sort()).toEqual(['headers', 'method', 'redirect', 'signal'])
    const forwarded = init.signal as AbortSignal
    expect(forwarded.aborted).toBe(false)
    ac.abort()
    expect(forwarded.aborted).toBe(true)
  })
})

describe('fetchWithTimeout — offline refusal', () => {
  it('rejects with OfflineError and never calls fetch while the check says offline', async () => {
    const spy = observerSpy()
    const fetchStub = okFetch()
    globalThis.fetch = fetchStub
    setOfflineCheck(() => true)

    const err = await fetchWithTimeout(URL_A).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OfflineError)
    expect(err).toMatchObject({ name: 'OfflineError', code: 'ANIME_DL_OFFLINE' })
    expect(isNetworkError(err)).toBe(true)
    expect(fetchStub).not.toHaveBeenCalled()
    expect(spy.onFailure).not.toHaveBeenCalled()
    expect(spy.onSuccess).not.toHaveBeenCalled()
  })

  it('lets bypassOffline through', async () => {
    const fetchStub = okFetch()
    globalThis.fetch = fetchStub
    setOfflineCheck(() => true)
    const res = await fetchWithTimeout(URL_A, { bypassOffline: true })
    expect(await res.text()).toBe('ok')
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(Object.keys(fetchStub.mock.calls[0][1] as object)).not.toContain('bypassOffline')
  })

  it('defaults to online: with no check installed nothing is refused', async () => {
    const fetchStub = okFetch()
    globalThis.fetch = fetchStub
    setOfflineCheck(() => true)
    setOfflineCheck(null)
    await fetchWithTimeout(URL_A)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })
})

describe('fetchWithTimeout — network observer', () => {
  it('reports one failure per network error and a success per answered request', async () => {
    const spy = observerSpy()
    const boom = new TypeError('fetch failed')
    globalThis.fetch = vi.fn(async () => {
      throw boom
    })
    await expect(fetchWithTimeout(URL_A)).rejects.toBe(boom)
    await expect(fetchWithTimeout(URL_A)).rejects.toBe(boom)
    expect(spy.onFailure).toHaveBeenCalledTimes(2)
    expect(spy.onFailure).toHaveBeenNthCalledWith(1, boom, URL_A)

    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 }))
    await fetchWithTimeout(URL_A)
    expect(spy.onSuccess).toHaveBeenCalledTimes(1)
    expect(spy.onSuccess).toHaveBeenCalledWith(URL_A)
    expect(spy.onFailure).toHaveBeenCalledTimes(2)
  })

  it('reports a connect timeout once', async () => {
    vi.useFakeTimers()
    const spy = observerSpy()
    globalThis.fetch = hungFetch()
    const result = track(fetchWithTimeout(URL_A, { connectMs: 100 }))
    await vi.advanceTimersByTimeAsync(100)
    expect(result.state()).toBe('rejected')
    expect(spy.onFailure).toHaveBeenCalledTimes(1)
    expect(spy.onFailure.mock.calls[0][0]).toBeInstanceOf(TimeoutError)
  })

  it('reports a stalled body once, after the success for its headers', async () => {
    vi.useFakeTimers()
    const spy = observerSpy()
    const body = stallingBody('head')
    globalThis.fetch = vi.fn(async () => new Response(body.stream))
    const res = await fetchWithTimeout(URL_A, { idleMs: 100 })
    expect(spy.onSuccess).toHaveBeenCalledTimes(1)
    const text = track(res.text())
    await vi.advanceTimersByTimeAsync(1000)
    expect(text.state()).toBe('rejected')
    expect(spy.onFailure).toHaveBeenCalledTimes(1)
    expect(spy.onFailure.mock.calls[0][0]).toBeInstanceOf(TimeoutError)
  })

  it('reports a mid-body socket error once', async () => {
    const spy = observerSpy()
    const reset = Object.assign(new Error('other side closed'), { code: 'ECONNRESET' })
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'))
      },
      pull(c) {
        c.error(reset)
      }
    })
    globalThis.fetch = vi.fn(async () => new Response(stream))
    const res = await fetchWithTimeout(URL_A)
    await expect(res.text()).rejects.toBe(reset)
    expect(spy.onFailure).toHaveBeenCalledTimes(1)
    expect(spy.onFailure).toHaveBeenCalledWith(reset, URL_A)
  })
})
