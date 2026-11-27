// A fake MyAnimeList for #702's tests: a `globalThis.fetch` stand-in that
// routes the stub API and OAuth bases (`ANIME_DL_MAL_*`, applied through
// `applyApiBaseOverrides`) to replies, usually the fixtures under
// `test/fixtures/mal/`, and records every request with its decoded form body.
// Requests go through the real `fetchWithTimeout` and `client.ts`.

import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  MAL_API_BASE_ENV,
  MAL_OAUTH_BASE_ENV,
  applyApiBaseOverrides
} from '../../src/main/lib/api-bases'

export const MAL_TEST_API = 'http://mal.test/v2'
export const MAL_TEST_OAUTH = 'http://mal.test/v1/oauth2'

export function malFixtureText(name: string): string {
  return readFileSync(resolve(__dirname, '../fixtures/mal', name), 'utf8')
}

export function malFixture<T = unknown>(name: string): T {
  return JSON.parse(malFixtureText(name)) as T
}

export interface MalCall {
  method: string
  url: URL
  headers: Record<string, string>
  /** The decoded `x-www-form-urlencoded` body, null when none was sent. */
  form: Record<string, string> | null
  contentType: string | null
}

export interface MalReply {
  status?: number
  json?: unknown
  text?: string
}

type Handler = (call: MalCall) => MalReply | Promise<MalReply>

interface Route {
  method: string
  match: (url: URL) => boolean
  handler: Handler
}

export interface FakeMal {
  calls: MalCall[]
  /** Routes `method` + a pathname (exact string, or a RegExp) to a reply; later routes win. */
  on(method: string, path: string | RegExp, reply: MalReply | Handler): FakeMal
  /** Calls whose pathname matches. */
  callsTo(method: string, path: string | RegExp): MalCall[]
  restore(): void
}

/** Points the MAL bases at the stub and installs the fake fetch. */
export function installFakeMal(): FakeMal {
  applyApiBaseOverrides(
    { [MAL_API_BASE_ENV]: MAL_TEST_API, [MAL_OAUTH_BASE_ENV]: MAL_TEST_OAUTH },
    false
  )
  const realFetch = globalThis.fetch
  const calls: MalCall[] = []
  const routes: Route[] = []
  const matcher = (path: string | RegExp) => (url: URL) =>
    typeof path === 'string' ? url.pathname === path : path.test(url.pathname)

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v
      ])
    )
    const contentType = headers['content-type'] ?? null
    const body = typeof init.body === 'string' ? init.body : null
    const form =
      body !== null && contentType === 'application/x-www-form-urlencoded'
        ? Object.fromEntries(new URLSearchParams(body))
        : null
    const call: MalCall = { method: init.method ?? 'GET', url, headers, form, contentType }
    calls.push(call)
    const route = [...routes].reverse().find((r) => r.method === call.method && r.match(url))
    const reply = route ? await route.handler(call) : { status: 418, text: 'no route' }
    const status = reply.status ?? 200
    const text = reply.text ?? (reply.json !== undefined ? JSON.stringify(reply.json) : '')
    return new Response(status === 204 ? null : text, { status })
  }) as typeof fetch

  const fake: FakeMal = {
    calls,
    on(method, path, reply) {
      const handler: Handler = typeof reply === 'function' ? reply : () => reply
      routes.push({ method, match: matcher(path), handler })
      return fake
    },
    callsTo: (method, path) => calls.filter((c) => c.method === method && matcher(path)(c.url)),
    restore() {
      globalThis.fetch = realFetch
      applyApiBaseOverrides({}, false)
    }
  }
  return fake
}

/** The `/v2` pathname of an API path (`/anime/1` → `/v2/anime/1`). */
export const api = (path: string): string => `/v2${path}`
export const oauth = (path: string): string => `/v1/oauth2${path}`
