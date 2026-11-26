import type { StorageService } from '../store/types'
import { VAULT_PLAIN_WARNING } from '@shared/tracker-vault'

export { VAULT_LOCKED_ACTION, VAULT_LOCKED_TITLE, VAULT_PLAIN_WARNING } from '@shared/tracker-vault'

/**
 * The store keys the vault owns (#690). Each holds a `VaultBlob` or null, and
 * the renderer's `get-setting` / `set-setting` refuse all three.
 */
export const VAULT_KEYS = [
  'anilistCredentials',
  'myanimelistCredentials',
  'myanimelistClientSecret'
] as const

export type VaultKey = (typeof VAULT_KEYS)[number]

/**
 * What a vault key stores. For `safeStorage`, `data` is the base64 ciphertext
 * of the value's JSON; for `plain` (no keyring), it is the JSON itself.
 */
export interface VaultBlob {
  v: 1
  enc: 'safeStorage' | 'plain'
  data: string
}

export type VaultMode = VaultBlob['enc']

/**
 * A `read`: nothing stored, a value (with how it is stored, so a card can show
 * the plain-fallback warning), or `locked` — a blob that can't be decrypted.
 */
export type VaultRead<T = unknown> =
  | { state: 'empty' }
  | { state: 'locked' }
  | { state: 'ok'; value: T; mode: VaultMode }

/**
 * The part of Electron's `safeStorage` the vault uses. Local rather than
 * `Electron.SafeStorage`: the locked Electron (41.10.7) has no async methods,
 * so they are optional here and the vault uses them whenever they exist.
 * `setUsePlainTextEncryption` is deliberately absent; the vault never calls it.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Linux only. */
  getSelectedStorageBackend?(): string
  encryptStringAsync?(plainText: string): Promise<Buffer>
  decryptStringAsync?(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

/**
 * Hands the vault `safeStorage` once the app is ready. The store opens before
 * `ready`, and Electron throws if safeStorage is used earlier, so `index.ts`
 * creates the holder at module level and `bootstrap()` attaches a getter. The
 * getter is evaluated on the vault's first real use, not at attach.
 */
export interface SafeStorageHolder {
  attach(get: () => SafeStorageLike): void
  /** Resolves after `attach`. The first call evaluates the getter and logs the Linux backend. */
  get(): Promise<SafeStorageLike>
}

export function createSafeStorageHolder(
  opts: { platform?: NodeJS.Platform; log?: (message: string) => void } = {}
): SafeStorageHolder {
  const platform = opts.platform ?? process.platform
  const log = opts.log ?? ((message: string) => console.log(message))
  let attach!: (get: () => SafeStorageLike) => void
  const attached = new Promise<() => SafeStorageLike>((resolve) => (attach = resolve))
  let instance: SafeStorageLike | null = null
  return {
    attach: (get) => attach(get),
    async get() {
      const get = await attached
      if (!instance) {
        instance = get()
        // Tells `basic_text` (Chromium's hardcoded key, which reports
        // encryption unavailable) apart from a locked gnome-keyring.
        if (platform === 'linux' && typeof instance.getSelectedStorageBackend === 'function') {
          log(`[vault] safeStorage backend: ${instance.getSelectedStorageBackend()}`)
        }
      }
      return instance
    }
  }
}

export interface CredentialVault {
  /** Encrypts `value` (or builds the plain-fallback blob). Stores nothing. */
  encrypt(value: unknown): Promise<VaultBlob>
  /**
   * Stores `blob` under `key`, or clears it with null. Synchronous: no await
   * and no safeStorage call, so a caller's check and its other plain-key
   * writes can share one synchronous step with the credential.
   */
  commit(key: VaultKey, blob: VaultBlob | null): void
  /**
   * `encrypt`, then `commit` unless `opts.if` returns false. `if` is
   * evaluated after the encrypt resolves, immediately before the commit.
   * Resolves to whether the value was stored.
   */
  write(key: VaultKey, value: unknown, opts?: { if?: () => boolean }): Promise<boolean>
  read<T = unknown>(key: VaultKey): Promise<VaultRead<T>>
  /** Whether a blob is stored, a `locked` one included. Never touches safeStorage. */
  has(key: VaultKey): Promise<boolean>
}

export interface CredentialVaultDeps {
  store: StorageService
  safeStorage: SafeStorageHolder
  /**
   * A stored blob failed to decrypt. Fires once per locked blob: again only
   * when the key's stored bytes change, or after an empty or successful read.
   * #696 (T3c) wires `notifyAccountsChanged()`.
   */
  onLocked?: (key: VaultKey) => void
  warn?: (message: string) => void
}

const VAULT_KEY_SET: ReadonlySet<string> = new Set(VAULT_KEYS)

function assertVaultKey(key: string): void {
  if (!VAULT_KEY_SET.has(key)) throw new Error(`credential vault: '${key}' is not a vault key`)
}

function isBlob(value: unknown): value is VaultBlob {
  if (value === null || typeof value !== 'object') return false
  const blob = value as Record<string, unknown>
  return (
    blob.v === 1 &&
    (blob.enc === 'safeStorage' || blob.enc === 'plain') &&
    typeof blob.data === 'string'
  )
}

/**
 * The AniList and MyAnimeList credential vault (#690), modeled on
 * `SyncplayPasswordVault`: lives in main, and the renderer never reads a
 * secret back.
 *
 * It never touches safeStorage for a Shikimori-only user: a null key reads as
 * empty and `has` answers from the blob's presence, so the first Keychain or
 * keyring prompt can only come from an AniList or MAL credential. A blob that
 * can't be decrypted reads as `locked` and no automatic path writes over it;
 * only a user action (a new sign-in's write, or Disconnect's `commit(key,
 * null)`) replaces or clears it. `docs/storage.md` has the full contract.
 */
export function createCredentialVault(deps: CredentialVaultDeps): CredentialVault {
  const { store } = deps
  const warn = deps.warn ?? ((message: string) => console.warn(message))

  const stored = (key: VaultKey): unknown => store.get(key)

  async function encrypt(value: unknown): Promise<VaultBlob> {
    if (value === undefined) throw new TypeError('credential vault: cannot encrypt undefined')
    const json = JSON.stringify(value)
    const safe = await deps.safeStorage.get()
    if (!safe.isEncryptionAvailable()) {
      warn(
        `[vault] encryption unavailable; storing a sign-in in plain text. ${VAULT_PLAIN_WARNING}`
      )
      return { v: 1, enc: 'plain', data: json }
    }
    const cipher = safe.encryptStringAsync
      ? await safe.encryptStringAsync(json)
      : safe.encryptString(json)
    return { v: 1, enc: 'safeStorage', data: cipher.toString('base64') }
  }

  function commit(key: VaultKey, blob: VaultBlob | null): void {
    assertVaultKey(key)
    store.set(key, blob)
  }

  // The one place a guard meets `store.set`: evaluated synchronously, right
  // before the commit, with nothing awaited between the two.
  function commitIf(key: VaultKey, blob: VaultBlob | null, guard?: () => boolean): boolean {
    if (guard && !guard()) return false
    commit(key, blob)
    return true
  }

  async function write(
    key: VaultKey,
    value: unknown,
    opts: { if?: () => boolean } = {}
  ): Promise<boolean> {
    assertVaultKey(key)
    const blob = value === null ? null : await encrypt(value)
    return commitIf(key, blob, opts.if)
  }

  /**
   * Re-stores a value just read, encrypted: the `shouldReEncrypt` write-back
   * and the plain-to-encrypted upgrade. Guarded by "the stored blob is still
   * byte-identical to the one read", so a logout's null, a fresh sign-in or a
   * refresh written during the encrypt wins. Never stores plain.
   */
  async function writeBack(key: VaultKey, readBytes: string, value: unknown): Promise<boolean> {
    let blob: VaultBlob
    try {
      blob = await encrypt(value)
    } catch (err) {
      warn(`[vault] re-encrypting ${key} failed: ${String(err)}`)
      return false
    }
    if (blob.enc !== 'safeStorage') return false
    return commitIf(key, blob, () => JSON.stringify(stored(key)) === readBytes)
  }

  // Per key, the bytes of the blob `onLocked` last fired for. `onLocked` fires
  // once per locked blob, not on every read: #696 (T3c) wires it to
  // `notifyAccountsChanged()`, and a refetch that reads the key again must not
  // turn a locked blob into a broadcast loop. New bytes fire again; an empty
  // or successful read clears the entry.
  const lockedBytes = new Map<VaultKey, string>()

  function locked(key: VaultKey, readBytes: string, why: string): VaultRead<never> {
    if (lockedBytes.get(key) !== readBytes) {
      lockedBytes.set(key, readBytes)
      warn(`[vault] can't unlock ${key}: ${why}`)
      deps.onLocked?.(key)
    }
    return { state: 'locked' }
  }

  async function read<T>(key: VaultKey): Promise<VaultRead<T>> {
    assertVaultKey(key)
    const raw = stored(key)
    if (raw === null || raw === undefined) {
      lockedBytes.delete(key)
      return { state: 'empty' }
    }
    const readBytes = JSON.stringify(raw)
    if (!isBlob(raw)) return locked(key, readBytes, 'not a vault blob')
    const safe = await deps.safeStorage.get()

    if (raw.enc === 'plain') {
      let value: T
      try {
        value = JSON.parse(raw.data) as T
      } catch (err) {
        return locked(key, readBytes, String(err))
      }
      lockedBytes.delete(key)
      if (!safe.isEncryptionAvailable()) return { state: 'ok', value, mode: 'plain' }
      const upgraded = await writeBack(key, readBytes, value)
      return { state: 'ok', value, mode: upgraded ? 'safeStorage' : 'plain' }
    }

    let value: T
    let reEncrypt = false
    try {
      const cipher = Buffer.from(raw.data, 'base64')
      let json: string
      if (safe.decryptStringAsync) {
        const out = await safe.decryptStringAsync(cipher)
        json = out.result
        reEncrypt = out.shouldReEncrypt
      } else {
        json = safe.decryptString(cipher)
      }
      value = JSON.parse(json) as T
    } catch (err) {
      return locked(key, readBytes, String(err))
    }
    lockedBytes.delete(key)
    if (reEncrypt) await writeBack(key, readBytes, value)
    return { state: 'ok', value, mode: 'safeStorage' }
  }

  async function has(key: VaultKey): Promise<boolean> {
    assertVaultKey(key)
    const raw = stored(key)
    return raw !== null && raw !== undefined
  }

  return { encrypt, commit, write, read, has }
}
