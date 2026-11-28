// A fixture server for AniList's GraphQL endpoint (#703). It replaces
// `globalThis.fetch`, so the real client, limiter, `fetchWithTimeout` and
// provider run end to end, and records every request: its operation name, its
// variables and the token it carried. Two layers:
//
// - `createAniListServer(route)`: answers each request from `route`, which
//   returns a reply (a status, a body, headers) per call. The fixture-replay
//   tests use it with the JSON files under `test/fixtures/anilist/`.
// - `createAniListWorld(...)`: a stateful fake account on top of it: the id
//   map, the list, `MediaList`, `SaveMediaListEntry` (stored at the user's
//   score format's step) and `DeleteMediaListEntry`, with per-operation error
//   injection. The drain tests use it.
//
// Every reply carries `X-RateLimit-Limit: 60000` unless it sets its own, so
// the limiter's spacing is 1 ms and real-timer tests aren't paced at 2 s.
// A document that passes a nullable variable (or nothing) where the schema
// wants a non-null argument (`NON_NULL_ARGS`) gets live AniList's 400 (#712).

import * as fs from 'fs'
import * as path from 'path'
import { vi, type Mock } from 'vitest'
import { anilistQuantize, type AnilistScoreFormat } from '../../src/main/trackers/scores'
import { createAniListLimiter, type AniListLimiter } from '../../src/main/trackers/anilist/limiter'
import { deadTokenError } from '../../src/main/trackers/anilist/client'
import {
  createAniListProvider,
  type AniListProvider,
  type AniListProviderDeps,
  type AniListUser
} from '../../src/main/trackers/anilist/provider'
import {
  createCredentialVault,
  type CredentialVault
} from '../../src/main/trackers/credential-vault'
import { createFakeSafeStorage } from './fake-safe-storage'
import { InMemoryStorage } from './in-memory-storage'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'anilist')

/** A fixture body, parsed fresh on every call. */
export function anilistFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as T
}

export interface AniListCall {
  operation: string
  query: string
  variables: Record<string, unknown>
  token: string | null
}

export interface AniListReply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  /** Throw this from `fetch` instead of answering (a network failure). */
  throws?: unknown
}

export type AniListRoute = (call: AniListCall) => AniListReply | Promise<AniListReply>

export interface AniListServer {
  readonly calls: AniListCall[]
  /** The calls of one operation. */
  of(operation: string): AniListCall[]
  restore(): void
}

const OPERATION_RE = /^\s*(?:query|mutation)\s+(\w+)/

/**
 * The field arguments AniList's schema makes non-null, for the fields the app
 * queries (#712): `Page.following(userId: Int!)` and `Page.followers(userId:
 * Int!)`. Every other argument the app passes is nullable in the schema.
 */
export const NON_NULL_ARGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  following: { userId: 'Int!' },
  followers: { userId: 'Int!' }
}

/**
 * What live AniList answers a document with, before running it, when a
 * non-null argument is missing or bound to a nullable variable: the 400 and
 * its message, or null when the document is valid on that count.
 */
export function variableTypeError(query: string): string | null {
  const header = /^\s*(?:query|mutation)\s+\w+\s*\(([^)]*)\)/.exec(query)?.[1] ?? ''
  const declared = new Map<string, string>()
  for (const m of header.matchAll(/\$(\w+)\s*:\s*([[\]\w!]+)/g)) declared.set(m[1], m[2])
  for (const [field, args] of Object.entries(NON_NULL_ARGS)) {
    for (const use of query.matchAll(new RegExp(`\\b${field}\\s*(\\(([^)]*)\\))?`, 'g'))) {
      const passed = new Map<string, string>()
      for (const a of (use[2] ?? '').matchAll(/(\w+)\s*:\s*(\$?\w+)/g)) passed.set(a[1], a[2])
      for (const [arg, type] of Object.entries(args)) {
        const value = passed.get(arg)
        if (value === undefined) {
          return `Field "${field}" argument "${arg}" of type "${type}" is required but not provided.`
        }
        if (!value.startsWith('$')) continue
        const name = value.slice(1)
        const got = declared.get(name)
        if (got !== type) {
          return `Variable "$${name}" of type "${got}" used in position expecting type "${type}".`
        }
      }
    }
  }
  return null
}

export function createAniListServer(route: AniListRoute): AniListServer {
  const calls: AniListCall[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      query: string
      variables?: Record<string, unknown>
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null
    const call: AniListCall = {
      operation: OPERATION_RE.exec(body.query)?.[1] ?? '?',
      query: body.query,
      variables: body.variables ?? {},
      token: auth ? auth.replace(/^Bearer /, '') : null
    }
    calls.push(call)
    // As live AniList: a document that misuses a non-null argument is a 400
    // before any route sees it.
    const invalid = variableTypeError(call.query)
    const reply: AniListReply = invalid
      ? { status: 400, body: { data: null, errors: [{ message: invalid, status: 400 }] } }
      : await route(call)
    if (reply.throws !== undefined) throw reply.throws
    return new Response(JSON.stringify(reply.body ?? { data: null }), {
      status: reply.status ?? 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '60000',
        ...reply.headers
      }
    })
  }) as typeof fetch
  return {
    calls,
    of: (operation) => calls.filter((c) => c.operation === operation),
    restore: () => {
      globalThis.fetch = realFetch
    }
  }
}

/** One entry on the fake account, in AniList's own terms. */
export interface WorldEntry {
  id: number
  mediaId: number
  idMal: number | null
  status: string
  score: number
  progress: number
  repeat: number
  updatedAt: number
}

export interface AniListWorld {
  server: AniListServer
  /** Entries by media id. */
  entries: Map<number, WorldEntry>
  /** MAL id → media ids `Page.media(idMal_in)` knows. */
  media: Map<number, number[]>
  scoreFormat: AnilistScoreFormat
  /** Replies queued per operation, used before the world answers (error injection). */
  inject(operation: string, ...replies: AniListReply[]): void
  /** `SaveMediaListEntry` variables, in order. */
  saves(): Record<string, unknown>[]
}

const rateOf = (e: WorldEntry) => ({
  id: e.id,
  status: e.status,
  score: e.score,
  progress: e.progress,
  repeat: e.repeat,
  updatedAt: e.updatedAt
})

/** A media's calendar fields (#709): `Page.media(id_in)` answers it, keyed by AniList id. */
export interface WorldAiring {
  idMal?: number | null
  isAdult?: boolean
  format?: string
  title?: { romaji: string | null; english: string | null }
  nextAiringEpisode: { episode: number; airingAt: number } | null
}

export function createAniListWorld(
  opts: {
    entries?: WorldEntry[]
    media?: Record<number, number[]>
    scoreFormat?: AnilistScoreFormat
    /** The `Calendar` operation's media, by AniList id; an id not here is omitted. */
    airing?: Record<number, WorldAiring>
  } = {}
): AniListWorld {
  const entries = new Map<number, WorldEntry>()
  for (const e of opts.entries ?? []) entries.set(e.mediaId, { ...e })
  const media = new Map<number, number[]>()
  for (const e of opts.entries ?? []) if (e.idMal !== null) media.set(e.idMal, [e.mediaId])
  for (const [mal, ids] of Object.entries(opts.media ?? {})) media.set(Number(mal), ids)
  const injected = new Map<string, AniListReply[]>()
  let nextId = 20_000
  let clock = 1_764_100_000

  const world: AniListWorld = {
    server: null as unknown as AniListServer,
    entries,
    media,
    scoreFormat: opts.scoreFormat ?? 'POINT_100',
    inject(operation, ...replies) {
      injected.set(operation, [...(injected.get(operation) ?? []), ...replies])
    },
    saves: () => world.server.of('SaveMediaListEntry').map((c) => c.variables)
  }

  const malOf = (mediaId: number): number | null => {
    for (const [mal, ids] of media) if (ids.includes(mediaId)) return mal
    return null
  }

  world.server = createAniListServer((call) => {
    const queue = injected.get(call.operation)
    if (queue && queue.length > 0) return queue.shift()!
    const v = call.variables
    switch (call.operation) {
      case 'IdMap':
      case 'Airing':
      case 'Details': {
        const ids = (v.ids as number[]) ?? []
        const out = ids.flatMap((mal) =>
          (media.get(mal) ?? []).map((id) => ({
            id,
            idMal: mal,
            ...(call.operation === 'IdMap'
              ? {}
              : {
                  episodes: 12,
                  status: 'RELEASING',
                  nextAiringEpisode: { episode: 5 },
                  description: `About #${mal}`,
                  genres: ['Drama'],
                  format: 'TV'
                })
          }))
        )
        return { body: { data: { Page: { media: out.reverse() } } } }
      }
      case 'MediaList': {
        const e = entries.get(v.mediaId as number)
        if (!e) return { status: 404, body: anilistFixture('not-found-404') }
        return { body: { data: { MediaList: rateOf(e) } } }
      }
      case 'SaveMediaListEntry': {
        const mediaId = v.mediaId as number
        const e =
          entries.get(mediaId) ??
          ({
            id: nextId++,
            mediaId,
            idMal: malOf(mediaId),
            status: 'PLANNING',
            score: 0,
            progress: 0,
            repeat: 0,
            updatedAt: 0
          } as WorldEntry)
        if (v.status !== undefined) e.status = v.status as string
        if (v.progress !== undefined) e.progress = v.progress as number
        if (v.scoreRaw !== undefined)
          e.score = anilistQuantize(v.scoreRaw as number, world.scoreFormat)
        if (v.repeat !== undefined) e.repeat = v.repeat as number
        e.updatedAt = ++clock
        entries.set(mediaId, e)
        return { body: { data: { SaveMediaListEntry: rateOf(e) } } }
      }
      case 'DeleteMediaListEntry': {
        const found = [...entries.values()].find((e) => e.id === v.id)
        if (!found) return { status: 404, body: anilistFixture('not-found-404') }
        entries.delete(found.mediaId)
        return { body: anilistFixture('delete-media-list-entry') }
      }
      case 'MediaListCollection': {
        const list = [...entries.values()].map((e) => ({
          ...rateOf(e),
          mediaId: e.mediaId,
          media: {
            id: e.mediaId,
            idMal: e.idMal,
            title: { romaji: `#${e.idMal}`, english: null },
            coverImage: { large: `https://s4.anilist.co/cover/${e.mediaId}.jpg` },
            format: 'TV',
            episodes: 12,
            status: 'FINISHED',
            nextAiringEpisode: null
          }
        }))
        return {
          body: {
            data: {
              MediaListCollection: {
                hasNextChunk: false,
                lists: [{ isCustomList: false, entries: list }]
              }
            }
          }
        }
      }
      case 'Calendar': {
        // Out of order, as AniList answers; one row per media, matched on `id`.
        const ids = (v.ids as number[]) ?? []
        const out = ids.flatMap((id) => {
          const a = opts.airing?.[id]
          if (!a) return []
          const idMal = a.idMal === undefined ? malOf(id) : a.idMal
          return [
            {
              id,
              idMal,
              isAdult: a.isAdult ?? false,
              format: a.format ?? 'TV',
              title: a.title ?? { romaji: `#${idMal}`, english: null },
              coverImage: { large: `https://s4.anilist.co/cover/${id}.jpg` },
              nextAiringEpisode: a.nextAiringEpisode
            }
          ]
        })
        return { body: { data: { Page: { media: out.reverse() } } } }
      }
      case 'Viewer':
        return { body: anilistFixture('viewer') }
      default:
        return {
          status: 400,
          body: { errors: [{ message: `unrouted ${call.operation}`, status: 400 }] }
        }
    }
  })
  return world
}

export const ALICE: AniListUser = {
  id: 5001,
  nickname: 'alice',
  avatar: null,
  scoreFormat: 'POINT_100',
  displayAdultContent: false,
  tokenExpiresAt: null
}

export interface TestAniList {
  store: InMemoryStorage
  vault: CredentialVault
  limiter: AniListLimiter
  provider: AniListProvider
  onSessionExpired: Mock
}

/**
 * The real provider on a fresh limiter (not the module-level one), a real
 * vault over a fake safeStorage, and a store with every default. `user` and
 * `token` sign the account in: the token is written through the vault.
 */
export async function createTestAniList(
  opts: {
    user?: AniListUser | null
    token?: string | null
    seed?: Record<string, unknown>
    provider?: Partial<AniListProviderDeps>
  } = {}
): Promise<TestAniList> {
  const store = new InMemoryStorage({
    ...(structuredClone(STORE_DEFAULTS) as Record<string, unknown>),
    installId: 'pc',
    ...opts.seed
  })
  const safe = createFakeSafeStorage({ async: false })
  const vault = createCredentialVault({ store, safeStorage: safe.holder, warn: () => {} })
  const user = opts.user === undefined ? ALICE : opts.user
  if (user) store.set('anilistUser', user)
  const token = opts.token === undefined ? 'tok-alice' : opts.token
  if (token) await vault.write('anilistCredentials', { accessToken: token, expiresAt: null })
  const limiter = createAniListLimiter({ deadTokenError })
  const onSessionExpired = vi.fn()
  const provider = createAniListProvider({
    store: store as never,
    vault,
    limiter,
    onSessionExpired,
    log: { log: () => {}, warn: () => {} },
    ...opts.provider
  })
  return { store, vault, limiter, provider, onSessionExpired }
}
