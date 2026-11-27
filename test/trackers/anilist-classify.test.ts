// AniList's classification table (#689), extended by #703 (T7) to the § 7
// table against the fixtures under `test/fixtures/anilist/`, with the session
// expiry and the sign-in's rejection copy.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { TrackerApiError } from '../../src/main/trackers/errors'
import { classifyAnilistError, graphqlErrorStatus } from '../../src/main/trackers/anilist/classify'
import { AniListSessionError, AniListUnmappedError } from '../../src/main/trackers/anilist/errors'
import { OfflineError } from '../../src/main/lib/net'
import { TOKEN_NOT_ACCEPTED } from '../../src/main/trackers/anilist/provider'
import { createTrackerLifecycle } from '../../src/main/trackers/lifecycle'
import { createTrackerAuthSessions } from '../../src/main/trackers/auth-session'
import {
  ALICE,
  anilistFixture,
  createAniListServer,
  createAniListWorld,
  createTestAniList,
  type AniListServer
} from '../helpers/anilist-server'

const api = (status: number, body = ''): TrackerApiError =>
  new TrackerApiError(`AniList API error: ${status}`, 'anilist', status, body)

const table = (rows: [string, () => unknown, TrackerErrorClass][]) =>
  rows.map(([name, make, cls]) => ({ name, make, cls }))

const gql = (status: number, message = 'x'): string =>
  JSON.stringify({ data: null, errors: [{ message, status }] })

describe('classifyAnilistError', () => {
  it.each(
    table([
      ['a bare TypeError', () => new TypeError('fetch failed'), 'network'],
      ['an ECONNRESET', () => ({ code: 'ECONNRESET' }), 'network'],
      ['HTTP 401', () => api(401, gql(401, 'Invalid token')), 'auth'],
      ['a 200 whose errors[0].status is 401', () => api(200, gql(401, 'Invalid token')), 'auth'],
      [
        'HTTP 403 (the API is down)',
        () => api(403, gql(403, 'temporarily disabled')),
        'rate-limit'
      ],
      ['HTTP 403 with no body', () => api(403), 'rate-limit'],
      ['HTTP 429', () => api(429, gql(429, 'Too Many Requests')), 'rate-limit'],
      ['HTTP 500', () => api(500, gql(500, 'Internal Server Error')), 'server'],
      ['HTTP 502 with no body', () => api(502), 'server'],
      ['a 200 whose errors[0].status is 500', () => api(200, gql(500)), 'server'],
      ['HTTP 400', () => api(400, gql(400, 'Validation')), 'item'],
      ['HTTP 404', () => api(404, gql(404, 'Not Found.')), 'item'],
      ['a 200 whose errors[0].status is 404', () => api(200, gql(404, 'Not Found.')), 'item'],
      [
        'a 200 whose errors carry no status',
        () => api(200, '{"errors":[{"message":"x"}]}'),
        'item'
      ],
      ['a plain Error', () => new Error('logic bug'), 'item']
    ])
  )('$name → $cls', ({ make, cls }) => {
    expect(classifyAnilistError(make())).toBe(cls)
  })

  it('a 403 is rate-limit, not server or auth', () => {
    const cls = classifyAnilistError(api(403))
    expect(cls).toBe('rate-limit')
    expect(cls).not.toBe('server')
    expect(cls).not.toBe('auth')
  })

  it('a TrackerApiError with a network code in its cause is classified by status', () => {
    const err = new TrackerApiError('x', 'anilist', 500, '', { cause: { code: 'ECONNRESET' } })
    expect(classifyAnilistError(err)).toBe('server')
  })
})

describe('graphqlErrorStatus', () => {
  it('reads errors[0].status, and survives a truncated body', () => {
    expect(graphqlErrorStatus(gql(401))).toBe(401)
    expect(graphqlErrorStatus(gql(401).slice(0, -3))).toBe(401)
    expect(graphqlErrorStatus('{"data":{}}')).toBeNull()
    expect(graphqlErrorStatus('')).toBeNull()
    expect(graphqlErrorStatus('<html>')).toBeNull()
  })
})

// ---- #703 (T7): the § 7 table, one row per line ---------------------------

const body = (name: string): string => JSON.stringify(anilistFixture(name))

describe('the § 7 table (#703)', () => {
  it.each(
    table([
      ['fetch threw', () => new TypeError('fetch failed'), 'network'],
      ['a timeout', () => Object.assign(new Error('t'), { name: 'TimeoutError' }), 'network'],
      ['OfflineError', () => new OfflineError(), 'network'],
      ['HTTP 401 (expired / missing token)', () => api(401, body('invalid-token-401')), 'auth'],
      ['an Invalid token error with status 400', () => api(400, body('invalid-token-400')), 'auth'],
      ['an Invalid token error on a 200', () => api(200, body('invalid-token-400')), 'auth'],
      [
        'any errors[].status 401, not the first',
        () =>
          api(
            200,
            JSON.stringify({
              errors: [
                { message: 'x', status: 400 },
                { message: 'y', status: 401 }
              ]
            })
          ),
        'auth'
      ],
      [
        'an Invalid token message in a truncated body',
        () => api(400, body('invalid-token-400').slice(0, 40)),
        'auth'
      ],
      ['the session-gone error from auth()', () => new AniListSessionError(), 'auth'],
      ['HTTP 429 after the retries', () => api(429), 'rate-limit'],
      ['HTTP 403, the API down', () => api(403, body('api-down-403')), 'rate-limit'],
      ['HTTP 500', () => api(500), 'server'],
      ['HTTP 503 on a 200 errors', () => api(200, gql(503)), 'server'],
      ['a 400 validation error', () => api(400, body('validation-400')), 'item'],
      ['a 404 on a write', () => api(404, body('not-found-404')), 'item'],
      ['a successful lookup that omitted the title', () => new AniListUnmappedError(9), 'item']
    ])
  )('$name → $cls', ({ make, cls }) => {
    expect(classifyAnilistError(make())).toBe(cls)
  })

  it('an Invalid token error with errors[].status 400 is auth, not item', () => {
    const err = api(400, body('invalid-token-400'))
    expect(graphqlErrorStatus(err.body)).toBe(400)
    expect(classifyAnilistError(err)).toBe('auth')
    expect(classifyAnilistError(err)).not.toBe('item')
  })

  it('403 is rate-limit, not server or auth', () => {
    expect(classifyAnilistError(api(403, body('api-down-403')))).toBe('rate-limit')
  })
})

describe('a 401 sets session-expired (#703 § 1)', () => {
  let server: AniListServer | null = null
  afterEach(() => {
    server?.restore()
    server = null
  })

  async function expiryRig() {
    const world = createAniListWorld({
      entries: [
        {
          id: 9001,
          mediaId: 101,
          idMal: 1,
          status: 'CURRENT',
          score: 85,
          progress: 7,
          repeat: 0,
          updatedAt: 1
        }
      ]
    })
    server = world.server
    world.inject('MediaList', { status: 401, body: anilistFixture('invalid-token-401') })
    const queue = [
      {
        malId: 1,
        rateId: 9001,
        before: { episodes: 7, status: 'watching', score: 9, rewatches: 0 },
        after: { episodes: 8, status: 'watching', score: 9, rewatches: 0 },
        queuedAt: 1
      }
    ]
    const t = await createTestAniList({ seed: { anilistUpdateQueue: queue } })
    const broadcast = vi.fn()
    const lifecycle = createTrackerLifecycle({
      store: t.store as never,
      vault: t.vault,
      trackerRates: { instance: () => null, refreshInBackground: () => {} },
      broadcast,
      accountsChangedChannel: 'tracker:accounts-changed'
    })
    // What `index.ts` wires: the status broadcast, then the accounts seam.
    const seen: unknown[] = []
    t.onSessionExpired.mockImplementation(() => {
      seen.push({
        expired: t.store.get('anilistSessionExpired'),
        credentials: t.store.get('anilistCredentials')
      })
      lifecycle.notifyAccountsChanged()
    })
    return { t, broadcast, lifecycle, queue, seen }
  }

  it('sets anilistSessionExpired, clears the credential, keeps the user and the queue, then notifies once', async () => {
    const { t, broadcast, lifecycle, queue, seen } = await expiryRig()
    const session = await t.provider.auth()
    const err = await t.provider.getEntry(session, { malId: 1, remoteId: 9001 }).catch((e) => e)
    expect(classifyAnilistError(err)).toBe('auth')
    await vi.waitFor(() => expect(t.onSessionExpired).toHaveBeenCalledTimes(1))
    expect(t.store.get('anilistSessionExpired')).toBe(true)
    expect(t.store.get('anilistCredentials')).toBeNull()
    expect(t.store.get('anilistUser')).toEqual(ALICE)
    expect(t.store.get('anilistUpdateQueue')).toEqual(queue)
    // Called after the writes.
    expect(seen).toEqual([{ expired: true, credentials: null }])
    expect(broadcast).toHaveBeenCalledTimes(1)
    const [channel, payload] = broadcast.mock.calls[0]
    expect(channel).toBe('tracker:accounts-changed')
    expect(payload).toEqual(lifecycle.accountsState())
    const anilist = (payload as TrackerAccountsState).accounts.find(
      (a) => a.trackerId === 'anilist'
    )
    expect(anilist).toMatchObject({ hasCredentials: false, sessionExpired: true, user: ALICE })
  })

  it('a refused token that is not the stored one (a pasted token, another account) clears nothing', async () => {
    const { t } = await expiryRig()
    await t.provider.expireSession('some-other-token')
    expect(t.store.get('anilistSessionExpired')).toBe(false)
    expect(t.store.get('anilistCredentials')).not.toBeNull()
    expect(t.onSessionExpired).not.toHaveBeenCalled()
  })
})

describe('COMPLETE_AUTH copy (#703 § 1)', () => {
  let server: AniListServer | null = null
  afterEach(() => {
    server?.restore()
    server = null
  })

  async function complete(reply: Parameters<typeof createAniListServer>[0]) {
    server = createAniListServer(reply)
    const t = await createTestAniList({ user: null, token: null })
    const auth = createTrackerAuthSessions({
      lifecycle: {
        completeLogin: async (_id, load) => ({ status: 'connected', user: (await load()).user }),
        account: () => ({}) as TrackerAccount
      },
      providers: { anilist: t.provider },
      isOffline: () => false,
      openExternal: async () => {},
      log: { warn: () => {} }
    })
    const result = await auth.complete('anilist', '  pasted-token  ')
    return { result, t }
  }

  it.each([
    ['a 401', { status: 401, body: anilistFixture('invalid-token-401') }],
    ['an Invalid token 400', { status: 400, body: anilistFixture('invalid-token-400') }],
    ['another 400', { status: 400, body: anilistFixture('validation-400') }],
    ['a 200 with no Viewer', { status: 200, body: { data: { Viewer: null } } }]
  ])('%s: "That token wasn’t accepted"', async (_name, reply) => {
    const { result } = await complete(() => reply)
    expect(result).toEqual({ status: 'error', kind: 'auth', message: TOKEN_NOT_ACCEPTED })
    expect(server!.calls[0].token).toBe('pasted-token')
  })

  it.each([
    ['a network failure', { throws: new TypeError('fetch failed') }, 'network'],
    ['a 403 (the API down)', { status: 403, body: anilistFixture('api-down-403') }, 'rate-limit'],
    ['a 500', { status: 500, body: {} }, 'server']
  ] as const)('%s is transient, not a rejection', async (_name, reply, kind) => {
    const { result } = await complete(() => reply)
    expect(result).toMatchObject({ status: 'error', kind })
    expect((result as { message: string }).message).not.toBe(TOKEN_NOT_ACCEPTED)
  })

  it('a rejected paste never reaches the session-expiry path', async () => {
    const { t } = await complete(() => ({ status: 401, body: anilistFixture('invalid-token-401') }))
    expect(t.onSessionExpired).not.toHaveBeenCalled()
  })
})
