import type { StorageService } from '../store/types'
import type { CredentialVault } from './credential-vault'

/**
 * What `myanimelistClientConfig` holds: the user's MAL client ID, in plain
 * text. It isn't secret (every authorize URL carries it). The optional client
 * secret lives in the credential vault under `myanimelistClientSecret`.
 */
export interface MalClientConfig {
  clientId: string
}

export interface MalClientConfigView {
  clientId: string | null
  /** Whether a secret blob is stored; computed, never stored, so it can't drift. */
  hasSecret: boolean
}

/**
 * The MAL client config for #695 (T3b)'s `tracker:get-client-config`. A plain
 * store read: never touches safeStorage, so a Shikimori-only start can call it.
 */
export function getClientConfig(store: StorageService): MalClientConfigView {
  const config = store.get<MalClientConfig | null | undefined>('myanimelistClientConfig')
  const secret = store.get<unknown>('myanimelistClientSecret')
  return {
    clientId: config?.clientId ?? null,
    hasSecret: secret !== null && secret !== undefined
  }
}

/**
 * Stores `{ clientId }`, and the secret through the vault when one is given:
 * a string replaces it, null clears it, and leaving it out keeps it. The
 * secret is encrypted first, then the config and the secret are committed in
 * one synchronous step, so no interleaving leaves one call's ID beside
 * another's secret.
 */
export async function setClientConfig(
  store: StorageService,
  vault: CredentialVault,
  input: { clientId: string; secret?: string | null }
): Promise<void> {
  const blob =
    input.secret === undefined || input.secret === null ? null : await vault.encrypt(input.secret)
  store.set('myanimelistClientConfig', { clientId: input.clientId } satisfies MalClientConfig)
  if (input.secret !== undefined) vault.commit('myanimelistClientSecret', blob)
}
