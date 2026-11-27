// MyAnimeList sign-in and tokens (#702): MAL's auth flow inside the real
// attempt state machine (`auth-session.ts`), the real lifecycle and vault, and
// real loopback listeners (port 0 through `ANIME_DL_MAL_LOOPBACK_PORT`, or a
// fixed port where the test is about rebinding one); MAL itself is
// `fake-mal.ts`. Then the four refresh rules, the session and the logout race.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as http from 'http'
import * as net from 'net'
import type { AddressInfo } from 'net'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { createFakeSafeStorage } from '../helpers/fake-safe-storage'
import {
  api,
  installFakeMal,
  malFixture,
  malFixtureText,
  oauth,
  type FakeMal
} from '../helpers/fake-mal'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'
import { createCredentialVault } from '../../src/main/trackers/credential-vault'
import { createTrackerLifecycle } from '../../src/main/trackers/lifecycle'
import { createTrackerAuthSessions } from '../../src/main/trackers/auth-session'
import { createMalClient } from '../../src/main/trackers/mal/client'
import {
  MAL_LOOPBACK_PORT,
  createMalAuth,
  malLoopbackPort,
  type MalCredentials
} from '../../src/main/trackers/mal/auth'
import { createMalProvider, type MalSession } from '../../src/main/trackers/mal/provider'
import { classifyMalError } from '../../src/main/trackers/mal/classify'

// `users-me.json`'s account.
const A = {
  id: 1234567,
  nickname: 'fake_mal_user',
  avatar: 'https://cdn.myanimelist.net/images/userimages/1234567.jpg'
}
const B = { id: 7654321, nickname: 'other_user', avatar: null }
const CLIENT_ID = 'cid-123'
const T0 = Date.now()
/** Past the half-life of a token obtained at `T0` (2415600 s / 2). */
const LATE = T0 + 2_000_000_000

let fake: FakeMal
const live: http.Server[] = []
const sockets: net.Socket[] = []

beforeEach(() => {
  fake = installFakeMal()
})

afterEach(() => {
  fake.restore()
  for (const s of sockets.splice(0)) s.destroy()
  for (const s of live.splice(0)) {
    s.closeAllConnections()
    s.close()
  }
})

const creds = (token: string, extra: Partial<MalCredentials> = {}): MalCredentials => ({
  access_token: `fake-access-token-${token}`,
  refresh_token: `fake-refresh-token-${token}`,
  expires_in: 2415600,
  // Fresh unless a test moves the clock past half-life.
  obtainedAt: T0,
  ...extra
})

/** A server whose `listen` on `host` fails with `code`. */
function failingOn(host: string, code: string) {
  return (listener: http.RequestListener): http.Server => {
    const s = http.createServer(listener)
    const listen = s.listen.bind(s) as (...args: unknown[]) => http.Server
    s.listen = ((...args: unknown[]) => {
      if (args[1] === host) {
        process.nextTick(() => s.emit('error', Object.assign(new Error(code), { code })))
        return s
      }
      return listen(...args)
    }) as typeof s.listen
    live.push(s)
    return s
  }
}

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

function rig(
  opts: {
    port?: number
    createServer?: (l: http.RequestListener) => http.Server
    timeoutMs?: number
    user?: TrackerUser | null
    now?: () => number
  } = {}
) {
  const store = new InMemoryStorage({
    ...(structuredClone(STORE_DEFAULTS) as Record<string, unknown>),
    myanimelistClientConfig: { clientId: CLIENT_ID },
    myanimelistUser: opts.user ?? null
  })
  const safe = createFakeSafeStorage({ async: true })
  const vault = createCredentialVault({ store, safeStorage: safe.holder, warn: () => {} })
  const client = createMalClient({ spacingMs: 0, sleep: async () => {} })
  const servers: http.Server[] = []
  const createServer =
    opts.createServer ??
    ((listener: http.RequestListener) => {
      const s = http.createServer(listener)
      live.push(s)
      return s
    })
  const listeningAtOpen: boolean[] = []
  const openExternal = vi.fn(async (_url: string) => {
    listeningAtOpen.push(servers.length > 0 && servers.every((s) => s.listening))
  })
  const lifecycle = createTrackerLifecycle({
    store,
    vault,
    trackerRates: { instance: () => null, refreshInBackground: () => {} },
    cancelAttempt: (id) => sessions.cancel(id)
  })
  const notify = vi.spyOn(lifecycle, 'notifyAccountsChanged')
  const generation = (): number => lifecycle.generation('mal')
  const auth = createMalAuth({
    store,
    vault,
    client,
    generation,
    port: opts.port ?? malLoopbackPort({ ANIME_DL_MAL_LOOPBACK_PORT: '0' }, false),
    timeoutMs: opts.timeoutMs,
    now: opts.now,
    onSessionExpired: () => lifecycle.notifyAccountsChanged()
  })
  const provider = createMalProvider({ store, client, auth, generation })
  const sessions = createTrackerAuthSessions({
    lifecycle,
    providers: { mal: provider },
    isOffline: () => false,
    openExternal,
    createServer: (listener) => {
      const s = createServer(listener)
      servers.push(s)
      return s
    },
    log: { warn: () => {} }
  })
  const seed = async (c: MalCredentials): Promise<void> =>
    vault.commit('myanimelistCredentials', await vault.encrypt(c))
  const stored = async (): Promise<MalCredentials | null> => {
    const r = await vault.read<MalCredentials>('myanimelistCredentials')
    return r.state === 'ok' ? r.value : null
  }
  const port = (): number => (servers[0].address() as AddressInfo).port
  const lastUrl = (): URL => new URL(openExternal.mock.calls.at(-1)![0])
  return {
    store,
    safe,
    vault,
    client,
    servers,
    openExternal,
    listeningAtOpen,
    lifecycle,
    notify,
    auth,
    provider,
    sessions,
    seed,
    stored,
    port,
    lastUrl
  }
}

type Rig = ReturnType<typeof rig>

function hit(
  port: number,
  query: string,
  opts: { host?: string; path?: string; method?: string; agent?: http.Agent | false } = {}
): Promise<{ status: number; connection: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: opts.host ?? '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: `${opts.path ?? '/callback'}?${query}`,
        agent: opts.agent ?? false
      },
      (res) => {
        res.resume()
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, connection: res.headers.connection })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

function serveSignIn(): void {
  fake.on('POST', oauth('/token'), { json: malFixture('token.json') })
  fake.on('GET', api('/users/@me'), { json: malFixture('users-me.json') })
}

async function begun(r: Rig): Promise<{ result: Promise<TrackerAuthResult>; state: string }> {
  const result = r.sessions.begin('mal')
  await vi.waitFor(() => expect(r.openExternal).toHaveBeenCalled())
  return { result, state: r.lastUrl().searchParams.get('state')! }
}

const allClosed = (r: Rig) => () => expect(r.servers.every((s) => !s.listening)).toBe(true)

describe('the fixed loopback port', () => {
  // Every user registers http://localhost:<this port>/callback in their own MAL
  // app, and MAL matches redirect_uri exactly: a new value silently breaks every
  // existing registration. Never change it.
  it('is pinned', () => {
    expect(MAL_LOOPBACK_PORT).toBe(41753)
  })

  it('the override applies only unpackaged', () => {
    expect(malLoopbackPort({ ANIME_DL_MAL_LOOPBACK_PORT: '0' }, false)).toBe(0)
    expect(malLoopbackPort({ ANIME_DL_MAL_LOOPBACK_PORT: '0' }, true)).toBe(MAL_LOOPBACK_PORT)
    expect(malLoopbackPort({}, false)).toBe(MAL_LOOPBACK_PORT)
  })
})

describe('the PKCE / loopback handshake', () => {
  it('binds before opening the browser; the challenge is the 128-character verifier, plain', async () => {
    serveSignIn()
    const r = rig()
    const { result } = await begun(r)
    expect(r.listeningAtOpen).toEqual([true])
    const url = r.lastUrl()
    expect(url.origin + url.pathname).toBe('http://mal.test/v1/oauth2/authorize')
    const q = url.searchParams
    expect(q.get('response_type')).toBe('code')
    expect(q.get('client_id')).toBe(CLIENT_ID)
    expect(q.get('code_challenge_method')).toBe('plain')
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9\-._~]{128}$/)
    // The redirect carries the port the loopback got.
    expect(q.get('redirect_uri')).toBe(`http://localhost:${r.port()}/callback`)
    expect(q.get('state')).toBeTruthy()
    r.sessions.cancel('mal')
    expect(await result).toEqual({ status: 'cancelled' })
  })

  it('a callback with the held state connects, and the exchange carries that verifier', async () => {
    serveSignIn()
    const r = rig()
    const { result, state } = await begun(r)
    const verifier = r.lastUrl().searchParams.get('code_challenge')
    const port = r.port()
    expect(await hit(port, `code=the-code&state=${state}`)).toMatchObject({ status: 200 })
    expect(await result).toMatchObject({ status: 'connected', account: { user: A } })
    const form = fake.callsTo('POST', oauth('/token'))[0].form!
    expect(form).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: verifier,
      redirect_uri: `http://localhost:${port}/callback`
    })
    expect(await r.stored()).toMatchObject({ access_token: 'fake-access-token-mal-1' })
    await vi.waitFor(allClosed(r))
  })

  it('a wrong state is refused, another path or method is a 404, and the attempt keeps waiting', async () => {
    serveSignIn()
    const r = rig()
    const { result, state } = await begun(r)
    expect((await hit(r.port(), 'code=c&state=wrong')).status).toBe(400)
    expect((await hit(r.port(), `code=c&state=${state}`, { path: '/other' })).status).toBe(404)
    expect((await hit(r.port(), `code=c&state=${state}`, { method: 'POST' })).status).toBe(404)
    expect(r.sessions.phase('mal')).toBe('waiting')
    expect(fake.callsTo('POST', oauth('/token'))).toHaveLength(0)
    r.sessions.cancel('mal')
    await result
  })

  it('both listeners close on cancel', async () => {
    const r = rig()
    const { result } = await begun(r)
    r.sessions.cancel('mal')
    await result
    await vi.waitFor(allClosed(r))
  })

  it('both listeners close on a timeout, and BEGIN says so', async () => {
    const r = rig({ timeoutMs: 50 })
    const { result } = await begun(r)
    expect(await result).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/timed out/)
    })
    await vi.waitFor(allClosed(r))
    expect(r.sessions.phase('mal')).toBeNull()
  })

  it('a duplicate callback while exchanging gets the static page and runs no second exchange', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    fake.on('POST', oauth('/token'), async () => {
      await held
      return { json: malFixture('token.json') }
    })
    fake.on('GET', api('/users/@me'), { json: malFixture('users-me.json') })
    const r = rig()
    const { result, state } = await begun(r)
    expect((await hit(r.port(), `code=c&state=${state}`)).status).toBe(200)
    await vi.waitFor(() => expect(r.sessions.phase('mal')).toBe('exchanging'))
    expect((await hit(r.port(), `code=c&state=${state}`)).status).toBe(200)
    release()
    expect((await result).status).toBe('connected')
    expect(fake.callsTo('POST', oauth('/token'))).toHaveLength(1)
  })

  it('an exchange answered invalid_grant is an attempt error: no "Session expired", credentials untouched', async () => {
    fake.on('POST', oauth('/token'), {
      status: 400,
      text: malFixtureText('error-invalid-grant.json')
    })
    const r = rig({ user: A })
    await r.seed(creds('a'))
    const before = JSON.stringify(r.store.get('myanimelistCredentials'))
    const { result, state } = await begun(r)
    await hit(r.port(), `code=reused&state=${state}`)
    expect(await result).toMatchObject({ status: 'error', kind: 'auth' })
    expect(r.store.get('myanimelistSessionExpired')).toBe(false)
    expect(JSON.stringify(r.store.get('myanimelistCredentials'))).toBe(before)
    expect(r.store.get('myanimelistUser')).toEqual(A)
  })

  it('EADDRINUSE on ::1 is port-busy and never opens the browser', async () => {
    const r = rig({ createServer: failingOn('::1', 'EADDRINUSE') })
    const result = await r.sessions.begin('mal')
    expect(result).toMatchObject({ status: 'port-busy', authorizeUrl: expect.any(String) })
    expect(r.openExternal).not.toHaveBeenCalled()
    await vi.waitFor(allClosed(r))
  })

  it.each(['EADDRNOTAVAIL', 'EAFNOSUPPORT'])(
    '%s on ::1 continues on 127.0.0.1 alone',
    async (code) => {
      const r = rig({ createServer: failingOn('::1', code) })
      const { result } = await begun(r)
      expect(r.listeningAtOpen).toEqual([false]) // the ::1 server never listened
      expect(r.servers[0].listening).toBe(true)
      r.sessions.cancel('mal')
      await result
    }
  )

  // On Linux the port frees on `close()` even with a kept-alive socket open,
  // so the rebind alone can't tell; the header and the socket close are what
  // each half of the fix guarantees (mutation: drop either and its line reds).
  it('rebinding the fixed port after a keep-alive callback: Connection: close, the sockets closed, no port-busy', async () => {
    serveSignIn()
    const fixed = await freePort()
    const r = rig({ port: fixed })
    const { result } = await begun(r)
    const agent = new http.Agent({ keepAlive: true })
    const reply = await hit(fixed, 'code=c&state=wrong', { agent })
    expect(reply.connection).toBe('close')
    // An idle connection that never sent a request.
    const idle = net.connect(fixed, '127.0.0.1')
    sockets.push(idle)
    idle.on('error', () => {})
    await new Promise<void>((resolve) => idle.once('connect', () => resolve()))
    const idleClosed = new Promise<boolean>((resolve) => {
      idle.once('close', () => resolve(true))
      setTimeout(() => resolve(false), 1000)
    })
    r.sessions.cancel('mal')
    await result
    expect(await idleClosed).toBe(true)
    const again = r.sessions.begin('mal')
    await vi.waitFor(() => expect(r.openExternal).toHaveBeenCalledTimes(2))
    expect(new URL(r.openExternal.mock.calls[1][0]).searchParams.get('redirect_uri')).toBe(
      `http://localhost:${fixed}/callback`
    )
    r.sessions.cancel('mal')
    expect(await again).toEqual({ status: 'cancelled' })
    agent.destroy()
  })
})

describe('the paste fallback', () => {
  it('with no server bound (port-busy), the full redirect URL completes', async () => {
    serveSignIn()
    const r = rig({ createServer: failingOn('127.0.0.1', 'EADDRINUSE') })
    const busy = await r.sessions.begin('mal')
    expect(busy.status).toBe('port-busy')
    const state = new URL((busy as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')
    const result = await r.sessions.complete(
      'mal',
      `http://localhost:41753/callback?code=pasted&state=${state}`
    )
    expect(result).toMatchObject({ status: 'connected', account: { user: A } })
    expect(fake.callsTo('POST', oauth('/token'))[0].form!.code).toBe('pasted')
  })

  it('a bare code, or a URL with a wrong state, is refused and the attempt stays held', async () => {
    const r = rig({ createServer: failingOn('127.0.0.1', 'EADDRINUSE') })
    await r.sessions.begin('mal')
    expect(await r.sessions.complete('mal', 'just-a-code')).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/full address/)
    })
    expect(
      await r.sessions.complete('mal', 'http://localhost:41753/callback?code=c&state=nope')
    ).toMatchObject({ status: 'error' })
    expect(r.sessions.phase('mal')).toBe('waiting')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('the session', () => {
  it('auth() reads myanimelistUser before its first await', async () => {
    const r = rig({ user: A })
    await r.seed(creds('a'))
    const realRead = r.vault.read.bind(r.vault)
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    vi.spyOn(r.vault, 'read').mockImplementation(async (key) => {
      await gate
      return realRead(key)
    })
    const pending = r.provider.auth()
    r.store.set('myanimelistUser', B)
    release()
    expect((await pending).userId).toBe(A.id)
  })

  it('with no user it rejects with Not logged in to MyAnimeList', async () => {
    const r = rig({ user: null })
    await expect(r.provider.auth()).rejects.toThrow('Not logged in to MyAnimeList')
  })

  it('the pinned session: after a switch to B, A’s calls still send A’s token, and a 401 does not retry with B’s', async () => {
    fake.on('GET', api('/anime/5114'), { json: malFixture('anime-entry.json') })
    fake.on('PATCH', api('/anime/5114/my_list_status'), { json: malFixture('my-list-status.json') })
    const r = rig({ user: A })
    await r.seed(creds('a'))
    const sessionA = await r.provider.auth()
    await r.lifecycle.completeLogin('mal', async () => ({ credentials: creds('b'), user: B }))
    expect(r.store.get('myanimelistUser')).toEqual(B)

    await r.provider.getEntry(sessionA, { malId: 5114, remoteId: 5114 })
    await r.provider.upsertEntry(
      sessionA,
      { malId: 5114, remoteId: 5114 },
      { episodes: 1, status: 'watching', score: 0, rewatches: 0 },
      ['episodes']
    )
    expect(fake.calls.map((c) => c.headers.authorization)).toEqual([
      'Bearer fake-access-token-a',
      'Bearer fake-access-token-a'
    ])

    // Mutation: retry without the generation check and this sends B's token.
    fake.on('GET', api('/anime/5114'), (call) =>
      call.headers.authorization === 'Bearer fake-access-token-a'
        ? { status: 401, json: malFixture('error-invalid-token.json') }
        : { json: malFixture('anime-entry.json') }
    )
    const err = await r.provider
      .getEntry(sessionA, { malId: 5114, remoteId: 5114 })
      .catch((e: unknown) => e)
    expect(classifyMalError(err)).toBe('auth')
    expect(fake.calls.at(-1)!.headers.authorization).toBe('Bearer fake-access-token-a')
    expect(fake.callsTo('POST', oauth('/token'))).toHaveLength(0)
  })
})

describe('refresh rule 1: a 401 retries once', () => {
  function serve401UnlessB(): void {
    fake.on('GET', /\/v2\/anime\/\d+$/, (call) =>
      call.headers.authorization === 'Bearer fake-access-token-mal-2'
        ? { json: malFixture('anime-entry.json') }
        : { status: 401, json: malFixture('error-invalid-token.json') }
    )
    fake.on('POST', oauth('/token'), { json: malFixture('token-refreshed.json') })
  }

  const sessionWith = (r: Rig, token: string): MalSession => ({
    token,
    userId: A.id,
    generation: r.lifecycle.generation('mal')
  })

  it('the stored token is already B: both retry with B and no refresh runs', async () => {
    serve401UnlessB()
    const r = rig({ user: A })
    await r.seed({ ...creds('x'), access_token: 'fake-access-token-mal-2' })
    const s = sessionWith(r, 'fake-access-token-a')
    await Promise.all([
      r.provider.getEntry(s, { malId: 5114, remoteId: 5114 }),
      r.provider.getEntry(s, { malId: 21, remoteId: 21 })
    ])
    expect(fake.callsTo('POST', oauth('/token'))).toHaveLength(0)
    const auths = fake.calls.map((c) => c.headers.authorization)
    expect(auths.filter((a) => a === 'Bearer fake-access-token-mal-2')).toHaveLength(2)
  })

  it('the stored token is still A: exactly one refresh, and each request retries once', async () => {
    serve401UnlessB()
    const r = rig({ user: A })
    await r.seed(creds('a'))
    const s = sessionWith(r, 'fake-access-token-a')
    await Promise.all([
      r.provider.getEntry(s, { malId: 5114, remoteId: 5114 }),
      r.provider.getEntry(s, { malId: 21, remoteId: 21 })
    ])
    expect(fake.callsTo('POST', oauth('/token'))).toHaveLength(1)
    expect(fake.callsTo('POST', oauth('/token'))[0].form).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'fake-refresh-token-a',
      client_id: CLIENT_ID
    })
    expect(fake.callsTo('GET', /\/v2\/anime\//)).toHaveLength(4)
    expect(await r.stored()).toMatchObject({ access_token: 'fake-access-token-mal-2' })
  })
})

describe('refresh rules 2 and 3: half-life, and obtainedAt stamped locally', () => {
  const HALF = (100 * 1000) / 2

  it('just past half-life refreshes first; just before does not', async () => {
    fake.on('POST', oauth('/token'), { json: malFixture('token-refreshed.json') })
    let clock = HALF - 1
    const r = rig({ user: A, now: () => clock })
    await r.seed(creds('a', { expires_in: 100, obtainedAt: 0 }))
    expect((await r.provider.auth()).token).toBe('fake-access-token-a')
    expect(fake.calls).toHaveLength(0)
    clock = HALF
    expect((await r.provider.auth()).token).toBe('fake-access-token-mal-2')
    expect(fake.callsTo('POST', oauth('/token'))).toHaveLength(1)
  })

  it('obtainedAt is the clock at store time (the token response has no created_at)', async () => {
    expect(malFixture('token-refreshed.json')).not.toHaveProperty('created_at')
    fake.on('POST', oauth('/token'), { json: malFixture('token-refreshed.json') })
    const r = rig({ user: A, now: () => 777_000 })
    await r.seed(creds('a', { expires_in: 100, obtainedAt: 0 }))
    await r.provider.auth()
    expect(await r.stored()).toEqual({
      access_token: 'fake-access-token-mal-2',
      refresh_token: 'fake-refresh-token-mal-2',
      expires_in: 2415600,
      obtainedAt: 777_000
    })
  })
})

describe('refresh rule 4: invalid_client is setup, invalid_grant is expiry', () => {
  it('invalid_client rejects as config, keeps the credentials and leaves session-expired false', async () => {
    fake.on('POST', oauth('/token'), {
      status: 401,
      text: malFixtureText('error-invalid-client.json')
    })
    const r = rig({ user: A, now: () => LATE })
    await r.seed(creds('a'))
    const err = await r.provider.auth().catch((e: unknown) => e)
    expect(classifyMalError(err)).toBe('config')
    expect(await r.stored()).toEqual(creds('a'))
    expect(r.store.get('myanimelistSessionExpired')).toBe(false)
    expect(r.notify).not.toHaveBeenCalled()
  })

  // Mutation: drop the onSessionExpired call and this reds.
  it('invalid_grant clears the credentials, sets session-expired, keeps the user, then notifies once', async () => {
    fake.on('POST', oauth('/token'), {
      status: 400,
      text: malFixtureText('error-invalid-grant.json')
    })
    const r = rig({ user: A, now: () => LATE })
    await r.seed(creds('a'))
    const seen: unknown[] = []
    r.notify.mockImplementation(() => {
      seen.push({
        creds: r.store.get('myanimelistCredentials'),
        expired: r.store.get('myanimelistSessionExpired'),
        user: r.store.get('myanimelistUser')
      })
    })
    const err = await r.provider.auth().catch((e: unknown) => e)
    expect(classifyMalError(err)).toBe('auth')
    expect(r.store.get('myanimelistCredentials')).toBeNull()
    expect(r.store.get('myanimelistSessionExpired')).toBe(true)
    expect(r.store.get('myanimelistUser')).toEqual(A)
    expect(seen).toEqual([{ creds: null, expired: true, user: A }])
  })
})

describe('the logout race across the async encrypt', () => {
  // Wrapped, or the async function's result would adopt (and wait for) `pending`.
  async function refreshHeldAtEncrypt(r: Rig): Promise<{ pending: Promise<unknown> }> {
    fake.on('POST', oauth('/token'), { json: malFixture('token-refreshed.json') })
    await r.seed(creds('a'))
    r.safe.hold = true
    const pending = r.provider.auth().catch((e: unknown) => e)
    await vi.waitFor(() => expect(fake.callsTo('POST', oauth('/token'))).toHaveLength(1))
    // Let the POST's body resolve and the encrypt start.
    await new Promise((res) => setTimeout(res, 20))
    return { pending }
  }

  // Mutation: compare the generation before the encrypt's await instead of in
  // the conditional write, and the refreshed tokens land over the logout.
  it('a logout while the refreshed tokens encrypt leaves the credentials null', async () => {
    const r = rig({ user: A, now: () => LATE })
    const { pending } = await refreshHeldAtEncrypt(r)
    r.lifecycle.logout('mal')
    r.safe.release()
    await pending
    expect(r.store.get('myanimelistCredentials')).toBeNull()
  })

  it('a logout plus a login keeps the new session’s credentials', async () => {
    const r = rig({ user: A, now: () => LATE })
    const { pending } = await refreshHeldAtEncrypt(r)
    r.lifecycle.logout('mal')
    const login = r.lifecycle.completeLogin('mal', async () => ({
      credentials: creds('b'),
      user: B
    }))
    await new Promise((res) => setTimeout(res, 20))
    r.safe.release() // the refresh's encrypt
    await pending
    r.safe.release() // the login's
    await login
    r.safe.hold = false
    expect(await r.stored()).toEqual(creds('b'))
    expect(r.store.get('myanimelistUser')).toEqual(B)
  })

  it('a caller arriving after the refresh resolved but before the store landed joins it: one POST', async () => {
    const r = rig({ user: A, now: () => LATE })
    const { pending } = await refreshHeldAtEncrypt(r)
    const second = r.provider.auth()
    await new Promise((res) => setTimeout(res, 20))
    r.safe.release()
    await pending
    expect((await second).token).toBe('fake-access-token-mal-2')
    expect(fake.callsTo('POST', oauth('/token'))).toHaveLength(1)
  })
})
