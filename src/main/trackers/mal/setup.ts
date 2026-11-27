// What the MAL card's setup needs from main (#702): the redirect URL to
// register, with main's port, and the Test of the saved client ID.

import { malApiBase } from '../../lib/api-bases'
import type { StorageService } from '../../store/types'
import { getClientConfig } from '../client-config'
import type { MalAuth } from './auth'
import { classifyMalError } from './classify'
import type { MalClient } from './client'

export interface MalSetup {
  redirectUri(): string
  /** `GET /anime/1` with `X-MAL-CLIENT-ID` and no token: does MAL accept the saved ID? */
  testClientConfig(): Promise<TrackerTestClientConfigResult>
}

const MESSAGES: Partial<Record<TrackerErrorClass, string>> = {
  config:
    'MyAnimeList rejected this client ID. Copy it again from your app on myanimelist.net/apiconfig.',
  network: 'Couldn’t reach MyAnimeList. Check the connection and try again.',
  'rate-limit': 'MyAnimeList is limiting requests right now. Try again in a minute.',
  server: 'MyAnimeList is having trouble right now. Try again later.'
}

export function createMalSetup(deps: {
  store: StorageService
  client: MalClient
  auth: Pick<MalAuth, 'redirectUri'>
}): MalSetup {
  return {
    redirectUri: () => deps.auth.redirectUri(),
    async testClientConfig() {
      const clientId = getClientConfig(deps.store).clientId
      if (!clientId) return { ok: false, kind: 'config', message: 'Save a client ID first.' }
      try {
        await deps.client.request({
          url: `${malApiBase()}/anime/1`,
          headers: { 'X-MAL-CLIENT-ID': clientId }
        })
        return { ok: true }
      } catch (err) {
        const kind = classifyMalError(err)
        const message = MESSAGES[kind] ?? (err instanceof Error ? err.message : String(err))
        return { ok: false, kind, message }
      }
    }
  }
}
