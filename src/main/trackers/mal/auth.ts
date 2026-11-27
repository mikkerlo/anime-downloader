// MyAnimeList sign-in and tokens (#702): PKCE `plain` over a loopback redirect,
// the code exchange, the user read, and the four refresh rules
// (`docs/trackers.md` § MyAnimeList). `trackers/auth-session.ts` runs the
// attempt (bind before open, `port-busy`, the paste, the duplicate callback);
// this module supplies MAL's half of it, and the session getter's token.

import { randomBytes } from 'crypto'
import { malOauthBase, malApiBase } from '../../lib/api-bases'
import type { StorageService } from '../../store/types'
import { getClientConfig } from '../client-config'
import type { CredentialVault } from '../credential-vault'
import { TrackerApiError } from '../errors'
import type { TrackerAuthAttempt, TrackerAuthFlow } from '../types'
import type { MalClient, MalFormValue } from './client'
import {
  MAL_LOCKED_MESSAGE,
  MAL_NOT_CONNECTED_MESSAGE,
  MAL_SESSION_EXPIRED_MESSAGE,
  MalConfigError,
  MalSessionChangedError,
  MalSessionGoneError
} from './errors'

/**
 * The loopback port. **Never change it**: every user registers
 * `http://localhost:41753/callback` as the one redirect URL of their own MAL
 * app, and MAL rejects any `redirect_uri` that doesn't match it exactly, so a
 * new value silently breaks every existing registration.
 */
export const MAL_LOOPBACK_PORT = 41753
export const MAL_LOOPBACK_PATH = '/callback'
/** Unpackaged runs only, like the API base overrides: tests pass `0`. */
export const MAL_LOOPBACK_PORT_ENV = 'ANIME_DL_MAL_LOOPBACK_PORT'
/** How long a sign-in waits for the browser before it is dropped. */
export const MAL_AUTH_TIMEOUT_MS = 10 * 60 * 1000

/** The port to bind: the fixed one, or `ANIME_DL_MAL_LOOPBACK_PORT` when unpackaged. */
export function malLoopbackPort(env: NodeJS.ProcessEnv, isPackaged: boolean): number {
  const raw = env[MAL_LOOPBACK_PORT_ENV]?.trim()
  if (isPackaged || !raw) return MAL_LOOPBACK_PORT
  const port = Number(raw)
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : MAL_LOOPBACK_PORT
}

/** The one redirect URL a user registers, and every authorize URL carries. */
export function malRedirectUri(port: number): string {
  return `http://localhost:${port}${MAL_LOOPBACK_PATH}`
}

/** What `myanimelistCredentials` holds, in the vault. */
export interface MalCredentials {
  access_token: string
  refresh_token: string
  /** Seconds, as MAL sent it. */
  expires_in: number
  /** Stamped locally when the tokens are stored: MAL's token response has no `created_at`. */
  obtainedAt: number
}

interface MalTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type?: string
}

/**
 * A 128-character PKCE verifier: 96 random bytes in base64url are exactly 128
 * characters of RFC 7636's unreserved set. With `plain`, it is the challenge.
 */
export function createVerifier(): string {
  return randomBytes(96).toString('base64url')
}

export function createState(): string {
  return randomBytes(24).toString('base64url')
}

export function malAuthorizeUrl(opts: {
  clientId: string
  verifier: string
  state: string
  redirectUri: string
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    code_challenge: opts.verifier,
    code_challenge_method: 'plain',
    state: opts.state,
    redirect_uri: opts.redirectUri
  })
  return `${malOauthBase()}/authorize?${params}`
}

/** `GET /users/@me` as the seam's user. */
export async function fetchMalUser(client: MalClient, token: string): Promise<TrackerUser> {
  const { body } = await client.request({
    url: `${malApiBase()}/users/@me`,
    headers: { Authorization: `Bearer ${token}` }
  })
  const me = body as { id: number; name: string; picture?: string | null }
  return { id: me.id, nickname: me.name, avatar: me.picture ?? null }
}

/** True for a refresh MAL answered with a dead refresh token. */
function isInvalidGrant(err: unknown): boolean {
  return err instanceof TrackerApiError && err.body.includes('invalid_grant')
}

/** A request's `401 invalid_token`: the one answer the data members refresh and retry on. */
export function isInvalidToken(err: unknown): boolean {
  return (
    err instanceof TrackerApiError && err.status === 401 && !err.body.includes('invalid_client')
  )
}

/** Whether a token obtained at `obtainedAt` is past half its life (rule 2). */
export function pastHalfLife(creds: MalCredentials, now: number): boolean {
  return now >= creds.obtainedAt + (creds.expires_in * 1000) / 2
}

export interface MalAuthDeps {
  store: StorageService
  vault: CredentialVault
  client: MalClient
  /** The lifecycle's per-tracker session generation (`lifecycle.generation('mal')`). */
  generation: () => number
  /** The port to bind (`malLoopbackPort`). */
  port: number
  /** How long an attempt waits for the browser; `MAL_AUTH_TIMEOUT_MS` by default. */
  timeoutMs?: number
  now?: () => number
  /** After an `invalid_grant` refresh cleared the credentials and set the expired flag. */
  onSessionExpired?: () => void
}

export interface MalAuth {
  /** MAL's half of the sign-in state machine. */
  flow: TrackerAuthFlow
  /** The redirect URL for the configured port (the card shows it). */
  redirectUri(): string
  /**
   * The access token for the session of `generation`: read from the vault,
   * refreshed first once past half-life. Throws `MalSessionChangedError` when
   * a login or logout landed during the read.
   */
  freshToken(generation: number): Promise<string>
  /**
   * Runs `send` with `token`; on a `401 invalid_token`, once more with the
   * stored token if it differs, else with a single-flight refresh's (rule 1).
   * Only while `generation` is still current: after a logout or a switch the
   * 401 is thrown as is (`auth`), and the drain's owner guard ends the run.
   */
  withRetry<T>(token: string, generation: number, send: (token: string) => Promise<T>): Promise<T>
  /** The saved client ID, or a `MalConfigError` (no request can be made without one). */
  clientId(): string
}

export function createMalAuth(deps: MalAuthDeps): MalAuth {
  const { store, vault, client } = deps
  const now = deps.now ?? Date.now
  const KEY = 'myanimelistCredentials' as const

  function clientId(): string {
    const id = getClientConfig(store).clientId
    if (!id) throw new MalConfigError('MyAnimeList needs setup: no client ID is saved')
    return id
  }

  /** `client_id`, and `client_secret` only when the user saved one: never sent empty. */
  async function clientFields(): Promise<Record<string, MalFormValue>> {
    const fields: Record<string, MalFormValue> = { client_id: clientId() }
    const secret = await vault.read<string>('myanimelistClientSecret')
    if (secret.state === 'locked') {
      throw new MalConfigError('Can’t unlock the saved MyAnimeList client secret')
    }
    if (secret.state === 'ok' && secret.value) fields.client_secret = secret.value
    return fields
  }

  async function tokenRequest(form: Record<string, MalFormValue>): Promise<MalTokenResponse> {
    const { body } = await client.request({
      method: 'POST',
      url: `${malOauthBase()}/token`,
      form: { ...(await clientFields()), ...form }
    })
    return body as MalTokenResponse
  }

  const stamp = (t: MalTokenResponse): MalCredentials => ({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_in: t.expires_in,
    obtainedAt: now()
  })

  const flow: TrackerAuthFlow = {
    paste: 'url',
    needsSetup: () => !getClientConfig(store).clientId,
    loopback: () => ({
      port: deps.port,
      path: MAL_LOOPBACK_PATH,
      timeoutMs: deps.timeoutMs ?? MAL_AUTH_TIMEOUT_MS
    }),
    // Built after the bind, with the port the loopback got (port 0 in tests).
    begin(bound): TrackerAuthAttempt {
      const verifier = createVerifier()
      const state = createState()
      const redirectUri = malRedirectUri(bound?.port ?? deps.port)
      const authorizeUrl = malAuthorizeUrl({ clientId: clientId(), verifier, state, redirectUri })
      return { authorizeUrl, state, verifier, redirectUri }
    },
    // A failed exchange (a reused code's `invalid_grant` included) is an attempt
    // error: nothing here touches the stored credentials or the expired flag.
    async exchange(code, attempt) {
      if (!attempt?.verifier || !attempt.redirectUri) {
        throw new Error('This MyAnimeList sign-in has expired. Press Connect again.')
      }
      const tokens = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri
      })
      const user = await fetchMalUser(client, tokens.access_token)
      return { credentials: stamp(tokens), user }
    }
  }

  // The refresh in flight, per session generation: a refresh token is
  // single-use, so two callers of one session share one POST. Held until the
  // new tokens are stored (or refused), so a caller arriving after the POST
  // resolved but before the store landed can't re-POST the rotated token.
  let inFlight: { generation: number; promise: Promise<MalCredentials> } | null = null

  function refresh(creds: MalCredentials, generation: number): Promise<MalCredentials> {
    if (inFlight && inFlight.generation === generation) return inFlight.promise
    const current = (): boolean => deps.generation() === generation
    const promise = (async (): Promise<MalCredentials> => {
      let next: MalCredentials
      try {
        next = stamp(
          await tokenRequest({ grant_type: 'refresh_token', refresh_token: creds.refresh_token })
        )
      } catch (err) {
        // `invalid_client` is a setup problem (`config`): the credentials and
        // the expired flag stay as they are, and the token step sets "Needs setup".
        if (!isInvalidGrant(err)) throw err
        if (current()) {
          vault.commit(KEY, null)
          store.set('myanimelistSessionExpired', true)
          deps.onSessionExpired?.()
        }
        throw new MalSessionGoneError(MAL_SESSION_EXPIRED_MESSAGE, { cause: err })
      }
      // The compare and the store are one synchronous step after the encrypt:
      // a logout (or a logout and a login) during it bumped the generation,
      // and its credentials win.
      await vault.write(KEY, next, { if: current })
      return next
    })()
    const entry = { generation, promise }
    inFlight = entry
    void promise
      .catch(() => {})
      .finally(() => {
        if (inFlight === entry) inFlight = null
      })
    return promise
  }

  async function storedCredentials(generation: number): Promise<MalCredentials> {
    const read = await vault.read<MalCredentials>(KEY)
    if (deps.generation() !== generation) throw new MalSessionChangedError()
    if (read.state === 'locked') throw new MalSessionGoneError(MAL_LOCKED_MESSAGE)
    if (read.state === 'empty') {
      const expired = Boolean(store.get('myanimelistSessionExpired'))
      throw new MalSessionGoneError(
        expired ? MAL_SESSION_EXPIRED_MESSAGE : MAL_NOT_CONNECTED_MESSAGE
      )
    }
    return read.value
  }

  async function freshToken(generation: number): Promise<string> {
    const creds = await storedCredentials(generation)
    if (!pastHalfLife(creds, now())) return creds.access_token
    const next = await refresh(creds, generation)
    // A logout during the refresh refused its store: the token is a dead session's.
    if (deps.generation() !== generation) throw new MalSessionChangedError()
    return next.access_token
  }

  async function withRetry<T>(
    token: string,
    generation: number,
    send: (token: string) => Promise<T>
  ): Promise<T> {
    try {
      return await send(token)
    } catch (err) {
      if (!isInvalidToken(err) || deps.generation() !== generation) throw err
      // The one place a data member reads the stored token: only for its own session.
      let creds: MalCredentials
      try {
        creds = await storedCredentials(generation)
      } catch {
        throw err
      }
      // A refresh revokes the old token: another caller may already have stored B.
      const retryToken =
        creds.access_token !== token
          ? creds.access_token
          : (await refresh(creds, generation)).access_token
      if (deps.generation() !== generation) throw err
      return send(retryToken)
    }
  }

  return {
    flow,
    redirectUri: () => malRedirectUri(deps.port),
    freshToken,
    withRetry,
    clientId
  }
}
