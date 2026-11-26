// The sign-in attempt state machine (#695): `trackers/auth-session.ts` over
// the real lifecycle and vault, with the fake-tracker personalities' auth
// flows. MAL's loopback binds real `http.Server`s on port 0, so the
// bind-before-open assertion reads real listeners.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import { createFakeTracker, type FakeTracker } from '../helpers/fake-tracker'
import { createFakeSafeStorage } from '../helpers/fake-safe-storage'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'
import { PERSISTED_STORE_KEYS } from '../../src/main/store/keys'
import { createCredentialVault } from '../../src/main/trackers/credential-vault'
import { createTrackerLifecycle } from '../../src/main/trackers/lifecycle'
import { createTrackerAuthSessions } from '../../src/main/trackers/auth-session'

const live: http.Server[] = []

afterEach(() => {
  for (const s of live.splice(0)) {
    s.closeAllConnections?.()
    s.close()
  }
})

/** Whether this host has an IPv6 loopback at all (Docker CI may not). */
async function hasIpv6Loopback(): Promise<boolean> {
  const s = http.createServer()
  return new Promise((resolve) => {
    s.once('error', () => resolve(false))
    s.listen(0, '::1', () => s.close(() => resolve(true)))
  })
}

/** A server whose `listen` on `host` fails with `code`, as a host without IPv6 answers. */
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

function rig(opts: { createServer?: (l: http.RequestListener) => http.Server } = {}) {
  const store = new InMemoryStorage(structuredClone(STORE_DEFAULTS) as Record<string, unknown>)
  const safe = createFakeSafeStorage({ async: true })
  const vault = createCredentialVault({ store, safeStorage: safe.holder, warn: () => {} })
  const fakes = {
    shikimori: createFakeTracker('shikimori'),
    anilist: createFakeTracker('anilist'),
    mal: createFakeTracker('mal')
  }
  const offline = { value: false }
  const servers: http.Server[] = []
  const createServer =
    opts.createServer ??
    ((listener: http.RequestListener) => {
      const s = http.createServer(listener)
      live.push(s)
      return s
    })
  const openExternal = vi.fn(async (_url: string) => {})
  const lifecycle = createTrackerLifecycle({
    store,
    vault,
    trackerRates: { instance: () => null, refreshInBackground: () => {} },
    cancelAttempt: (id) => auth.cancel(id)
  })
  const auth = createTrackerAuthSessions({
    lifecycle,
    providers: {
      shikimori: fakes.shikimori.provider,
      anilist: fakes.anilist.provider,
      mal: fakes.mal.provider
    },
    isOffline: () => offline.value,
    openExternal,
    createServer: (listener) => {
      const s = createServer(listener)
      servers.push(s)
      return s
    },
    log: { warn: () => {} }
  })
  const snapshot = (): string =>
    JSON.stringify(Object.fromEntries(PERSISTED_STORE_KEYS.map((k) => [k, store.get(k)])))
  const port = (): number => (servers[0].address() as AddressInfo).port
  return {
    store,
    safe,
    vault,
    fakes,
    offline,
    servers,
    openExternal,
    lifecycle,
    auth,
    snapshot,
    port
  }
}

type Rig = ReturnType<typeof rig>

/** GET the MAL loopback's callback; resolves the status code. */
function hit(port: number, query: string, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host, port, path: `/callback?${query}`, agent: false }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      .on('error', reject)
  })
}

/** Resolves once the MAL loopback is bound and the browser was asked to open. */
async function opened(r: Rig): Promise<void> {
  await vi.waitFor(() => expect(r.openExternal).toHaveBeenCalled())
}

function hold(fake: FakeTracker<TrackerId>, step: 'exchange' | 'user') {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let reached!: () => void
  const atGate = new Promise<void>((resolve) => (reached = resolve))
  fake.signIn.gate = async (s) => {
    if (s !== step) return
    reached()
    await held
  }
  return { atGate, release }
}

const malUrl = (state: string, code = 'mal-code') =>
  `http://localhost:0/callback?code=${code}&state=${state}`

describe('the loopback callback (MAL)', () => {
  it('a callback with the held state connects; a wrong state is refused and the attempt keeps waiting', async () => {
    const r = rig()
    const begin = r.auth.begin('mal')
    await opened(r)
    expect(await hit(r.port(), 'code=c1&state=wrong')).toBe(400)
    expect(await hit(r.port(), 'state=state-1')).toBe(400)
    expect(r.auth.phase('mal')).toBe('waiting')
    expect(r.fakes.mal.signIn.calls).toEqual([])

    expect(await hit(r.port(), 'code=c1&state=state-1')).toBe(200)
    const result = await begin
    expect(result).toMatchObject({ status: 'connected', account: { trackerId: 'mal' } })
    expect(r.fakes.mal.signIn.calls).toEqual([
      { input: 'c1', attempt: r.fakes.mal.signIn.begun[0] }
    ])
    expect(r.store.get('myanimelistUser')).toEqual({ id: 1, nickname: 'mal-user', avatar: null })
    // The loopback is closed once the attempt completes.
    expect(r.servers.every((s) => !s.listening)).toBe(true)
  })

  it('binds 127.0.0.1 and ::1 before the browser opens', async () => {
    const v6 = await hasIpv6Loopback()
    const r = rig()
    const atOpen: { listening: boolean[]; hosts: string[] }[] = []
    r.openExternal.mockImplementation(async () => {
      atOpen.push({
        listening: r.servers.map((s) => s.listening),
        hosts: r.servers.filter((s) => s.listening).map((s) => (s.address() as AddressInfo).address)
      })
    })
    const begin = r.auth.begin('mal')
    await opened(r)
    expect(atOpen).toEqual([
      {
        listening: v6 ? [true, true] : [true, false],
        hosts: v6 ? ['127.0.0.1', '::1'] : ['127.0.0.1']
      }
    ])
    if (v6) expect(await hit(r.port(), 'code=c&state=state-1', '::1')).toBe(200)
    else expect(await hit(r.port(), 'code=c&state=state-1')).toBe(200)
    expect(await begin).toMatchObject({ status: 'connected' })
  })

  it.each(['EADDRNOTAVAIL', 'EAFNOSUPPORT'])(
    'no IPv6 loopback (%s on ::1): the flow continues on 127.0.0.1',
    async (code) => {
      const r = rig({ createServer: failingOn('::1', code) })
      const begin = r.auth.begin('mal')
      await opened(r)
      expect(r.servers.map((s) => s.listening)).toEqual([true, false])
      expect(await hit(r.port(), 'code=c&state=state-1')).toBe(200)
      expect(await begin).toMatchObject({ status: 'connected' })
    }
  )

  it('a second callback while exchanging runs no second exchange', async () => {
    const r = rig()
    const gate = hold(r.fakes.mal, 'exchange')
    const begin = r.auth.begin('mal')
    await opened(r)
    expect(await hit(r.port(), 'code=c&state=state-1')).toBe(200)
    await gate.atGate
    expect(r.auth.phase('mal')).toBe('exchanging')
    // A browser reload: the same callback again, and a paste of the same URL.
    expect(await hit(r.port(), 'code=c&state=state-1')).toBe(200)
    const paste = r.auth.complete('mal', malUrl('state-1', 'c'))
    gate.release()
    const result = await begin
    expect(result).toMatchObject({ status: 'connected' })
    expect(await paste).toEqual(result)
    expect(r.fakes.mal.signIn.calls).toHaveLength(1)
  })

  it('a paste after the loopback completed resolves the same connected result, with no second exchange', async () => {
    const r = rig()
    const begin = r.auth.begin('mal')
    await opened(r)
    await hit(r.port(), 'code=c&state=state-1')
    const result = await begin
    expect(await r.auth.complete('mal', malUrl('state-1', 'c'))).toEqual(result)
    expect(r.fakes.mal.signIn.calls).toHaveLength(1)
  })
})

describe('port-busy and open-failed', () => {
  it('port-busy returns the authorize URL, never opens the browser, and a later paste completes', async () => {
    const holder = http.createServer()
    live.push(holder)
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
    const r = rig()
    r.fakes.mal.signIn.loopback = {
      port: (holder.address() as AddressInfo).port,
      path: '/callback'
    }
    const result = await r.auth.begin('mal')
    expect(result).toEqual({
      status: 'port-busy',
      authorizeUrl: r.fakes.mal.signIn.begun[0].authorizeUrl
    })
    expect(r.openExternal).not.toHaveBeenCalled()
    expect(r.auth.phase('mal')).toBe('waiting')
    expect(await r.auth.complete('mal', malUrl('state-1'))).toMatchObject({ status: 'connected' })
  })

  it('EADDRINUSE on ::1 is port-busy too, and the 127.0.0.1 listener is closed', async () => {
    const r = rig({ createServer: failingOn('::1', 'EADDRINUSE') })
    expect(await r.auth.begin('mal')).toMatchObject({ status: 'port-busy' })
    expect(r.openExternal).not.toHaveBeenCalled()
    expect(r.servers.map((s) => s.listening)).toEqual([false, false])
  })

  it('open-failed returns the authorize URL and keeps the attempt, so a paste still completes', async () => {
    const r = rig()
    r.openExternal.mockRejectedValue(new Error('no browser'))
    const result = await r.auth.begin('anilist')
    expect(result).toEqual({
      status: 'open-failed',
      authorizeUrl: r.fakes.anilist.signIn.begun[0].authorizeUrl
    })
    expect(await r.auth.complete('anilist', 'tok')).toMatchObject({ status: 'connected' })
  })
})

describe('cancel, supersede and offline', () => {
  it('cancel resolves the pending BEGIN cancelled and closes the loopback', async () => {
    const r = rig()
    const begin = r.auth.begin('mal')
    await opened(r)
    r.auth.cancel('mal')
    expect(await begin).toEqual({ status: 'cancelled' })
    expect(r.servers.every((s) => !s.listening)).toBe(true)
    expect(r.auth.phase('mal')).toBeNull()
  })

  it('a second BEGIN cancels the first', async () => {
    const r = rig()
    const first = r.auth.begin('anilist')
    const second = r.auth.begin('anilist')
    expect(await first).toEqual({ status: 'cancelled' })
    expect(await r.auth.complete('anilist', 'tok')).toMatchObject({ status: 'connected' })
    expect(await second).toMatchObject({ status: 'connected' })
  })

  it('offline: BEGIN resolves offline with no bind and no browser', async () => {
    const r = rig()
    r.offline.value = true
    expect(await r.auth.begin('mal')).toEqual({ status: 'offline' })
    expect(await r.auth.begin('shikimori')).toEqual({ status: 'offline' })
    expect(r.servers).toEqual([])
    expect(r.openExternal).not.toHaveBeenCalled()
    expect(r.auth.phase('mal')).toBeNull()
  })

  it('needs-setup when MAL has no client ID: no bind and no browser', async () => {
    const r = rig()
    r.fakes.mal.signIn.ready = () => false
    expect(await r.auth.begin('mal')).toEqual({ status: 'needs-setup' })
    expect(r.servers).toEqual([])
    expect(r.openExternal).not.toHaveBeenCalled()
  })
})

describe('the paste', () => {
  it('a full MAL URL completes; a mismatched state or a bare code is rejected and the attempt stays held', async () => {
    const r = rig()
    r.fakes.mal.signIn.loopback = null
    const begin = r.auth.begin('mal')
    await opened(r)
    expect(await r.auth.complete('mal', malUrl('state-0'))).toMatchObject({
      status: 'error',
      kind: 'auth'
    })
    expect(await r.auth.complete('mal', 'mal-code')).toMatchObject({
      status: 'error',
      kind: 'auth'
    })
    expect(r.auth.phase('mal')).toBe('waiting')
    expect(r.fakes.mal.signIn.calls).toEqual([])
    const result = await r.auth.complete('mal', `  ${malUrl('state-1', 'pasted')}  `)
    expect(result).toMatchObject({ status: 'connected' })
    expect(await begin).toEqual(result)
    expect(r.fakes.mal.signIn.calls.map((c) => c.input)).toEqual(['pasted'])
  })

  it('an AniList token is validated with the user read; a rejected one returns error/auth and writes nothing', async () => {
    const r = rig()
    const before = r.snapshot()
    expect(await r.auth.complete('anilist', 'bad')).toMatchObject({ status: 'error', kind: 'auth' })
    expect(r.snapshot()).toBe(before)
    expect(r.lifecycle.generation('anilist')).toBe(0)
    expect(await r.auth.complete('anilist', 'good')).toMatchObject({
      status: 'connected',
      account: { trackerId: 'anilist', user: { nickname: 'anilist-user' } }
    })
  })

  it('a config error from the exchange returns kind config', async () => {
    const r = rig()
    r.fakes.mal.signIn.loopback = null
    r.fakes.mal.signIn.failNext = 'config'
    const begin = r.auth.begin('mal')
    await opened(r)
    const result = await r.auth.complete('mal', malUrl('state-1'))
    expect(result).toMatchObject({ status: 'error', kind: 'config' })
    expect(await begin).toEqual(result)
    expect(r.auth.phase('mal')).toBeNull()
  })

  it('a second paste while exchanging runs no second exchange', async () => {
    const r = rig()
    const gate = hold(r.fakes.anilist, 'user')
    const first = r.auth.complete('anilist', 'tok')
    await gate.atGate
    const second = r.auth.complete('anilist', 'tok')
    gate.release()
    expect(await second).toEqual(await first)
    expect(r.fakes.anilist.signIn.calls).toHaveLength(1)
  })
})

describe('a completion with no attempt held', () => {
  it.each(['anilist', 'shikimori'] as const)(
    '%s registers an implicit attempt in exchanging, then completes',
    async (id) => {
      const r = rig()
      const gate = hold(r.fakes[id], 'exchange')
      const done = r.auth.complete(id, 'pasted')
      await gate.atGate
      expect(r.auth.phase(id)).toBe('exchanging')
      gate.release()
      expect(await done).toMatchObject({ status: 'connected', account: { trackerId: id } })
      expect(r.fakes[id].signIn.calls).toEqual([{ input: 'pasted', attempt: null }])
    }
  )

  it('MAL returns error/auth and writes nothing: the verifier went with the attempt', async () => {
    const r = rig()
    const before = r.snapshot()
    expect(await r.auth.complete('mal', malUrl('state-1'))).toMatchObject({
      status: 'error',
      kind: 'auth'
    })
    expect(r.snapshot()).toBe(before)
    expect(r.fakes.mal.signIn.calls).toEqual([])
    expect(r.auth.phase('mal')).toBeNull()
  })
})
