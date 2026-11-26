/**
 * A fake Electron `safeStorage` for the credential vault (#690).
 *
 * `test/setup/electron-mock.ts` has no `safeStorage`, and the vault takes it
 * through an injected holder anyway. The fake records every property read on
 * the instance (`touched`) and every getter call, which is what the
 * zero-safeStorage-calls assertions read. It encrypts reversibly under a
 * `key`; changing `key` makes earlier blobs undecryptable, which is how a
 * moved profile or a lost keyring is modelled.
 *
 * `async: true` adds `encryptStringAsync` / `decryptStringAsync` (what
 * Electron 45+ has); without it the fake has only the sync pair, like the
 * locked 41.10.7. `hold` keeps each async encrypt pending until `release()`.
 * `onEncrypt` runs inside every encrypt, on either backend, so a test can land
 * a write in the window between the read and the commit on the sync backend
 * too.
 */
import { vi, type Mock } from 'vitest'
import type { SafeStorageHolder, SafeStorageLike } from '../../src/main/trackers/credential-vault'
import { createSafeStorageHolder } from '../../src/main/trackers/credential-vault'

export interface FakeSafeStorage {
  /** The proxied instance the getter returns. */
  readonly instance: SafeStorageLike
  /** The getter handed to `holder.attach`. */
  readonly getter: Mock<() => SafeStorageLike>
  /** A holder already attached to `getter`, logging into `logs`. */
  readonly holder: SafeStorageHolder
  readonly logs: string[]
  /** Every property read on the instance, in order. */
  readonly touched: string[]
  readonly setUsePlainTextEncryption: Mock
  available: boolean
  key: string
  /** Bumped on every encrypt, so a re-encrypt yields different bytes. */
  generation: number
  shouldReEncrypt: boolean
  hold: boolean
  onEncrypt: (() => void) | null
  /** Resolves the oldest held async encrypt. */
  release(): void
  readonly held: number
  /** No getter call and no property read so far. */
  untouched(): boolean
}

const PREFIX = 'fake-ss'

export function createFakeSafeStorage(
  opts: { async?: boolean; available?: boolean; platform?: NodeJS.Platform } = {}
): FakeSafeStorage {
  const touched: string[] = []
  const logs: string[] = []
  const waiting: (() => void)[] = []

  const encryptSync = (plain: string): Buffer => {
    fake.onEncrypt?.()
    fake.generation += 1
    const hex = Buffer.from(plain, 'utf8').toString('hex')
    return Buffer.from(`${PREFIX}:${fake.key}:${fake.generation}:${hex}`, 'utf8')
  }
  const decryptSync = (cipher: Buffer): string => {
    const [prefix, key, , hex] = cipher.toString('utf8').split(':')
    if (prefix !== PREFIX || key !== fake.key || hex === undefined) {
      throw new Error(
        'Error while decrypting the ciphertext provided to safeStorage.decryptString.'
      )
    }
    return Buffer.from(hex, 'hex').toString('utf8')
  }

  const setUsePlainTextEncryption = vi.fn()
  const target: Record<string, unknown> = {
    isEncryptionAvailable: () => fake.available,
    encryptString: encryptSync,
    decryptString: decryptSync,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    setUsePlainTextEncryption
  }
  if (opts.async) {
    target.encryptStringAsync = async (plain: string): Promise<Buffer> => {
      if (fake.hold) await new Promise<void>((resolve) => waiting.push(resolve))
      return encryptSync(plain)
    }
    target.decryptStringAsync = async (
      cipher: Buffer
    ): Promise<{ result: string; shouldReEncrypt: boolean }> => ({
      result: decryptSync(cipher),
      shouldReEncrypt: fake.shouldReEncrypt
    })
  }
  const instance = new Proxy(target, {
    get(t, prop) {
      touched.push(String(prop))
      return t[prop as string]
    }
  }) as unknown as SafeStorageLike

  const getter = vi.fn(() => instance)
  const holder = createSafeStorageHolder({
    platform: opts.platform ?? 'linux',
    log: (m) => logs.push(m)
  })
  holder.attach(getter)

  const fake: FakeSafeStorage = {
    instance,
    getter,
    holder,
    logs,
    touched,
    setUsePlainTextEncryption,
    available: opts.available ?? true,
    key: 'user-key',
    generation: 0,
    shouldReEncrypt: false,
    hold: false,
    onEncrypt: null,
    release: () => waiting.shift()?.(),
    get held() {
      return waiting.length
    },
    untouched: () => getter.mock.calls.length === 0 && touched.length === 0
  }
  return fake
}
