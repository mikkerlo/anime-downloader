// The sign-in attempts (#695, epic #688): one generic state machine for every
// tracker's `authFlow`, behind `tracker:begin-auth`, `tracker:complete-auth`
// and `tracker:cancel-auth`.
//
//   idle → binding → waiting → exchanging → connected | cancelled | error
//
// The rules no provider can get wrong live here: the offline refusal, and for
// a loopback flow (MAL) the bind on `127.0.0.1` and `::1` before the browser
// opens, because with PKCE `plain` whoever holds the port receives the code.
// One attempt per tracker, in memory only: a restart loses it. Every
// completion runs through `lifecycle.completeLogin` with the attempt as its
// guard, so a cancel, a logout or a new `BEGIN` that lands while the exchange
// is in flight stops the commit. `docs/trackers.md` § Accounts and sign-in
// describes the flow.

import * as http from 'http'
import type { AddressInfo } from 'net'
import type { TrackerLifecycle } from './lifecycle'
import type { TrackerAuthAttempt, TrackerAuthFlow, TrackerProvider } from './types'
import { TRACKER_LABELS } from './types'

/** What the state machine needs from a provider. */
export type TrackerAuthProvider = Pick<TrackerProvider<unknown, unknown>, 'classifyError'> & {
  authFlow?: TrackerAuthFlow
}

type Phase = 'binding' | 'waiting' | 'exchanging' | 'connected' | 'cancelled' | 'error'

interface Loopback {
  close(): void
}

interface Attempt {
  readonly trackerId: TrackerId
  readonly flow: TrackerAuthFlow
  readonly provider: TrackerAuthProvider
  /** Null for an implicit attempt (a completion with no attempt held). */
  readonly params: TrackerAuthAttempt | null
  phase: Phase
  loopback: Loopback | null
  /** The pending `BEGIN`, until it resolves. */
  settle: ((result: TrackerAuthResult) => void) | null
  /** The one exchange, once started: a second callback or paste awaits it. */
  exchange: Promise<TrackerAuthResult> | null
  /** What that exchange ran with (the code or token), so only a replay of it reuses the result. */
  input: string | null
}

export interface TrackerAuthSessionsDeps {
  lifecycle: Pick<TrackerLifecycle, 'completeLogin' | 'account'>
  /** The providers with a sign-in flow, by tracker. */
  providers: Partial<Record<TrackerId, TrackerAuthProvider>>
  isOffline: () => boolean
  openExternal: (url: string) => Promise<void>
  /** The loopback's server factory: a seam for the tests' listening and bind-failure checks. */
  createServer?: (listener: http.RequestListener) => http.Server
  log?: Pick<Console, 'warn'>
}

export interface TrackerAuthSessions {
  begin(trackerId: TrackerId): Promise<TrackerAuthResult>
  complete(trackerId: TrackerId, urlOrToken: string): Promise<TrackerAuthResult>
  /** Closes the loopback, drops the attempt, and the pending `BEGIN` resolves `cancelled`. */
  cancel(trackerId: TrackerId): void
  /** The held attempt's phase, or null when none is held. */
  phase(trackerId: TrackerId): Phase | null
}

/** A bind failure that leaves the port to someone else: `port-busy`, never an auto-open. */
class PortBusyError extends Error {}

/** `::1` errors that mean "no IPv6 loopback here": the flow continues on `127.0.0.1`. */
const NO_IPV6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT'])

const PAGE_DONE =
  '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
  '<p>You can close this tab and return to the app.</p>'
const PAGE_REFUSED =
  '<!doctype html><meta charset="utf-8"><title>Sign-in link not recognized</title>' +
  '<p>This sign-in link isn’t from the attempt the app is waiting for. ' +
  'Return to the app and press Connect again.</p>'

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createTrackerAuthSessions(deps: TrackerAuthSessionsDeps): TrackerAuthSessions {
  const { lifecycle } = deps
  const log = deps.log ?? console
  const createServer = deps.createServer ?? ((listener) => http.createServer(listener))
  const current = new Map<TrackerId, Attempt>()

  function providerOf(id: TrackerId): { provider: TrackerAuthProvider; flow: TrackerAuthFlow } {
    const provider = deps.providers[id]
    if (!provider?.authFlow) throw new Error(`${TRACKER_LABELS[id]} sign-in isn't available yet`)
    return { provider, flow: provider.authFlow }
  }

  function closeLoopback(a: Attempt): void {
    a.loopback?.close()
    a.loopback = null
  }

  function settleBegin(a: Attempt, result: TrackerAuthResult): void {
    const settle = a.settle
    a.settle = null
    settle?.(result)
  }

  function cancel(id: TrackerId): void {
    const a = current.get(id)
    if (!a) return
    current.delete(id)
    if (a.phase !== 'connected') a.phase = 'cancelled'
    closeLoopback(a)
    settleBegin(a, { status: 'cancelled' })
  }

  /** The one exchange of an attempt. Resolves `cancelled` if the attempt was overtaken. */
  function runExchange(a: Attempt, input: string): Promise<TrackerAuthResult> {
    a.phase = 'exchanging'
    a.input = input
    const isCurrent = (): boolean => current.get(a.trackerId) === a
    a.exchange = (async (): Promise<TrackerAuthResult> => {
      let result: TrackerAuthResult
      try {
        const outcome = await lifecycle.completeLogin(
          a.trackerId,
          () => a.flow.exchange(input, a.params),
          { attempt: { isCurrent } }
        )
        result =
          outcome.status === 'connected'
            ? { status: 'connected', account: lifecycle.account(a.trackerId) }
            : { status: 'cancelled' }
      } catch (err) {
        result = { status: 'error', kind: a.provider.classifyError(err), message: messageOf(err) }
      }
      // Overtaken: a committed login still reports itself; anything else is `cancelled`.
      if (!isCurrent()) return result.status === 'connected' ? result : { status: 'cancelled' }
      closeLoopback(a)
      if (result.status === 'connected') {
        // Kept: a late paste after the loopback completed answers with this result.
        a.phase = 'connected'
        a.exchange = Promise.resolve(result)
      } else {
        a.phase = result.status === 'cancelled' ? 'cancelled' : 'error'
        current.delete(a.trackerId)
      }
      settleBegin(a, result)
      return result
    })()
    return a.exchange
  }

  /** The loopback's request handler: a callback with the held `state` starts the exchange. */
  function onCallback(a: Attempt, path: string): http.RequestListener {
    return (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== path) {
        res.writeHead(404).end()
        return
      }
      const reply = (status: number, page: string): void => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page)
      }
      if (current.get(a.trackerId) !== a) return reply(400, PAGE_REFUSED)
      // A duplicate callback (a browser reload) while exchanging, or after: no second exchange.
      if (a.exchange) return reply(200, PAGE_DONE)
      const code = url.searchParams.get('code')
      if (!code || !a.params?.state || url.searchParams.get('state') !== a.params.state) {
        return reply(400, PAGE_REFUSED)
      }
      reply(200, PAGE_DONE)
      void runExchange(a, code)
    }
  }

  async function bindLoopback(a: Attempt, port: number, path: string): Promise<Loopback> {
    const servers: http.Server[] = []
    const close = (): void => {
      for (const s of servers) s.close()
    }
    const v4 = createServer(onCallback(a, path))
    try {
      await listen(v4, port, '127.0.0.1')
    } catch (err) {
      throw new PortBusyError(messageOf(err))
    }
    servers.push(v4)
    // Port 0 (the tests) binds `::1` on the port `127.0.0.1` got.
    const bound = (v4.address() as AddressInfo).port
    const v6 = createServer(onCallback(a, path))
    try {
      await listen(v6, bound, '::1')
      servers.push(v6)
    } catch (err) {
      if (!NO_IPV6.has(codeOf(err) ?? '')) {
        close()
        throw new PortBusyError(messageOf(err))
      }
    }
    return { close }
  }

  async function begin(id: TrackerId): Promise<TrackerAuthResult> {
    const { provider, flow } = providerOf(id)
    if (deps.isOffline()) return { status: 'offline' }
    if (flow.needsSetup?.()) return { status: 'needs-setup' }
    // A second `BEGIN` cancels the first (and resolves a reloaded window's old one).
    cancel(id)
    const params = flow.begin()
    const loopback = flow.loopback?.()
    const a: Attempt = {
      trackerId: id,
      flow,
      provider,
      params,
      phase: loopback ? 'binding' : 'waiting',
      loopback: null,
      settle: null,
      exchange: null,
      input: null
    }
    current.set(id, a)
    const pending = new Promise<TrackerAuthResult>((resolve) => (a.settle = resolve))

    if (loopback) {
      let handle: Loopback
      try {
        handle = await bindLoopback(a, loopback.port, loopback.path)
      } catch (err) {
        if (!(err instanceof PortBusyError)) throw err
        // Whoever holds the port would receive the code: never open the browser.
        if (current.get(id) !== a) return pending
        if (a.phase === 'binding') a.phase = 'waiting'
        a.settle = null
        return { status: 'port-busy', authorizeUrl: params.authorizeUrl }
      }
      // Cancelled, superseded or completed by a paste while binding.
      if (current.get(id) !== a || a.phase !== 'binding') {
        handle.close()
        return pending
      }
      a.loopback = handle
      a.phase = 'waiting'
    }

    try {
      await deps.openExternal(params.authorizeUrl)
    } catch (err) {
      log.warn(`[auth] could not open the ${TRACKER_LABELS[id]} sign-in page:`, err)
      if (current.get(id) !== a || a.phase !== 'waiting') return pending
      a.settle = null
      return { status: 'open-failed', authorizeUrl: params.authorizeUrl }
    }
    return pending
  }

  /** A pasted completion's input, or a rejection that keeps the attempt held. */
  function pasted(
    flow: TrackerAuthFlow,
    a: Attempt,
    raw: string
  ): { input: string } | { refused: string } {
    const text = raw.trim()
    if (flow.paste !== 'url') {
      return text ? { input: text } : { refused: 'Paste the sign-in code first.' }
    }
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return { refused: 'Paste the full address from the browser’s address bar.' }
    }
    const code = url.searchParams.get('code')
    if (!code) return { refused: 'That address has no sign-in code in it.' }
    if (!a.params?.state || url.searchParams.get('state') !== a.params.state) {
      return { refused: 'That address is from a different sign-in attempt. Press Connect again.' }
    }
    return { input: code }
  }

  async function complete(id: TrackerId, urlOrToken: string): Promise<TrackerAuthResult> {
    const { provider, flow } = providerOf(id)
    const held = current.get(id)
    // Exchanging: the one exchange's result, no second one.
    if (held?.exchange && held.phase !== 'connected') return held.exchange
    if (held) {
      const p = pasted(flow, held, urlOrToken)
      if (held.phase === 'connected' && held.exchange) {
        // The same input again (a double submit, a late paste of the URL the
        // loopback took) gets that result while its credential is still
        // stored. Anything else, or a replay after an expiry cleared the
        // credential, is a new sign-in.
        const replay = 'input' in p && p.input === held.input
        if (replay && lifecycle.account(id).hasCredentials) return held.exchange
        cancel(id)
      } else {
        if ('refused' in p) return { status: 'error', kind: 'auth', message: p.refused }
        closeLoopback(held)
        return runExchange(held, p.input)
      }
    }
    // No attempt held (a restart, or a window reload, then a paste).
    if (flow.paste === 'url') {
      // The verifier and `state` went with the attempt: nothing to complete.
      return {
        status: 'error',
        kind: 'auth',
        message: `This ${TRACKER_LABELS[id]} sign-in has expired. Press Connect again.`
      }
    }
    const text = urlOrToken.trim()
    if (!text) return { status: 'error', kind: 'auth', message: 'Paste the sign-in code first.' }
    // An implicit attempt, entering at `exchanging`, so cancel, logout and a
    // new `BEGIN` stop it the way they stop a normal one.
    const a: Attempt = {
      trackerId: id,
      flow,
      provider,
      params: null,
      phase: 'exchanging',
      loopback: null,
      settle: null,
      exchange: null,
      input: null
    }
    current.set(id, a)
    return runExchange(a, text)
  }

  return {
    begin,
    complete,
    cancel,
    phase: (id) => current.get(id)?.phase ?? null
  }
}
