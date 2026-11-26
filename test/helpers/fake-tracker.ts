// An in-memory `TrackerProvider` (#689) with Shikimori, AniList and MyAnimeList
// personalities, so failure isolation can be tested before any real AniList or
// MAL client exists (T2b, T2c). It generalizes `fake-shikimori.ts`, which stays
// as it is: that one is a module-level `vi.mock` fake and imports nothing from
// `src/`. The Shikimori personality shares its row model (`vals`, `iso`, the
// `anime_rates` row shape).
//
// Each personality has its own server rows, its own session from `auth()`,
// error injection by class, and records every `upsertEntry` call with its
// session, and each has an `authFlow` (#695) driven through `signIn`. The
// AniList and MAL error replies encode the epic's documented
// behaviour only; #703 (T7) and #702 (T6) replace them with captured fixtures.

import { ShikiApiError, ShikiAuthError } from '../../src/main/shikimori'
import type { RateValues } from '../../src/main/lib/shikimori-rate'
import { TrackerApiError } from '../../src/main/trackers/errors'
import { classifyShikimoriError } from '../../src/main/trackers/shikimori.errors'
import { classifyAnilistError } from '../../src/main/trackers/anilist/classify'
import { classifyMalError } from '../../src/main/trackers/mal/classify'
import {
  anilistRawToStore,
  anilistStatusFromApp,
  appScoreFromAnilistRaw,
  appStatusFromAnilist,
  appStatusFromMal,
  malStatusFromApp,
  type AnilistStatus,
  type MalStatusPair
} from '../../src/main/trackers/scores'
import {
  TRACKER_CAPABILITIES,
  type TrackerAuthAttempt,
  type TrackerAuthFlow,
  type TrackerCapabilities,
  type TrackerEntry,
  type TrackerProvider,
  type TrackerRateEntry,
  type TrackerRateField,
  type TrackerRef
} from '../../src/main/trackers/types'
import { T0, iso } from './fake-shikimori'

export interface FakeSession {
  token: string
  userId: number
}

/** One user's entry on the fake server, in app values. */
export interface FakeRow {
  malId: number
  remoteId: number
  values: RateValues
  /** AniList only: the stored `scoreRaw` (POINT_100). */
  scoreRaw?: number
  updatedAt: number
}

export interface UpsertCall {
  session: FakeSession
  ref: TrackerRef
  values: RateValues
  changedFields: readonly TrackerRateField[]
}

/** The canned failures each personality can answer with. */
export const REPLIES = {
  shikimori: {
    network: () => new TypeError('fetch failed'),
    auth: () => new ShikiApiError('Shikimori API error: 401', 401),
    'auth-expired': () => new ShikiAuthError('Shikimori session expired', 400, 'invalid_grant'),
    'rate-limit': () => new ShikiApiError('Shikimori API error: 429', 429),
    server: () => new ShikiApiError('Shikimori API error: 503', 503),
    item: () => new ShikiApiError('Shikimori API error: 422', 422)
  },
  anilist: {
    network: () => new TypeError('fetch failed'),
    auth: () => anilistError(401, 'Invalid token'),
    /** A 200 that still carries `errors`: `errors[0].status` decides. */
    'auth-200': () => anilistError(200, 'Invalid token', 401),
    /** AniList answers 403 when the API is down. */
    'rate-limit': () => anilistError(403, 'The AniList API has been temporarily disabled'),
    'rate-limit-429': () => anilistError(429, 'Too Many Requests.'),
    server: () => anilistError(500, 'Internal Server Error'),
    item: () => anilistError(404, 'Not Found.')
  },
  mal: {
    network: () => new TypeError('fetch failed'),
    auth: () => malError(401, '{"error":"invalid_token","message":"token is invalid"}'),
    config: () => malError(400, '{"message":"Invalid client id","error":"invalid_request"}'),
    /** A missing or blocked client header. */
    'config-forbidden': () => malError(403, '{"message":"","error":"forbidden"}'),
    /** Akamai throttling: transient. */
    'rate-limit': () => malError(403, '<html><body>DoS detected</body></html>'),
    server: () => malError(500, '{"error":"internal_server_error"}'),
    item: () => malError(404, '{"message":"","error":"not_found"}')
  }
} as const satisfies Record<TrackerId, Record<string, () => unknown>>

export type ReplyName<P extends TrackerId> = keyof (typeof REPLIES)[P]

function anilistError(httpStatus: number, message: string, errorStatus = httpStatus) {
  const body = JSON.stringify({ errors: [{ message, status: errorStatus }], data: null })
  return new TrackerApiError(`AniList API error: ${httpStatus}`, 'anilist', httpStatus, body)
}

function malError(status: number, body: string) {
  return new TrackerApiError(`MAL API error: ${status}`, 'mal', status, body)
}

// ---- Native row shapes --------------------------------------------------------

/** Shikimori's `anime_rates` row, as `fake-shikimori.ts` builds it. */
export interface FakeShikiRow {
  id: number
  score: number
  status: string
  episodes: number
  rewatches: number
  updated_at: string
  target_type: 'Anime'
  anime: { id: number; name: string }
}

export interface FakeAnilistRow {
  id: number
  mediaId: number
  status: AnilistStatus
  /** POINT_100. */
  score: number
  progress: number
  repeat: number
  /** Seconds, as AniList sends it. */
  updatedAt: number
  media: { id: number; idMal: number; title: { romaji: string }; episodes: number | null }
}

export interface FakeMalRow {
  node: { id: number; title: string }
  list_status: MalStatusPair & {
    score: number
    num_episodes_watched: number
    num_times_rewatched: number
    updated_at: string
  }
}

export interface NativeOf {
  shikimori: FakeShikiRow
  anilist: FakeAnilistRow
  mal: FakeMalRow
}

/** AniList media ids for the MAL ids the fake knows. 9999 is the unmapped title. */
export const ANILIST_MEDIA_IDS: Record<number, number> = { 1: 101, 2: 102, 3: 103, 9001: 109001 }
export const UNMAPPED_MAL_ID = 9999

const CLASSIFIERS: Record<TrackerId, (err: unknown) => TrackerErrorClass> = {
  shikimori: classifyShikimoriError,
  anilist: classifyAnilistError,
  mal: classifyMalError
}

const NO_CAPABILITIES = Object.fromEntries(
  TRACKER_CAPABILITIES.map((c) => [c, false])
) as unknown as TrackerCapabilities

export interface FakeTracker<P extends TrackerId> {
  readonly id: P
  readonly provider: TrackerProvider<FakeSession, NativeOf[P], NativeOf[P]>
  /** The signed-in user's rows, by MAL id. */
  readonly rows: Map<number, FakeRow>
  readonly upserts: UpsertCall[]
  user: TrackerUser & { token: string }
  set(malId: number, values: Partial<RateValues>, opts?: { at?: number; scoreRaw?: number }): void
  /** The next `times` calls of `member` (any data member when omitted) answer with `reply`. */
  fail(reply: ReplyName<P>, opts?: { times?: number; member?: FakeMember }): void
  native(malId: number): NativeOf[P]
  reset(): void
  /** The sign-in flow's controls (#695). */
  readonly signIn: FakeSignIn
}

export type FakeMember = 'auth' | 'listEntries' | 'getEntry' | 'upsertEntry'

/** One `authFlow.exchange` call. */
export interface FakeExchangeCall {
  input: string
  attempt: TrackerAuthAttempt | null
}

/**
 * The fake `authFlow` (#695): Shikimori pastes a code, AniList a token, and
 * MAL the full redirect URL, with a loopback. Each input names the account it
 * signs in as (`accounts`, else `user`); `'bad'` is rejected as `auth` by the
 * user read, as a rejected AniList token is by `Viewer`.
 */
export interface FakeSignIn {
  readonly calls: FakeExchangeCall[]
  /** Input → the account it signs in as. Unlisted inputs sign in as `fake.user`. */
  readonly accounts: Map<string, TrackerUser>
  /** Awaited at each step: a test holds one to land a cancel or a logout there. */
  gate: ((step: 'exchange' | 'user') => Promise<void>) | null
  /** The exchange's next failure, by class name, once. */
  failNext: string | null
  /** MAL: whether the flow can start (no client ID saved means false). */
  ready: () => boolean
  /** MAL's loopback; null turns it off (a paste-only flow). */
  loopback: { port: number; path: string } | null
  /** The attempts `begin` made, in order. */
  readonly begun: TrackerAuthAttempt[]
}

/** The credentials an exchange returns for `input`. */
export function fakeCredentials(id: TrackerId, input: string): { access_token: string } {
  return { access_token: `${id}-token-for-${input}` }
}

export function createFakeTracker<P extends TrackerId>(id: P): FakeTracker<P> {
  const replies = REPLIES[id] as Record<string, () => unknown>
  const rows = new Map<number, FakeRow>()
  const upserts: UpsertCall[] = []
  let clock = T0 + 1_000_000
  let failures: { reply: string; times: number; member?: FakeMember }[] = []

  function maybeFail(member: FakeMember): void {
    const f = failures.find((x) => x.member === undefined || x.member === member)
    if (!f) return
    if (--f.times <= 0) failures = failures.filter((x) => x !== f)
    throw replies[f.reply]()
  }

  function mediaIdOf(malId: number): number {
    const mediaId = ANILIST_MEDIA_IDS[malId]
    if (mediaId === undefined) throw replies.item()
    return mediaId
  }

  function native(row: FakeRow): NativeOf[P] {
    const v = row.values
    if (id === 'anilist') {
      const mediaId = ANILIST_MEDIA_IDS[row.malId]
      const out: FakeAnilistRow = {
        id: row.remoteId,
        mediaId,
        status: anilistStatusFromApp(v.status),
        score: row.scoreRaw ?? v.score * 10,
        progress: v.episodes,
        repeat: v.rewatches,
        updatedAt: Math.floor(row.updatedAt / 1000),
        media: { id: mediaId, idMal: row.malId, title: { romaji: `#${row.malId}` }, episodes: 12 }
      }
      return out as NativeOf[P]
    }
    if (id === 'mal') {
      const out: FakeMalRow = {
        node: { id: row.malId, title: `#${row.malId}` },
        list_status: {
          ...malStatusFromApp(v.status),
          score: v.score,
          num_episodes_watched: v.episodes,
          num_times_rewatched: v.rewatches,
          updated_at: iso(row.updatedAt)
        }
      }
      return out as NativeOf[P]
    }
    const out: FakeShikiRow = {
      id: row.remoteId,
      score: v.score,
      status: v.status,
      episodes: v.episodes,
      rewatches: v.rewatches,
      updated_at: iso(row.updatedAt),
      target_type: 'Anime',
      anime: { id: row.malId, name: `#${row.malId}` }
    }
    return out as NativeOf[P]
  }

  /** The app values a native row reads as: AniList's raw score and MAL's status pair mapped back. */
  function valuesOf(row: FakeRow): RateValues {
    const n = native(row) as NativeOf[TrackerId]
    if (id === 'anilist') {
      const a = n as FakeAnilistRow
      return {
        episodes: a.progress,
        status: appStatusFromAnilist(a.status),
        score: appScoreFromAnilistRaw(a.score),
        rewatches: a.repeat
      }
    }
    if (id === 'mal') {
      const m = (n as FakeMalRow).list_status
      return {
        episodes: m.num_episodes_watched,
        status: appStatusFromMal(m),
        score: m.score,
        rewatches: m.num_times_rewatched
      }
    }
    return { ...row.values }
  }

  function entry(row: FakeRow): TrackerEntry<NativeOf[P]> {
    return {
      trackerId: id,
      malId: row.malId,
      remoteId: row.remoteId,
      values: valuesOf(row),
      native: native(row)
    }
  }

  function remoteIdFor(malId: number): number {
    if (id === 'anilist') return mediaIdOf(malId) * 10
    if (id === 'mal') return malId
    return malId * 10
  }

  const signIn: FakeSignIn = {
    calls: [],
    accounts: new Map(),
    gate: null,
    failNext: null,
    ready: () => true,
    loopback: id === 'mal' ? { port: 0, path: '/callback' } : null,
    begun: []
  }

  const AUTHORIZE: Record<TrackerId, string> = {
    shikimori: 'https://shikimori.one/oauth/authorize',
    anilist: 'https://anilist.co/api/v2/oauth/authorize',
    mal: 'https://myanimelist.net/v1/oauth2/authorize'
  }

  const authFlow: TrackerAuthFlow = {
    paste: id === 'mal' ? 'url' : id === 'anilist' ? 'token' : 'code',
    ...(id === 'mal' ? { needsSetup: () => !signIn.ready() } : {}),
    begin() {
      const n = signIn.begun.length + 1
      const attempt: TrackerAuthAttempt =
        id === 'mal'
          ? {
              authorizeUrl: `${AUTHORIZE[id]}?state=state-${n}`,
              state: `state-${n}`,
              verifier: `verifier-${n}`
            }
          : { authorizeUrl: `${AUTHORIZE[id]}?attempt=${n}` }
      signIn.begun.push(attempt)
      return attempt
    },
    ...(id === 'mal' ? { loopback: () => signIn.loopback } : {}),
    async exchange(input, attempt) {
      signIn.calls.push({ input, attempt })
      await signIn.gate?.('exchange')
      if (signIn.failNext) {
        const reply = signIn.failNext
        signIn.failNext = null
        throw replies[reply]()
      }
      await signIn.gate?.('user')
      if (input === 'bad') throw replies.auth()
      const account = signIn.accounts.get(input) ?? fake.user
      return {
        credentials: fakeCredentials(id, input),
        user: { id: account.id, nickname: account.nickname, avatar: account.avatar }
      }
    }
  }

  const fake: FakeTracker<P> = {
    id,
    rows,
    upserts,
    signIn,
    user: { id: 1, nickname: `${id}-user`, avatar: null, token: `fake-access-token-${id}` },
    set(malId, values, opts = {}) {
      const prev = rows.get(malId)
      const merged: RateValues = {
        episodes: 0,
        status: 'watching',
        score: 0,
        rewatches: 0,
        ...prev?.values,
        ...values
      }
      const row: FakeRow = {
        malId,
        remoteId: prev?.remoteId ?? remoteIdFor(malId),
        values: merged,
        updatedAt: opts.at ?? (clock += 1000)
      }
      if (id === 'anilist') {
        if (opts.scoreRaw !== undefined) row.scoreRaw = opts.scoreRaw
        else if (values.score !== undefined || !prev) row.scoreRaw = merged.score * 10
        else row.scoreRaw = prev.scoreRaw
      }
      rows.set(malId, row)
    },
    fail(reply, opts = {}) {
      if (!(String(reply) in replies)) throw new Error(`${id} has no reply ${String(reply)}`)
      failures.push({ reply: String(reply), times: opts.times ?? 1, member: opts.member })
    },
    native(malId) {
      const row = rows.get(malId)
      if (!row) throw new Error(`no row for ${malId}`)
      return native(row)
    },
    reset() {
      rows.clear()
      upserts.length = 0
      failures = []
      clock = T0 + 1_000_000
    },
    provider: {
      id,
      capabilities: NO_CAPABILITIES,
      authFlow,
      async auth() {
        maybeFail('auth')
        return { token: fake.user.token, userId: fake.user.id }
      },
      async getUser(token) {
        if (token !== fake.user.token) throw replies.auth()
        const { id: userId, nickname, avatar } = fake.user
        return { id: userId, nickname, avatar }
      },
      classifyError: CLASSIFIERS[id],
      async listEntries(_session, opts) {
        maybeFail('listEntries')
        const out: TrackerRateEntry<NativeOf[P]>[] = []
        for (const row of rows.values()) {
          const values = valuesOf(row)
          if (opts?.status && values.status !== opts.status) continue
          out.push({
            trackerId: id,
            malId: row.malId,
            remoteId: row.remoteId,
            values,
            updatedAt: row.updatedAt,
            anime: {
              title: `#${row.malId}`,
              poster: null,
              kind: 'tv',
              episodes: 12,
              episodesAired: 12,
              status: 'released'
            },
            smotretAnime: null,
            native: native(row)
          })
        }
        return out
      },
      async getEntry(_session, ref) {
        maybeFail('getEntry')
        if (id === 'anilist') mediaIdOf(ref.malId)
        const row = rows.get(ref.malId)
        return row ? entry(row) : null
      },
      async upsertEntry(session, ref, values, changedFields) {
        upserts.push({
          session: { ...session },
          ref: { ...ref },
          values: { ...values },
          changedFields
        })
        maybeFail('upsertEntry')
        if (id === 'anilist') mediaIdOf(ref.malId)
        const prev = rows.get(ref.malId)
        const scoreRaw =
          id === 'anilist'
            ? anilistRawToStore(values.score, prev?.scoreRaw ?? null, 'POINT_100')
            : undefined
        fake.set(ref.malId, values, scoreRaw !== undefined ? { scoreRaw } : {})
        return entry(rows.get(ref.malId)!)
      }
    }
  }
  return fake
}
