// AniList's host limiter (#703 § 3), under fake timers. Each request's `send`
// is a stub that records when it ran and answers with the status and headers
// a test gives it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createAniListLimiter,
  FALLBACK_429_BACKOFF_MS,
  MAX_429_RETRIES,
  MAX_WAIT_MS,
  type AniListPriority,
  type LimiterResponse
} from '../../src/main/trackers/anilist/limiter'
import { createAniListClient, deadTokenError } from '../../src/main/trackers/anilist/client'
import { createAniListIdMap } from '../../src/main/trackers/anilist/id-map'
import { classifyAnilistError } from '../../src/main/trackers/anilist/classify'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { createAniListServer } from '../helpers/anilist-server'

const T0 = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

type Answer = { status?: number; headers?: Record<string, string>; authRejected?: boolean }

function rig() {
  const limiter = createAniListLimiter({ deadTokenError })
  const sent: { name: string; at: number }[] = []
  const answers = new Map<string, Answer[]>()
  function req(
    name: string,
    priority: AniListPriority = 'interactive',
    opts: { token?: string; signal?: AbortSignal } = {}
  ) {
    const p = limiter.schedule({ priority, ...opts }, async () => {
      sent.push({ name, at: Date.now() - T0 })
      const a = answers.get(name)?.shift() ?? {}
      return {
        status: a.status ?? 200,
        headers: new Headers(a.headers ?? {}),
        authRejected: a.authRejected
      } satisfies LimiterResponse
    })
    p.catch(() => {})
    return p
  }
  const answer = (name: string, ...a: Answer[]) => answers.set(name, a)
  return { limiter, sent, req, answer, names: () => sent.map((s) => s.name) }
}

describe('the 429 pause', () => {
  it('a 429 with Retry-After: 5 waits 5 s and retries', async () => {
    const r = rig()
    r.answer('a', { status: 429, headers: { 'retry-after': '5' } }, { status: 200 })
    const p = r.req('a')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(r.sent.map((s) => s.at)).toEqual([0])
    await vi.advanceTimersByTimeAsync(1)
    expect(r.sent.map((s) => s.at)).toEqual([0, 5_000])
    expect((await p).status).toBe(200)
  })

  it('a 429 without Retry-After waits until X-RateLimit-Reset', async () => {
    const r = rig()
    const reset = String(Math.floor(T0 / 1000) + 12)
    r.answer('a', { status: 429, headers: { 'x-ratelimit-reset': reset } }, {})
    void r.req('a')
    await vi.advanceTimersByTimeAsync(11_999)
    expect(r.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.sent.map((s) => s.at)).toEqual([0, 12_000])
  })

  it('with neither header, a fixed backoff', async () => {
    const r = rig()
    r.answer('a', { status: 429 }, {})
    void r.req('a')
    await vi.advanceTimersByTimeAsync(FALLBACK_429_BACKOFF_MS)
    expect(r.sent.map((s) => s.at)).toEqual([0, FALLBACK_429_BACKOFF_MS])
  })

  it('is host-wide: with requests queued across classes, none is sent until the pause ends, and the rate-limited one goes first', async () => {
    const r = rig()
    r.answer('drain', { status: 429, headers: { 'retry-after': '20' } }, {})
    void r.req('drain', 'interactive')
    void r.req('page', 'reconcile')
    void r.req('details', 'prefetch')
    void r.req('edit', 'interactive')
    await vi.advanceTimersByTimeAsync(19_999)
    expect(r.names()).toEqual(['drain'])
    await vi.advanceTimersByTimeAsync(1)
    expect(r.sent[1]).toEqual({ name: 'drain', at: 20_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.names()).toEqual(['drain', 'drain', 'edit', 'page', 'details'])
  })

  it('clamps every wait: a reset hours ahead (a skewed clock) and a huge Retry-After hold for at most 60 s', async () => {
    const r = rig()
    const hours = String(Math.floor(T0 / 1000) + 5 * 3600)
    r.answer('a', { status: 429, headers: { 'x-ratelimit-reset': hours } }, {})
    r.answer('b', { status: 429, headers: { 'retry-after': '86400' } }, {})
    void r.req('a')
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS)
    expect(r.sent.map((s) => s.at)).toEqual([0, 60_000])
    void r.req('b')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(r.sent.at(-1)).toEqual({ name: 'b', at: 62_000 })
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS)
    expect(r.sent.at(-1)).toEqual({ name: 'b', at: 122_000 })
  })

  it('honours the retry cap: after 3 retries the 429 is the answer', async () => {
    const r = rig()
    const r429 = { status: 429, headers: { 'retry-after': '1' } }
    r.answer('a', r429, r429, r429, r429, {})
    const p = r.req('a')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.sent).toHaveLength(1 + MAX_429_RETRIES)
    expect((await p).status).toBe(429)
  })
})

describe('the window', () => {
  it('X-RateLimit-Remaining: 0 holds the whole queue until the reset', async () => {
    const r = rig()
    const reset = String(Math.floor(T0 / 1000) + 30)
    r.answer('a', { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } })
    void r.req('a')
    void r.req('b', 'reconcile')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(r.names()).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(1)
    expect(r.sent[1]).toEqual({ name: 'b', at: 30_000 })
  })

  it('starts at 30 a minute, then re-seeds from X-RateLimit-Limit: 90', async () => {
    const r = rig()
    expect(r.limiter.limit()).toBe(30)
    r.answer('a', { headers: { 'x-ratelimit-limit': '90' } })
    void r.req('a')
    void r.req('b')
    void r.req('c')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.limiter.limit()).toBe(90)
    // 60 s / 90 between sends once the limit is known.
    expect(r.sent.map((s) => s.at)).toEqual([0, 667, 1_334])
  })

  it('the burst spacing keeps a minimum gap of 60 s / limit', async () => {
    const r = rig()
    for (const n of ['a', 'b', 'c', 'd']) void r.req(n)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.sent.map((s) => s.at)).toEqual([0, 2_000, 4_000, 6_000])
  })
})

describe('a 403 is not a 429', () => {
  it('sent once, answered as it is, no pause: the next queued request goes at the normal gap', async () => {
    const r = rig()
    r.answer('down', { status: 403 })
    const p = r.req('down')
    void r.req('next', 'reconcile')
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await p).status).toBe(403)
    expect(r.sent).toEqual([
      { name: 'down', at: 0 },
      { name: 'next', at: 2_000 }
    ])
  })
})

describe('priority classes', () => {
  it('a drain request enqueued after prefetch and reconcile requests still runs first', async () => {
    const r = rig()
    void r.req('first')
    void r.req('details', 'prefetch')
    void r.req('page', 'reconcile')
    void r.req('drain', 'interactive')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.names()).toEqual(['first', 'drain', 'page', 'details'])
  })

  it('FIFO within a class', async () => {
    const r = rig()
    for (const n of ['p1', 'p2', 'p3']) void r.req(n, 'reconcile')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.names()).toEqual(['p1', 'p2', 'p3'])
  })
})

describe('id-map lookups take their caller’s class', () => {
  async function lookupRig() {
    const server = createAniListServer((call) =>
      call.operation === 'IdMap'
        ? {
            body: {
              data: {
                Page: {
                  media: (call.variables.ids as number[]).map((id) => ({
                    id: id + 1000,
                    idMal: id
                  }))
                }
              }
            },
            headers: { 'x-ratelimit-limit': '30' }
          }
        : { body: { data: {} }, headers: { 'x-ratelimit-limit': '30' } }
    )
    const limiter = createAniListLimiter({ deadTokenError })
    const client = createAniListClient({ limiter })
    const idMap = createAniListIdMap({ store: new InMemoryStorage() as never, client })
    return { server, limiter, client, idMap }
  }

  it('the drain’s lookup for an unmapped title runs at interactive, before queued reconcile pages', async () => {
    const { server, client, idMap } = await lookupRig()
    try {
      for (let i = 1; i <= 3; i++) {
        void client.request(`query Page${i} { x }`, {}, { priority: 'reconcile' }).catch(() => {})
      }
      const lookup = idMap.resolve([42], { priority: 'interactive' })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(await lookup).toEqual(new Map([[42, 1042]]))
      expect(server.calls.map((c) => c.operation)).toEqual(['Page1', 'IdMap', 'Page2', 'Page3'])
    } finally {
      server.restore()
    }
  })

  it('a warmup lookup runs at prefetch, after reconcile pages', async () => {
    const { server, client, idMap } = await lookupRig()
    try {
      void client.request('query Page1 { x }', {}, { priority: 'reconcile' }).catch(() => {})
      const warm = idMap.resolve([7], { priority: 'prefetch' })
      void client.request('query Page2 { x }', {}, { priority: 'reconcile' }).catch(() => {})
      await vi.advanceTimersByTimeAsync(20_000)
      await warm
      expect(server.calls.map((c) => c.operation)).toEqual(['Page1', 'Page2', 'IdMap'])
    } finally {
      server.restore()
    }
  })
})

describe('session expired empties the dead token’s work', () => {
  it('a 401 while N requests are queued causes 0 further fetches with that token; token-less ones still run', async () => {
    const r = rig()
    r.answer('drain', { status: 401, authRejected: true })
    const first = r.req('drain', 'interactive', { token: 'dead' })
    const queued = [
      r.req('edit', 'interactive', { token: 'dead' }),
      r.req('page', 'reconcile', { token: 'dead' }),
      r.req('details', 'prefetch', { token: 'dead' })
    ]
    void r.req('calendar', 'prefetch')
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await first).status).toBe(401)
    for (const q of queued) {
      const err = await q.catch((e) => e)
      expect(classifyAnilistError(err)).toBe('auth')
    }
    expect(r.names()).toEqual(['drain', 'calendar'])
    // A later request with the dead token is refused unsent too.
    const late = await r.req('late', 'interactive', { token: 'dead' }).catch((e) => e)
    expect(classifyAnilistError(late)).toBe('auth')
    expect(r.names()).toEqual(['drain', 'calendar'])
  })
})

describe('abort', () => {
  it('an aborted queued request never runs', async () => {
    const r = rig()
    const ctl = new AbortController()
    void r.req('a')
    const b = r.req('b', 'prefetch', { signal: ctl.signal })
    void r.req('c', 'prefetch')
    ctl.abort()
    expect((await b.catch((e) => e)).name).toBe('AbortError')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.names()).toEqual(['a', 'c'])
    expect(r.limiter.pending()).toBe(0)
  })

  it('an already-aborted signal rejects at once', async () => {
    const r = rig()
    const ctl = new AbortController()
    ctl.abort()
    await expect(r.req('a', 'prefetch', { signal: ctl.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(r.sent).toHaveLength(0)
  })
})
